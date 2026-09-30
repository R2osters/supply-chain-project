//! Where things go and what this run is (install, upgrade or uninstall).
//!
//! `SCIP_SETUP_TEST=1` moves everything the installer writes away from a real SCIP: program and
//! data under a temp folder, registry key `SCIP-Test`, shortcuts `SCIP Test.lnk`. Developers
//! (and the automated tests of the installer) can then run the real binary on a machine where
//! SCIP is installed and in use without touching it.

use std::path::{Path, PathBuf};

use serde::Serialize;

pub const TEST_ENV: &str = "SCIP_SETUP_TEST";
/// Test root, `%TEMP%\scip-setup-test` by default.
pub const TEST_ROOT_ENV: &str = "SCIP_SETUP_TEST_ROOT";
/// A setup exe (with payload) to install from instead of this exe, for `tauri dev`.
pub const PAYLOAD_ENV: &str = "SCIP_SETUP_PAYLOAD";
/// Same variable as apps/desktop/src-tauri/src/paths.rs: the data folder of SCIP.
pub const DATA_DIR_ENV: &str = "SCIP_DATA_DIR";

/// The data folder SCIP uses (apps/desktop paths.rs, `identifier` of its tauri.conf.json).
const DATA_FOLDER: &str = "com.scip.desktop";
pub const APP_EXE: &str = "scip-desktop.exe";
pub const UNINSTALL_EXE: &str = "uninstall.exe";

/// The SCIP version being installed. The packaging script sets it from apps/desktop's
/// tauri.conf.json; a plain `cargo build` uses this crate's version.
pub fn setup_version() -> &'static str {
    option_env!("SCIP_SETUP_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    pub install_dir: PathBuf,
    pub data_dir: PathBuf,
    /// Name under `HKCU\...\Uninstall`.
    pub registry_key: String,
    /// File name of the Start menu and Desktop shortcuts.
    pub shortcut_name: String,
    pub test_mode: bool,
}

#[derive(Debug, thiserror::Error)]
#[error("LOCALAPPDATA is not set: cannot choose where to install SCIP")]
pub struct NoLocalAppData;

impl Layout {
    pub fn resolve(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, NoLocalAppData> {
        let get = |key: &str| lookup(key).filter(|v| !v.trim().is_empty());
        if get(TEST_ENV).is_some_and(|v| v != "0") {
            let root: PathBuf = match get(TEST_ROOT_ENV) {
                Some(root) => PathBuf::from(root),
                None => std::env::temp_dir().join("scip-setup-test"),
            };
            return Ok(Self {
                install_dir: root.join("SCIP"),
                data_dir: root.join("data"),
                registry_key: "SCIP-Test".into(),
                shortcut_name: "SCIP Test.lnk".into(),
                test_mode: true,
            });
        }
        let local = PathBuf::from(get("LOCALAPPDATA").ok_or(NoLocalAppData)?);
        Ok(Self {
            // Per user, no administrator rights (docs/installer.md).
            install_dir: local.join("Programs").join("SCIP"),
            data_dir: get(DATA_DIR_ENV).map(PathBuf::from).unwrap_or_else(|| local.join(DATA_FOLDER)),
            registry_key: "SCIP".into(),
            shortcut_name: "SCIP.lnk".into(),
            test_mode: false,
        })
    }

    pub fn from_process_env() -> Result<Self, NoLocalAppData> {
        Self::resolve(|key| std::env::var(key).ok())
    }

    pub fn log_file(&self) -> PathBuf {
        self.data_dir.join("logs").join("install.log")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Install,
    Upgrade,
    Uninstall,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Locale {
    Fr,
    En,
}

impl Locale {
    /// French unless Windows is set to another language: SCIP is French-first, and the welcome
    /// screen lets the user switch anyway.
    pub fn from_language_id(primary_language: Option<u16>) -> Self {
        const LANG_FRENCH: u16 = 0x0c;
        match primary_language {
            Some(id) if id != LANG_FRENCH => Locale::En,
            _ => Locale::Fr,
        }
    }

    pub fn detect() -> Self {
        #[cfg(windows)]
        {
            // The low 10 bits of a LANGID are the primary language.
            let langid: u16 = unsafe { windows::Win32::Globalization::GetUserDefaultUILanguage() };
            Self::from_language_id(Some(langid & 0x3ff))
        }
        #[cfg(not(windows))]
        Self::from_language_id(None)
    }

    pub fn pick<'a>(self, fr: &'a str, en: &'a str) -> &'a str {
        match self {
            Locale::Fr => fr,
            Locale::En => en,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Existing {
    pub version: String,
    pub dir: String,
}

/// What `get_context` returns (docs/installer.md), camelCase for the screens.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextInfo {
    pub mode: Mode,
    /// Started by SCIP's updater (`--update`) over an existing install: no screen to click.
    pub auto_update: bool,
    /// Relaunch SCIP once the automatic update is done (not with `--no-launch`).
    pub launch_after: bool,
    pub version: String,
    pub existing: Option<Existing>,
    pub locale: Locale,
    /// Compressed size of the payload (0 for `uninstall.exe`).
    pub payload_bytes: u64,
    pub default_install_dir: String,
}

/// Everything decided once at startup.
#[derive(Debug, Clone)]
pub struct SetupContext {
    pub mode: Mode,
    pub layout: Layout,
    pub existing: Option<Existing>,
    pub locale: Locale,
    /// File whose tail holds the payload (normally this exe).
    pub payload_source: PathBuf,
    pub payload_bytes: u64,
    /// `--update` over an existing install (see `ContextInfo::auto_update`).
    pub auto_update: bool,
    pub launch_after: bool,
}

impl SetupContext {
    /// `--update` only means something over an existing install; elsewhere it is ignored.
    pub fn with_update(mut self, update: bool, no_launch: bool) -> Self {
        self.auto_update = update && self.mode == Mode::Upgrade;
        self.launch_after = self.auto_update && !no_launch;
        self
    }

    pub fn decide_mode(uninstall_flag: bool, existing: Option<&Existing>) -> Mode {
        match (uninstall_flag, existing) {
            (true, _) => Mode::Uninstall,
            (false, Some(_)) => Mode::Upgrade,
            (false, None) => Mode::Install,
        }
    }

    /// Program folder this run works on: an upgrade or an uninstall goes where SCIP already is.
    pub fn target_dir(&self) -> PathBuf {
        match &self.existing {
            Some(existing) if self.mode != Mode::Install => PathBuf::from(&existing.dir),
            _ => self.layout.install_dir.clone(),
        }
    }

    pub fn info(&self) -> ContextInfo {
        ContextInfo {
            mode: self.mode,
            auto_update: self.auto_update,
            launch_after: self.launch_after,
            version: setup_version().to_string(),
            existing: self.existing.clone(),
            locale: self.locale,
            payload_bytes: self.payload_bytes,
            default_install_dir: self.target_dir().display().to_string(),
        }
    }

    pub fn app_exe(&self) -> PathBuf {
        self.target_dir().join(APP_EXE)
    }
}

/// `true` when `path` is `dir` or inside it, ignoring case and `\\?\` prefixes (Windows paths).
pub fn is_inside(path: &Path, dir: &Path) -> bool {
    let norm = |p: &Path| -> String {
        let text = p.to_string_lossy().replace('/', "\\").to_lowercase();
        let text = text.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(text);
        text.trim_end_matches('\\').to_string()
    };
    let (path, dir) = (norm(path), norm(dir));
    !dir.is_empty() && (path == dir || path.starts_with(&format!("{dir}\\")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> =
            pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |key| map.get(key).cloned()
    }

    #[test]
    fn production_layout() {
        let layout = Layout::resolve(env(&[("LOCALAPPDATA", r"C:\Users\a\AppData\Local")])).unwrap();
        let local = Path::new(r"C:\Users\a\AppData\Local");
        assert_eq!(layout.install_dir, local.join("Programs").join("SCIP"));
        assert_eq!(layout.data_dir, local.join("com.scip.desktop"));
        assert_eq!(layout.registry_key, "SCIP");
        assert_eq!(layout.shortcut_name, "SCIP.lnk");
        assert_eq!(layout.log_file(), local.join("com.scip.desktop").join("logs").join("install.log"));
    }

    #[test]
    fn test_layout_never_points_at_the_real_install() {
        let layout = Layout::resolve(env(&[
            ("LOCALAPPDATA", r"C:\Users\a\AppData\Local"),
            (TEST_ENV, "1"),
            (TEST_ROOT_ENV, r"D:\tmp\t"),
        ]))
        .unwrap();
        assert_eq!(layout.install_dir, Path::new(r"D:\tmp\t").join("SCIP"));
        assert_eq!(layout.data_dir, Path::new(r"D:\tmp\t").join("data"));
        assert_eq!(layout.registry_key, "SCIP-Test");
        assert_eq!(layout.shortcut_name, "SCIP Test.lnk");
        assert!(layout.test_mode);
    }

    #[test]
    fn data_dir_override_is_shared_with_scip() {
        let layout =
            Layout::resolve(env(&[("LOCALAPPDATA", "C:/x"), (DATA_DIR_ENV, "E:/scip-data")])).unwrap();
        assert_eq!(layout.data_dir, PathBuf::from("E:/scip-data"));
    }

    #[test]
    fn needs_localappdata_outside_tests() {
        assert!(Layout::resolve(env(&[])).is_err());
        assert!(Layout::resolve(env(&[(TEST_ENV, "0")])).is_err());
    }

    #[test]
    fn mode_from_flags_and_existing_install() {
        let existing = Existing { version: "0.1.0".into(), dir: "C:/x".into() };
        assert_eq!(SetupContext::decide_mode(false, None), Mode::Install);
        assert_eq!(SetupContext::decide_mode(false, Some(&existing)), Mode::Upgrade);
        assert_eq!(SetupContext::decide_mode(true, Some(&existing)), Mode::Uninstall);
    }

    #[test]
    fn locale_defaults_to_french() {
        assert_eq!(Locale::from_language_id(Some(0x0c)), Locale::Fr);
        assert_eq!(Locale::from_language_id(Some(0x09)), Locale::En);
        assert_eq!(Locale::from_language_id(None), Locale::Fr);
    }

    #[test]
    fn inside_is_case_and_prefix_insensitive() {
        let dir = Path::new(r"C:\Users\a\AppData\Local\Programs\SCIP");
        assert!(is_inside(Path::new(r"\\?\c:\users\a\appdata\local\programs\scip\scip-desktop.exe"), dir));
        assert!(is_inside(Path::new(r"C:\Users\a\AppData\Local\Programs\SCIP\resources\node\node.exe"), dir));
        assert!(!is_inside(Path::new(r"C:\Users\a\AppData\Local\Programs\SCIP2\scip-desktop.exe"), dir));
        assert!(!is_inside(Path::new(r"C:\x.exe"), Path::new("")));
    }

    #[test]
    fn upgrade_targets_the_existing_folder() {
        let layout = Layout::resolve(env(&[("LOCALAPPDATA", "C:/x")])).unwrap();
        let mut ctx = SetupContext {
            mode: Mode::Upgrade,
            layout,
            existing: Some(Existing { version: "0.1.0".into(), dir: r"C:\Old\SCIP".into() }),
            locale: Locale::Fr,
            payload_source: PathBuf::new(),
            payload_bytes: 0,
            auto_update: false,
            launch_after: false,
        };
        assert_eq!(ctx.target_dir(), PathBuf::from(r"C:\Old\SCIP"));
        assert_eq!(ctx.info().default_install_dir, r"C:\Old\SCIP");
        ctx.mode = Mode::Install;
        assert_eq!(ctx.target_dir(), ctx.layout.install_dir);
    }

    #[test]
    fn update_flags_apply_only_over_an_existing_install() {
        let layout = Layout::resolve(env(&[("LOCALAPPDATA", "C:/x")])).unwrap();
        let base = SetupContext {
            mode: Mode::Upgrade,
            layout,
            existing: Some(Existing { version: "0.2.0".into(), dir: r"C:\Old\SCIP".into() }),
            locale: Locale::Fr,
            payload_source: PathBuf::new(),
            payload_bytes: 0,
            auto_update: false,
            launch_after: false,
        };
        let updating = base.clone().with_update(true, false);
        assert!(updating.auto_update && updating.launch_after);
        assert!(updating.info().auto_update);
        let closing = base.clone().with_update(true, true);
        assert!(closing.auto_update && !closing.launch_after);
        let mut fresh = base.clone();
        fresh.mode = Mode::Install;
        let fresh = fresh.with_update(true, false);
        assert!(!fresh.auto_update && !fresh.launch_after);
        assert!(!base.with_update(false, false).auto_update);
    }
}
