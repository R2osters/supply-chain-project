//! Headless mode for automated tests: the same install and uninstall, no window, events printed
//! to stdout as JSON lines (`{"event":"install://step","payload":{...}}`).
//!
//! ```text
//! SCIP-Setup.exe --silent --plan plan.json [--skip-provision]
//! SCIP-Setup.exe --silent --update              (upgrade the existing install, no plan)
//! SCIP-Setup.exe --silent --uninstall [--remove-data]
//! ```
//!
//! TEST ONLY: `--plan` reads the plan, passwords included, from a file, which the real installer
//! never does (docs/installer.md). Use it with `SCIP_SETUP_TEST=1` and throwaway credentials.
//! The exe is a GUI program: redirect or pipe stdout to see the events.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;

use crate::commands::{build_context, journal_for, system_actions, system_uninstall};
use crate::context::Mode;
use crate::events::{EventSink, InstallEvent, Reporter};
use crate::install::Installer;
use crate::plan::InstallPlan;
use crate::uninstall;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Args {
    pub silent: bool,
    pub uninstall: bool,
    pub plan: Option<PathBuf>,
    pub skip_provision: bool,
    pub remove_data: bool,
    /// Started by SCIP's updater: upgrade the existing install without screens to click.
    pub update: bool,
    /// With `--update`: SCIP is closing, do not relaunch it.
    pub no_launch: bool,
}

impl Args {
    pub fn parse(args: impl IntoIterator<Item = String>) -> Self {
        let mut out = Args::default();
        let mut iter = args.into_iter();
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--silent" => out.silent = true,
                "--uninstall" => out.uninstall = true,
                "--plan" => out.plan = iter.next().map(PathBuf::from),
                "--skip-provision" => out.skip_provision = true,
                "--remove-data" => out.remove_data = true,
                "--update" => out.update = true,
                "--no-launch" => out.no_launch = true,
                // Unknown arguments are ignored: Windows or a shortcut may add its own.
                _ => {}
            }
        }
        out
    }
}

struct StdoutSink;

impl EventSink for StdoutSink {
    fn emit(&self, event: InstallEvent) {
        let line = serde_json::json!({ "event": event.name(), "payload": event.payload() });
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }
}

fn fail(code: &str, message: &str) -> i32 {
    StdoutSink.emit(InstallEvent::Error(crate::events::ErrorEvent {
        step: "setup".into(),
        code: code.into(),
        message: message.into(),
        retryable: false,
    }));
    1
}

/// Returns the process exit code: 0 on success.
pub fn run(args: &Args) -> i32 {
    let ctx = match build_context(args.uninstall) {
        // Headless: never relaunch SCIP (the caller, e.g. `scip-desktop.exe --update`, decides).
        Ok(ctx) => ctx.with_update(args.update, true),
        Err(e) => return fail(&e.code, &e.message),
    };
    let journal = Arc::new(journal_for(&ctx));
    journal.append(&format!("silent run · mode {:?} · {}", ctx.mode, ctx.target_dir().display()));
    let reporter = Reporter::new(Arc::new(StdoutSink), journal);
    if ctx.mode == Mode::Uninstall {
        let ok = uninstall::run(&system_uninstall(&ctx), &reporter, ctx.locale, args.remove_data);
        uninstall::spawn_pending_self_delete();
        return if ok { 0 } else { 1 };
    }
    let plan: InstallPlan = match (&args.plan, args.update) {
        // An upgrade keeps the data and settings: the plan carries nothing (plan.rs).
        (None, true) if ctx.mode == Mode::Upgrade => InstallPlan::upgrade(),
        (None, true) => return fail("not_installed", "--update: no SCIP installation to update"),
        (None, false) => {
            return fail("invalid_input", "--silent needs --plan <file.json>, --update or --uninstall")
        }
        (Some(plan_path), _) => match std::fs::read(plan_path)
            .map_err(|e| e.to_string())
            .and_then(|bytes| serde_json::from_slice(&bytes).map_err(|e| e.to_string()))
        {
            Ok(plan) => plan,
            Err(e) => return fail("invalid_plan", &format!("{}: {e}", plan_path.display())),
        },
    };
    let installer = Installer::new(
        Arc::new(system_actions(&ctx, args.skip_provision)),
        reporter,
        ctx.locale,
        ctx.mode == Mode::Upgrade,
    );
    if let Err(e) = installer.start(plan) {
        return fail(&e.code, &e.message);
    }
    if installer.run() {
        0
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> Args {
        Args::parse(line.split_whitespace().map(String::from))
    }

    #[test]
    fn parses_flags() {
        assert_eq!(parse(""), Args::default());
        let a = parse("--silent --plan C:/p.json --skip-provision");
        assert!(a.silent && a.skip_provision && !a.uninstall);
        assert_eq!(a.plan, Some(PathBuf::from("C:/p.json")));
        let u = parse("--uninstall --silent --remove-data --whatever");
        assert!(u.silent && u.uninstall && u.remove_data && u.plan.is_none());
        let up = parse("--update --no-launch");
        assert!(up.update && up.no_launch && !up.silent && up.plan.is_none());
        let headless = parse("--silent --update");
        assert!(headless.silent && headless.update && !headless.no_launch);
    }
}
