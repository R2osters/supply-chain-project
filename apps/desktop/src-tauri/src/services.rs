//! The concrete SCIP sidecars and the startup sequence, expressed as supervisor specs.
//!
//! Resource layout (filled by `apps/desktop/scripts/stage-*.mjs`, see `resources/README.md`):
//!
//! ```text
//! resources/
//!   postgres/bin/{initdb,pg_ctl,postgres,psql}.exe   (+ lib/, share/ with PostGIS)
//!   node/node.exe
//!   api/dist/main.js, api/prisma/schema.prisma, api/node_modules/prisma/build/index.js
//!   ai/scip-ai.exe
//! ```
//!
//! Everything here is pure: it builds data, the supervisor does the I/O.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::paths::DataDirs;
use crate::ports::ServicePorts;
use crate::secrets::Secrets;
use crate::supervisor::spec::{
    HealthCheck, ProcessCommand, ServiceSpec, SkipCondition, StopMethod, TaskSpec, TempFile,
};

/// Overrides where the sidecar binaries are looked up (dev builds, CI).
pub const RESOURCES_DIR_ENV: &str = "SCIP_RESOURCES_DIR";

pub const DB_USER: &str = "scip";
pub const DB_NAME: &str = "scip";
pub const API_PREFIX: &str = "api/v1";
/// GT06 trackers are configured with this port once, on the device; it cannot move.
pub const DEVICE_GATEWAY_PORT: u16 = 5023;
/// Origins the Tauri webview uses on Windows (http/https depending on `useHttpsScheme`).
pub const WEBVIEW_ORIGINS: &str = "http://tauri.localhost,https://tauri.localhost,tauri://localhost";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceLayout {
    pub root: PathBuf,
}

impl ResourceLayout {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn exe(dir: PathBuf, name: &str) -> PathBuf {
        dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX))
    }

    pub fn postgres_bin(&self, name: &str) -> PathBuf {
        Self::exe(self.root.join("postgres").join("bin"), name)
    }

    pub fn node(&self) -> PathBuf {
        Self::exe(self.root.join("node"), "node")
    }

    pub fn api_dir(&self) -> PathBuf {
        self.root.join("api")
    }

    pub fn api_main(&self) -> PathBuf {
        self.api_dir().join("dist").join("main.js")
    }

    /// Static export of the web UI, served by the API to drivers' phones on the local network.
    /// Optional: without it the desktop window still works, only the phone app is unavailable.
    pub fn web_dir(&self) -> PathBuf {
        self.root.join("web")
    }

    pub fn prisma_cli(&self) -> PathBuf {
        self.api_dir().join("node_modules").join("prisma").join("build").join("index.js")
    }

    pub fn prisma_schema(&self) -> PathBuf {
        self.api_dir().join("prisma").join("schema.prisma")
    }

    pub fn ai_exe(&self) -> PathBuf {
        Self::exe(self.root.join("ai"), "scip-ai")
    }

    pub fn required_files(&self) -> Vec<PathBuf> {
        vec![
            self.postgres_bin("initdb"),
            self.postgres_bin("pg_ctl"),
            self.postgres_bin("postgres"),
            self.postgres_bin("psql"),
            self.node(),
            self.api_main(),
            self.prisma_cli(),
            self.prisma_schema(),
            self.ai_exe(),
        ]
    }

    /// Checked before anything starts, so a dev build without staged binaries shows one
    /// clear list instead of a cryptic spawn error halfway through.
    pub fn missing_files(&self) -> Vec<PathBuf> {
        self.required_files().into_iter().filter(|p: &PathBuf| !p.is_file()).collect()
    }
}

/// `SCIP_RESOURCES_DIR` wins, else `<tauri resource dir>/resources`.
pub fn resolve_resources_root(
    override_dir: Option<String>,
    bundled_resource_dir: Option<&Path>,
) -> Option<PathBuf> {
    match override_dir.filter(|v: &String| !v.trim().is_empty()) {
        Some(dir) => Some(PathBuf::from(dir)),
        None => bundled_resource_dir.map(|dir: &Path| without_verbatim_prefix(dir).join("resources")),
    }
}

/// Turns `\\?\C:\x` into `C:\x` and `\\?\UNC\host\share` into `\\host\share`.
///
/// Tauri reports the installed resource folder in Windows' verbatim form. Most APIs accept it,
/// but initdb locates `postgres.exe` by rewriting its own path, turns the prefix into `//?/`, and
/// fails with "program postgres is needed by initdb but was not found".
pub fn without_verbatim_prefix(path: &Path) -> PathBuf {
    let text: String = path.to_string_lossy().into_owned();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

/// Everything needed to build the specs for one launch.
#[derive(Debug, Clone)]
pub struct RuntimeContext {
    pub dirs: DataDirs,
    pub ports: ServicePorts,
    pub secrets: Secrets,
    pub resources: ResourceLayout,
}

/// Specs are a few hundred bytes and the plan has seven entries built once per launch:
/// boxing would add noise for no measurable gain.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartupStep {
    Task(TaskSpec),
    Service(ServiceSpec),
    /// A service the app can run without (the AI engine: TRACK works without OPTIMIZE).
    OptionalService(ServiceSpec),
}

impl StartupStep {
    pub fn name(&self) -> &str {
        match self {
            Self::Task(task) => &task.name,
            Self::Service(service) | Self::OptionalService(service) => &service.name,
        }
    }
}

impl RuntimeContext {
    /// The base64url alphabet needs no percent-encoding, which is why secrets use it.
    pub fn database_url(&self) -> String {
        format!(
            "postgresql://{DB_USER}:{}@127.0.0.1:{}/{DB_NAME}?schema=public",
            self.secrets.postgres_password, self.ports.postgres
        )
    }

    pub fn api_base_url(&self) -> String {
        format!("http://127.0.0.1:{}/{API_PREFIX}", self.ports.api)
    }

    pub fn ai_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.ports.ai)
    }

    /// Order matters: database first, then the AI (the API calls it), then the API.
    pub fn startup_plan(&self) -> Vec<StartupStep> {
        vec![
            StartupStep::Task(self.initdb_task()),
            StartupStep::Service(self.postgres_service()),
            StartupStep::Task(self.create_database_task()),
            StartupStep::Task(self.postgis_task()),
            StartupStep::Task(self.migrate_task()),
            StartupStep::OptionalService(self.ai_service()),
            StartupStep::Service(self.api_service()),
        ]
    }

    // ------------------------------------------------------------ postgres

    /// First run only: `PG_VERSION` is written by initdb once the cluster is complete.
    pub fn initdb_task(&self) -> TaskSpec {
        let pwfile: PathBuf = self.dirs.root.join("initdb-password.tmp");
        let command = ProcessCommand::new(self.resources.postgres_bin("initdb")).args([
            "-D".to_owned(),
            path_arg(&self.dirs.pgdata),
            "-U".to_owned(),
            DB_USER.to_owned(),
            "--auth=scram-sha-256".to_owned(),
            format!("--pwfile={}", path_arg(&pwfile)),
            "--encoding=UTF8".to_owned(),
            // The C locale sorts identically on every Windows language, so a backup restored
            // on another PC keeps valid indexes.
            "--no-locale".to_owned(),
        ]);
        let mut task = TaskSpec::new("initdb", command, Duration::from_secs(120));
        task.skip_if = Some(SkipCondition::PathExists(self.dirs.pgdata.join("PG_VERSION")));
        task.temp_files.push(TempFile { path: pwfile, contents: self.secrets.postgres_password.clone() });
        task
    }

    /// `postgres.exe` directly rather than `pg_ctl start`, which detaches and would leave
    /// the supervisor watching nothing. Note it refuses to run from an elevated (admin)
    /// process; SCIP runs as a normal user so this is fine.
    pub fn postgres_service(&self) -> ServiceSpec {
        let command = ProcessCommand::new(self.resources.postgres_bin("postgres")).args([
            "-D".to_owned(),
            path_arg(&self.dirs.pgdata),
            "-p".to_owned(),
            self.ports.postgres.to_string(),
            "-c".to_owned(),
            "listen_addresses=127.0.0.1".to_owned(),
        ]);
        let stop = ProcessCommand::new(self.resources.postgres_bin("pg_ctl")).args([
            "stop".to_owned(),
            "-D".to_owned(),
            path_arg(&self.dirs.pgdata),
            "-m".to_owned(),
            "fast".to_owned(),
            "-w".to_owned(),
        ]);
        ServiceSpec {
            name: "postgres".to_owned(),
            command,
            // A query, not a port check: Postgres accepts TCP while still replaying WAL.
            health: HealthCheck::Command(self.psql("postgres").args(["-c", "SELECT 1"])),
            start_timeout: Duration::from_secs(60),
            stop: StopMethod::Command(stop),
            stop_timeout: Duration::from_secs(30),
        }
    }

    fn psql(&self, database: &str) -> ProcessCommand {
        ProcessCommand::new(self.resources.postgres_bin("psql"))
            .args([
                "-h",
                "127.0.0.1",
                "-p",
                &self.ports.postgres.to_string(),
                "-U",
                DB_USER,
                "-d",
                database,
                "-X",
                "-q",
                "-v",
                "ON_ERROR_STOP=1",
            ])
            .env("PGPASSWORD", self.secrets.postgres_password.clone())
            .env("PGCONNECT_TIMEOUT", "3")
    }

    /// Idempotent `createdb`: `CREATE DATABASE` has no `IF NOT EXISTS`, hence `\gexec`.
    pub fn create_database_task(&self) -> TaskSpec {
        let sql: String = format!(
            "SELECT 'CREATE DATABASE {DB_NAME}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '{DB_NAME}')\\gexec\n"
        );
        TaskSpec::new("create-database", self.psql("postgres").stdin(sql), Duration::from_secs(30))
    }

    pub fn postgis_task(&self) -> TaskSpec {
        let command = self.psql(DB_NAME).args(["-c", "CREATE EXTENSION IF NOT EXISTS postgis"]);
        TaskSpec::new("postgis", command, Duration::from_secs(60))
    }

    // ------------------------------------------------------------ api

    pub fn migrate_task(&self) -> TaskSpec {
        let command = ProcessCommand::new(self.resources.node())
            .args([
                path_arg(&self.resources.prisma_cli()),
                "migrate".to_owned(),
                "deploy".to_owned(),
                "--schema".to_owned(),
                path_arg(&self.resources.prisma_schema()),
            ])
            .env("DATABASE_URL", self.database_url())
            // Prisma otherwise tries to phone home and to prompt for updates.
            .env("CHECKPOINT_DISABLE", "1")
            .env("PRISMA_HIDE_UPDATE_MESSAGE", "1")
            .cwd(self.resources.api_dir());
        TaskSpec::new("migrate", command, Duration::from_secs(300))
    }

    pub fn api_env(&self) -> BTreeMap<String, String> {
        let pairs: [(&str, String); 15] = [
            ("NODE_ENV", "production".to_owned()),
            ("SCIP_RUNTIME", "desktop".to_owned()),
            ("API_PORT", self.ports.api.to_string()),
            ("API_GLOBAL_PREFIX", API_PREFIX.to_owned()),
            ("PUBLIC_API_URL", self.api_base_url()),
            ("DATABASE_URL", self.database_url()),
            ("JWT_ACCESS_SECRET", self.secrets.jwt_access_secret.clone()),
            ("JWT_REFRESH_SECRET", self.secrets.jwt_refresh_secret.clone()),
            ("AI_SERVICE_URL", self.ai_url()),
            ("AI_SERVICE_TOKEN", self.secrets.ai_service_token.clone()),
            ("STORAGE_DIR", path_arg(&self.dirs.files)),
            ("CORS_ORIGINS", WEBVIEW_ORIGINS.to_owned()),
            ("DEVICE_GATEWAY_PORT", DEVICE_GATEWAY_PORT.to_string()),
            ("CHECKPOINT_DISABLE", "1".to_owned()),
            ("WEB_DIST_DIR", path_arg(&self.resources.web_dir())),
        ];
        pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()
    }

    pub fn api_service(&self) -> ServiceSpec {
        let command = ProcessCommand::new(self.resources.node())
            .args([path_arg(&self.resources.api_main())])
            .envs(&self.api_env())
            // Mail is off until the user configures SMTP in the settings; a stray SMTP_HOST
            // from the user's environment must not switch it on.
            .unset("SMTP_HOST")
            .cwd(self.resources.api_dir());
        ServiceSpec {
            name: "api".to_owned(),
            command,
            health: HealthCheck::http_local(self.ports.api, &format!("/{API_PREFIX}/health")),
            start_timeout: Duration::from_secs(90),
            // Stateless: everything durable is in Postgres, so a hard stop loses nothing.
            stop: StopMethod::Kill,
            stop_timeout: Duration::from_secs(5),
        }
    }

    // ------------------------------------------------------------ ai

    pub fn ai_service(&self) -> ServiceSpec {
        let command = ProcessCommand::new(self.resources.ai_exe())
            .env("SCIP_AI_HOST", "127.0.0.1")
            .env("SCIP_AI_PORT", self.ports.ai.to_string())
            .env("SCIP_RUNTIME", "desktop")
            .env("DATABASE_URL", self.database_url())
            .env("AI_SERVICE_TOKEN", self.secrets.ai_service_token.clone())
            .env("MODELS_STORE", path_arg(&self.dirs.models))
            .cwd(&self.dirs.root);
        ServiceSpec {
            name: "ai".to_owned(),
            command,
            health: HealthCheck::http_local(self.ports.ai, "/health"),
            // A PyInstaller build unpacks and imports scipy/ortools on first launch.
            start_timeout: Duration::from_secs(180),
            stop: StopMethod::Kill,
            stop_timeout: Duration::from_secs(5),
        }
    }
}

fn path_arg(path: &Path) -> String {
    path.display().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> RuntimeContext {
        RuntimeContext {
            dirs: DataDirs::from_root("/data/SCIP"),
            ports: ServicePorts { postgres: 15432, api: 13001, ai: 18000 },
            secrets: Secrets {
                jwt_access_secret: "access".into(),
                jwt_refresh_secret: "refresh".into(),
                ai_service_token: "ai-token".into(),
                postgres_password: "pg-pass_-".into(),
            },
            resources: ResourceLayout::new("/res"),
        }
    }

    #[test]
    fn plan_runs_database_then_ai_then_api() {
        let names: Vec<String> = ctx().startup_plan().iter().map(|s| s.name().to_owned()).collect();
        assert_eq!(names, vec!["initdb", "postgres", "create-database", "postgis", "migrate", "ai", "api"]);
    }

    #[test]
    fn urls_use_the_picked_ports() {
        let c = ctx();
        assert_eq!(c.database_url(), "postgresql://scip:pg-pass_-@127.0.0.1:15432/scip?schema=public");
        assert_eq!(c.api_base_url(), "http://127.0.0.1:13001/api/v1");
        assert_eq!(c.ai_url(), "http://127.0.0.1:18000");
    }

    #[test]
    fn api_env_matches_the_contract() {
        let c = ctx();
        let env = c.api_env();
        let get = |k: &str| env.get(k).map(String::as_str);
        assert_eq!(get("NODE_ENV"), Some("production"));
        assert_eq!(get("API_PORT"), Some("13001"));
        assert_eq!(get("DATABASE_URL"), Some(c.database_url().as_str()));
        assert_eq!(get("AI_SERVICE_URL"), Some("http://127.0.0.1:18000"));
        assert_eq!(get("AI_SERVICE_TOKEN"), Some("ai-token"));
        assert_eq!(get("JWT_ACCESS_SECRET"), Some("access"));
        assert_eq!(get("JWT_REFRESH_SECRET"), Some("refresh"));
        assert_eq!(get("PUBLIC_API_URL"), Some("http://127.0.0.1:13001/api/v1"));
        assert_eq!(get("STORAGE_DIR"), Some(path_arg(&c.dirs.files).as_str()));
        assert_eq!(get("DEVICE_GATEWAY_PORT"), Some("5023"));
        assert_eq!(get("SCIP_RUNTIME"), Some("desktop"));
        assert!(get("CORS_ORIGINS").unwrap().contains("http://tauri.localhost"));
        assert!(get("SMTP_HOST").is_none());
        assert!(c.api_service().command.env_remove.contains(&"SMTP_HOST".to_owned()));
    }

    #[test]
    fn api_is_healthy_on_the_prefixed_health_route() {
        let spec = ctx().api_service();
        assert_eq!(spec.health, HealthCheck::http_local(13001, "/api/v1/health"));
        assert_eq!(spec.command.program, ResourceLayout::new("/res").node());
        assert_eq!(spec.command.args, vec![path_arg(&ResourceLayout::new("/res").api_main())]);
    }

    #[test]
    fn ai_gets_host_port_token_and_models_dir() {
        let c = ctx();
        let spec = c.ai_service();
        let get = |k: &str| spec.command.env.get(k).cloned();
        assert_eq!(get("SCIP_AI_PORT").as_deref(), Some("18000"));
        assert_eq!(get("SCIP_AI_HOST").as_deref(), Some("127.0.0.1"));
        assert_eq!(get("MODELS_STORE"), Some(path_arg(&c.dirs.models)));
        assert_eq!(get("AI_SERVICE_TOKEN").as_deref(), Some("ai-token"));
        assert_eq!(spec.health, HealthCheck::http_local(18000, "/health"));
    }

    #[test]
    fn initdb_is_skipped_once_the_cluster_exists_and_keeps_the_password_off_the_command_line() {
        let c = ctx();
        let task = c.initdb_task();
        assert_eq!(task.skip_if, Some(SkipCondition::PathExists(c.dirs.pgdata.join("PG_VERSION"))));
        assert!(task.command.args.iter().all(|a| !a.contains("pg-pass")));
        assert_eq!(task.temp_files[0].contents, "pg-pass_-");
        assert!(task.command.args.contains(&"--auth=scram-sha-256".to_owned()));
        assert!(task.command.args.windows(2).any(|w| w == ["-U", "scip"]));
    }

    #[test]
    fn postgres_listens_on_loopback_and_stops_gracefully() {
        let spec = ctx().postgres_service();
        assert!(spec.command.args.contains(&"listen_addresses=127.0.0.1".to_owned()));
        assert!(spec.command.args.contains(&"15432".to_owned()));
        assert!(matches!(spec.stop, StopMethod::Command(_)));
        assert!(matches!(spec.health, HealthCheck::Command(_)));
    }

    #[test]
    fn create_database_is_idempotent_sql() {
        let task = ctx().create_database_task();
        let sql: String = task.command.stdin.unwrap();
        assert!(sql.contains("WHERE NOT EXISTS") && sql.contains("\\gexec"));
        assert_eq!(task.command.env.get("PGPASSWORD").map(String::as_str), Some("pg-pass_-"));
    }

    #[test]
    fn migrate_runs_prisma_deploy_with_the_database_url() {
        let c = ctx();
        let task = c.migrate_task();
        assert_eq!(task.command.program, c.resources.node());
        assert_eq!(task.command.args[1..3], ["migrate".to_owned(), "deploy".to_owned()]);
        assert_eq!(task.command.env.get("DATABASE_URL"), Some(&c.database_url()));
    }

    #[test]
    fn missing_files_lists_everything_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = ResourceLayout::new(tmp.path());
        assert_eq!(layout.missing_files().len(), layout.required_files().len());
        std::fs::create_dir_all(tmp.path().join("node")).unwrap();
        std::fs::write(layout.node(), "").unwrap();
        assert!(!layout.missing_files().contains(&layout.node()));
    }

    #[test]
    fn resources_root_override_wins() {
        let bundled = Path::new("/app");
        assert_eq!(resolve_resources_root(Some("/x".into()), Some(bundled)), Some(PathBuf::from("/x")));
        assert_eq!(resolve_resources_root(Some(" ".into()), Some(bundled)), Some(bundled.join("resources")));
        assert_eq!(resolve_resources_root(None, None), None);
    }

    #[test]
    fn bundled_resource_dir_loses_the_verbatim_prefix() {
        let bundled = Path::new(r"\\?\C:\Users\a\AppData\Local\SCIP");
        assert_eq!(
            resolve_resources_root(None, Some(bundled)),
            Some(PathBuf::from(r"C:\Users\a\AppData\Local\SCIP").join("resources"))
        );
        assert_eq!(
            without_verbatim_prefix(Path::new(r"\\?\UNC\srv\share\SCIP")),
            PathBuf::from(r"\\srv\share\SCIP")
        );
        assert_eq!(without_verbatim_prefix(Path::new(r"D:\SCIP")), PathBuf::from(r"D:\SCIP"));
    }
}
