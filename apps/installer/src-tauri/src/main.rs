// Hides the extra console window in release builds on Windows. Do not remove.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    scip_installer_lib::run();
}
