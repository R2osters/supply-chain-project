//! `pending-restore.json`: a restore chosen in Settings, performed at the next start.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::BackupError;

const FILE_NAME: &str = "pending-restore.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRestore {
    /// The backup to restore.
    pub archive: PathBuf,
    /// Taken just before, named in the error message if the restore fails.
    pub safety_backup: Option<PathBuf>,
}

pub fn pending_path(data_root: &Path) -> PathBuf {
    data_root.join(FILE_NAME)
}

/// The scheduled restore, if any; an unreadable file counts as none (and is logged).
pub fn read_pending(data_root: &Path) -> Option<PendingRestore> {
    let path: PathBuf = pending_path(data_root);
    let body: String = std::fs::read_to_string(&path).ok()?;
    match serde_json::from_str(&body) {
        Ok(pending) => Some(pending),
        Err(e) => {
            log::warn!("ignoring unreadable {}: {e}", path.display());
            None
        }
    }
}

pub fn write_pending(data_root: &Path, pending: &PendingRestore) -> Result<(), BackupError> {
    let path: PathBuf = pending_path(data_root);
    let body: Vec<u8> = serde_json::to_vec_pretty(pending).map_err(|e| BackupError::Format(e.to_string()))?;
    let temporary: PathBuf = path.with_extension("json.tmp");
    std::fs::write(&temporary, body).map_err(|e| BackupError::io("écriture de la restauration prévue", e))?;
    std::fs::rename(&temporary, &path).map_err(|e| BackupError::io("écriture de la restauration prévue", e))
}

pub fn clear_pending(data_root: &Path) {
    let _ = std::fs::remove_file(pending_path(data_root));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_read_clear() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_pending(dir.path()), None);
        let pending = PendingRestore {
            archive: PathBuf::from(r"C:\Users\a\Documents\SCIP\Sauvegardes\SCIP-sauvegarde-x.scip-backup"),
            safety_backup: Some(PathBuf::from("safety.scip-backup")),
        };
        write_pending(dir.path(), &pending).unwrap();
        assert_eq!(read_pending(dir.path()), Some(pending));
        clear_pending(dir.path());
        assert_eq!(read_pending(dir.path()), None);
    }

    #[test]
    fn an_unreadable_file_means_no_restore() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(pending_path(dir.path()), b"{not json").unwrap();
        assert_eq!(read_pending(dir.path()), None);
    }
}
