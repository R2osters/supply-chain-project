//! Supervisor behaviour with fake processes, fake probes and virtual time.

use super::*;
use crate::events::testing::CollectingSink;
use clock::testing::FakeClock;
use spec::{HealthCheck, ProcessCommand, SkipCondition, TempFile};
use std::collections::{HashMap, HashSet};
use std::io;
use std::path::Path;

// ------------------------------------------------------------------ fakes

#[derive(Default)]
struct ChildState {
    exit: Option<ExitInfo>,
    killed: bool,
}

struct FakeChild(Arc<Mutex<ChildState>>);

impl ChildProcess for FakeChild {
    fn try_wait(&mut self) -> io::Result<Option<ExitInfo>> {
        Ok(self.0.lock().unwrap().exit)
    }

    fn kill(&mut self) -> io::Result<()> {
        let mut state = self.0.lock().unwrap();
        state.killed = true;
        state.exit.get_or_insert(ExitInfo { code: None });
        Ok(())
    }
}

/// Programs listed in `exit_codes` exit immediately with that code; others run forever.
#[derive(Default)]
struct FakeSpawner {
    exit_codes: Mutex<HashMap<String, i32>>,
    fail_spawn: Mutex<HashSet<String>>,
    spawned: Mutex<Vec<(String, Arc<Mutex<ChildState>>)>>,
}

impl FakeSpawner {
    fn exits_with(&self, program: &str, code: i32) {
        self.exit_codes.lock().unwrap().insert(program.into(), code);
    }

    fn spawned_programs(&self) -> Vec<String> {
        self.spawned.lock().unwrap().iter().map(|(p, _)| p.clone()).collect()
    }

    fn last_child(&self, program: &str) -> Arc<Mutex<ChildState>> {
        let spawned = self.spawned.lock().unwrap();
        let (_, state) = spawned.iter().rev().find(|(p, _)| p == program).expect("never spawned");
        Arc::clone(state)
    }
}

impl ProcessSpawner for FakeSpawner {
    fn spawn(&self, command: &ProcessCommand, _log: &Path) -> io::Result<Box<dyn ChildProcess>> {
        let program: String = command.program.display().to_string();
        if self.fail_spawn.lock().unwrap().contains(&program) {
            return Err(io::Error::new(io::ErrorKind::NotFound, "no such file"));
        }
        let exit: Option<ExitInfo> =
            self.exit_codes.lock().unwrap().get(&program).map(|c| ExitInfo { code: Some(*c) });
        let state = Arc::new(Mutex::new(ChildState { exit, killed: false }));
        self.spawned.lock().unwrap().push((program, Arc::clone(&state)));
        Ok(Box::new(FakeChild(state)))
    }
}

/// Healthy when the TCP port is in the set.
#[derive(Default)]
struct FakeProber {
    healthy: Mutex<HashSet<u16>>,
}

impl HealthProber for FakeProber {
    fn probe(&self, check: &HealthCheck) -> bool {
        match check {
            HealthCheck::Tcp { port } => self.healthy.lock().unwrap().contains(port),
            _ => false,
        }
    }
}

struct Harness {
    spawner: Arc<FakeSpawner>,
    prober: Arc<FakeProber>,
    clock: Arc<FakeClock>,
    events: Arc<CollectingSink>,
    supervisor: Supervisor,
}

fn harness() -> Harness {
    let spawner = Arc::new(FakeSpawner::default());
    let prober = Arc::new(FakeProber::default());
    let clock = Arc::new(FakeClock::new());
    let events = Arc::new(CollectingSink::default());
    let supervisor = Supervisor::new(
        spawner.clone(),
        prober.clone(),
        clock.clone(),
        events.clone(),
        PathBuf::from("logs"),
    );
    Harness { spawner, prober, clock, events, supervisor }
}

fn service(name: &str, port: u16) -> ServiceSpec {
    ServiceSpec {
        name: name.into(),
        command: ProcessCommand::new(name),
        health: HealthCheck::Tcp { port },
        start_timeout: Duration::from_secs(10),
        stop: StopMethod::Kill,
        stop_timeout: Duration::from_secs(5),
    }
}

impl Harness {
    fn start_healthy(&self, name: &str, port: u16) {
        self.prober.healthy.lock().unwrap().insert(port);
        self.supervisor.start_service(service(name, port)).unwrap();
    }

    fn crash(&self, name: &str) {
        self.spawner.last_child(name).lock().unwrap().exit = Some(ExitInfo { code: Some(1) });
    }
}

// ------------------------------------------------------------------ startup

#[test]
fn starts_a_healthy_service() {
    let h = harness();
    h.start_healthy("api", 1);
    assert_eq!(h.supervisor.running_services(), vec!["api"]);
}

#[test]
fn times_out_and_kills_an_unhealthy_service() {
    let h = harness();
    let err = h.supervisor.start_service(service("api", 1)).unwrap_err();
    assert!(matches!(err, SupervisorError::Unhealthy { .. }), "{err}");
    assert!(h.spawner.last_child("api").lock().unwrap().killed);
    assert!(h.supervisor.running_services().is_empty());
    let waited: Duration = h.clock.sleeps.lock().unwrap().iter().sum();
    assert!(waited >= Duration::from_secs(10), "gave up after only {waited:?}");
}

#[test]
fn reports_early_exit_instead_of_waiting_for_the_timeout() {
    let h = harness();
    h.spawner.exits_with("api", 1);
    let err = h.supervisor.start_service(service("api", 1)).unwrap_err();
    assert!(matches!(err, SupervisorError::ExitedDuringStartup { .. }), "{err}");
    assert!(h.clock.sleeps.lock().unwrap().is_empty(), "should fail on the first poll");
    assert_eq!(err.log_file(), &PathBuf::from("logs").join("api.log"));
}

#[test]
fn spawn_failure_names_the_program() {
    let h = harness();
    h.spawner.fail_spawn.lock().unwrap().insert("api".into());
    let err = h.supervisor.start_service(service("api", 1)).unwrap_err();
    assert!(matches!(err, SupervisorError::Spawn { .. }));
    assert_eq!(err.code(), ErrorCode::SpawnFailed);
}

// ------------------------------------------------------------------ tasks

#[test]
fn task_success_failure_and_timeout() {
    let h = harness();
    h.spawner.exits_with("ok", 0);
    h.spawner.exits_with("bad", 2);
    let t = |name: &str| TaskSpec::new(name, ProcessCommand::new(name), Duration::from_secs(1));
    assert_eq!(h.supervisor.run_task(&t("ok")).unwrap(), TaskOutcome::Ran);
    let failed = h.supervisor.run_task(&t("bad")).unwrap_err();
    assert!(failed.to_string().contains("exit code 2"), "{failed}");
    let hung = h.supervisor.run_task(&t("hang")).unwrap_err();
    assert!(matches!(hung, SupervisorError::TaskTimeout { .. }));
    assert!(h.spawner.last_child("hang").lock().unwrap().killed);
}

#[test]
fn skipped_task_is_not_spawned() {
    let h = harness();
    let tmp = tempfile::tempdir().unwrap();
    let mut task = TaskSpec::new("initdb", ProcessCommand::new("initdb"), Duration::from_secs(1));
    task.skip_if = Some(SkipCondition::PathExists(tmp.path().to_path_buf()));
    assert_eq!(h.supervisor.run_task(&task).unwrap(), TaskOutcome::Skipped);
    assert!(h.spawner.spawned_programs().is_empty());
}

#[test]
fn temp_files_exist_only_while_the_task_runs() {
    let h = harness();
    h.spawner.exits_with("initdb", 1);
    let tmp = tempfile::tempdir().unwrap();
    let pw: PathBuf = tmp.path().join("pw");
    let mut task = TaskSpec::new("initdb", ProcessCommand::new("initdb"), Duration::from_secs(1));
    task.temp_files.push(TempFile { path: pw.clone(), contents: "secret".into() });
    assert!(h.supervisor.run_task(&task).is_err());
    assert!(!pw.exists(), "secret file must be removed even when the task fails");
}

// ------------------------------------------------------------------ crashes

#[test]
fn crashed_service_is_restarted_after_backoff() {
    let h = harness();
    h.start_healthy("api", 1);
    h.crash("api");
    h.supervisor.check_crashes();
    assert_eq!(h.spawner.spawned_programs(), vec!["api", "api"]);
    assert_eq!(h.supervisor.running_services(), vec!["api"]);
    assert!(h.clock.sleeps.lock().unwrap().contains(&Duration::from_secs(1)));
    assert!(h.events.progress().contains(&("api".into(), StepStatus::Restarting)));
}

#[test]
fn gives_up_after_three_quick_crashes_and_reports_the_log() {
    let h = harness();
    h.start_healthy("api", 1);
    for _ in 0..3 {
        h.crash("api");
        h.supervisor.check_crashes();
    }
    assert!(h.events.errors().is_empty());
    h.crash("api");
    h.supervisor.check_crashes();
    assert!(h.supervisor.running_services().is_empty());
    let errors = h.events.errors();
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].code, ErrorCode::Crashed);
    assert!(errors[0].log_file.as_deref().unwrap().ends_with("api.log"));
}

#[test]
fn long_uptime_resets_the_crash_counter() {
    let h = harness();
    h.start_healthy("api", 1);
    for _ in 0..10 {
        h.clock.advance(restart_policy::STABLE_UPTIME);
        h.crash("api");
        h.supervisor.check_crashes();
    }
    assert!(h.events.errors().is_empty());
    assert_eq!(h.supervisor.running_services(), vec!["api"]);
}

#[test]
fn restart_keeps_the_service_order() {
    let h = harness();
    h.start_healthy("postgres", 1);
    h.start_healthy("ai", 2);
    h.start_healthy("api", 3);
    h.crash("ai");
    h.supervisor.check_crashes();
    assert_eq!(h.supervisor.running_services(), vec!["postgres", "ai", "api"]);
}

#[test]
fn failed_restarts_consume_attempts_then_give_up() {
    let h = harness();
    h.start_healthy("api", 1);
    h.prober.healthy.lock().unwrap().clear();
    h.crash("api");
    h.supervisor.check_crashes();
    assert!(h.supervisor.running_services().is_empty());
    assert_eq!(h.events.errors().len(), 1);
    // 1 initial start + 3 restart attempts.
    assert_eq!(h.spawner.spawned_programs().len(), 4);
}

// ------------------------------------------------------------------ shutdown

#[test]
fn stops_in_reverse_order_using_the_graceful_command() {
    let h = harness();
    h.spawner.exits_with("pg_ctl", 0);
    let mut pg = service("postgres", 1);
    pg.stop = StopMethod::Command(ProcessCommand::new("pg_ctl").args(["stop"]));
    h.prober.healthy.lock().unwrap().extend([1, 2]);
    h.supervisor.start_service(pg).unwrap();
    h.supervisor.start_service(service("api", 2)).unwrap();

    h.supervisor.stop_all();

    // pg_ctl does not really stop the fake postgres, so it is killed after the grace period.
    assert_eq!(h.spawner.spawned_programs(), vec!["postgres", "api", "pg_ctl"]);
    assert!(h.spawner.last_child("api").lock().unwrap().killed);
    assert!(h.spawner.last_child("postgres").lock().unwrap().killed);
    assert!(h.supervisor.running_services().is_empty());
    assert!(h.supervisor.is_shutting_down());
}

#[test]
fn graceful_stop_that_works_does_not_kill() {
    let h = harness();
    let mut pg = service("postgres", 1);
    pg.stop = StopMethod::Command(ProcessCommand::new("pg_ctl"));
    h.prober.healthy.lock().unwrap().insert(1);
    h.supervisor.start_service(pg).unwrap();
    // Simulate pg_ctl doing its job: postgres has exited by the time we wait for it.
    h.spawner.exits_with("pg_ctl", 0);
    h.spawner.last_child("postgres").lock().unwrap().exit = Some(ExitInfo { code: Some(0) });
    h.supervisor.stop_all();
    assert!(!h.spawner.last_child("postgres").lock().unwrap().killed);
}

#[test]
fn no_restart_once_shutting_down() {
    let h = harness();
    h.start_healthy("api", 1);
    h.supervisor.stop_all();
    h.supervisor.check_crashes();
    assert_eq!(h.spawner.spawned_programs(), vec!["api"]);
}
