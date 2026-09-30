//! `scip-desktop.exe --update [--check]`: the update of Settings without a window, for scripts
//! and tests. `--check` only looks and downloads; otherwise the data is backed up (with SCIP's
//! own database, so SCIP must be closed) and `SCIP-Setup.exe --silent --update` starts, detached:
//! this exe lives in the folder the installer replaces, so it hands over and exits. The
//! installer's JSON lines go to `updates/install-{version}.log`, its last line says how it ended.
//! One JSON object per line, like `--backup`.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};

use super::launch::spawn_silent_installer;
use super::updater::{HttpFetcher, UpdateState, UpdateStatus, Updater};
use super::{UpdateConfig, Version};
use crate::backup::backups_dir;
use crate::backup::cli::{context_from_env, line, with_own_database};
use crate::backup::manifest::BackupKind;
use crate::backup::run::create_backup;
use crate::services::RuntimeContext;

#[derive(Debug, PartialEq, Eq)]
pub struct UpdateCommand {
    pub check_only: bool,
}

pub fn parse(args: &[String]) -> Option<UpdateCommand> {
    args.iter()
        .any(|a| a == "--update")
        .then(|| UpdateCommand { check_only: args.iter().any(|a| a == "--check") })
}

pub fn run_cli(command: UpdateCommand) -> i32 {
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

fn execute(command: UpdateCommand) -> Result<Value, String> {
    let ctx: RuntimeContext = context_from_env()?;
    let config =
        UpdateConfig::from_env().ok_or("mises à jour désactivées : aucune clé de l'éditeur dans ce build")?;
    let current = Version::parse(env!("CARGO_PKG_VERSION")).ok_or("version de SCIP illisible")?;
    let updater = Updater::new(
        Some(config),
        current,
        ctx.dirs.root.join("updates"),
        Arc::new(HttpFetcher),
        Box::new(|status: &UpdateStatus| line(json!({ "update": status }))),
    );
    updater.restore();
    let status = updater.check_now();
    if let UpdateState::Error { message } = &status.state {
        return Err(message.clone());
    }
    if command.check_only || !updater.has_ready() {
        return Ok(json!({ "status": status }));
    }

    // Backup first (seconds of pg_dump), then check and start the installer under one lock.
    let backup = with_own_database(&ctx, |_, _| {
        create_backup(&ctx, &backups_dir(), BackupKind::BeforeUpdate)
            .map_err(|e| format!("la sauvegarde avant mise à jour a échoué, mise à jour annulée : {e}"))
    })?;
    let ready = updater.ready_installer().map_err(|e| e.to_string())?;
    let version: &Version = &ready.version;
    line(json!({ "log": format!("Sauvegarde {} créée, installation de {version}", backup.name) }));

    let log: PathBuf = ctx.dirs.root.join("updates").join(format!("install-{version}.log"));
    spawn_silent_installer(&ready.path, &log)
        .map_err(|e| format!("l'installeur de {version} n'a pas pu démarrer : {e}"))?;
    Ok(json!({ "installing": version.to_string(), "backup": backup.name, "log": log }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_update_and_check() {
        assert_eq!(parse(&args(&["--update"])), Some(UpdateCommand { check_only: false }));
        assert_eq!(parse(&args(&["--update", "--check"])), Some(UpdateCommand { check_only: true }));
        assert_eq!(parse(&args(&["--backup"])), None);
        assert_eq!(parse(&args(&[])), None);
    }
}
