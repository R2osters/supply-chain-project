//! Start menu and Desktop shortcuts (`.lnk`), made with the shell's own COM objects
//! (IShellLinkW + IPersistFile): the only supported way to write a shortcut Windows fully
//! understands (icon, working folder, pinning).

use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Shortcut {
    pub target: PathBuf,
    pub working_dir: PathBuf,
    /// The exe itself: the SCIP icon is embedded in scip-desktop.exe.
    pub icon: PathBuf,
    pub description: String,
}

/// Folders of the current user, as the shell reports them (the Desktop may be redirected to
/// OneDrive, so `%USERPROFILE%\Desktop` is not reliable).
#[derive(Debug, Clone, Copy)]
pub enum Location {
    StartMenuPrograms,
    Desktop,
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::core::{Interface, HSTRING};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        FOLDERID_Desktop, FOLDERID_Programs, IShellLinkW, SHGetKnownFolderPath, ShellLink, KF_FLAG_DEFAULT,
    };

    fn to_io(e: windows::core::Error) -> io::Error {
        io::Error::other(e.message())
    }

    /// COM needs an initialised apartment on the calling thread; Tauri's command threads may
    /// already have one of another kind. A short-lived thread of our own avoids both issues.
    fn on_com_thread<T: Send + 'static>(
        job: impl FnOnce() -> io::Result<T> + Send + 'static,
    ) -> io::Result<T> {
        std::thread::spawn(move || unsafe {
            let initialised = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
            let result = job();
            if initialised {
                CoUninitialize();
            }
            result
        })
        .join()
        .map_err(|_| io::Error::other("shortcut thread panicked"))?
    }

    pub fn create(path: &Path, shortcut: &Shortcut) -> io::Result<()> {
        let path = path.to_path_buf();
        let shortcut = shortcut.clone();
        on_com_thread(move || unsafe {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let link: IShellLinkW =
                CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(to_io)?;
            link.SetPath(&HSTRING::from(shortcut.target.as_path())).map_err(to_io)?;
            link.SetWorkingDirectory(&HSTRING::from(shortcut.working_dir.as_path())).map_err(to_io)?;
            link.SetIconLocation(&HSTRING::from(shortcut.icon.as_path()), 0).map_err(to_io)?;
            link.SetDescription(&HSTRING::from(shortcut.description.as_str())).map_err(to_io)?;
            let file: IPersistFile = link.cast().map_err(to_io)?;
            file.Save(&HSTRING::from(path.as_path()), true).map_err(to_io)
        })
    }

    pub fn folder(location: Location) -> Option<PathBuf> {
        let id = match location {
            Location::StartMenuPrograms => &FOLDERID_Programs,
            Location::Desktop => &FOLDERID_Desktop,
        };
        unsafe {
            let raw = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
            let path = raw.to_string().ok().map(PathBuf::from);
            CoTaskMemFree(Some(raw.0 as *const _));
            path
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn create(_path: &Path, _shortcut: &Shortcut) -> io::Result<()> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "Windows only"))
    }
    pub fn folder(_location: Location) -> Option<PathBuf> {
        None
    }
}

pub use imp::{create, folder};

/// Full path of the shortcut `name` in `location`.
pub fn shortcut_path(location: Location, name: &str) -> Option<PathBuf> {
    folder(location).map(|dir| dir.join(name))
}

/// Deletes a shortcut if present.
pub fn remove(path: &Path) -> io::Result<()> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

pub fn for_app(app_exe: &Path) -> Shortcut {
    Shortcut {
        target: app_exe.to_path_buf(),
        working_dir: app_exe.parent().map(Path::to_path_buf).unwrap_or_default(),
        icon: app_exe.to_path_buf(),
        description: "SCIP · Supply Chain Intelligence Platform".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_shortcut_uses_the_exe_for_icon_and_folder() {
        let s = for_app(Path::new(r"C:\P\SCIP\scip-desktop.exe"));
        assert_eq!(s.icon, s.target);
        assert_eq!(s.working_dir, PathBuf::from(r"C:\P\SCIP"));
    }

    #[cfg(windows)]
    #[test]
    fn creates_a_real_lnk_in_a_temp_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let target = std::env::current_exe().unwrap();
        let lnk = tmp.path().join("sub").join("SCIP Test.lnk");
        create(&lnk, &for_app(&target)).unwrap();
        let bytes = std::fs::read(&lnk).unwrap();
        // Shell link header: size 0x4C, then the ShellLink CLSID.
        assert_eq!(&bytes[..4], &[0x4c, 0, 0, 0]);
        remove(&lnk).unwrap();
        remove(&lnk).unwrap();
        assert!(!lnk.exists());
    }

    #[cfg(windows)]
    #[test]
    fn known_folders_resolve() {
        assert!(folder(Location::StartMenuPrograms).is_some_and(|p| p.is_absolute()));
        assert!(folder(Location::Desktop).is_some_and(|p| p.is_absolute()));
    }
}
