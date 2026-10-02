//! Where SCIP keeps its data on disk.
//!
//! Everything lives under one per-user root (`%LOCALAPPDATA%\com.scip.desktop` by default) so a
//! backup, an uninstall or a support request only ever has to point at a single folder.
//!
//! macOS and Linux have no `%LOCALAPPDATA%`: the root is under `~/Library/Application Support`
//! on macOS and under `$XDG_DATA_HOME` (`~/.local/share`) on Linux, closed to other accounts.

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
    #[error(
        "cannot locate the data folder: set {DATA_DIR_ENV} (or LOCALAPPDATA on Windows, HOME elsewhere)"
    )]
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
            None => per_user_folder(&lookup).ok_or(PathsError::NoDataRoot)?.join(APP_FOLDER),
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
            create_private_dir(dir)
                .map_err(|source: io::Error| PathsError::Create { path: dir.clone(), source })?;
        }
        // A root that existed already keeps the mode it had: close it too.
        restrict_to_owner(&self.root)
            .map_err(|source: io::Error| PathsError::Create { path: self.root.clone(), source })
    }

    pub fn log_file(&self, name: &str) -> PathBuf {
        self.logs.join(format!("{name}.log"))
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|v: &String| !v.trim().is_empty())
}

/// The per-user folder applications keep their data in. `LOCALAPPDATA` is Windows'; macOS and
/// Linux, which never set it, derive theirs from the home folder.
fn per_user_folder(lookup: &impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if let Some(local) = non_empty(lookup("LOCALAPPDATA")) {
        return Some(PathBuf::from(local));
    }
    if !cfg!(unix) {
        return None;
    }
    let home = || non_empty(lookup("HOME")).map(PathBuf::from);
    if cfg!(target_os = "macos") {
        return home().map(|home: PathBuf| home.join("Library").join("Application Support"));
    }
    non_empty(lookup("XDG_DATA_HOME"))
        .map(PathBuf::from)
        .or_else(|| home().map(|home: PathBuf| home.join(".local").join("share")))
}

/// Windows keeps `%LOCALAPPDATA%` to its user through the profile's ACL. macOS and Linux give no
/// such guarantee (`~/.local/share` can be readable by every account), and this folder holds the
/// database, its password and the signing secrets: only its owner may enter it.
#[cfg(unix)]
pub(crate) fn restrict_to_owner(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
pub(crate) fn restrict_to_owner(_dir: &Path) -> io::Result<()> {
    Ok(())
}

/// `create_dir_all`, and on macOS and Linux a folder (with the parents it lacks) that is closed
/// to other accounts from the moment it exists, not a moment later.
#[cfg(unix)]
pub(crate) fn create_private_dir(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
}

#[cfg(not(unix))]
pub(crate) fn create_private_dir(dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)
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

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_defaults_to_application_support() {
        let dirs = DataDirs::resolve(env(&[("HOME", "/Users/a"), ("XDG_DATA_HOME", "/x")])).unwrap();
        assert_eq!(dirs.root, Path::new("/Users/a/Library/Application Support").join("com.scip.desktop"));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn linux_follows_xdg_then_the_home_folder() {
        let dirs = DataDirs::resolve(env(&[("HOME", "/home/a")])).unwrap();
        assert_eq!(dirs.root, Path::new("/home/a/.local/share").join("com.scip.desktop"));
        let dirs = DataDirs::resolve(env(&[("HOME", "/home/a"), ("XDG_DATA_HOME", "/data")])).unwrap();
        assert_eq!(dirs.root, Path::new("/data").join("com.scip.desktop"));
        let dirs = DataDirs::resolve(env(&[("HOME", "/home/a"), ("XDG_DATA_HOME", " ")])).unwrap();
        assert_eq!(dirs.root, Path::new("/home/a/.local/share").join("com.scip.desktop"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_does_not_fall_back_on_the_home_folder() {
        let unix_only = env(&[("HOME", "C:/Users/a"), ("XDG_DATA_HOME", "C:/x")]);
        assert!(matches!(DataDirs::resolve(unix_only), Err(PathsError::NoDataRoot)));
    }

    #[cfg(unix)]
    #[test]
    fn the_data_folder_is_closed_to_other_accounts() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |dir: &Path| std::fs::metadata(dir).unwrap().permissions().mode() & 0o777;
        let tmp = tempfile::tempdir().unwrap();

        // Created here: private from the start, with the parent it lacked and what is inside.
        let fresh = DataDirs::from_root(tmp.path().join("share").join("com.scip.desktop"));
        fresh.ensure_created().unwrap();
        assert_eq!(mode(&fresh.root), 0o700);
        assert_eq!(mode(&tmp.path().join("share")), 0o700);
        assert_eq!(mode(&fresh.files), 0o700);

        // Found there with a wider mode (an older SCIP, a restored home folder): closed as well.
        let dirs = DataDirs::from_root(tmp.path().join("SCIP"));
        std::fs::create_dir_all(&dirs.root).unwrap();
        std::fs::set_permissions(&dirs.root, std::fs::Permissions::from_mode(0o755)).unwrap();
        dirs.ensure_created().unwrap();
        assert_eq!(mode(&dirs.root), 0o700);
    }
}
