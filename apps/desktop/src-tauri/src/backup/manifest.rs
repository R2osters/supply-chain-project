//! What a backup says about itself, its file name, and the list shown in Settings.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::archive::read_manifest;

pub const FORMAT: u32 = 1;
pub const EXTENSION: &str = "scip-backup";
pub const MANIFEST_NAME: &str = "manifest.json";
pub const DUMP_NAME: &str = "database.dump";
pub const FILES_DIR: &str = "files";
const PREFIX: &str = "SCIP-sauvegarde-";

/// Why a backup was taken: by hand, or automatically before a restore or an update.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupKind {
    Manual,
    BeforeRestore,
    BeforeUpdate,
}

impl BackupKind {
    fn suffix(self) -> &'static str {
        match self {
            BackupKind::Manual => "",
            BackupKind::BeforeRestore => "-avant-restauration",
            BackupKind::BeforeUpdate => "-avant-mise-a-jour",
        }
    }

    /// Taken by SCIP itself; shown as a safety backup in Settings.
    pub fn is_automatic(self) -> bool {
        self != BackupKind::Manual
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub shipments: i64,
    pub purchase_orders: i64,
    pub users: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: u32,
    pub app_version: String,
    /// RFC 3339, local time with its offset.
    pub created_at: String,
    pub company: Option<String>,
    /// Newest applied Prisma migration: a restore refuses a backup newer than this build.
    pub latest_migration: Option<String>,
    pub counts: Counts,
    /// Number of delivery-proof files included.
    pub files: u64,
    /// Taken automatically before a restore.
    #[serde(default)]
    pub safety: bool,
    /// Major version of the PostgreSQL that made the dump. Absent from the backups made before
    /// the macOS and Linux builds existed: those all come from the Windows build, PostgreSQL 16.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub postgres_major: Option<u32>,
}

/// What a backup without `postgresMajor` was made with (see `Manifest::postgres_major`).
pub const POSTGRES_MAJOR_WHEN_UNSAID: u32 = 16;

/// One row of the Settings list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub name: String,
    pub created_at: String,
    pub size_bytes: u64,
    pub company: Option<String>,
    pub app_version: String,
    pub latest_migration: Option<String>,
    pub counts: Counts,
    pub files: u64,
    pub safety: bool,
}

/// `SCIP-sauvegarde-2026-09-30-141502.scip-backup`, `…-avant-restauration…`, `…-avant-mise-a-jour…`.
pub fn file_name(stamp: &str, kind: BackupKind) -> String {
    format!("{PREFIX}{stamp}{}.{EXTENSION}", kind.suffix())
}

/// A bare file name of ours: no folder part, so a name from the UI cannot point elsewhere.
pub fn is_backup_name(name: &str) -> bool {
    !name.contains(['/', '\\', ':'])
        && name != "."
        && name != ".."
        && name.starts_with("SCIP-")
        && name.ends_with(&format!(".{EXTENSION}"))
}

/// The backup `name` inside `dir`, if it is one of ours and exists.
pub fn resolve(dir: &Path, name: &str) -> Option<PathBuf> {
    if !is_backup_name(name) {
        return None;
    }
    let path: PathBuf = dir.join(name);
    path.is_file().then_some(path)
}

/// Backups of `dir`, newest first; files that are not readable backups are left out.
pub fn list_backups(dir: &Path) -> Vec<BackupInfo> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut backups: Vec<BackupInfo> = entries
        .flatten()
        .filter_map(|entry| {
            let name: String = entry.file_name().to_string_lossy().into_owned();
            if !is_backup_name(&name) {
                return None;
            }
            let size_bytes: u64 = entry.metadata().ok()?.len();
            let manifest: Manifest = read_manifest(&entry.path()).ok()?;
            Some(info(name, size_bytes, manifest))
        })
        .collect();
    backups.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.name.cmp(&a.name)));
    backups
}

pub fn info(name: String, size_bytes: u64, manifest: Manifest) -> BackupInfo {
    BackupInfo {
        name,
        created_at: manifest.created_at,
        size_bytes,
        company: manifest.company,
        app_version: manifest.app_version,
        latest_migration: manifest.latest_migration,
        counts: manifest.counts,
        files: manifest.files,
        safety: manifest.safety,
    }
}

/// Prisma migration folders are named `YYYYMMDDHHMMSS_name`, so names sort in time order. A
/// backup whose newest migration this build does not ship comes from a newer SCIP: restoring it
/// would leave a schema this API does not know. Unknown on either side: allowed (an old backup
/// without the field, or a build whose migrations could not be listed is caught by `migrate`).
pub fn migration_is_supported(backup: Option<&str>, shipped_latest: Option<&str>) -> bool {
    match (backup, shipped_latest) {
        (Some(backup), Some(shipped)) => backup <= shipped,
        _ => true,
    }
}

/// The PostgreSQL major version of a cluster: what `initdb` wrote in its `PG_VERSION` file.
pub fn cluster_major(pgdata: &Path) -> Option<u32> {
    std::fs::read_to_string(pgdata.join("PG_VERSION")).ok()?.trim().parse().ok()
}

/// `pg_restore` cannot read the archive of a newer `pg_dump`: the macOS and Linux builds ship
/// PostgreSQL 18, the Windows build 16, so a backup crosses from Windows to them and not back.
/// `Some((backup, here))` when the backup comes from a newer PostgreSQL than this cluster's;
/// `None` when it can be restored, or when this cluster's version is unknown (`pg_restore` then
/// decides).
pub fn newer_postgres(backup: Option<u32>, cluster: Option<u32>) -> Option<(u32, u32)> {
    let backup: u32 = backup.unwrap_or(POSTGRES_MAJOR_WHEN_UNSAID);
    cluster.filter(|here: &u32| backup > *here).map(|here: u32| (backup, here))
}

/// The newest migration shipped with this build (`resources/api/prisma/migrations`).
pub fn latest_shipped_migration(api_dir: &Path) -> Option<String> {
    std::fs::read_dir(api_dir.join("prisma").join("migrations"))
        .ok()?
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.len() > 14 && name[..14].bytes().all(|b| b.is_ascii_digit()))
        .max()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::archive::write_archive;

    pub fn manifest(created_at: &str) -> Manifest {
        Manifest {
            format: FORMAT,
            app_version: "0.2.0".into(),
            created_at: created_at.into(),
            company: Some("Demo".into()),
            latest_migration: Some("20260929120000_user_must_change_password".into()),
            counts: Counts { shipments: 55, purchase_orders: 180, users: 7 },
            files: 0,
            safety: false,
            postgres_major: None,
        }
    }

    #[test]
    fn a_backup_from_a_newer_postgres_is_refused() {
        assert_eq!(newer_postgres(Some(18), Some(16)), Some((18, 16)), "macOS or Linux to Windows");
        assert_eq!(newer_postgres(Some(16), Some(18)), None, "Windows to macOS or Linux");
        assert_eq!(newer_postgres(Some(18), Some(18)), None);
        assert_eq!(newer_postgres(None, Some(16)), None, "a backup made before the field existed");
        assert_eq!(newer_postgres(None, Some(18)), None);
        assert_eq!(newer_postgres(Some(18), None), None, "no cluster yet: pg_restore decides");
    }

    #[test]
    fn the_postgres_version_is_optional_in_the_manifest_and_read_from_the_cluster() {
        // A backup made by SCIP 0.2.1 has no such field and stays readable.
        let old: Manifest = serde_json::from_str(
            r#"{"format":1,"appVersion":"0.2.1","createdAt":"2026-10-01T10:00:00+02:00","company":null,
                "latestMigration":null,"counts":{"shipments":0,"purchaseOrders":0,"users":1},"files":0}"#,
        )
        .unwrap();
        assert_eq!(old.postgres_major, None);
        assert!(!serde_json::to_string(&old).unwrap().contains("postgresMajor"));

        let new = Manifest { postgres_major: Some(18), ..old };
        let json: String = serde_json::to_string(&new).unwrap();
        assert!(json.contains(r#""postgresMajor":18"#), "{json}");
        assert_eq!(serde_json::from_str::<Manifest>(&json).unwrap(), new);

        let dir = tempfile::tempdir().unwrap();
        assert_eq!(cluster_major(dir.path()), None, "initdb has not run");
        std::fs::write(dir.path().join("PG_VERSION"), "18\n").unwrap();
        assert_eq!(cluster_major(dir.path()), Some(18));
    }

    #[test]
    fn names_carry_the_time_and_the_safety_suffix() {
        assert_eq!(
            file_name("2026-09-30-141502", BackupKind::Manual),
            "SCIP-sauvegarde-2026-09-30-141502.scip-backup"
        );
        assert_eq!(
            file_name("2026-09-30-141502", BackupKind::BeforeRestore),
            "SCIP-sauvegarde-2026-09-30-141502-avant-restauration.scip-backup"
        );
        assert_eq!(
            file_name("2026-09-30-141502", BackupKind::BeforeUpdate),
            "SCIP-sauvegarde-2026-09-30-141502-avant-mise-a-jour.scip-backup"
        );
        assert!(BackupKind::BeforeUpdate.is_automatic() && !BackupKind::Manual.is_automatic());
    }

    #[test]
    fn only_bare_names_of_ours_are_backups() {
        assert!(is_backup_name("SCIP-sauvegarde-2026-09-30-141502.scip-backup"));
        for bad in [
            "..\\SCIP-x.scip-backup",
            "C:\\x\\SCIP-a.scip-backup",
            "a/SCIP-b.scip-backup",
            "SCIP-a.zip",
            "other.scip-backup",
            "SCIP-a.scip-backup:stream",
        ] {
            assert!(!is_backup_name(bad), "{bad}");
        }
    }

    #[test]
    fn lists_newest_first_and_skips_unreadable_files() {
        let dir = tempfile::tempdir().unwrap();
        let dump = dir.path().join("d.dump");
        std::fs::write(&dump, b"dump").unwrap();
        let empty = dir.path().join("empty-files");
        for (name, at) in [
            ("SCIP-sauvegarde-a.scip-backup", "2026-09-29T10:00:00+02:00"),
            ("SCIP-sauvegarde-b.scip-backup", "2026-09-30T10:00:00+02:00"),
        ] {
            write_archive(&dir.path().join(name), &manifest(at), &dump, &empty).unwrap();
        }
        std::fs::write(dir.path().join("SCIP-sauvegarde-broken.scip-backup"), b"not a tar").unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"x").unwrap();

        let list = list_backups(dir.path());
        assert_eq!(
            list.iter().map(|b| b.name.as_str()).collect::<Vec<_>>(),
            ["SCIP-sauvegarde-b.scip-backup", "SCIP-sauvegarde-a.scip-backup"]
        );
        assert_eq!(list[0].counts.shipments, 55);
        assert!(list[0].size_bytes > 0);
        assert!(list_backups(&dir.path().join("missing")).is_empty());
    }

    #[test]
    fn resolve_stays_inside_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("SCIP-sauvegarde-a.scip-backup"), b"x").unwrap();
        assert!(resolve(dir.path(), "SCIP-sauvegarde-a.scip-backup").is_some());
        assert!(resolve(dir.path(), "SCIP-sauvegarde-missing.scip-backup").is_none());
        assert!(resolve(dir.path(), "..\\SCIP-sauvegarde-a.scip-backup").is_none());
    }

    #[test]
    fn a_backup_from_a_newer_scip_is_refused() {
        let shipped = Some("20260929120000_user_must_change_password");
        assert!(migration_is_supported(Some("20260813002719_init"), shipped));
        assert!(migration_is_supported(Some("20260929120000_user_must_change_password"), shipped));
        assert!(!migration_is_supported(Some("20261015000000_future"), shipped));
        assert!(migration_is_supported(None, shipped));
        assert!(migration_is_supported(Some("x"), None));
    }

    #[test]
    fn latest_shipped_migration_reads_timestamped_folders_only() {
        let dir = tempfile::tempdir().unwrap();
        let migrations = dir.path().join("prisma").join("migrations");
        for name in
            ["20260813002719_init", "20260929120000_user_must_change_password", "migration_lock.toml.d"]
        {
            std::fs::create_dir_all(migrations.join(name)).unwrap();
        }
        std::fs::write(migrations.join("99999999999999_file_not_folder"), b"").unwrap();
        assert_eq!(
            latest_shipped_migration(dir.path()).as_deref(),
            Some("20260929120000_user_must_change_password")
        );
        assert_eq!(latest_shipped_migration(&dir.path().join("none")), None);
    }
}
