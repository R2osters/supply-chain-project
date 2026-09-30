// Hides the extra console window in release builds on Windows. Do not remove.
// `--provision` still writes to stdout: the installer starts it with redirected pipes.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Headless mode for the installer (docs/installer.md). Checked before Tauri starts, so it
    // never registers the single-instance lock: that would hand the plan to a running SCIP.
    if std::env::args().skip(1).any(|arg| arg == "--provision") {
        std::process::exit(scip_desktop_lib::provision::run_cli());
    }
    // Backup / restore / update without a window (DEPLOYMENT.md), same reasons as `--provision`.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(command) = scip_desktop_lib::update::cli::parse(&args) {
        std::process::exit(scip_desktop_lib::update::cli::run_cli(command));
    }
    if let Some(command) = scip_desktop_lib::backup::cli::parse(&args) {
        std::process::exit(match command {
            Ok(command) => scip_desktop_lib::backup::cli::run_cli(command),
            Err(message) => {
                println!("{}", serde_json::json!({ "error": message }));
                2
            }
        });
    }
    scip_desktop_lib::run();
}
