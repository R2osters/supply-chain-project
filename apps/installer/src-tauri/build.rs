fn main() {
    // The version shown and registered is the SCIP version being installed, which the packaging
    // script passes in; a plain `cargo build` falls back to this crate's version.
    println!("cargo:rerun-if-env-changed=SCIP_SETUP_VERSION");
    // The DLLs the installer imports are looked up in System32 only, never next to the exe: SCIP
    // runs its updates from `<data>\updates`, which the user's programs can write to. The loader
    // resolves imports before main, so only this PE flag covers them (Windows 10 1607 and later;
    // lib.rs covers DLLs loaded at run time).
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg-bin=scip-installer=/DEPENDENTLOADFLAG:0x800");
    }
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
