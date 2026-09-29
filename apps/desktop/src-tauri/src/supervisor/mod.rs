//! Generic sidecar supervisor: starts processes in order, waits for them to be healthy,
//! restarts them on crash and stops them in reverse order. Knows nothing about SCIP itself;
//! the concrete services live in `services.rs`.

pub mod clock;
pub mod health;
pub mod process;
pub mod restart_policy;
pub mod spec;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::events::{ErrorCode, ErrorEvent, EventSink, ProgressEvent, StepStatus, SupervisorEvent};
use clock::Clock;
use health::HealthProber;
use process::{ChildProcess, ExitInfo, ProcessSpawner};
use restart_policy::{restart_decision, RestartDecision};
use spec::{ServiceSpec, StopMethod, TaskSpec};

const HEALTH_POLL: Duration = Duration::from_millis(250);
const EXIT_POLL: Duration = Duration::from_millis(100);
pub const MONITOR_POLL: Duration = Duration::from_millis(500);

#[derive(Debug, thiserror::Error)]
pub enum SupervisorError {
    #[error("could not start {name}: {message}")]
    Spawn { name: String, message: String, log_file: PathBuf },
    #[error("{name} exited during startup ({exit})")]
    ExitedDuringStartup { name: String, exit: String, log_file: PathBuf },
    #[error("{name} did not become healthy within {timeout:?}")]
    Unhealthy { name: String, timeout: Duration, log_file: PathBuf },
    #[error("step {name} failed ({exit})")]
    TaskFailed { name: String, exit: String, log_file: PathBuf },
    #[error("step {name} did not finish within {timeout:?}")]
    TaskTimeout { name: String, timeout: Duration, log_file: PathBuf },
    #[error("cannot write a temporary file for {name}: {message}")]
    TempFile { name: String, message: String, log_file: PathBuf },
}

impl SupervisorError {
    pub fn log_file(&self) -> &PathBuf {
        match self {
            Self::Spawn { log_file, .. }
            | Self::ExitedDuringStartup { log_file, .. }
            | Self::Unhealthy { log_file, .. }
            | Self::TaskFailed { log_file, .. }
            | Self::TaskTimeout { log_file, .. }
            | Self::TempFile { log_file, .. } => log_file,
        }
    }

    pub fn code(&self) -> ErrorCode {
        match self {
            Self::Spawn { .. } | Self::TempFile { .. } => ErrorCode::SpawnFailed,
            Self::ExitedDuringStartup { .. } | Self::Unhealthy { .. } => ErrorCode::Unhealthy,
            Self::TaskFailed { .. } | Self::TaskTimeout { .. } => ErrorCode::TaskFailed,
        }
    }

    pub fn to_event(&self) -> ErrorEvent {
        ErrorEvent {
            code: self.code(),
            message: self.to_string(),
            details: Vec::new(),
            log_file: Some(self.log_file().display().to_string()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskOutcome {
    Ran,
    Skipped,
}

struct RunningService {
    spec: ServiceSpec,
    child: Box<dyn ChildProcess>,
    started_at: Instant,
    restarts: u32,
}

pub struct Supervisor {
    spawner: Arc<dyn ProcessSpawner>,
    prober: Arc<dyn HealthProber>,
    clock: Arc<dyn Clock>,
    events: Arc<dyn EventSink>,
    logs_dir: PathBuf,
    running: Mutex<Vec<RunningService>>,
    shutting_down: AtomicBool,
}

impl Supervisor {
    pub fn new(
        spawner: Arc<dyn ProcessSpawner>,
        prober: Arc<dyn HealthProber>,
        clock: Arc<dyn Clock>,
        events: Arc<dyn EventSink>,
        logs_dir: PathBuf,
    ) -> Self {
        Self {
            spawner,
            prober,
            clock,
            events,
            logs_dir,
            running: Mutex::new(Vec::new()),
            shutting_down: AtomicBool::new(false),
        }
    }

    pub fn log_file(&self, name: &str) -> PathBuf {
        self.logs_dir.join(format!("{name}.log"))
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

    pub fn running_services(&self) -> Vec<String> {
        self.running.lock().unwrap().iter().map(|s: &RunningService| s.spec.name.clone()).collect()
    }

    // ---------------------------------------------------------------- one-shot tasks

    pub fn run_task(&self, task: &TaskSpec) -> Result<TaskOutcome, SupervisorError> {
        if task.should_skip() {
            return Ok(TaskOutcome::Skipped);
        }
        let log_file: PathBuf = self.log_file(&task.name);
        self.write_temp_files(task, &log_file)?;
        let result: Result<TaskOutcome, SupervisorError> = self.run_task_process(task, &log_file);
        // Always removed, success or not: these files hold secrets.
        for temp in &task.temp_files {
            let _ = std::fs::remove_file(&temp.path);
        }
        result
    }

    fn write_temp_files(&self, task: &TaskSpec, log_file: &Path) -> Result<(), SupervisorError> {
        for temp in &task.temp_files {
            std::fs::write(&temp.path, &temp.contents).map_err(|e| SupervisorError::TempFile {
                name: task.name.clone(),
                message: e.to_string(),
                log_file: log_file.to_path_buf(),
            })?;
        }
        Ok(())
    }

    fn run_task_process(&self, task: &TaskSpec, log_file: &Path) -> Result<TaskOutcome, SupervisorError> {
        let mut child: Box<dyn ChildProcess> =
            self.spawner.spawn(&task.command, log_file).map_err(|e| SupervisorError::Spawn {
                name: task.name.clone(),
                message: format!("{} ({})", e, task.command.program.display()),
                log_file: log_file.to_path_buf(),
            })?;
        match self.wait_exit(child.as_mut(), task.timeout) {
            Some(exit) if exit.success() => Ok(TaskOutcome::Ran),
            Some(exit) => Err(SupervisorError::TaskFailed {
                name: task.name.clone(),
                exit: exit.describe(),
                log_file: log_file.to_path_buf(),
            }),
            None => {
                let _ = child.kill();
                Err(SupervisorError::TaskTimeout {
                    name: task.name.clone(),
                    timeout: task.timeout,
                    log_file: log_file.to_path_buf(),
                })
            }
        }
    }

    /// `None` on timeout. A `try_wait` error is treated as an abnormal exit.
    fn wait_exit(&self, child: &mut dyn ChildProcess, timeout: Duration) -> Option<ExitInfo> {
        let deadline: Instant = self.clock.now() + timeout;
        loop {
            match child.try_wait() {
                Ok(Some(exit)) => return Some(exit),
                Err(_) => return Some(ExitInfo { code: None }),
                Ok(None) if self.clock.now() >= deadline => return None,
                Ok(None) => self.clock.sleep(EXIT_POLL),
            }
        }
    }

    // ---------------------------------------------------------------- services

    /// Starts one service and returns once it is healthy. On failure the process is killed.
    pub fn start_service(&self, spec: ServiceSpec) -> Result<(), SupervisorError> {
        let child: Box<dyn ChildProcess> = self.spawn_healthy(&spec)?;
        let started_at: Instant = self.clock.now();
        self.running.lock().unwrap().push(RunningService { spec, child, started_at, restarts: 0 });
        Ok(())
    }

    fn spawn_healthy(&self, spec: &ServiceSpec) -> Result<Box<dyn ChildProcess>, SupervisorError> {
        let log_file: PathBuf = self.log_file(&spec.name);
        let mut child: Box<dyn ChildProcess> =
            self.spawner.spawn(&spec.command, &log_file).map_err(|e| SupervisorError::Spawn {
                name: spec.name.clone(),
                message: format!("{} ({})", e, spec.command.program.display()),
                log_file: log_file.to_path_buf(),
            })?;
        match self.wait_healthy(spec, child.as_mut(), &log_file) {
            Ok(()) => Ok(child),
            Err(error) => {
                let _ = child.kill();
                Err(error)
            }
        }
    }

    fn wait_healthy(
        &self,
        spec: &ServiceSpec,
        child: &mut dyn ChildProcess,
        log_file: &Path,
    ) -> Result<(), SupervisorError> {
        let deadline: Instant = self.clock.now() + spec.start_timeout;
        loop {
            // Checked first: a process that died will never become healthy, and saying
            // "exited with code 1" is far more useful than a timeout a minute later.
            if let Ok(Some(exit)) = child.try_wait() {
                return Err(SupervisorError::ExitedDuringStartup {
                    name: spec.name.clone(),
                    exit: exit.describe(),
                    log_file: log_file.to_path_buf(),
                });
            }
            if self.prober.probe(&spec.health) {
                return Ok(());
            }
            if self.clock.now() >= deadline {
                return Err(SupervisorError::Unhealthy {
                    name: spec.name.clone(),
                    timeout: spec.start_timeout,
                    log_file: log_file.to_path_buf(),
                });
            }
            self.clock.sleep(HEALTH_POLL);
        }
    }

    // ---------------------------------------------------------------- crash handling

    /// Runs until `stop_all`. Meant for a dedicated thread.
    pub fn monitor(&self) {
        while !self.is_shutting_down() {
            self.check_crashes();
            self.clock.sleep(MONITOR_POLL);
        }
    }

    /// One monitoring pass: finds services that exited and applies the restart policy.
    pub fn check_crashes(&self) {
        while let Some((index, crashed, exit)) = self.take_first_crashed() {
            if self.is_shutting_down() {
                return;
            }
            self.handle_crash(index, crashed, exit);
        }
    }

    /// Removes the crashed entry from the list so the lock is not held during backoff,
    /// which would block `stop_all` for seconds.
    fn take_first_crashed(&self) -> Option<(usize, RunningService, ExitInfo)> {
        let mut running = self.running.lock().unwrap();
        let found: Option<(usize, ExitInfo)> =
            running.iter_mut().enumerate().find_map(|(i, s)| match s.child.try_wait() {
                Ok(Some(exit)) => Some((i, exit)),
                Err(_) => Some((i, ExitInfo { code: None })),
                Ok(None) => None,
            });
        found.map(|(index, exit)| (index, running.remove(index), exit))
    }

    fn handle_crash(&self, index: usize, crashed: RunningService, exit: ExitInfo) {
        let uptime: Duration = self.clock.now().saturating_duration_since(crashed.started_at);
        let name: String = crashed.spec.name.clone();
        log::warn!("{name} exited after {uptime:?} ({})", exit.describe());
        match restart_decision(crashed.restarts, uptime) {
            RestartDecision::GiveUp => self.emit_crash_error(&name, &exit, crashed.restarts),
            RestartDecision::Restart { after, attempt } => {
                self.emit_restarting(&name, attempt);
                self.clock.sleep(after);
                self.restart(index, crashed.spec, attempt);
            }
        }
    }

    fn restart(&self, index: usize, spec: ServiceSpec, attempt: u32) {
        if self.is_shutting_down() {
            return;
        }
        match self.spawn_healthy(&spec) {
            Ok(mut child) => {
                // Shutdown may have begun while we were waiting on health.
                if self.is_shutting_down() {
                    let _ = child.kill();
                    return;
                }
                self.emit_progress(&spec.name, StepStatus::Done);
                let started_at: Instant = self.clock.now();
                let mut running = self.running.lock().unwrap();
                let at: usize = index.min(running.len());
                running.insert(at, RunningService { spec, child, started_at, restarts: attempt });
            }
            Err(error) => {
                // Counts as another crash with zero uptime, so the policy decides again.
                log::error!("restart of {} failed: {error}", spec.name);
                let placeholder = RunningService {
                    spec,
                    child: Box::new(ExitedChild),
                    started_at: self.clock.now(),
                    restarts: attempt,
                };
                self.handle_crash(index, placeholder, ExitInfo { code: None });
            }
        }
    }

    fn emit_progress(&self, name: &str, status: StepStatus) {
        self.events.emit(SupervisorEvent::Progress(ProgressEvent {
            step: name.to_owned(),
            label: name.to_owned(),
            status,
            index: 0,
            total: 0,
        }));
    }

    fn emit_restarting(&self, name: &str, attempt: u32) {
        self.events.emit(SupervisorEvent::Progress(ProgressEvent {
            step: name.to_owned(),
            label: format!("{name} (relance {attempt}/{})", restart_policy::MAX_RESTARTS),
            status: StepStatus::Restarting,
            index: 0,
            total: 0,
        }));
    }

    fn emit_crash_error(&self, name: &str, exit: &ExitInfo, restarts: u32) {
        self.events.emit(SupervisorEvent::Error(ErrorEvent {
            code: ErrorCode::Crashed,
            message: format!("{name} s'est arrêté et n'a pas pu être relancé"),
            details: vec![exit.describe(), format!("{restarts} relance(s) tentée(s)")],
            log_file: Some(self.log_file(name).display().to_string()),
        }));
    }

    // ---------------------------------------------------------------- shutdown

    /// Stops every service, last started first. Idempotent.
    pub fn stop_all(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        let services: Vec<RunningService> = std::mem::take(&mut *self.running.lock().unwrap());
        for service in services.into_iter().rev() {
            self.stop_service(service);
        }
    }

    fn stop_service(&self, mut service: RunningService) {
        let name: String = service.spec.name.clone();
        if let StopMethod::Command(command) = &service.spec.stop {
            match self.spawner.spawn(command, &self.log_file(&name)) {
                Ok(mut stopper) => {
                    let _ = self.wait_exit(stopper.as_mut(), service.spec.stop_timeout);
                }
                Err(e) => log::warn!("graceful stop of {name} failed to start: {e}"),
            }
            if self.wait_exit(service.child.as_mut(), service.spec.stop_timeout).is_some() {
                return;
            }
            log::warn!("{name} did not stop within {:?}; killing it", service.spec.stop_timeout);
        }
        if let Err(e) = service.child.kill() {
            log::warn!("could not kill {name}: {e}");
        }
    }
}

/// Stand-in for a process that never came up, so a failed restart flows through the same
/// crash path as a real exit.
struct ExitedChild;

impl ChildProcess for ExitedChild {
    fn try_wait(&mut self) -> std::io::Result<Option<ExitInfo>> {
        Ok(Some(ExitInfo { code: None }))
    }

    fn kill(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests;
