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
pub fn backups_dir() -> PathBuf {
    backups_dir_from(std::env::var(BACKUP_DIR_ENV).ok(), dirs::document_dir())
}

fn backups_dir_from(explicit: Option<String>, documents: Option<PathBuf>) -> PathBuf {
    match explicit.filter(|value: &String| !value.trim().is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => documents.unwrap_or_else(std::env::temp_dir).join("SCIP").join("Sauvegardes"),
    }
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
}
