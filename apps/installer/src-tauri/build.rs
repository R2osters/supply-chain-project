fn main() {
    // The version shown and registered is the SCIP version being installed, which the packaging
    // script passes in; a plain `cargo build` falls back to this crate's version.
    println!("cargo:rerun-if-env-changed=SCIP_SETUP_VERSION");
    // One permission per command, so the capability file grants exactly these and nothing else.
    let manifest = tauri_build::AppManifest::new().commands(&[
        "get_context",
        "run_system_checks",
        "test_database",
        "start_install",
        "retry_install",
        "launch_scip",
        "start_uninstall",
        "read_log",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to run tauri-build");
}
