//! The real [`Runtime`]: the same supervisor, specs and `startup::prepare` as a normal launch,
//! with the output going to the installer instead of the splash screen.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use super::api_client::HttpApi;
use super::output::{Emitter, ProvisionError, Status, StepId};
use super::plan::ExternalDatabase;
use super::{ConfigUpdate, Runtime};
use crate::events::{ErrorCode, ErrorEvent, EventSink, StepStatus, SupervisorEvent};
use crate::paths::DataDirs;
use crate::secrets::{self, DatabaseConfig, LocalConfig};
use crate::services::{resolve_resources_root, RuntimeContext, StartupStep, RESOURCES_DIR_ENV};
use crate::startup;
use crate::supervisor::clock::SystemClock;
use crate::supervisor::health::NetProber;
use crate::supervisor::process::StdSpawner;
use crate::supervisor::spec::{ProcessCommand, TaskSpec};
use crate::supervisor::{Supervisor, SupervisorError};

/// Lines of a failed service's log forwarded to the installer's journal.
const FAILURE_TAIL_LINES: usize = 30;
/// The pump threads copy a child's output to its log slightly after it exits.
const LOG_SETTLE: Duration = Duration::from_millis(300);

pub struct SupervisorRuntime {
    out: Arc<Emitter>,
    dirs: Result<DataDirs, String>,
    resources_root: Option<PathBuf>,
    /// The plan's external server, for the connectivity check (absent on upgrade).
    external: Option<ExternalDatabase>,
    ctx: Option<RuntimeContext>,
    supervisor: Option<Arc<Supervisor>>,
}

impl SupervisorRuntime {
    /// Same lookups as the app: `SCIP_DATA_DIR`/`LOCALAPPDATA`, then `SCIP_RESOURCES_DIR` or
    /// `resources/` next to the executable (Tauri's resource folder on Windows).
    pub fn from_process_env(out: Arc<Emitter>, external: Option<ExternalDatabase>) -> Self {
        let exe_dir: Option<PathBuf> =
            std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf));
        Self {
            out,
            dirs: DataDirs::from_process_env().map_err(|e| e.to_string()),
            resources_root: resolve_resources_root(std::env::var(RESOURCES_DIR_ENV).ok(), exe_dir.as_deref()),
            external,
            ctx: None,
            supervisor: None,
        }
    }

    fn ctx(&self, step: StepId) -> Result<&RuntimeContext, ProvisionError> {
        self.ctx
            .as_ref()
            .ok_or_else(|| ProvisionError::new(step, "not-prepared", "préparation non effectuée", false))
    }

    fn parts(&self, step: StepId) -> Result<(&RuntimeContext, &Arc<Supervisor>), ProvisionError> {
        let ctx: &RuntimeContext = self.ctx(step)?;
        let supervisor = self
            .supervisor
            .as_ref()
            .ok_or_else(|| ProvisionError::new(step, "not-prepared", "préparation non effectuée", false))?;
        Ok((ctx, supervisor))
    }

    fn sink(&self) -> ProvisionSink {
        ProvisionSink { out: Arc::clone(&self.out) }
    }

    fn forward(&self, lines: &[String]) {
        for line in lines {
            self.out.log(line);
        }
    }

    fn check_external(&self, db: &ExternalDatabase) -> Result<Status, ProvisionError> {
        let (ctx, supervisor) = self.parts(StepId::Database)?;
        let task: TaskSpec = external_check_task(ctx, db);
        let log: LogCursor = LogCursor::at_end(&supervisor.log_file(&task.name));
        let result = supervisor.run_task(&task);
        std::thread::sleep(LOG_SETTLE);
        let lines: Vec<String> = log.new_lines();
        match result {
            Ok(_) => Ok(Status::Done),
            Err(error) => {
                self.forward(&lines);
                Err(classify_database_failure(StepId::Database, &lines.join("\n"), &error))
            }
        }
    }
}

/// `psql -c "SELECT 1"` against the customer's server. Connection settings go through the
/// environment, never the command line, which any local process can read.
pub fn external_check_task(ctx: &RuntimeContext, db: &ExternalDatabase) -> TaskSpec {
    let command = ProcessCommand::new(ctx.resources.postgres_bin("psql"))
        .args(["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1"])
        .env("PGHOST", db.host.trim())
        .env("PGPORT", db.port.to_string())
        .env("PGDATABASE", db.database.trim())
        .env("PGUSER", db.user.trim())
        .env("PGPASSWORD", db.password.clone())
        .env("PGSSLMODE", if db.ssl { "require" } else { "prefer" })
        .env("PGCONNECT_TIMEOUT", "10");
    TaskSpec::new("database-check", command, Duration::from_secs(30))
}

impl Runtime for SupervisorRuntime {
    type Api = HttpApi;

    fn prepare(&mut self, update: &ConfigUpdate) -> Result<(), ProvisionError> {
        let step = StepId::Prepare;
        let dirs: DataDirs =
            self.dirs.clone().map_err(|m| ProvisionError::new(step, "data-dir", m, false))?;
        dirs.ensure_created().map_err(|e| ProvisionError::new(step, "data-dir", e.to_string(), false))?;
        apply_config_update(&dirs.config_file, update)
            .map_err(|e| ProvisionError::new(step, "config", e.to_string(), false))?;
        let mut ctx: RuntimeContext =
            startup::prepare(dirs, self.resources_root.clone()).map_err(|e| event_error(step, &e))?;
        // The temporary API of an installation is never exposed, whatever network.json says.
        ctx.lan_access = false;
        // Never the preferred 3001: a SCIP already running there (an upgrade started with the
        // window open) would answer our health check and receive the plan. Nobody bookmarks
        // this temporary API, so any free port does.
        let taken: [u16; 2] = [ctx.ports.postgres, ctx.ports.ai];
        ctx.ports.api = crate::ports::pick_free_ports(3)
            .ok()
            .and_then(|ports| ports.into_iter().find(|p| !taken.contains(p)))
            .ok_or_else(|| ProvisionError::new(step, "ports", "aucun port local libre", true))?;
        self.out.log(&format!("Dossier de données : {}", ctx.dirs.root.display()));
        let supervisor = Supervisor::new(
            Arc::new(StdSpawner),
            Arc::new(NetProber),
            Arc::new(SystemClock),
            Arc::new(self.sink()),
            ctx.dirs.logs.clone(),
        );
        self.supervisor = Some(Arc::new(supervisor));
        self.ctx = Some(ctx);
        Ok(())
    }

    fn database(&mut self) -> Result<Status, ProvisionError> {
        let (ctx, supervisor) = self.parts(StepId::Database)?;
        if ctx.is_external_database() {
            return match self.external.clone() {
                Some(db) => self.check_external(&db),
                None => {
                    self.out.log("Base existante : rien à démarrer.");
                    Ok(Status::Skipped)
                }
            };
        }
        startup::run_plan(supervisor, ctx.database_plan(), &self.sink())
            .map_err(|e| supervisor_error(StepId::Database, &e))?;
        Ok(Status::Done)
    }

    fn migrate(&mut self) -> Result<(), ProvisionError> {
        let (ctx, supervisor) = self.parts(StepId::Migrate)?;
        let task: TaskSpec = ctx.migrate_task();
        let log: LogCursor = LogCursor::at_end(&supervisor.log_file(&task.name));
        let result = supervisor.run_task(&task);
        std::thread::sleep(LOG_SETTLE);
        let lines: Vec<String> = log.new_lines();
        self.forward(&lines);
        match result {
            Ok(_) => Ok(()),
            Err(error) => Err(classify_database_failure(StepId::Migrate, &lines.join("\n"), &error)),
        }
    }

    fn start_services(&mut self) -> Result<HttpApi, ProvisionError> {
        let (ctx, supervisor) = self.parts(StepId::Services)?;
        let mut plan: Vec<StartupStep> = ctx.services_plan();
        for step in &mut plan {
            if let StartupStep::Service(spec) = step {
                // Trackers are not needed to provision, and port 5023 may still be held by a
                // SCIP window the user left open during an upgrade.
                spec.command.env.insert("DEVICE_GATEWAY_ENABLED".to_owned(), "false".to_owned());
            }
        }
        let api_log: LogCursor = LogCursor::at_end(&supervisor.log_file("api"));
        if let Err(error) = startup::run_plan(supervisor, plan, &self.sink()) {
            let lines: Vec<String> = api_log.new_lines();
            let start: usize = lines.len().saturating_sub(FAILURE_TAIL_LINES);
            self.forward(&lines[start..]);
            return Err(supervisor_error(StepId::Services, &error));
        }
        self.out.log(&format!("API prête sur {}", ctx.api_base_url()));
        Ok(HttpApi::new(ctx.api_base_url()))
    }

    fn stop_all(&mut self) {
        if let Some(supervisor) = &self.supervisor {
            supervisor.stop_all();
        }
    }
}

/// Records the installer's choices in `config.json`, keeping the secrets and unknown sections.
pub fn apply_config_update(path: &Path, update: &ConfigUpdate) -> Result<(), secrets::SecretsError> {
    let mut config: LocalConfig = secrets::load_or_create(path)?;
    let mut changed: bool = false;
    if let Some(database) = &update.database {
        // Embedded stays implicit on a fresh config, so it looks the same whether or not the
        // installer wrote it.
        let wanted: Option<DatabaseConfig> = match database {
            DatabaseConfig::Embedded if config.database.is_none() => None,
            other => Some(other.clone()),
        };
        if config.database != wanted {
            config.database = wanted;
            changed = true;
        }
    }
    if let Some(simulator) = update.simulator {
        if config.simulator != Some(simulator) {
            config.simulator = Some(simulator);
            changed = true;
        }
    }
    if changed {
        secrets::save(path, &config)?;
    }
    Ok(())
}

// ------------------------------------------------------------------------------ error mapping

pub fn supervisor_error(step: StepId, error: &SupervisorError) -> ProvisionError {
    let (code, retryable) = match error {
        SupervisorError::Spawn { .. } | SupervisorError::TempFile { .. } => ("spawn-failed", false),
        SupervisorError::ExitedDuringStartup { .. } => ("service-exited", false),
        SupervisorError::Unhealthy { .. } => ("timeout", true),
        SupervisorError::TaskFailed { .. } => ("task-failed", false),
        SupervisorError::TaskTimeout { .. } => ("timeout", true),
    };
    let message: String = format!("{error} (journal : {})", error.log_file().display());
    ProvisionError::new(step, code, message, retryable)
}

fn event_error(step: StepId, event: &ErrorEvent) -> ProvisionError {
    let (code, retryable) = match event.code {
        ErrorCode::DataDir => ("data-dir", false),
        ErrorCode::Config => ("config", false),
        ErrorCode::Ports => ("ports", true),
        ErrorCode::MissingResources => ("missing-resources", false),
        ErrorCode::SpawnFailed => ("spawn-failed", false),
        ErrorCode::TaskFailed => ("task-failed", false),
        ErrorCode::Unhealthy | ErrorCode::Crashed => ("unhealthy", true),
    };
    let mut message: String = event.message.clone();
    for detail in event.details.iter().take(10) {
        message.push_str(&format!("\n{detail}"));
    }
    ProvisionError::new(step, code, message, retryable)
}

/// Reads psql/Prisma output to tell "the server is unreachable" (worth a retry: network, VPN,
/// server starting) from "the credentials or database are wrong" (fix the plan). psql messages
/// are localised, hence the French variants.
pub fn classify_database_failure(step: StepId, output: &str, error: &SupervisorError) -> ProvisionError {
    let text: String = output.to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| text.contains(n));
    let base: ProvisionError = supervisor_error(step, error);
    let detail = |headline: &str| format!("{headline} ({})", base.message);
    if has(&[
        "p1000",
        "password authentication failed",
        "authentification par mot de passe",
        "no password supplied",
    ]) {
        ProvisionError::new(step, "db-auth", detail("identifiants de la base refusés"), false)
    } else if has(&["p1003", "does not exist", "n'existe pas"]) {
        ProvisionError::new(step, "db-missing", detail("la base de données demandée n'existe pas"), false)
    } else if has(&[
        "p1001",
        "p1002",
        "p1017",
        "can't reach database",
        "could not connect",
        "connection refused",
        "econnrefused",
        "timeout expired",
        "timed out",
        "could not translate host name",
        "n'a pas pu",
    ]) {
        ProvisionError::new(step, "db-unreachable", detail("serveur de base de données injoignable"), true)
    } else {
        base
    }
}

// ------------------------------------------------------------------------------ plumbing

/// Supervisor events become journal lines; the installer shows its own step list.
struct ProvisionSink {
    out: Arc<Emitter>,
}

fn status_text(status: StepStatus) -> &'static str {
    match status {
        StepStatus::Running => "en cours",
        StepStatus::Done => "terminé",
        StepStatus::Skipped => "déjà fait",
        StepStatus::Restarting => "relance",
        StepStatus::Degraded => "indisponible (facultatif)",
    }
}

impl EventSink for ProvisionSink {
    fn emit(&self, event: SupervisorEvent) {
        match event {
            SupervisorEvent::Progress(p) => self.out.log(&format!("{} : {}", p.label, status_text(p.status))),
            SupervisorEvent::Error(e) => self.out.log(&e.message),
            SupervisorEvent::Ready(_) => {}
        }
    }
}

/// Reads what a log file gained since a point in time (the logs are appended across launches).
pub struct LogCursor {
    path: PathBuf,
    offset: u64,
}

impl LogCursor {
    pub fn at_end(path: &Path) -> Self {
        let offset: u64 = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        Self { path: path.to_path_buf(), offset }
    }

    pub fn new_lines(&self) -> Vec<String> {
        let Ok(mut file) = std::fs::File::open(&self.path) else { return Vec::new() };
        // A rotated log starts again at zero.
        let len: u64 = file.metadata().map(|m| m.len()).unwrap_or(0);
        let from: u64 = if len < self.offset { 0 } else { self.offset };
        let mut bytes: Vec<u8> = Vec::new();
        if file.seek(SeekFrom::Start(from)).is_err() || file.read_to_end(&mut bytes).is_err() {
            return Vec::new();
        }
        String::from_utf8_lossy(&bytes).lines().filter(|l| !l.trim().is_empty()).map(str::to_owned).collect()
    }
}

/// `log::warn!` from the supervisor (an optional service that did not start...) reaches the
/// installer's journal instead of nowhere.
struct EmitterLogger(Arc<Emitter>);

impl log::Log for EmitterLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            self.0.log(&record.args().to_string());
        }
    }

    fn flush(&self) {}
}

pub fn install_logger(out: Arc<Emitter>) {
    if log::set_boxed_logger(Box::new(EmitterLogger(out))).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::ServicePorts;
    use crate::services::ResourceLayout;

    fn task_failed() -> SupervisorError {
        SupervisorError::TaskFailed {
            name: "migrate".into(),
            exit: "exit code 1".into(),
            log_file: "m.log".into(),
        }
    }

    #[test]
    fn database_failures_are_classified() {
        let c = |out: &str| classify_database_failure(StepId::Migrate, out, &task_failed());
        let unreachable = c("Error: P1001: Can't reach database server at `db:5432`");
        assert_eq!((unreachable.code.as_str(), unreachable.retryable), ("db-unreachable", true));
        let auth = c("Error: P1000: Authentication failed against database server");
        assert_eq!((auth.code.as_str(), auth.retryable), ("db-auth", false));
        let fr =
            c("psql: erreur : FATAL:  l'authentification par mot de passe a échoué pour l'utilisateur « x »");
        assert_eq!(fr.code, "db-auth");
        assert_eq!(c("FATAL: database \"nope\" does not exist").code, "db-missing");
        let other = c("syntax error in migration");
        assert_eq!((other.code.as_str(), other.retryable), ("task-failed", false));
    }

    #[test]
    fn supervisor_errors_map_timeouts_to_retryable() {
        let timeout = SupervisorError::Unhealthy {
            name: "api".into(),
            timeout: Duration::from_secs(1),
            log_file: "a".into(),
        };
        assert!(supervisor_error(StepId::Services, &timeout).retryable);
        let spawn = SupervisorError::Spawn { name: "api".into(), message: "x".into(), log_file: "a".into() };
        assert!(!supervisor_error(StepId::Services, &spawn).retryable);
    }

    #[test]
    fn config_update_records_mode_and_simulator_and_keeps_secrets() {
        let tmp = tempfile::tempdir().unwrap();
        let path: PathBuf = tmp.path().join("config.json");
        let first: LocalConfig = secrets::load_or_create(&path).unwrap();
        let update = ConfigUpdate {
            database: Some(DatabaseConfig::External { url: "postgresql://u:p@h/d".into() }),
            simulator: Some(false),
        };
        apply_config_update(&path, &update).unwrap();
        let after: LocalConfig = secrets::load_or_create(&path).unwrap();
        assert_eq!(after.secrets, first.secrets);
        assert_eq!(after.database, update.database);
        assert_eq!(after.simulator, Some(false));

        apply_config_update(
            &path,
            &ConfigUpdate { database: Some(DatabaseConfig::Embedded), simulator: None },
        )
        .unwrap();
        let back: LocalConfig = secrets::load_or_create(&path).unwrap();
        assert_eq!(back.database, Some(DatabaseConfig::Embedded));
        assert_eq!(back.simulator, Some(false), "untouched when not in the update");
    }

    #[test]
    fn embedded_stays_implicit_on_a_fresh_config() {
        let tmp = tempfile::tempdir().unwrap();
        let path: PathBuf = tmp.path().join("config.json");
        apply_config_update(
            &path,
            &ConfigUpdate { database: Some(DatabaseConfig::Embedded), simulator: Some(true) },
        )
        .unwrap();
        let raw: String = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("database") && raw.contains("\"simulator\": true"), "{raw}");
    }

    #[test]
    fn external_check_keeps_the_password_off_the_command_line() {
        let ctx = RuntimeContext {
            dirs: DataDirs::from_root("/d"),
            ports: ServicePorts { postgres: 1, api: 2, ai: 3 },
            secrets: Default::default(),
            resources: ResourceLayout::new("/r"),
            database: DatabaseConfig::External { url: "x".into() },
            simulator: false,
            lan_access: false,
        };
        let db = ExternalDatabase {
            host: "db".into(),
            port: 5433,
            database: "scip".into(),
            user: "ops".into(),
            password: "s3cret-pw".into(),
            ssl: true,
        };
        let task = external_check_task(&ctx, &db);
        assert!(task.command.args.iter().all(|a| !a.contains("s3cret")));
        assert_eq!(task.command.env.get("PGPASSWORD").map(String::as_str), Some("s3cret-pw"));
        assert_eq!(task.command.env.get("PGSSLMODE").map(String::as_str), Some("require"));
    }

    #[test]
    fn log_cursor_returns_only_new_lines() {
        let tmp = tempfile::tempdir().unwrap();
        let log: PathBuf = tmp.path().join("migrate.log");
        std::fs::write(&log, "old line\n").unwrap();
        let cursor = LogCursor::at_end(&log);
        std::fs::write(&log, "old line\nnew 1\n\nnew 2\n").unwrap();
        assert_eq!(cursor.new_lines(), vec!["new 1", "new 2"]);
        assert!(LogCursor::at_end(&tmp.path().join("none.log")).new_lines().is_empty());
    }
}
