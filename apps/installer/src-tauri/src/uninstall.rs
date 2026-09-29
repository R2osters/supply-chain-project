//! `uninstall.exe --uninstall`: the installer binary without its payload, run from "Apps &
//! features". The confirmation screen has already asked the user (SCIP will be closed, keep or
//! delete data); this module only executes.
//!
//! Steps (`install://step` ids): `stop`, `shortcuts`, `register`, `data` (only if removeData),
//! `files`. The program folder goes last and, when the uninstaller runs from inside it, is deleted
//! by a detached `cmd` a few seconds after we exit: a running exe cannot delete itself.

use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::context::{is_inside, Layout, Locale, APP_EXE, UNINSTALL_EXE};
use crate::events::{Reporter, StepStatus};
use crate::install::StepFailure;
use crate::payload::remove_dir_with_retry;
use crate::shortcuts::{self, Location};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UStep {
    Stop,
    Shortcuts,
    Register,
    Data,
    Files,
}

impl UStep {
    pub fn id(self) -> &'static str {
        match self {
            UStep::Stop => "stop",
            UStep::Shortcuts => "shortcuts",
            UStep::Register => "register",
            UStep::Data => "data",
            UStep::Files => "files",
        }
    }

    pub fn label(self, l: Locale) -> &'static str {
        match self {
            UStep::Stop => l.pick("Fermeture de SCIP", "Closing SCIP"),
            UStep::Shortcuts => l.pick("Suppression des raccourcis", "Removing shortcuts"),
            UStep::Register => l.pick("Désinscription de Windows", "Unregistering from Windows"),
            UStep::Data => l.pick("Suppression des données", "Deleting data"),
            UStep::Files => l.pick("Suppression du programme", "Removing the program"),
        }
    }

    pub fn plan(remove_data: bool) -> Vec<UStep> {
        let mut steps = vec![UStep::Stop, UStep::Shortcuts, UStep::Register];
        if remove_data {
            steps.push(UStep::Data);
        }
        steps.push(UStep::Files);
        steps
    }
}

pub trait UninstallActions: Send + Sync {
    fn stop(&self, reporter: &Reporter) -> Result<(), StepFailure>;
    fn remove_shortcuts(&self) -> Result<(), StepFailure>;
    fn unregister(&self) -> Result<(), StepFailure>;
    fn remove_data(&self) -> Result<(), StepFailure>;
    fn remove_program(&self) -> Result<(), StepFailure>;
}

/// Runs every step; `true` on success. Stops at the first failure: e.g. deleting files still in
/// use would leave a half-removed SCIP that neither runs nor uninstalls.
pub fn run(actions: &dyn UninstallActions, reporter: &Reporter, locale: Locale, remove_data: bool) -> bool {
    let steps = UStep::plan(remove_data);
    for step in &steps {
        reporter.step(step.id(), StepStatus::Pending, step.label(locale));
    }
    for (index, step) in steps.iter().enumerate() {
        let label = step.label(locale);
        reporter.step(step.id(), StepStatus::Running, label);
        reporter.progress(index as f64 / steps.len() as f64, label);
        let result = match step {
            UStep::Stop => actions.stop(reporter),
            UStep::Shortcuts => actions.remove_shortcuts(),
            UStep::Register => actions.unregister(),
            UStep::Data => actions.remove_data(),
            UStep::Files => actions.remove_program(),
        };
        if let Err(failure) = result {
            reporter.step(step.id(), StepStatus::Failed, label);
            reporter.error(step.id(), &failure.code, &failure.message, failure.retryable);
            return false;
        }
        reporter.step(step.id(), StepStatus::Done, label);
    }
    reporter.progress(1.0, "");
    reporter.done();
    true
}

/// Guard against deleting the wrong folder (a damaged registry value pointing at `C:\` or the
/// user profile): only a folder that actually holds SCIP, at least two levels deep.
pub fn is_program_dir(dir: &Path) -> bool {
    deep_enough(dir) && (dir.join(APP_EXE).is_file() || dir.join(UNINSTALL_EXE).is_file())
}

/// Same for the data folder: SCIP's own folder name, or one that holds SCIP's `config.json`.
pub fn is_data_dir(dir: &Path, layout: &Layout) -> bool {
    let named = dir.file_name().is_some_and(|n| n.eq_ignore_ascii_case("com.scip.desktop"));
    deep_enough(dir)
        && (named || dir.join("config.json").is_file() || (layout.test_mode && dir == layout.data_dir))
}

fn deep_enough(dir: &Path) -> bool {
    dir.is_absolute() && dir.components().filter(|c| matches!(c, Component::Normal(_))).count() >= 2
}

pub struct SystemUninstall {
    pub program_dir: PathBuf,
    pub layout: Layout,
    pub locale: Locale,
}

fn io_failure(code: &str, path: &Path, e: impl std::fmt::Display) -> StepFailure {
    StepFailure::new(code, format!("{}: {e}", path.display()), true)
}

impl SystemUninstall {
    fn stop_postgres(&self, reporter: &Reporter) {
        let pgdata = self.layout.data_dir.join("pgdata");
        let pg_ctl = self.program_dir.join("resources").join("postgres").join("bin").join("pg_ctl.exe");
        if !pgdata.join("postmaster.pid").exists() || !pg_ctl.is_file() {
            return;
        }
        reporter.log("pg_ctl stop -m fast");
        let mut command = Command::new(&pg_ctl);
        command.arg("stop").arg("-D").arg(&pgdata).args(["-m", "fast", "-w", "-t", "30"]);
        hide_window(&mut command);
        match command.output() {
            Ok(out) => reporter.log(String::from_utf8_lossy(&out.stdout).trim()),
            Err(e) => reporter.log(&format!("pg_ctl: {e}")),
        }
    }
}

fn hide_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

fn kill_from(dir: &Path, reporter: &Reporter) {
    for process in crate::processes::running_in(crate::processes::list(), dir) {
        reporter.log(&format!("stop {} (pid {})", process.exe.display(), process.pid));
        crate::processes::kill(process.pid);
    }
}

impl UninstallActions for SystemUninstall {
    fn stop(&self, reporter: &Reporter) -> Result<(), StepFailure> {
        // SCIP first: its job object takes the sidecars down with it. Then a graceful stop of a
        // Postgres that outlived it, then anything else still running from the folder.
        kill_from(&self.program_dir, reporter);
        self.stop_postgres(reporter);
        kill_from(&self.program_dir, reporter);
        let left = crate::processes::running_in(crate::processes::list(), &self.program_dir);
        match left.first() {
            None => Ok(()),
            Some(p) => Err(io_failure(
                "scip_running",
                &p.exe,
                self.locale.pick("toujours en cours", "still running"),
            )),
        }
    }

    fn remove_shortcuts(&self) -> Result<(), StepFailure> {
        for location in [Location::StartMenuPrograms, Location::Desktop] {
            if let Some(path) = shortcuts::shortcut_path(location, &self.layout.shortcut_name) {
                shortcuts::remove(&path).map_err(|e| io_failure("shortcut", &path, e))?;
            }
        }
        Ok(())
    }

    fn unregister(&self) -> Result<(), StepFailure> {
        crate::registry::delete(&crate::registry::uninstall_subkey(&self.layout.registry_key))
            .map_err(|e| StepFailure::new("registry", e.to_string(), true))
    }

    fn remove_data(&self) -> Result<(), StepFailure> {
        let dir = &self.layout.data_dir;
        if !dir.exists() {
            return Ok(());
        }
        if !is_data_dir(dir, &self.layout) {
            return Err(io_failure("unsafe_path", dir, "not a SCIP data folder, left in place"));
        }
        remove_dir_with_retry(dir, 10, Duration::from_millis(500))
            .map_err(|e| io_failure("files_locked", dir, e))
    }

    fn remove_program(&self) -> Result<(), StepFailure> {
        let dir = &self.program_dir;
        if !dir.exists() {
            return Ok(());
        }
        if !is_program_dir(dir) {
            return Err(io_failure("unsafe_path", dir, "not a SCIP program folder, left in place"));
        }
        let me = std::env::current_exe().unwrap_or_default();
        if !is_inside(&me, dir) {
            return remove_dir_with_retry(dir, 10, Duration::from_millis(500))
                .map_err(|e| io_failure("files_locked", dir, e));
        }
        // Everything but our own exe goes now, so the user sees SCIP gone; the folder and
        // uninstall.exe go once this process exits (the window may stay open a while).
        let entries = std::fs::read_dir(dir).map_err(|e| io_failure("io", dir, e))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if is_inside(&me, &path) {
                continue; // our exe, or the folder holding it: left to the delayed delete
            }
            if path.is_dir() {
                remove_dir_with_retry(&path, 10, Duration::from_millis(500))
                    .map_err(|e| io_failure("files_locked", &path, e))?;
            } else {
                std::fs::remove_file(&path).map_err(|e| io_failure("files_locked", &path, e))?;
            }
        }
        *PENDING_SELF_DELETE.lock().unwrap() = Some(dir.clone());
        Ok(())
    }
}

/// Folder to delete once this process has exited (see [`spawn_pending_self_delete`]).
static PENDING_SELF_DELETE: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

/// Called when the uninstaller exits: hands the removal of its own folder to a detached `cmd`
/// that waits two seconds, by which time the exe is no longer locked.
pub fn spawn_pending_self_delete() {
    if let Some(dir) = PENDING_SELF_DELETE.lock().unwrap().take() {
        if let Err(e) = schedule_removal(&dir) {
            log::warn!("could not schedule removal of {}: {e}", dir.display());
        }
    }
}

/// The command line for the delayed delete; `ping` is the classic portable 2-second sleep.
pub fn removal_command_line(dir: &Path) -> String {
    format!("/c ping 127.0.0.1 -n 3 > nul & rmdir /s /q \"{}\"", dir.display())
}

fn schedule_removal(dir: &Path) -> std::io::Result<()> {
    let mut command = Command::new("cmd.exe");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Raw: Rust's quoting rules are not cmd's, and the path must stay one quoted token.
        command.raw_arg(removal_command_line(dir));
    }
    hide_window(&mut command);
    // Outside the folder, or cmd's own working directory would keep it alive.
    command.current_dir(std::env::temp_dir());
    command.spawn().map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::test_reporter;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Fake {
        calls: Mutex<Vec<&'static str>>,
        fail: Option<&'static str>,
    }

    impl Fake {
        fn call(&self, name: &'static str) -> Result<(), StepFailure> {
            self.calls.lock().unwrap().push(name);
            if self.fail == Some(name) {
                return Err(StepFailure::new("x", "y", true));
            }
            Ok(())
        }
    }

    impl UninstallActions for Fake {
        fn stop(&self, _r: &Reporter) -> Result<(), StepFailure> {
            self.call("stop")
        }
        fn remove_shortcuts(&self) -> Result<(), StepFailure> {
            self.call("shortcuts")
        }
        fn unregister(&self) -> Result<(), StepFailure> {
            self.call("register")
        }
        fn remove_data(&self) -> Result<(), StepFailure> {
            self.call("data")
        }
        fn remove_program(&self) -> Result<(), StepFailure> {
            self.call("files")
        }
    }

    #[test]
    fn keeps_data_unless_asked() {
        let fake = Fake::default();
        let (reporter, sink) = test_reporter();
        assert!(run(&fake, &reporter, Locale::Fr, false));
        assert_eq!(*fake.calls.lock().unwrap(), ["stop", "shortcuts", "register", "files"]);
        assert!(sink.is_done());

        let fake = Fake::default();
        let (reporter, _) = test_reporter();
        assert!(run(&fake, &reporter, Locale::Fr, true));
        assert_eq!(*fake.calls.lock().unwrap(), ["stop", "shortcuts", "register", "data", "files"]);
    }

    #[test]
    fn stops_at_the_first_failure() {
        let fake = Fake { fail: Some("stop"), ..Default::default() };
        let (reporter, sink) = test_reporter();
        assert!(!run(&fake, &reporter, Locale::Fr, true));
        assert_eq!(*fake.calls.lock().unwrap(), ["stop"]);
        assert_eq!(sink.errors()[0].step, "stop");
        assert!(!sink.is_done());
    }

    #[test]
    fn refuses_folders_that_are_not_scip() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("SCIP");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!is_program_dir(&dir), "empty folder");
        std::fs::write(dir.join("scip-desktop.exe"), "").unwrap();
        assert!(is_program_dir(&dir));
        assert!(!is_program_dir(Path::new(r"C:\")));
        assert!(!is_program_dir(Path::new("relative/SCIP")));

        let layout = Layout::resolve(|k| (k == "LOCALAPPDATA").then(|| "C:/x".to_string())).unwrap();
        let data = tmp.path().join("somewhere");
        std::fs::create_dir_all(&data).unwrap();
        assert!(!is_data_dir(&data, &layout));
        std::fs::write(data.join("config.json"), "{}").unwrap();
        assert!(is_data_dir(&data, &layout));
        assert!(is_data_dir(&tmp.path().join("com.scip.desktop"), &layout));
    }

    #[test]
    fn removal_command_quotes_the_folder() {
        let line = removal_command_line(Path::new(r"C:\Users\a b\AppData\Local\Programs\SCIP"));
        assert_eq!(
            line,
            r#"/c ping 127.0.0.1 -n 3 > nul & rmdir /s /q "C:\Users\a b\AppData\Local\Programs\SCIP""#
        );
    }

    #[test]
    fn system_uninstall_removes_a_test_install() {
        let tmp = tempfile::tempdir().unwrap();
        let program = tmp.path().join("SCIP");
        std::fs::create_dir_all(program.join("resources")).unwrap();
        std::fs::write(program.join("uninstall.exe"), "").unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let layout = Layout::resolve(|k| match k {
            "SCIP_SETUP_TEST" => Some("1".into()),
            "SCIP_SETUP_TEST_ROOT" => Some(root.clone()),
            _ => None,
        })
        .unwrap();
        std::fs::create_dir_all(layout.data_dir.join("logs")).unwrap();
        let actions =
            SystemUninstall { program_dir: program.clone(), layout: layout.clone(), locale: Locale::Fr };
        actions.remove_data().unwrap();
        actions.remove_program().unwrap();
        assert!(!program.exists() && !layout.data_dir.exists());
    }
}
