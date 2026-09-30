//! Tauri glue: the commands of docs/installer.md ("Contrat écran ↔ moteur"), the window, and the
//! event forwarding. The logic lives in the Tauri-free modules; this file only wires them.

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Manager, RunEvent};

use crate::checks::{self, Check, RealProbe};
use crate::context::{
    payload_source, setup_version, ContextInfo, Existing, Layout, Locale, Mode, SetupContext, DATA_DIR_ENV,
    PAYLOAD_ENV, UNINSTALL_EXE,
};
use crate::db::{self, DbParams, DbReport};
use crate::events::{CommandError, EventSink, InstallEvent, Journal, Reporter};
use crate::install::{Installer, SystemActions};
use crate::payload::PayloadReader;
use crate::plan::InstallPlan;
use crate::provision::StdLauncher;
use crate::registry;
use crate::shortcuts::{self, Location};
use crate::uninstall::{self, SystemUninstall};

/// Decides install / upgrade / uninstall and where, from the environment, the registry and argv.
pub fn build_context(uninstall_flag: bool) -> Result<SetupContext, CommandError> {
    let layout =
        Layout::from_process_env().map_err(|e| CommandError::new("no_local_appdata", e.to_string()))?;
    let mut existing: Option<Existing> =
        registry::read_existing(&registry::uninstall_subkey(&layout.registry_key));
    let me: PathBuf = std::env::current_exe().unwrap_or_default();
    // `uninstall.exe` knows where it is even if the registry entry is gone.
    let running_as_uninstaller = me.file_name().is_some_and(|n| n.eq_ignore_ascii_case(UNINSTALL_EXE));
    if uninstall_flag && running_as_uninstaller {
        if let Some(dir) = me.parent() {
            let version =
                existing.as_ref().map(|e| e.version.clone()).unwrap_or_else(|| setup_version().into());
            existing = Some(Existing { version, dir: dir.display().to_string() });
        }
    }
    let mode = SetupContext::decide_mode(uninstall_flag, existing.as_ref());
    let payload_source: PathBuf =
        payload_source(me, std::env::var(PAYLOAD_ENV).ok(), layout.test_mode, cfg!(debug_assertions));
    let payload_bytes = PayloadReader::open(&payload_source).map(|r| r.footer().len).unwrap_or(0);
    Ok(SetupContext {
        mode,
        layout,
        existing,
        locale: Locale::detect(),
        payload_source,
        payload_bytes,
        auto_update: false,
        launch_after: false,
    })
}

/// Install logs go to the data folder with SCIP's other logs. The uninstaller logs to %TEMP%:
/// it may be about to delete the data folder.
pub fn journal_for(ctx: &SetupContext) -> Journal {
    let file = match ctx.mode {
        Mode::Uninstall => std::env::temp_dir().join("scip-uninstall.log"),
        _ => ctx.layout.log_file(),
    };
    Journal::new(Some(file))
}

pub fn system_actions(ctx: &SetupContext, skip_provision: bool) -> SystemActions {
    SystemActions { ctx: ctx.clone(), skip_provision, launcher: Arc::new(StdLauncher) }
}

pub fn system_uninstall(ctx: &SetupContext) -> SystemUninstall {
    SystemUninstall { program_dir: ctx.target_dir(), layout: ctx.layout.clone(), locale: ctx.locale }
}

struct AppState {
    ctx: SetupContext,
    journal: Arc<Journal>,
    /// Set in `setup`, once the window exists to receive events.
    installer: Mutex<Option<Arc<Installer>>>,
    reporter: Mutex<Option<Reporter>>,
    uninstalling: AtomicBool,
}

impl AppState {
    fn installer(&self) -> Result<Arc<Installer>, CommandError> {
        self.installer
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| CommandError::new("not_ready", "installer not initialised"))
    }
    fn reporter(&self) -> Result<Reporter, CommandError> {
        self.reporter
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| CommandError::new("not_ready", "installer not initialised"))
    }
}

type State<'a> = tauri::State<'a, Arc<AppState>>;

/// Accepts both `invoke(cmd, input)` and `invoke(cmd, { <wrapper>: input })`: the contract gives
/// the input object, and Tauri's usual style wraps it in a named argument.
fn input<T: DeserializeOwned>(request: &Request<'_>, wrappers: &[&str]) -> Result<T, CommandError> {
    let value: Value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        InvokeBody::Raw(bytes) => serde_json::from_slice(bytes).unwrap_or(Value::Null),
    };
    parse_input(value, wrappers)
}

fn parse_input<T: DeserializeOwned>(value: Value, wrappers: &[&str]) -> Result<T, CommandError> {
    for key in wrappers {
        if let Some(inner) = value.get(key).filter(|v| v.is_object()) {
            if let Ok(parsed) = serde_json::from_value(inner.clone()) {
                return Ok(parsed);
            }
        }
    }
    serde_json::from_value(value).map_err(|e| CommandError::new("invalid_input", e.to_string()))
}

#[tauri::command]
fn get_context(state: State<'_>) -> ContextInfo {
    state.ctx.info()
}

#[tauri::command]
async fn run_system_checks(state: State<'_>) -> Result<Vec<Check>, CommandError> {
    let ctx = state.ctx.clone();
    // Process listing and port probes block: keep them off the async workers.
    tauri::async_runtime::spawn_blocking(move || {
        checks::run_system_checks(&RealProbe, &ctx.target_dir(), ctx.locale)
    })
    .await
    .map_err(|e| CommandError::new("internal", e.to_string()))
}

#[tauri::command]
async fn test_database(state: State<'_>, request: Request<'_>) -> Result<DbReport, CommandError> {
    let params: DbParams = input(&request, &["params", "config", "input", "connection"])?;
    db::test_database(&params, db::TIMEOUT, state.ctx.locale).await
}

#[tauri::command]
fn start_install(app: AppHandle, state: State<'_>, request: Request<'_>) -> Result<(), CommandError> {
    if state.ctx.mode == Mode::Uninstall {
        return Err(CommandError::new("wrong_mode", "this is the uninstaller"));
    }
    let plan: InstallPlan = input(&request, &["plan"])?;
    let installer = state.installer()?;
    installer.start(plan)?;
    let ctx = state.ctx.clone();
    std::thread::Builder::new()
        .name("install".into())
        .spawn(move || {
            let done: bool = installer.run();
            // An update started by SCIP ends on its own: SCIP relaunched (or not, when it was
            // closing), then the window closes after a moment on the "done" screen.
            if done && ctx.auto_update {
                if ctx.launch_after {
                    if let Err(e) = start_scip(&ctx) {
                        log::warn!("could not relaunch SCIP after the update: {}", e.message);
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(1500));
                app.exit(0);
            }
        })
        .map_err(|e| CommandError::new("internal", e.to_string()))?;
    Ok(())
}

#[tauri::command]
fn retry_install(state: State<'_>) -> Result<(), CommandError> {
    let installer = state.installer()?;
    installer.retry()?;
    std::thread::Builder::new()
        .name("install".into())
        .spawn(move || {
            installer.run();
        })
        .map_err(|e| CommandError::new("internal", e.to_string()))?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchOptions {
    #[serde(default)]
    create_desktop_shortcut: bool,
}

#[tauri::command]
fn launch_scip(app: AppHandle, state: State<'_>, request: Request<'_>) -> Result<(), CommandError> {
    let options: LaunchOptions = input(&request, &["options", "input"])?;
    let ctx = &state.ctx;
    let exe = ctx.app_exe();
    if !exe.is_file() {
        return Err(CommandError::new("not_installed", format!("{} not found", exe.display())));
    }
    // The box on the last screen is the final word on the Desktop shortcut: create or remove.
    if let Some(path) = shortcuts::shortcut_path(Location::Desktop, &ctx.layout.shortcut_name) {
        let result = if options.create_desktop_shortcut {
            shortcuts::create(&path, &shortcuts::for_app(&exe))
        } else {
            shortcuts::remove(&path)
        };
        result.map_err(|e| CommandError::new("shortcut", e.to_string()))?;
    }
    start_scip(ctx)?;
    // Let the command's reply reach the page before the window closes.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        app.exit(0);
    });
    Ok(())
}

/// Starts the installed SCIP, detached: it must outlive the installer, which exits right after.
fn start_scip(ctx: &SetupContext) -> Result<(), CommandError> {
    let exe = ctx.app_exe();
    let mut command = Command::new(&exe);
    command.current_dir(ctx.target_dir());
    if ctx.layout.test_mode {
        command.env(DATA_DIR_ENV, &ctx.layout.data_dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    command.spawn().map(|_| ()).map_err(|e| CommandError::new("launch_failed", e.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UninstallOptions {
    #[serde(default)]
    remove_data: bool,
}

#[tauri::command]
fn start_uninstall(state: State<'_>, request: Request<'_>) -> Result<(), CommandError> {
    if state.ctx.mode != Mode::Uninstall {
        return Err(CommandError::new("wrong_mode", "start the installer with --uninstall"));
    }
    let options: UninstallOptions = input(&request, &["options", "input"])?;
    if state.uninstalling.swap(true, Ordering::SeqCst) {
        return Err(CommandError::new("busy", "uninstall already running"));
    }
    let reporter = state.reporter()?;
    let actions = system_uninstall(&state.ctx);
    let (locale, app_state) = (state.ctx.locale, Arc::clone(state.inner()));
    std::thread::Builder::new()
        .name("uninstall".into())
        .spawn(move || {
            uninstall::run(&actions, &reporter, locale, options.remove_data);
            app_state.uninstalling.store(false, Ordering::SeqCst);
        })
        .map_err(|e| CommandError::new("internal", e.to_string()))?;
    Ok(())
}

#[tauri::command]
fn read_log(state: State<'_>) -> String {
    state.journal.text()
}

struct TauriSink(AppHandle);

impl EventSink for TauriSink {
    fn emit(&self, event: InstallEvent) {
        if let Err(e) = self.0.emit(event.name(), event.payload()) {
            log::warn!("could not emit {}: {e}", event.name());
        }
    }
}

pub fn run_app(uninstall_flag: bool, update: bool, no_launch: bool) {
    let ctx = match build_context(uninstall_flag) {
        Ok(ctx) => ctx.with_update(update, no_launch),
        Err(e) => {
            eprintln!("SCIP Setup: {}", e.message);
            std::process::exit(2);
        }
    };
    let journal = Arc::new(journal_for(&ctx));
    journal.append(&format!(
        "SCIP Setup {} · mode {:?} · {}",
        setup_version(),
        ctx.mode,
        ctx.target_dir().display()
    ));
    let state = Arc::new(AppState {
        ctx,
        journal,
        installer: Mutex::new(None),
        reporter: Mutex::new(None),
        uninstalling: AtomicBool::new(false),
    });
    let setup_state = Arc::clone(&state);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::clone(&state))
        .invoke_handler(tauri::generate_handler![
            get_context,
            run_system_checks,
            test_database,
            start_install,
            retry_install,
            launch_scip,
            start_uninstall,
            read_log
        ])
        .setup(move |app| {
            let reporter =
                Reporter::new(Arc::new(TauriSink(app.handle().clone())), Arc::clone(&setup_state.journal));
            let ctx = &setup_state.ctx;
            let installer = Installer::new(
                Arc::new(system_actions(ctx, false)),
                reporter.clone(),
                ctx.locale,
                ctx.mode == Mode::Upgrade,
            );
            *setup_state.installer.lock().unwrap() = Some(Arc::new(installer));
            *setup_state.reporter.lock().unwrap() = Some(reporter);
            if ctx.mode == Mode::Uninstall {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title(ctx.locale.pick("Désinstallation de SCIP", "Uninstall SCIP"));
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the SCIP Setup window");
    app.run(|_app, event| {
        if let RunEvent::Exit = event {
            uninstall::spawn_pending_self_delete();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_accepts_bare_and_wrapped_objects() {
        let bare = serde_json::json!({ "kind": "demo", "desktopShortcut": true });
        let plan: InstallPlan = parse_input(bare.clone(), &["plan"]).unwrap();
        assert!(plan.desktop_shortcut && plan.rest.get("plan").is_none());
        let plan: InstallPlan = parse_input(serde_json::json!({ "plan": bare }), &["plan"]).unwrap();
        assert!(plan.desktop_shortcut && plan.kind() == Some("demo"));

        let o: LaunchOptions =
            parse_input(serde_json::json!({ "createDesktopShortcut": true }), &["options"]).unwrap();
        assert!(o.create_desktop_shortcut);
        let o: UninstallOptions = parse_input(serde_json::json!({}), &["options"]).unwrap();
        assert!(!o.remove_data);
        let e = parse_input::<DbParams>(serde_json::json!({ "host": 1 }), &["params"]);
        assert_eq!(e.unwrap_err().code, "invalid_input");
    }
}
