//! Tauri glue: app state, commands, event forwarding and lifecycle. The logic lives in the
//! Tauri-free modules; this file only wires them to the window.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent};

use crate::backup::manifest::{self as backup_manifest, BackupInfo};
use crate::backup::pending::{write_pending, PendingRestore};
use crate::backup::run::{self as backup_run, RestoreResult};
use crate::backup::backups_dir;
use crate::events::{
    ErrorEvent, EventSink, StartupSnapshot, SupervisorEvent, ERROR_EVENT, PROGRESS_EVENT, READY_EVENT,
};
use crate::paths::DataDirs;
use crate::recovery::{self, RecoveredAccount};
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
    /// API base URL and local recovery token, once the services are prepared.
    recovery: Mutex<Option<(String, String)>>,
    /// Ports, password and folders of the running services, for backups.
    context: Mutex<Option<Arc<RuntimeContext>>>,
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

/// "Mot de passe oublié ?" on this computer: gives an administrator a temporary password, shown
/// once on the sign-in screen and changed at the next sign-in (see recovery.rs).
#[tauri::command]
async fn recover_admin_password(
    state: tauri::State<'_, Arc<AppState>>,
    email: Option<String>,
) -> Result<RecoveredAccount, String> {
    let (api, token) = state
        .recovery
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "SCIP est encore en train de démarrer. Réessayez dans un instant.".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || recovery::request(&api, &token, email.as_deref()))
        .await
        .map_err(|_| "La récupération du mot de passe a échoué.".to_owned())?
}

const STARTING: &str = "SCIP est encore en train de démarrer. Réessayez dans un instant.";

fn running_context(state: &AppState) -> Result<Arc<RuntimeContext>, String> {
    state.context.lock().unwrap().clone().ok_or_else(|| STARTING.to_owned())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupsView {
    pub directory: String,
    /// False with an external database: backups are then that server's business.
    pub embedded: bool,
    pub backups: Vec<BackupInfo>,
    pub last_restore: Option<RestoreResult>,
}

/// Settings → Sauvegarde: the backups of the folder, newest first.
#[tauri::command]
async fn list_backups(state: tauri::State<'_, Arc<AppState>>) -> Result<BackupsView, String> {
    let ctx: Arc<RuntimeContext> = running_context(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = backups_dir();
        BackupsView {
            directory: dir.display().to_string(),
            embedded: !ctx.is_external_database(),
            backups: backup_manifest::list_backups(&dir),
            last_restore: backup_run::read_last_result(&ctx.dirs.root),
        }
    })
    .await
    .map_err(|_| "La lecture des sauvegardes a échoué.".to_owned())
}

/// Takes a backup of the running database and the delivery proofs (a few seconds).
#[tauri::command]
async fn create_backup(state: tauri::State<'_, Arc<AppState>>) -> Result<BackupInfo, String> {
    let ctx: Arc<RuntimeContext> = running_context(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        backup_run::create_backup(&ctx, &backups_dir(), false).map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| "La sauvegarde a échoué.".to_owned())?
}

#[tauri::command]
fn open_backups_folder(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = backups_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener().open_path(dir.display().to_string(), None::<&str>).map_err(|e| e.to_string())
}

/// Restores `name` (a backup of the folder): safety backup first, then SCIP restarts its
/// services and the startup plan rebuilds the database from the backup.
#[tauri::command]
async fn schedule_restore(app: AppHandle, state: tauri::State<'_, Arc<AppState>>, name: String) -> Result<(), String> {
    let ctx: Arc<RuntimeContext> = running_context(&state)?;
    let state: Arc<AppState> = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let dir = backups_dir();
        let archive = backup_manifest::resolve(&dir, &name)
            .ok_or_else(|| "Sauvegarde introuvable dans le dossier des sauvegardes.".to_owned())?;
        backup_run::check_restorable(&ctx, &archive).map_err(|e| e.to_string())?;
        let safety: BackupInfo = backup_run::create_backup(&ctx, &dir, true)
            .map_err(|e| format!("La sauvegarde de sécurité a échoué, restauration annulée : {e}"))?;
        write_pending(&ctx.dirs.root, &PendingRestore { archive, safety_backup: Some(dir.join(&safety.name)) })
            .map_err(|e| e.to_string())?;
        restart_services(app, state);
        Ok(())
    })
    .await
    .map_err(|_| "La restauration n'a pas pu être lancée.".to_owned())?
}

/// Stops every service, shows the startup screen again and boots anew in this process (a new
/// process would meet the single-instance lock of this one). The boot finds the scheduled
/// restore; the startup screen then reopens the interface on the new API port.
fn restart_services(app: AppHandle, state: Arc<AppState>) {
    let supervisor: Option<Arc<Supervisor>> = state.supervisor.lock().unwrap().take();
    if let Some(supervisor) = supervisor {
        supervisor.stop_all();
    }
    *state.snapshot.lock().unwrap() = StartupSnapshot::default();
    *state.context.lock().unwrap() = None;
    *state.recovery.lock().unwrap() = None;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval("window.location.replace('/splash/index.html')");
    }
    let spawned = std::thread::Builder::new().name("supervisor".into()).spawn(move || boot(app, state));
    if let Err(e) = spawned {
        log::error!("could not restart the services: {e}");
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
    *state.recovery.lock().unwrap() = Some((ctx.api_base_url(), ctx.secrets.local_recovery_token.clone()));
    let ctx: Arc<RuntimeContext> = Arc::new(ctx);
    *state.context.lock().unwrap() = Some(Arc::clone(&ctx));
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
        .invoke_handler(tauri::generate_handler![
            get_runtime_info,
            get_startup_status,
            recover_admin_password,
            list_backups,
            create_backup,
            open_backups_folder,
            schedule_restore
        ])
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
