fn main() {
    // Declaring the app commands makes Tauri generate one permission per command, so the
    // capability file can grant them individually instead of exposing every command by default.
    let manifest = tauri_build::AppManifest::new().commands(&["get_runtime_info", "get_startup_status"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to run tauri-build");
}
