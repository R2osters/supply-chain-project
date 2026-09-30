//! Screen 10: runs the install steps in order (docs/installer.md: `extract`, `shortcuts`,
//! `register`, `provision`, `finish`) and remembers which ones finished, so "Réessayer" resumes
//! at the failed step instead of copying 1 GB again.
//!
//! The steps' real work is behind [`InstallActions`]; [`SystemActions`] does it on this PC.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::context::{Locale, SetupContext, DATA_DIR_ENV};
use crate::events::{CommandError, Reporter, StepStatus};
use crate::payload::{self, PayloadReader};
use crate::plan::InstallPlan;
use crate::provision::{self, LaunchRequest, ProcessLauncher};
use crate::registry::{self, UninstallEntry};
use crate::shortcuts::{self, Location};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Extract,
    Shortcuts,
    Register,
    Provision,
    Finish,
}

impl Step {
    pub const ALL: [Step; 5] =
        [Step::Extract, Step::Shortcuts, Step::Register, Step::Provision, Step::Finish];

    pub fn id(self) -> &'static str {
        match self {
            Step::Extract => "extract",
            Step::Shortcuts => "shortcuts",
            Step::Register => "register",
            Step::Provision => "provision",
            Step::Finish => "finish",
        }
    }

    pub fn label(self, l: Locale, upgrade: bool) -> &'static str {
        match self {
            Step::Extract => l.pick("Copie des fichiers", "Copying files"),
            Step::Shortcuts => l.pick("Raccourcis", "Shortcuts"),
            Step::Register => l.pick("Inscription dans Windows", "Registering with Windows"),
            Step::Provision if upgrade => l.pick("Mise à jour de la base", "Updating the database"),
            Step::Provision => l.pick("Base de données et configuration", "Database and configuration"),
            Step::Finish => l.pick("Finalisation", "Finishing"),
        }
    }

    /// Share of the overall bar: copying and provisioning are the long parts.
    fn span(self) -> (f64, f64) {
        match self {
            Step::Extract => (0.0, 0.6),
            Step::Shortcuts => (0.6, 0.62),
            Step::Register => (0.62, 0.65),
            Step::Provision => (0.65, 0.98),
            Step::Finish => (0.98, 1.0),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct StepFailure {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl StepFailure {
    pub fn new(code: &str, message: impl Into<String>, retryable: bool) -> Self {
        Self { code: code.into(), message: message.into(), retryable }
    }
}

/// `progress(fraction of this step, detail)`.
pub type Progress<'a> = &'a mut dyn FnMut(f64, &str);

pub trait InstallActions: Send + Sync {
    fn extract(&self, progress: Progress) -> Result<(), StepFailure>;
    fn shortcuts(&self, plan: &InstallPlan) -> Result<(), StepFailure>;
    fn register(&self) -> Result<(), StepFailure>;
    fn provision(
        &self,
        plan: &InstallPlan,
        reporter: &Reporter,
        progress: Progress,
    ) -> Result<(), StepFailure>;
    fn finish(&self) -> Result<(), StepFailure>;
}

#[derive(Default)]
struct State {
    plan: Option<InstallPlan>,
    done: Vec<Step>,
    running: bool,
}

pub struct Installer {
    actions: Arc<dyn InstallActions>,
    reporter: Reporter,
    locale: Locale,
    upgrade: bool,
    state: Mutex<State>,
}

fn busy() -> CommandError {
    CommandError::new("busy", "an installation is already running")
}

impl Installer {
    pub fn new(actions: Arc<dyn InstallActions>, reporter: Reporter, locale: Locale, upgrade: bool) -> Self {
        Self { actions, reporter, locale, upgrade, state: Mutex::new(State::default()) }
    }

    /// Accepts a plan and resets progress; the caller then runs [`Installer::run`], usually on a
    /// background thread so the command returns at once and events tell the rest.
    pub fn start(&self, plan: InstallPlan) -> Result<(), CommandError> {
        plan.validate(self.upgrade)?;
        let mut state = self.state.lock().unwrap();
        if state.running {
            return Err(busy());
        }
        *state = State { plan: Some(plan), done: Vec::new(), running: true };
        Ok(())
    }

    /// Prepares a resume at the first unfinished step.
    pub fn retry(&self) -> Result<(), CommandError> {
        let mut state = self.state.lock().unwrap();
        if state.running {
            return Err(busy());
        }
        if state.plan.is_none() {
            return Err(CommandError::new("nothing_to_retry", "start_install was never called"));
        }
        state.running = true;
        Ok(())
    }

    pub fn completed(&self) -> Vec<Step> {
        self.state.lock().unwrap().done.clone()
    }

    /// Runs the remaining steps; `true` when everything is done.
    pub fn run(&self) -> bool {
        let (plan, done) = {
            let state = self.state.lock().unwrap();
            match &state.plan {
                Some(plan) => (plan.clone(), state.done.clone()),
                None => return false,
            }
        };
        let r = &self.reporter;
        // Resend every step's state: after a retry the screen shows finished steps as done.
        for step in Step::ALL {
            let status = if done.contains(&step) { StepStatus::Done } else { StepStatus::Pending };
            r.step(step.id(), status, step.label(self.locale, self.upgrade));
        }
        for step in Step::ALL.into_iter().filter(|s| !done.contains(s)) {
            let label = step.label(self.locale, self.upgrade);
            let (from, to) = step.span();
            r.step(step.id(), StepStatus::Running, label);
            r.progress(from, label);
            let mut progress = |fraction: f64, detail: &str| {
                r.progress(from + (to - from) * fraction.clamp(0.0, 1.0), detail);
            };
            let result = match step {
                Step::Extract => self.actions.extract(&mut progress),
                Step::Shortcuts => self.actions.shortcuts(&plan),
                Step::Register => self.actions.register(),
                Step::Provision => self.actions.provision(&plan, r, &mut progress),
                Step::Finish => self.actions.finish(),
            };
            match result {
                Ok(()) => {
                    self.state.lock().unwrap().done.push(step);
                    r.step(step.id(), StepStatus::Done, label);
                    r.progress(to, label);
                }
                Err(failure) => {
                    r.step(step.id(), StepStatus::Failed, label);
                    r.error(step.id(), &failure.code, &failure.message, failure.retryable);
                    self.state.lock().unwrap().running = false;
                    return false;
                }
            }
        }
        self.state.lock().unwrap().running = false;
        r.done();
        true
    }
}

/// The real steps.
pub struct SystemActions {
    pub ctx: SetupContext,
    /// Headless tests only: stop before `scip-desktop.exe --provision`.
    pub skip_provision: bool,
    pub launcher: Arc<dyn ProcessLauncher>,
}

fn mb(bytes: u64) -> u64 {
    bytes / (1024 * 1024)
}

impl SystemActions {
    fn target(&self) -> PathBuf {
        self.ctx.target_dir()
    }

    fn upgrade(&self) -> bool {
        self.ctx.mode == crate::context::Mode::Upgrade
    }
}

impl InstallActions for SystemActions {
    fn extract(&self, progress: Progress) -> Result<(), StepFailure> {
        let target = self.target();
        // SCIP started this update and is closing: give it time to stop its database cleanly,
        // then stop whatever is left in its folder.
        if self.ctx.auto_update {
            crate::processes::wait_then_stop(&target, std::time::Duration::from_secs(60));
        }
        // The checks screen already said so; this covers SCIP being started since.
        if crate::processes::app_running_in(crate::processes::list(), &target) {
            let message = self.ctx.locale.pick("Fermez SCIP pour continuer", "Close SCIP to continue");
            return Err(StepFailure::new("scip_running", message, true));
        }
        let reader = PayloadReader::open(&self.ctx.payload_source)
            .map_err(|e| StepFailure::new(e.code(), e.to_string(), e.retryable()))?;
        payload::install_payload(&reader, &target, |done, total| {
            let fraction = if total == 0 { 1.0 } else { done as f64 / total as f64 };
            progress(fraction, &format!("{} / {} Mo", mb(done), mb(total)));
        })
        .map(|_| ())
        .map_err(|e| StepFailure::new(e.code(), e.to_string(), e.retryable()))
    }

    fn shortcuts(&self, plan: &InstallPlan) -> Result<(), StepFailure> {
        let shortcut = shortcuts::for_app(&self.ctx.app_exe());
        let mut locations = vec![Location::StartMenuPrograms];
        if plan.desktop_shortcut {
            locations.push(Location::Desktop);
        }
        for location in locations {
            let path =
                shortcuts::shortcut_path(location, &self.ctx.layout.shortcut_name).ok_or_else(|| {
                    StepFailure::new("shortcut", format!("{location:?} folder not found"), true)
                })?;
            shortcuts::create(&path, &shortcut)
                .map_err(|e| StepFailure::new("shortcut", format!("{}: {e}", path.display()), true))?;
        }
        Ok(())
    }

    fn register(&self) -> Result<(), StepFailure> {
        let target = self.target();
        let reader = PayloadReader::open(&self.ctx.payload_source)
            .map_err(|e| StepFailure::new(e.code(), e.to_string(), e.retryable()))?;
        let uninstaller = target.join(crate::context::UNINSTALL_EXE);
        reader
            .copy_stub(&uninstaller)
            .map_err(|e| StepFailure::new("io", format!("{}: {e}", uninstaller.display()), true))?;
        let entry = UninstallEntry {
            version: crate::context::setup_version(),
            install_dir: &target,
            estimated_size_kb: registry::dir_size_kb(&target),
        };
        let subkey = registry::uninstall_subkey(&self.ctx.layout.registry_key);
        // Recreated from scratch: an upgrade from the NSIS installer leaves values we don't own.
        registry::delete(&subkey)
            .and_then(|()| registry::write(&subkey, &entry.values()))
            .map_err(|e| StepFailure::new("registry", e.to_string(), true))
    }

    fn provision(
        &self,
        plan: &InstallPlan,
        reporter: &Reporter,
        progress: Progress,
    ) -> Result<(), StepFailure> {
        if self.skip_provision {
            reporter.log("provisioning skipped (--skip-provision)");
            return Ok(());
        }
        let stdin = serde_json::to_vec(&plan.provision_request(self.upgrade()))
            .map_err(|e| StepFailure::new("invalid_plan", e.to_string(), false))?;
        let request = LaunchRequest {
            exe: self.ctx.app_exe(),
            args: vec!["--provision".into()],
            // Explicit, so SCIP provisions exactly the folder the installer (and its tests) chose.
            env: vec![(DATA_DIR_ENV.into(), self.ctx.layout.data_dir.display().to_string())],
            cwd: self.target(),
            stdin,
        };
        // The number of provisioning steps is SCIP's business: approach the end geometrically.
        let mut started = 0i32;
        provision::run(self.launcher.as_ref(), &request, reporter, |label| {
            started += 1;
            progress(1.0 - 0.8f64.powi(started), label);
        })
        .map_err(|f| StepFailure::new(&f.code, f.message, f.retryable))
    }

    fn finish(&self) -> Result<(), StepFailure> {
        // Leftovers of an earlier interrupted swap; harmless if they stay.
        let target = self.target();
        for suffix in [".old", ".new"] {
            let mut name = target.file_name().map(|n| n.to_os_string()).unwrap_or_default();
            name.push(suffix);
            let _ = std::fs::remove_dir_all(target.with_file_name(name));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::test_reporter;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Counts calls per step and fails a step while its failure budget lasts.
    #[derive(Default)]
    struct FakeActions {
        calls: Mutex<Vec<Step>>,
        failures_left: Mutex<Vec<(Step, u32)>>,
        provision_retryable: bool,
        extract_progress: AtomicU32,
    }

    impl FakeActions {
        fn failing(step: Step, times: u32) -> Self {
            Self {
                failures_left: Mutex::new(vec![(step, times)]),
                provision_retryable: true,
                ..Default::default()
            }
        }
        fn record(&self, step: Step) -> Result<(), StepFailure> {
            self.calls.lock().unwrap().push(step);
            let mut failures = self.failures_left.lock().unwrap();
            if let Some((_, left)) = failures.iter_mut().find(|(s, left)| *s == step && *left > 0) {
                *left -= 1;
                return Err(StepFailure::new("boom", "failed", self.provision_retryable));
            }
            Ok(())
        }
        fn calls(&self) -> Vec<Step> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl InstallActions for FakeActions {
        fn extract(&self, progress: Progress) -> Result<(), StepFailure> {
            progress(0.5, "half");
            self.extract_progress.fetch_add(1, Ordering::SeqCst);
            self.record(Step::Extract)
        }
        fn shortcuts(&self, _plan: &InstallPlan) -> Result<(), StepFailure> {
            self.record(Step::Shortcuts)
        }
        fn register(&self) -> Result<(), StepFailure> {
            self.record(Step::Register)
        }
        fn provision(&self, _plan: &InstallPlan, _r: &Reporter, _p: Progress) -> Result<(), StepFailure> {
            self.record(Step::Provision)
        }
        fn finish(&self) -> Result<(), StepFailure> {
            self.record(Step::Finish)
        }
    }

    fn demo_plan() -> InstallPlan {
        serde_json::from_value(serde_json::json!({
            "kind": "demo", "database": { "mode": "embedded" }, "sources": { "vehicles": "simulation" }
        }))
        .unwrap()
    }

    #[test]
    fn runs_all_steps_in_order() {
        let actions = Arc::new(FakeActions::default());
        let (reporter, sink) = test_reporter();
        let installer = Installer::new(actions.clone(), reporter, Locale::Fr, false);
        installer.start(demo_plan()).unwrap();
        assert!(installer.run());
        assert_eq!(actions.calls(), Step::ALL);
        assert!(sink.is_done());
        let running: Vec<String> =
            sink.steps().into_iter().filter(|(_, s)| *s == StepStatus::Running).map(|(id, _)| id).collect();
        assert_eq!(running, ["extract", "shortcuts", "register", "provision", "finish"]);
    }

    #[test]
    fn retry_resumes_at_the_failed_step() {
        let actions = Arc::new(FakeActions::failing(Step::Provision, 1));
        let (reporter, sink) = test_reporter();
        let installer = Installer::new(actions.clone(), reporter, Locale::Fr, false);
        installer.start(demo_plan()).unwrap();
        assert!(!installer.run());
        assert_eq!(installer.completed(), [Step::Extract, Step::Shortcuts, Step::Register]);
        let errors = sink.errors();
        assert_eq!(
            (errors[0].step.as_str(), errors[0].code.as_str(), errors[0].retryable),
            ("provision", "boom", true)
        );
        assert!(!sink.is_done());

        installer.retry().unwrap();
        assert!(installer.run());
        assert_eq!(
            actions.calls(),
            [Step::Extract, Step::Shortcuts, Step::Register, Step::Provision, Step::Provision, Step::Finish]
        );
        assert_eq!(actions.extract_progress.load(Ordering::SeqCst), 1, "files are not copied twice");
        // The retry re-announced the finished steps as done before resuming.
        let steps = sink.steps();
        let after_failure =
            steps.iter().position(|(id, s)| id == "provision" && *s == StepStatus::Failed).unwrap();
        assert!(steps[after_failure..].contains(&("extract".to_string(), StepStatus::Done)));
        assert!(sink.is_done());
    }

    #[test]
    fn start_resets_and_guards() {
        let actions = Arc::new(FakeActions::default());
        let (reporter, _) = test_reporter();
        let installer = Installer::new(actions, reporter, Locale::En, false);
        assert_eq!(installer.retry().unwrap_err().code, "nothing_to_retry");
        installer.start(demo_plan()).unwrap();
        assert_eq!(installer.start(demo_plan()).unwrap_err().code, "busy");
        assert_eq!(installer.retry().unwrap_err().code, "busy");
        assert!(installer.run());
        let invalid: InstallPlan = serde_json::from_value(serde_json::json!({ "kind": "nope" })).unwrap();
        assert_eq!(installer.start(invalid).unwrap_err().code, "invalid_plan");
    }

    #[test]
    fn upgrade_accepts_a_bare_plan() {
        let actions = Arc::new(FakeActions::default());
        let (reporter, _) = test_reporter();
        let installer = Installer::new(actions, reporter, Locale::Fr, true);
        let bare: InstallPlan =
            serde_json::from_value(serde_json::json!({ "desktopShortcut": false })).unwrap();
        installer.start(bare).unwrap();
        assert!(installer.run());
    }

    #[test]
    fn progress_is_monotonic_across_steps() {
        let actions = Arc::new(FakeActions::default());
        let (reporter, sink) = test_reporter();
        let installer = Installer::new(actions, reporter, Locale::Fr, false);
        installer.start(demo_plan()).unwrap();
        installer.run();
        let fractions: Vec<f64> = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                crate::events::InstallEvent::Progress(p) => Some(p.fraction),
                _ => None,
            })
            .collect();
        assert!(fractions.windows(2).all(|w| w[1] >= w[0]), "{fractions:?}");
        assert_eq!(*fractions.last().unwrap(), 1.0);
        assert!(fractions.contains(&0.3), "extract reported half of its 60%");
    }
}
