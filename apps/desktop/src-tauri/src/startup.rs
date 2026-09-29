//! The boot sequence: prepare the environment, then walk the startup plan while reporting
//! progress. Tauri-free so it can be exercised with the fake supervisor pieces.

use std::path::PathBuf;

use crate::events::{
    ErrorCode, ErrorEvent, EventSink, ProgressEvent, ReadyEvent, StepStatus, SupervisorEvent,
};
use crate::paths::DataDirs;
use crate::ports::ServicePorts;
use crate::secrets;
use crate::services::{ResourceLayout, RuntimeContext, StartupStep};
use crate::supervisor::{Supervisor, SupervisorError, TaskOutcome};

/// Resolves folders, secrets, ports and resources. Any failure becomes a user-facing event.
pub fn prepare(dirs: DataDirs, resources_root: Option<PathBuf>) -> Result<RuntimeContext, ErrorEvent> {
    dirs.ensure_created().map_err(|e| error(ErrorCode::DataDir, e.to_string(), Vec::new()))?;
    let config = secrets::load_or_create(&dirs.config_file)
        .map_err(|e| error(ErrorCode::Config, e.to_string(), Vec::new()))?;
    let ports: ServicePorts = ServicePorts::pick()
        .map_err(|e| error(ErrorCode::Ports, format!("no free local port: {e}"), Vec::new()))?;
    let root: PathBuf = resources_root.ok_or_else(|| {
        error(ErrorCode::MissingResources, "resource folder not found".to_owned(), Vec::new())
    })?;
    let resources = ResourceLayout::new(root);
    check_resources(&resources)?;
    Ok(RuntimeContext { dirs, ports, secrets: config.secrets, resources })
}

fn check_resources(resources: &ResourceLayout) -> Result<(), ErrorEvent> {
    let missing: Vec<PathBuf> = resources.missing_files();
    if missing.is_empty() {
        return Ok(());
    }
    Err(error(
        ErrorCode::MissingResources,
        format!(
            "{} composant(s) embarqué(s) manquant(s) dans {}. En développement, lancez les scripts de staging (voir resources/README.md).",
            missing.len(),
            resources.root.display()
        ),
        missing.iter().map(|p: &PathBuf| p.display().to_string()).collect(),
    ))
}

fn error(code: ErrorCode, message: String, details: Vec<String>) -> ErrorEvent {
    ErrorEvent { code, message, details, log_file: None }
}

/// Human labels for the splash; unknown steps fall back to their id.
pub fn step_label(step: &str) -> &str {
    match step {
        "initdb" => "Création de la base locale",
        "postgres" => "Démarrage de PostgreSQL",
        "create-database" => "Préparation de la base SCIP",
        "postgis" => "Activation de PostGIS",
        "migrate" => "Mise à jour du schéma",
        "ai" => "Démarrage du moteur IA",
        "api" => "Démarrage du serveur SCIP",
        other => other,
    }
}

/// Runs every step in order and stops at the first failure. Services already started stay
/// up; the caller decides whether to `stop_all` (the app does, on exit).
pub fn run_plan(
    supervisor: &Supervisor,
    plan: Vec<StartupStep>,
    events: &dyn EventSink,
) -> Result<(), SupervisorError> {
    let total: usize = plan.len();
    for (i, step) in plan.into_iter().enumerate() {
        let name: String = step.name().to_owned();
        let emit = |status: StepStatus| {
            events.emit(SupervisorEvent::Progress(ProgressEvent {
                step: name.clone(),
                label: step_label(&name).to_owned(),
                status,
                index: i + 1,
                total,
            }))
        };
        emit(StepStatus::Running);
        let status: StepStatus = match step {
            StartupStep::Task(task) => match supervisor.run_task(&task)? {
                TaskOutcome::Ran => StepStatus::Done,
                TaskOutcome::Skipped => StepStatus::Skipped,
            },
            StartupStep::Service(service) => {
                supervisor.start_service(service)?;
                StepStatus::Done
            }
            // The API reports the AI as down on /health/ready and the UI greys out the
            // OPTIMIZE screens; refusing to open the app over it would be worse.
            StartupStep::OptionalService(service) => match supervisor.start_service(service) {
                Ok(()) => StepStatus::Done,
                Err(e) => {
                    log::warn!("optional service {name} did not start: {e}");
                    StepStatus::Degraded
                }
            },
        };
        emit(status);
    }
    Ok(())
}

/// Full boot after `prepare`: plan, then ready or error event.
pub fn boot(supervisor: &Supervisor, ctx: &RuntimeContext, events: &dyn EventSink) -> bool {
    match run_plan(supervisor, ctx.startup_plan(), events) {
        Ok(()) => {
            events.emit(SupervisorEvent::Ready(ReadyEvent { api_base_url: ctx.api_base_url() }));
            true
        }
        Err(e) => {
            log::error!("startup failed: {e}");
            events.emit(SupervisorEvent::Error(e.to_event()));
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::testing::CollectingSink;

    #[test]
    fn prepare_reports_every_missing_resource() {
        let tmp = tempfile::tempdir().unwrap();
        let dirs = DataDirs::from_root(tmp.path().join("SCIP"));
        let err: ErrorEvent = prepare(dirs.clone(), Some(tmp.path().join("res"))).unwrap_err();
        assert_eq!(err.code, ErrorCode::MissingResources);
        assert_eq!(err.details.len(), ResourceLayout::new("x").required_files().len());
        // Folders and secrets are still created, so the next launch is idempotent.
        assert!(dirs.logs.is_dir() && dirs.config_file.is_file());
    }

    #[test]
    fn prepare_without_resource_dir_is_an_error_event() {
        let tmp = tempfile::tempdir().unwrap();
        let err = prepare(DataDirs::from_root(tmp.path()), None).unwrap_err();
        assert_eq!(err.code, ErrorCode::MissingResources);
    }

    #[test]
    fn labels_cover_the_whole_plan() {
        let ctx = RuntimeContext {
            dirs: DataDirs::from_root("/d"),
            ports: ServicePorts { postgres: 1, api: 2, ai: 3 },
            secrets: Default::default(),
            resources: ResourceLayout::new("/r"),
        };
        for step in ctx.startup_plan() {
            assert_ne!(step_label(step.name()), step.name(), "no label for {}", step.name());
        }
    }

    /// Supervisor whose processes exit at once: code 1 if the program name ends in "bad".
    fn exiting_supervisor() -> (Supervisor, std::sync::Arc<CollectingSink>) {
        use crate::supervisor::clock::SystemClock;
        use crate::supervisor::health::HealthProber;
        use crate::supervisor::process::{ChildProcess, ExitInfo, ProcessSpawner};
        use crate::supervisor::spec::{HealthCheck, ProcessCommand};
        use std::sync::Arc;

        struct Exits(i32);
        impl ChildProcess for Exits {
            fn try_wait(&mut self) -> std::io::Result<Option<ExitInfo>> {
                Ok(Some(ExitInfo { code: Some(self.0) }))
            }
            fn kill(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        struct Spawner;
        impl ProcessSpawner for Spawner {
            fn spawn(
                &self,
                c: &ProcessCommand,
                _: &std::path::Path,
            ) -> std::io::Result<Box<dyn ChildProcess>> {
                Ok(Box::new(Exits(if c.program.ends_with("bad") { 1 } else { 0 })))
            }
        }
        struct Never;
        impl HealthProber for Never {
            fn probe(&self, _: &HealthCheck) -> bool {
                false
            }
        }

        let sink = Arc::new(CollectingSink::default());
        let sup = Supervisor::new(
            Arc::new(Spawner),
            Arc::new(Never),
            Arc::new(SystemClock),
            sink.clone(),
            "logs".into(),
        );
        (sup, sink)
    }

    #[test]
    fn run_plan_emits_running_then_done_and_stops_on_failure() {
        use crate::supervisor::spec::{ProcessCommand, TaskSpec};
        use std::time::Duration;

        let (sup, sink) = exiting_supervisor();
        let task =
            |n: &str| StartupStep::Task(TaskSpec::new(n, ProcessCommand::new(n), Duration::from_secs(1)));
        let result = run_plan(&sup, vec![task("ok"), task("bad"), task("never")], sink.as_ref());
        assert!(result.is_err());
        let seen: Vec<(String, StepStatus)> = sink.progress();
        assert_eq!(
            seen,
            vec![
                ("ok".into(), StepStatus::Running),
                ("ok".into(), StepStatus::Done),
                ("bad".into(), StepStatus::Running),
            ]
        );
    }

    #[test]
    fn failed_optional_service_degrades_instead_of_aborting() {
        use crate::supervisor::spec::{HealthCheck, ProcessCommand, ServiceSpec, StopMethod, TaskSpec};
        use std::time::Duration;

        let (sup, sink) = exiting_supervisor();
        let ai = ServiceSpec {
            name: "ai".into(),
            command: ProcessCommand::new("ai-bad"),
            health: HealthCheck::http_local(1, "/health"),
            start_timeout: Duration::from_secs(1),
            stop: StopMethod::Kill,
            stop_timeout: Duration::from_secs(1),
        };
        let after =
            StartupStep::Task(TaskSpec::new("after", ProcessCommand::new("after"), Duration::from_secs(1)));
        let result = run_plan(&sup, vec![StartupStep::OptionalService(ai), after], sink.as_ref());
        assert!(result.is_ok());
        let seen: Vec<(String, StepStatus)> = sink.progress();
        assert!(seen.contains(&("ai".into(), StepStatus::Degraded)));
        assert!(seen.contains(&("after".into(), StepStatus::Done)));
    }
}
