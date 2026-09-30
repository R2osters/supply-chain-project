//! SCIP Setup: the custom installer and uninstaller of SCIP (docs/installer.md).
//!
//! One binary, three uses: the installer with its payload appended (`SCIP-Setup-<v>.exe`), the
//! same binary without payload as `uninstall.exe --uninstall`, and `--silent` for tests.

pub mod checks;
mod commands;
pub mod context;
pub mod db;
pub mod events;
pub mod install;
pub mod payload;
pub mod plan;
pub mod processes;
pub mod provision;
pub mod registry;
pub mod shortcuts;
pub mod silent;
pub mod uninstall;

pub fn run() {
    let args = silent::Args::parse(std::env::args().skip(1));
    if args.silent {
        std::process::exit(silent::run(&args));
    }
    commands::run_app(args.uninstall, args.update, args.no_launch);
}
