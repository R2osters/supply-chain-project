//! `scip-desktop.exe --backup [--out DIR]` and `scip-desktop.exe --restore FILE`: the backup and
//! restore of the Settings screen, without a window (scripts, tests, a PC whose window will not
//! open). Like `--provision`, it runs before Tauri and never takes the single-instance lock; it
//! starts its own PostgreSQL on the data folder, so it refuses to run while SCIP is open.
//!
//! Output: one JSON object per line (`{"step":…}` progress, then `{"done":true,…}` or `{"error":…}`).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};

use super::pending::{write_pending, PendingRestore};
use super::run::{self, check_restorable, create_backup};
use super::backups_dir;
use super::manifest::BackupKind;
use crate::events::{EventSink, SupervisorEvent};
use crate::paths::DataDirs;
use crate::services::{resolve_resources_root, RuntimeContext, RESOURCES_DIR_ENV};
use crate::startup;
use crate::supervisor::clock::SystemClock;
use crate::supervisor::health::NetProber;
use crate::supervisor::process::{build_command, StdSpawner};
use crate::supervisor::spec::ProcessCommand;
use crate::supervisor::Supervisor;

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Backup { out: Option<PathBuf> },
    Restore { archive: PathBuf },
}

/// `None` when the arguments ask for neither; `Some(Err)` when they ask badly.
pub fn parse(args: &[String]) -> Option<Result<Command, String>> {
    let value_after = |flag: &str| args.iter().position(|a| a == flag).map(|i| args.get(i + 1).cloned());
    if args.iter().any(|a| a == "--backup") {
        return Some(match value_after("--out") {
            Some(Some(dir)) if !dir.starts_with("--") => Ok(Command::Backup { out: Some(PathBuf::from(dir)) }),
            Some(_) => Err("--out attend un dossier".into()),
            None => Ok(Command::Backup { out: None }),
        });
    }
    if args.iter().any(|a| a == "--restore") {
        return Some(match value_after("--restore") {
            Some(Some(file)) if !file.starts_with("--") => Ok(Command::Restore { archive: PathBuf::from(file) }),
            _ => Err("--restore attend le chemin d'une sauvegarde".into()),
        });
    }
    None
}

fn line(value: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

struct JsonSink;

impl EventSink for JsonSink {
    fn emit(&self, event: SupervisorEvent) {
        match event {
            SupervisorEvent::Progress(p) => line(json!({ "step": p.step, "label": p.label, "status": p.status })),
            SupervisorEvent::Error(e) => line(json!({ "log": e.message, "details": e.details })),
            SupervisorEvent::Ready(_) => {}
        }
    }
}

pub fn run_cli(command: Command) -> i32 {
    match execute(command) {
        Ok(result) => {
            line(json!({ "done": true, "result": result }));
            0
        }
        Err(message) => {
            line(json!({ "error": message }));
            1
        }
    }
}

/// `pg_ctl status` exits 0 only when a server runs on that data folder (a stale pid file after
/// a crash does not count).
fn postgres_runs(ctx: &RuntimeContext) -> bool {
    let status = ProcessCommand::new(ctx.resources.postgres_bin("pg_ctl"))
        .args(["status".to_owned(), "-D".to_owned(), ctx.dirs.pgdata.display().to_string()]);
    build_command(&status).output().map(|o| o.status.success()).unwrap_or(false)
}

fn execute(command: Command) -> Result<Value, String> {
    let dirs: DataDirs = DataDirs::from_process_env().map_err(|e| e.to_string())?;
    let exe_dir: Option<PathBuf> = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf));
    let resources = resolve_resources_root(std::env::var(RESOURCES_DIR_ENV).ok(), exe_dir.as_deref());
    let ctx: RuntimeContext = startup::prepare(dirs, resources).map_err(|e| e.message)?;
    if ctx.is_external_database() {
        return Err("SCIP utilise une base PostgreSQL externe : utilisez les outils de ce serveur.".into());
    }
    if postgres_runs(&ctx) {
        return Err("SCIP est ouvert (sa base tourne) : fermez-le avant de sauvegarder ou de restaurer.".into());
    }

    let sink = Arc::new(JsonSink);
    let supervisor = Supervisor::new(
        Arc::new(StdSpawner),
        Arc::new(NetProber),
        Arc::new(SystemClock),
        sink.clone(),
        ctx.dirs.logs.clone(),
    );
    let result = (|| {
        startup::run_plan(&supervisor, ctx.database_plan(), sink.as_ref()).map_err(|e| e.to_string())?;
        match &command {
            Command::Backup { out } => {
                let dir: PathBuf = out.clone().unwrap_or_else(backups_dir);
                let info = create_backup(&ctx, &dir, BackupKind::Manual).map_err(|e| e.to_string())?;
                Ok(json!({ "backup": info, "directory": dir }))
            }
            Command::Restore { archive } => restore(&supervisor, &ctx, sink.as_ref(), archive),
        }
    })();
    supervisor.stop_all();
    result
}

fn restore(supervisor: &Supervisor, ctx: &RuntimeContext, sink: &JsonSink, archive: &Path) -> Result<Value, String> {
    check_restorable(ctx, archive).map_err(|e| e.to_string())?;
    let dir: PathBuf = backups_dir();
    let safety = create_backup(ctx, &dir, BackupKind::BeforeRestore)
        .map_err(|e| format!("la sauvegarde de sécurité a échoué, restauration annulée : {e}"))?;
    write_pending(
        &ctx.dirs.root,
        &PendingRestore { archive: archive.to_path_buf(), safety_backup: Some(dir.join(&safety.name)) },
    )
    .map_err(|e| e.to_string())?;
    let staged = run::stage_pending_restore(ctx)
        .map_err(|e| e.to_string())?
        .ok_or("la restauration prévue a disparu")?;
    startup::restore_database(supervisor, ctx, &staged, sink, true).map_err(|e| e.to_string())?;
    // A failed restore that fell back on the safety backup returns Ok: the result file says which.
    match run::read_last_result(&ctx.dirs.root) {
        Some(result) if result.ok => Ok(json!({ "restored": archive, "safetyBackup": safety.name })),
        Some(result) => Err(result.message),
        None => Err("résultat de la restauration introuvable".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_backup_and_restore_flags() {
        assert_eq!(parse(&args(&["--backup"])), Some(Ok(Command::Backup { out: None })));
        assert_eq!(
            parse(&args(&["--backup", "--out", r"D:\b"])),
            Some(Ok(Command::Backup { out: Some(PathBuf::from(r"D:\b")) }))
        );
        assert!(matches!(parse(&args(&["--backup", "--out"])), Some(Err(_))));
        assert_eq!(
            parse(&args(&["--restore", r"C:\x.scip-backup"])),
            Some(Ok(Command::Restore { archive: PathBuf::from(r"C:\x.scip-backup") }))
        );
        assert!(matches!(parse(&args(&["--restore"])), Some(Err(_))));
        assert!(matches!(parse(&args(&["--restore", "--backup"])), Some(Ok(Command::Backup { .. }))));
        assert_eq!(parse(&args(&["--provision"])), None);
        assert_eq!(parse(&args(&[])), None);
    }
}
