//! Tauri glue: app state, commands, event forwarding and lifecycle. The logic lives in the
//! Tauri-free modules; this file only wires them to the window.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent};

use crate::events::{
    ErrorEvent, EventSink, StartupSnapshot, SupervisorEvent, ERROR_EVENT, PROGRESS_EVENT, READY_EVENT,
};
use crate::paths::DataDirs;
use crate::services::{resolve_resources_root, RuntimeContext, RESOURCES_DIR_ENV};
use crate::startup;
use crate::supervisor::clock::SystemClock;
use crate::supervisor::health::NetProber;
use crate::supervisor::process::StdSpawner;
use crate::supervisor::Supervisor;

#[derive(Default)]
struct AppState {
    snapshot: Mutex<StartupSnapshot>,
    data_dir: Mutex<Option<PathBuf>>,
    supervisor: Mutex<Option<Arc<Supervisor>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    /// `None` until every service is healthy.
    pub api_base_url: Option<String>,
    pub version: String,
    pub data_dir: Option<String>,
}

#[tauri::command]
fn get_runtime_info(app: AppHandle, state: tauri::State<'_, Arc<AppState>>) -> RuntimeInfo {
    RuntimeInfo {
        api_base_url: state.snapshot.lock().unwrap().ready.as_ref().map(|r| r.api_base_url.clone()),
        version: app.package_info().version.to_string(),
        data_dir: state.data_dir.lock().unwrap().as_ref().map(|p| p.display().to_string()),
    }
}

/// Lets a page that loaded after some events were emitted catch up.
#[tauri::command]
fn get_startup_status(state: tauri::State<'_, Arc<AppState>>) -> StartupSnapshot {
    state.snapshot.lock().unwrap().clone()
}

/// Records into the snapshot first, then emits, so a page calling `get_startup_status`
/// right after subscribing never misses an event.
struct TauriSink {
    app: AppHandle,
    state: Arc<AppState>,
}

impl EventSink for TauriSink {
    fn emit(&self, event: SupervisorEvent) {
        self.state.snapshot.lock().unwrap().apply(&event);
        let result = match &event {
            SupervisorEvent::Progress(p) => self.app.emit(PROGRESS_EVENT, p),
            SupervisorEvent::Error(e) => self.app.emit(ERROR_EVENT, e),
            SupervisorEvent::Ready(r) => self.app.emit(READY_EVENT, r),
        };
        if let Err(e) = result {
            log::warn!("could not emit supervisor event: {e}");
        }
    }
}

fn boot(app: AppHandle, state: Arc<AppState>) {
    let sink: Arc<TauriSink> = Arc::new(TauriSink { app: app.clone(), state: Arc::clone(&state) });
    let ctx: RuntimeContext = match prepare(&app, &state) {
        Ok(ctx) => ctx,
        Err(error) => {
            log::error!("startup aborted: {}", error.message);
            sink.emit(SupervisorEvent::Error(error));
            return;
        }
    };
    let supervisor: Arc<Supervisor> = Arc::new(Supervisor::new(
        Arc::new(StdSpawner),
        Arc::new(NetProber),
        Arc::new(SystemClock),
        sink.clone(),
        ctx.dirs.logs.clone(),
    ));
    *state.supervisor.lock().unwrap() = Some(Arc::clone(&supervisor));
    if startup::boot(&supervisor, &ctx, sink.as_ref()) {
        supervisor.monitor();
    }
}

fn prepare(app: &AppHandle, state: &AppState) -> Result<RuntimeContext, ErrorEvent> {
    let dirs: DataDirs = DataDirs::from_process_env().map_err(|e| ErrorEvent {
        code: crate::events::ErrorCode::DataDir,
        message: e.to_string(),
        details: Vec::new(),
        log_file: None,
    })?;
    *state.data_dir.lock().unwrap() = Some(dirs.root.clone());
    let bundled: Option<PathBuf> = app.path().resource_dir().ok();
    let resources = resolve_resources_root(std::env::var(RESOURCES_DIR_ENV).ok(), bundled.as_deref());
    startup::prepare(dirs, resources)
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// The window background (tauri.conf.json) is the light `--bg`; in dark mode it would flash
/// light grey before the page paints, so switch it to the dark `--bg` (#121314) up front.
fn match_system_theme(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    if matches!(window.theme(), Ok(tauri::Theme::Dark)) {
        let _ = window.set_background_color(Some(tauri::window::Color(0x12, 0x13, 0x14, 0xff)));
    }
}

fn log_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_log::{Target, TargetKind};
    let mut builder = tauri_plugin_log::Builder::new()
        .clear_targets()
        .level(log::LevelFilter::Info)
        .target(Target::new(TargetKind::Stdout));
    // Same folder as the sidecar logs: a support request is then "send me the logs folder".
    if let Ok(dirs) = DataDirs::from_process_env() {
        builder = builder
            .target(Target::new(TargetKind::Folder { path: dirs.logs, file_name: Some("desktop".into()) }));
    }
    builder.build()
}

pub fn run() {
    let state: Arc<AppState> = Arc::new(AppState::default());
    let app = tauri::Builder::default()
        // Must be registered first: a second launch has to exit before touching anything,
        // otherwise it would start a second Postgres on the same data folder.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| focus_main_window(app)))
        .plugin(log_plugin())
        // External links (aisstream.io, opensky-network.org...) open in the user's browser; the
        // webview itself never navigates away from the app.
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::clone(&state))
        .invoke_handler(tauri::generate_handler![get_runtime_info, get_startup_status])
        .setup(move |app| {
            match_system_theme(app.handle());
            let handle: AppHandle = app.handle().clone();
            let boot_state: Arc<AppState> = Arc::clone(&state);
            // Off the main thread: health checks block for up to minutes on first run.
            std::thread::Builder::new().name("supervisor".into()).spawn(move || boot(handle, boot_state))?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the SCIP window");

    app.run(|app: &AppHandle, event: RunEvent| {
        if let RunEvent::Exit = event {
            let state = app.state::<Arc<AppState>>();
            let supervisor: Option<Arc<Supervisor>> = state.supervisor.lock().unwrap().clone();
            if let Some(supervisor) = supervisor {
                supervisor.stop_all();
            }
        }
    });
}
