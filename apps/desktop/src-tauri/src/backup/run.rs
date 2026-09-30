//! Taking a backup of the running database, and the file side of a restore at startup.

use std::path::{Path, PathBuf};
use std::process::Output;

use serde::{Deserialize, Serialize};

use super::archive::{extract_archive, write_archive};
use super::manifest::{self, file_name, info, BackupInfo, Counts, Manifest, DUMP_NAME, FILES_DIR, FORMAT};
use super::pending::{clear_pending, read_pending};
use super::BackupError;
use crate::services::RuntimeContext;
use crate::supervisor::process::build_command;

const STAGING_DIR: &str = "restore-staging";
const ROLLBACK_DIR: &str = "restore-rollback";
const FILES_BEFORE: &str = "files.before-restore";
const RESULT_FILE: &str = "restore-result.json";

/// Outcome of the last restore, shown by the Settings panel after the restart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub ok: bool,
    pub archive: String,
    pub at: String,
    pub message: String,
}

/// A restore whose files are in place and whose dump waits for the startup plan.
#[derive(Debug, Clone)]
pub struct StagedRestore {
    pub archive: PathBuf,
    pub safety_backup: Option<PathBuf>,
    pub dump: PathBuf,
    pub manifest: Manifest,
}

fn now_rfc3339() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
}

fn stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d-%H%M%S").to_string()
}

fn run(command: std::process::Command, what: &str) -> Result<Output, BackupError> {
    let mut command = command;
    let output: Output = command.output().map_err(|e| BackupError::io(format!("lancement de {what}"), e))?;
    if !output.status.success() {
        let stderr: String = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let tail: String = stderr.lines().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" | ");
        return Err(BackupError::Tool(format!("{what} a échoué : {tail}")));
    }
    Ok(output)
}

fn count_files(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            let path: PathBuf = entry.path();
            if path.is_dir() {
                count_files(&path)
            } else {
                1
            }
        })
        .sum()
}

/// Parses the tab-separated line of `backup_facts_command`.
pub fn parse_facts(line: &str) -> (Counts, Option<String>, Option<String>) {
    let parts: Vec<&str> = line.trim_end_matches(['\r', '\n']).split('\t').collect();
    let number = |i: usize| parts.get(i).and_then(|v| v.trim().parse::<i64>().ok()).unwrap_or(0);
    let text = |i: usize| parts.get(i).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
    (Counts { shipments: number(0), purchase_orders: number(1), users: number(2) }, text(3), text(4))
}

/// A backup of the running embedded database and the delivery proofs, written to `dir`.
pub fn create_backup(ctx: &RuntimeContext, dir: &Path, safety: bool) -> Result<BackupInfo, BackupError> {
    if ctx.is_external_database() {
        return Err(BackupError::Refused(
            "SCIP utilise une base PostgreSQL externe : sauvegardez-la avec les outils de ce serveur.".into(),
        ));
    }
    std::fs::create_dir_all(dir).map_err(|e| BackupError::io(format!("création de {}", dir.display()), e))?;

    let mut name: String = file_name(&stamp(), safety);
    let mut n = 2;
    while dir.join(&name).exists() {
        name = file_name(&format!("{}-{n}", stamp()), safety);
        n += 1;
    }
    let dump: PathBuf = dir.join(format!(".{name}.dump"));
    let part: PathBuf = dir.join(format!("{name}.part"));
    let result = (|| {
        run(build_command(&ctx.pg_dump_command(&dump)), "pg_dump")?;
        let facts = run(build_command(&ctx.backup_facts_command()), "la lecture des compteurs")?;
        let (counts, company, latest_migration) = parse_facts(&String::from_utf8_lossy(&facts.stdout));
        let manifest = Manifest {
            format: FORMAT,
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
            created_at: now_rfc3339(),
            company,
            latest_migration,
            counts,
            files: count_files(&ctx.dirs.files),
            safety,
        };
        write_archive(&part, &manifest, &dump, &ctx.dirs.files)?;
        std::fs::rename(&part, dir.join(&name)).map_err(|e| BackupError::io("finalisation de la sauvegarde", e))?;
        let size: u64 = std::fs::metadata(dir.join(&name)).map(|m| m.len()).unwrap_or(0);
        Ok(info(name.clone(), size, manifest))
    })();
    let _ = std::fs::remove_file(&dump);
    let _ = std::fs::remove_file(&part);
    result
}

/// Checks a backup before scheduling it: readable, and not from a newer SCIP.
pub fn check_restorable(ctx: &RuntimeContext, archive: &Path) -> Result<Manifest, BackupError> {
    if ctx.is_external_database() {
        return Err(BackupError::Refused("SCIP utilise une base externe : restauration impossible d'ici.".into()));
    }
    let manifest: Manifest = super::archive::read_manifest(archive)?;
    let shipped: Option<String> = manifest::latest_shipped_migration(&ctx.resources.api_dir());
    if !manifest::migration_is_supported(manifest.latest_migration.as_deref(), shipped.as_deref()) {
        return Err(BackupError::Refused(format!(
            "Cette sauvegarde vient d'une version plus récente de SCIP ({}) : mettez SCIP à jour avant de la restaurer.",
            manifest.app_version
        )));
    }
    Ok(manifest)
}

/// Startup, before the plan: extracts a scheduled restore and puts its files in place. `None`
/// when nothing is scheduled. On error nothing has been changed yet and the schedule is dropped,
/// so the next start is a normal one.
pub fn stage_pending_restore(ctx: &RuntimeContext) -> Result<Option<StagedRestore>, BackupError> {
    let root: &Path = &ctx.dirs.root;
    let Some(pending) = read_pending(root) else {
        return Ok(None);
    };
    let staging: PathBuf = root.join(STAGING_DIR);
    let staged = (|| {
        let manifest: Manifest = check_restorable(ctx, &pending.archive)?;
        let _ = std::fs::remove_dir_all(&staging);
        extract_archive(&pending.archive, &staging)?;
        swap_in_files(&ctx.dirs.files, &staging.join(FILES_DIR), &root.join(FILES_BEFORE))?;
        Ok(StagedRestore {
            archive: pending.archive.clone(),
            safety_backup: pending.safety_backup.clone(),
            dump: staging.join(DUMP_NAME),
            manifest,
        })
    })();
    if staged.is_err() {
        clear_pending(root);
        let _ = std::fs::remove_dir_all(&staging);
    }
    staged.map(Some)
}

/// Current photos aside (kept until the restore succeeds), the backup's in their place.
fn swap_in_files(files: &Path, restored: &Path, before: &Path) -> Result<(), BackupError> {
    let _ = std::fs::remove_dir_all(before);
    if files.exists() {
        std::fs::rename(files, before).map_err(|e| BackupError::io("mise de côté des preuves de livraison", e))?;
    }
    if restored.is_dir() {
        std::fs::rename(restored, files).map_err(|e| BackupError::io("restauration des preuves de livraison", e))
    } else {
        std::fs::create_dir_all(files).map_err(|e| BackupError::io("création du dossier des preuves", e))
    }
}

/// The restore worked: the old photos and the staging folder go, the result is recorded.
pub fn finish_restore(ctx: &RuntimeContext, staged: &StagedRestore) {
    let root: &Path = &ctx.dirs.root;
    let _ = std::fs::remove_dir_all(root.join(STAGING_DIR));
    let _ = std::fs::remove_dir_all(root.join(FILES_BEFORE));
    clear_pending(root);
    record_result(
        root,
        &RestoreResult {
            ok: true,
            archive: display_name(&staged.archive),
            at: now_rfc3339(),
            message: format!("Sauvegarde « {} » restaurée.", display_name(&staged.archive)),
        },
    );
    log::info!("restore of {} done", staged.archive.display());
}

/// The restore failed after the database was dropped: photos back, and the safety backup's dump
/// ready for `rollback_plan`. `None` without a safety backup.
pub fn prepare_rollback(ctx: &RuntimeContext, staged: &StagedRestore) -> Result<Option<PathBuf>, BackupError> {
    let root: &Path = &ctx.dirs.root;
    clear_pending(root);
    let before: PathBuf = root.join(FILES_BEFORE);
    if before.exists() {
        let _ = std::fs::remove_dir_all(&ctx.dirs.files);
        std::fs::rename(&before, &ctx.dirs.files).map_err(|e| BackupError::io("retour des preuves de livraison", e))?;
    }
    let Some(safety) = &staged.safety_backup else {
        return Ok(None);
    };
    let rollback: PathBuf = root.join(ROLLBACK_DIR);
    let _ = std::fs::remove_dir_all(&rollback);
    extract_archive(safety, &rollback)?;
    Ok(Some(rollback.join(DUMP_NAME)))
}

/// After a rollback (whatever its outcome): temporary folders go, the failure is recorded. The
/// technical reason goes to the log; the message says what the user needs to know.
pub fn finish_rollback(ctx: &RuntimeContext, staged: &StagedRestore, reason: &str) {
    log::error!("restore of {} rolled back: {reason}", staged.archive.display());
    let root: &Path = &ctx.dirs.root;
    let _ = std::fs::remove_dir_all(root.join(STAGING_DIR));
    let _ = std::fs::remove_dir_all(root.join(ROLLBACK_DIR));
    record_result(
        root,
        &RestoreResult {
            ok: false,
            archive: display_name(&staged.archive),
            at: now_rfc3339(),
            message: format!(
                "La restauration de « {} » a échoué : la sauvegarde est illisible ou incompatible. SCIP a repris les données d'avant la restauration.",
                display_name(&staged.archive)
            ),
        },
    );
}

fn display_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

pub fn record_result(root: &Path, result: &RestoreResult) {
    if let Ok(body) = serde_json::to_vec_pretty(result) {
        let _ = std::fs::write(root.join(RESULT_FILE), body);
    }
}

pub fn read_last_result(root: &Path) -> Option<RestoreResult> {
    serde_json::from_str(&std::fs::read_to_string(root.join(RESULT_FILE)).ok()?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn facts_line_is_parsed_leniently() {
        let (counts, company, migration) = parse_facts("55\t180\t7\tAcme Logistics\t20260929120000_x\n");
        assert_eq!(counts, Counts { shipments: 55, purchase_orders: 180, users: 7 });
        assert_eq!(company.as_deref(), Some("Acme Logistics"));
        assert_eq!(migration.as_deref(), Some("20260929120000_x"));

        let (counts, company, migration) = parse_facts("0\t0\t1\t\t\r\n");
        assert_eq!(counts.users, 1);
        assert_eq!((company, migration), (None, None));
        assert_eq!(parse_facts("garbage").0, Counts::default());
    }

    #[test]
    fn files_are_swapped_and_the_old_ones_kept_aside() {
        let dir = tempfile::tempdir().unwrap();
        let files = dir.path().join("files");
        std::fs::create_dir_all(&files).unwrap();
        std::fs::write(files.join("current.jpg"), b"now").unwrap();
        let restored = dir.path().join("staging").join("files");
        std::fs::create_dir_all(&restored).unwrap();
        std::fs::write(restored.join("old.jpg"), b"then").unwrap();
        let before = dir.path().join("files.before-restore");

        swap_in_files(&files, &restored, &before).unwrap();
        assert!(files.join("old.jpg").is_file());
        assert!(!files.join("current.jpg").exists());
        assert!(before.join("current.jpg").is_file());
    }

    #[test]
    fn a_backup_without_photos_leaves_an_empty_folder() {
        let dir = tempfile::tempdir().unwrap();
        let files = dir.path().join("files");
        std::fs::create_dir_all(&files).unwrap();
        std::fs::write(files.join("current.jpg"), b"now").unwrap();
        swap_in_files(&files, &dir.path().join("none"), &dir.path().join("before")).unwrap();
        assert!(files.is_dir());
        assert_eq!(std::fs::read_dir(&files).unwrap().count(), 0);
    }

    #[test]
    fn restore_result_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_last_result(dir.path()), None);
        let result = RestoreResult { ok: false, archive: "a".into(), at: "t".into(), message: "m".into() };
        record_result(dir.path(), &result);
        assert_eq!(read_last_result(dir.path()), Some(result));
    }
}
