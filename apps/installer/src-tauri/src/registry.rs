//! The "Apps & features" entry: `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<key>`.
//!
//! Per user (HKCU), like the install itself: no administrator rights. The same key tells the next
//! installer that SCIP is already there (upgrade mode) and where.

use std::path::Path;

use crate::context::{Existing, UNINSTALL_EXE};

pub const UNINSTALL_ROOT: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";

pub fn uninstall_subkey(key_name: &str) -> String {
    format!(r"{UNINSTALL_ROOT}\{key_name}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegValue {
    Str(String),
    Dword(u32),
}

#[derive(Debug, Clone)]
pub struct UninstallEntry<'a> {
    pub version: &'a str,
    pub install_dir: &'a Path,
    pub estimated_size_kb: u64,
}

impl UninstallEntry<'_> {
    /// Exactly what gets written; pure so it can be checked without a registry.
    pub fn values(&self) -> Vec<(&'static str, RegValue)> {
        let dir = self.install_dir.display().to_string();
        let exe = self.install_dir.join(crate::context::APP_EXE).display().to_string();
        let uninstaller = self.install_dir.join(UNINSTALL_EXE).display().to_string();
        vec![
            ("DisplayName", RegValue::Str("SCIP".into())),
            ("DisplayVersion", RegValue::Str(self.version.into())),
            ("Publisher", RegValue::Str("SCIP".into())),
            ("DisplayIcon", RegValue::Str(exe)),
            ("InstallLocation", RegValue::Str(dir)),
            ("UninstallString", RegValue::Str(format!("\"{uninstaller}\" --uninstall"))),
            ("QuietUninstallString", RegValue::Str(format!("\"{uninstaller}\" --uninstall --silent"))),
            // Windows expects KB in a DWORD; SCIP is far below the 4 TB this caps at.
            ("EstimatedSize", RegValue::Dword(self.estimated_size_kb.min(u32::MAX as u64) as u32)),
            ("NoModify", RegValue::Dword(1)),
            ("NoRepair", RegValue::Dword(1)),
        ]
    }
}

/// Reads an existing install from its values. Older installs (the NSIS one) may lack
/// `InstallLocation`; the folder of the uninstaller named in `UninstallString` is then used.
pub fn existing_from_values(
    version: Option<String>,
    install_location: Option<String>,
    uninstall_string: Option<String>,
) -> Option<Existing> {
    let dir = install_location.filter(|d| !d.trim().is_empty()).or_else(|| {
        let command = uninstall_string?;
        let exe = command.trim().trim_start_matches('"').split('"').next()?.to_string();
        Path::new(&exe).parent().map(|p| p.display().to_string())
    })?;
    let dir = dir.trim().trim_matches('"').trim_end_matches('\\').to_string();
    Some(Existing { version: version.unwrap_or_default(), dir })
}

/// Total size of a folder in KB, for `EstimatedSize`.
pub fn dir_size_kb(dir: &Path) -> u64 {
    fn walk(dir: &Path) -> u64 {
        let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
        entries
            .flatten()
            .map(|entry| match entry.file_type() {
                Ok(t) if t.is_dir() => walk(&entry.path()),
                Ok(_) => entry.metadata().map(|m| m.len()).unwrap_or(0),
                Err(_) => 0,
            })
            .sum()
    }
    walk(dir).div_ceil(1024)
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::io;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    pub fn write(subkey: &str, values: &[(&'static str, RegValue)]) -> io::Result<()> {
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(subkey)?;
        for (name, value) in values {
            match value {
                RegValue::Str(s) => key.set_value(name, s)?,
                RegValue::Dword(d) => key.set_value(name, d)?,
            }
        }
        Ok(())
    }

    pub fn delete(subkey: &str) -> io::Result<()> {
        match RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(subkey) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }

    pub fn read_existing(subkey: &str) -> Option<Existing> {
        let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(subkey, KEY_READ).ok()?;
        let get = |name: &str| key.get_value::<String, _>(name).ok();
        existing_from_values(get("DisplayVersion"), get("InstallLocation"), get("UninstallString"))
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    use std::io;

    pub fn write(_subkey: &str, _values: &[(&'static str, RegValue)]) -> io::Result<()> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "Windows only"))
    }
    pub fn delete(_subkey: &str) -> io::Result<()> {
        Ok(())
    }
    pub fn read_existing(_subkey: &str) -> Option<Existing> {
        None
    }
}

pub use imp::{delete, read_existing, write};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_follow_the_spec() {
        let dir = Path::new(r"C:\Users\a\AppData\Local\Programs\SCIP");
        let entry = UninstallEntry { version: "0.3.0", install_dir: dir, estimated_size_kb: 1_200_000 };
        let values = entry.values();
        let get = |name: &str| values.iter().find(|(n, _)| *n == name).map(|(_, v)| v.clone()).unwrap();
        assert_eq!(get("DisplayName"), RegValue::Str("SCIP".into()));
        assert_eq!(get("DisplayVersion"), RegValue::Str("0.3.0".into()));
        assert_eq!(get("Publisher"), RegValue::Str("SCIP".into()));
        assert_eq!(get("DisplayIcon"), RegValue::Str(format!(r"{}\scip-desktop.exe", dir.display())));
        assert_eq!(get("InstallLocation"), RegValue::Str(dir.display().to_string()));
        assert_eq!(
            get("UninstallString"),
            RegValue::Str(format!("\"{}\\uninstall.exe\" --uninstall", dir.display()))
        );
        assert_eq!(get("EstimatedSize"), RegValue::Dword(1_200_000));
        assert_eq!(get("NoModify"), RegValue::Dword(1));
        assert_eq!(get("NoRepair"), RegValue::Dword(1));
    }

    #[test]
    fn existing_install_falls_back_to_the_uninstaller_folder() {
        let from_location = existing_from_values(Some("0.2.0".into()), Some(r"C:\P\SCIP\".into()), None);
        assert_eq!(from_location, Some(Existing { version: "0.2.0".into(), dir: r"C:\P\SCIP".into() }));
        let from_command = existing_from_values(
            Some("0.1.0".into()),
            None,
            Some(r#""C:\Users\a\AppData\Local\SCIP\uninstall.exe" /S"#.into()),
        );
        assert_eq!(from_command.unwrap().dir, r"C:\Users\a\AppData\Local\SCIP");
        assert_eq!(existing_from_values(None, None, None), None);
    }

    #[test]
    fn size_in_kb_rounds_up() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("a")).unwrap();
        std::fs::write(tmp.path().join("a").join("f"), vec![0u8; 1500]).unwrap();
        std::fs::write(tmp.path().join("g"), vec![0u8; 100]).unwrap();
        assert_eq!(dir_size_kb(tmp.path()), 2);
    }

    /// Uses its own key outside `Uninstall`, so it never shows up in "Apps & features".
    #[cfg(windows)]
    #[test]
    fn write_read_delete_roundtrip() {
        let subkey = format!(r"Software\SCIP-Setup-UnitTests\{}", std::process::id());
        let dir = Path::new(r"C:\Test\SCIP");
        let entry = UninstallEntry { version: "9.9.9", install_dir: dir, estimated_size_kb: 10 };
        write(&subkey, &entry.values()).unwrap();
        let existing = read_existing(&subkey).unwrap();
        assert_eq!(existing, Existing { version: "9.9.9".into(), dir: r"C:\Test\SCIP".into() });
        delete(&subkey).unwrap();
        assert_eq!(read_existing(&subkey), None);
        delete(&subkey).unwrap();
        let _ = delete(r"Software\SCIP-Setup-UnitTests");
    }
}
