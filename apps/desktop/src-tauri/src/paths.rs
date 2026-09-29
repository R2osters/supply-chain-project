//! Where SCIP keeps its data on disk.
//!
//! Everything lives under one per-user root (`%LOCALAPPDATA%\com.scip.desktop` by default) so a
//! backup, an uninstall or a support request only ever has to point at a single folder.

use std::io;
use std::path::{Path, PathBuf};

/// Overrides the data root. Useful for tests, for running two builds side by side, and for
/// users who want their database on another drive.
pub const DATA_DIR_ENV: &str = "SCIP_DATA_DIR";

/// The bundle identifier, not the product name: the per-user installer puts the program itself in
/// `%LOCALAPPDATA%\SCIP`, and data mixed into it would be at the mercy of every upgrade. The
/// uninstaller's "delete application data" option removes exactly this folder, as users expect.
/// Must match `identifier` in tauri.conf.json.
const APP_FOLDER: &str = "com.scip.desktop";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataDirs {
    pub root: PathBuf,
    /// Postgres cluster (`initdb` target).
    pub pgdata: PathBuf,
    /// Uploaded documents and proofs of delivery (replaces MinIO).
    pub files: PathBuf,
    /// Fitted AI models (replaces the `models_store` volume).
    pub models: PathBuf,
    pub logs: PathBuf,
    /// Secrets and local settings, see `secrets.rs`.
    pub config_file: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum PathsError {
    #[error("cannot locate the data folder: set {DATA_DIR_ENV} or LOCALAPPDATA")]
    NoDataRoot,
    #[error("cannot create {path}: {source}")]
    Create { path: PathBuf, source: io::Error },
}

impl DataDirs {
    pub fn from_root(root: impl Into<PathBuf>) -> Self {
        let root: PathBuf = root.into();
        Self {
            pgdata: root.join("pgdata"),
            files: root.join("files"),
            models: root.join("models"),
            logs: root.join("logs"),
            config_file: root.join("config.json"),
            root,
        }
    }

    /// Resolves the root from the environment without touching the disk.
    pub fn resolve(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, PathsError> {
        let root: PathBuf = match non_empty(lookup(DATA_DIR_ENV)) {
            Some(explicit) => PathBuf::from(explicit),
            None => {
                let local: String = non_empty(lookup("LOCALAPPDATA")).ok_or(PathsError::NoDataRoot)?;
                Path::new(&local).join(APP_FOLDER)
            }
        };
        Ok(Self::from_root(root))
    }

    pub fn from_process_env() -> Result<Self, PathsError> {
        Self::resolve(|key: &str| std::env::var(key).ok())
    }

    /// Creates every folder except `pgdata`: `initdb` refuses a pre-existing non-empty
    /// directory and is the only thing that should decide what goes in there.
    pub fn ensure_created(&self) -> Result<(), PathsError> {
        for dir in [&self.root, &self.files, &self.models, &self.logs] {
            std::fs::create_dir_all(dir)
                .map_err(|source: io::Error| PathsError::Create { path: dir.clone(), source })?;
        }
        Ok(())
    }

    pub fn log_file(&self, name: &str) -> PathBuf {
        self.logs.join(format!("{name}.log"))
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|v: &String| !v.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> =
            pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |key: &str| map.get(key).cloned()
    }

    #[test]
    fn defaults_to_localappdata_identifier_folder() {
        let dirs = DataDirs::resolve(env(&[("LOCALAPPDATA", r"C:\Users\a\AppData\Local")])).unwrap();
        assert_eq!(dirs.root, Path::new(r"C:\Users\a\AppData\Local").join("com.scip.desktop"));
        assert_eq!(dirs.pgdata, dirs.root.join("pgdata"));
        assert_eq!(dirs.config_file, dirs.root.join("config.json"));
    }

    #[test]
    fn explicit_override_wins() {
        let dirs = DataDirs::resolve(env(&[("LOCALAPPDATA", "C:/x"), (DATA_DIR_ENV, "D:/scip")])).unwrap();
        assert_eq!(dirs.root, PathBuf::from("D:/scip"));
    }

    #[test]
    fn blank_override_is_ignored() {
        let dirs = DataDirs::resolve(env(&[("LOCALAPPDATA", "C:/x"), (DATA_DIR_ENV, "  ")])).unwrap();
        assert_eq!(dirs.root, Path::new("C:/x").join("com.scip.desktop"));
    }

    #[test]
    fn fails_without_any_root() {
        assert!(matches!(DataDirs::resolve(env(&[])), Err(PathsError::NoDataRoot)));
    }

    #[test]
    fn ensure_created_leaves_pgdata_to_initdb() {
        let tmp = tempfile::tempdir().unwrap();
        let dirs = DataDirs::from_root(tmp.path().join("SCIP"));
        dirs.ensure_created().unwrap();
        assert!(dirs.logs.is_dir() && dirs.files.is_dir() && dirs.models.is_dir());
        assert!(!dirs.pgdata.exists());
        assert_eq!(dirs.log_file("api"), dirs.logs.join("api.log"));
    }
}
