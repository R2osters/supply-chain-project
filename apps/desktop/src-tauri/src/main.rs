// Hides the extra console window in release builds on Windows. Do not remove.
// `--provision` still writes to stdout: the installer starts it with redirected pipes.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Headless mode for the installer (docs/installer.md). Checked before Tauri starts, so it
    // never registers the single-instance lock: that would hand the plan to a running SCIP.
    if std::env::args().skip(1).any(|arg| arg == "--provision") {
        std::process::exit(scip_desktop_lib::provision::run_cli());
    }
    scip_desktop_lib::run();
}
