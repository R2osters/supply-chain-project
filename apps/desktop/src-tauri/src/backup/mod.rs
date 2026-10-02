//! Backup and restore of the embedded database and the delivery photos (DEPLOYMENT.md, "Backup").
//!
//! A backup is one tar file in `Documents\SCIP\Sauvegardes`: `manifest.json`, `database.dump`
//! (`pg_dump --format=custom`) and `files/` (proofs of delivery). It holds no secret of this
//! install (`config.json`) nor the data-source keys (`settings.json`), so it can travel on a USB
//! stick without exposing an API key.
//!
//! A restore is scheduled, not run live: the app restarts and the startup plan drops and rebuilds
//! the database from the dump before the API starts, so nothing holds a connection to it and the
//! usual migrations bring an older backup up to date.

pub mod archive;
pub mod cli;
pub mod manifest;
pub mod pending;
pub mod run;

use std::path::PathBuf;

pub use manifest::{BackupInfo, Counts, Manifest};

/// Overrides the backup folder (tests, or a user who wants them elsewhere).
pub const BACKUP_DIR_ENV: &str = "SCIP_BACKUP_DIR";

#[derive(Debug, thiserror::Error)]
pub enum BackupError {
    #[error("{context}: {source}")]
    Io { context: String, source: std::io::Error },
    #[error("{0}")]
    Format(String),
    #[error("{0}")]
    Tool(String),
    #[error("{0}")]
    Refused(String),
}

impl BackupError {
    pub fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        Self::Io { context: context.into(), source }
    }
}

/// `SCIP_BACKUP_DIR`, else Windows' Documents folder (OneDrive redirection included) + SCIP\Sauvegardes.
/// A Linux session without a Documents folder (none declared to XDG) uses the home folder: the
/// temporary folder of the last resort is emptied at every restart there.
pub fn backups_dir() -> PathBuf {
    backups_dir_from(std::env::var(BACKUP_DIR_ENV).ok(), dirs::document_dir().or_else(dirs::home_dir))
}

fn backups_dir_from(explicit: Option<String>, documents: Option<PathBuf>) -> PathBuf {
    match explicit.filter(|value: &String| !value.trim().is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => documents.unwrap_or_else(std::env::temp_dir).join("SCIP").join("Sauvegardes"),
    }
}

/// Creates the backup folder when it is missing. A backup holds every account and the business
/// data, and on macOS and Linux Documents is not always closed to the other accounts of the
/// computer: a folder created here is for its owner only. One that already exists keeps the
/// mode its owner gave it.
pub fn ensure_backups_dir(dir: &std::path::Path) -> std::io::Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(dir)?;
    crate::paths::restrict_to_owner(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_is_documents_scip_sauvegardes_unless_overridden() {
        let documents: PathBuf = PathBuf::from(r"C:\Users\a\Documents");
        assert_eq!(
            backups_dir_from(None, Some(documents.clone())),
            documents.join("SCIP").join("Sauvegardes")
        );
        assert_eq!(
            backups_dir_from(Some("  ".into()), Some(documents.clone())),
            documents.join("SCIP").join("Sauvegardes")
        );
        assert_eq!(backups_dir_from(Some(r"D:\b".into()), Some(documents)), PathBuf::from(r"D:\b"));
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_created_here_is_private_and_an_existing_one_is_left_alone() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |dir: &std::path::Path| std::fs::metadata(dir).unwrap().permissions().mode() & 0o777;
        let tmp = tempfile::tempdir().unwrap();

        let created: PathBuf = tmp.path().join("Documents").join("SCIP").join("Sauvegardes");
        ensure_backups_dir(&created).unwrap();
        assert_eq!(mode(&created), 0o700);

        let chosen: PathBuf = tmp.path().join("shared");
        std::fs::create_dir(&chosen).unwrap();
        std::fs::set_permissions(&chosen, std::fs::Permissions::from_mode(0o755)).unwrap();
        ensure_backups_dir(&chosen).unwrap();
        assert_eq!(mode(&chosen), 0o755);
    }
}
