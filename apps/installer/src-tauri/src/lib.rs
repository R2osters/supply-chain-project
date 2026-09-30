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
    harden_dll_search();
    let args = silent::Args::parse(std::env::args().skip(1));
    if args.silent {
        std::process::exit(silent::run(&args));
    }
    commands::run_app(args.uninstall, args.update, args.no_launch);
}

/// DLLs loaded by name at run time come from System32 only, never from the folder this exe runs
/// from: SCIP starts its updates from `<data>\updates`, which any program of the user can write
/// to, and a DLL dropped there would otherwise run inside the installer. The DLLs the exe imports
/// are resolved before this runs; build.rs covers them at link time (/DEPENDENTLOADFLAG). The
/// installer needs no DLL of its own: WebView2's loader is linked statically.
fn harden_dll_search() {
    #[cfg(windows)]
    {
        use windows::Win32::System::LibraryLoader::{SetDefaultDllDirectories, LOAD_LIBRARY_SEARCH_SYSTEM32};
        // SAFETY: a process-wide setting with a constant flag, made before any other thread starts.
        if let Err(e) = unsafe { SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32) } {
            eprintln!("SCIP Setup: could not restrict the DLL search path: {e}");
        }
    }
}
