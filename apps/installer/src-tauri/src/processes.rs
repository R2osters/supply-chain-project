//! Finds and stops programs running from the SCIP folder (SCIP itself, and the node/postgres/AI
//! sidecars it started). Files of a running exe are locked on Windows: an upgrade or uninstall
//! cannot replace or delete them.
//!
//! Matching is by full image path, never by name: a user may run another SCIP (e.g. the real one
//! while testing with `SCIP_SETUP_TEST`) or unrelated `node.exe`/`postgres.exe` that must survive.

use std::path::{Path, PathBuf};

use crate::context::{is_inside, APP_EXE};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunningProcess {
    pub pid: u32,
    pub exe: PathBuf,
}

/// Waits up to `patience` for SCIP to close on its own (an update it started), then stops what is
/// still running from `dir`, SCIP first.
pub fn wait_then_stop(dir: &Path, patience: std::time::Duration) {
    let deadline = std::time::Instant::now() + patience;
    while app_running_in(list(), dir) && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    for process in running_in(list(), dir) {
        kill(process.pid);
    }
}

/// Processes whose executable lives in `dir`, SCIP itself first (killing it lets its job object
/// take the sidecars down with it).
pub fn running_in(all: Vec<RunningProcess>, dir: &Path) -> Vec<RunningProcess> {
    let mut inside: Vec<RunningProcess> = all.into_iter().filter(|p| is_inside(&p.exe, dir)).collect();
    inside.sort_by_key(|p| !is_app(&p.exe));
    inside
}

/// `SCIP.exe` is the name the previous NSIS installer gave the same program.
fn is_app(exe: &Path) -> bool {
    exe.file_name().is_some_and(|n| {
        let name = n.to_string_lossy();
        name.eq_ignore_ascii_case(APP_EXE) || name.eq_ignore_ascii_case("SCIP.exe")
    })
}

/// Is SCIP (the app, not just a sidecar) running from `dir`?
pub fn app_running_in(all: Vec<RunningProcess>, dir: &Path) -> bool {
    running_in(all, dir).iter().any(|p| is_app(&p.exe))
}

#[cfg(windows)]
mod imp {
    use super::RunningProcess;
    use std::path::PathBuf;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    fn image_path(pid: u32) -> Option<PathBuf> {
        unsafe {
            let handle = Handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?);
            let mut buffer = [0u16; 1024];
            let mut len = buffer.len() as u32;
            QueryFullProcessImageNameW(handle.0, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut len)
                .ok()?;
            Some(PathBuf::from(String::from_utf16_lossy(&buffer[..len as usize])))
        }
    }

    /// Every process whose image path we can read (others belong to other users or the system,
    /// and cannot be running from a per-user SCIP folder anyway).
    pub fn list() -> Vec<RunningProcess> {
        let mut out = Vec::new();
        unsafe {
            let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
            let snapshot = Handle(snapshot);
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            let mut ok = Process32FirstW(snapshot.0, &mut entry).is_ok();
            while ok {
                let pid = entry.th32ProcessID;
                if pid != 0 && pid != std::process::id() {
                    if let Some(exe) = image_path(pid) {
                        out.push(RunningProcess { pid, exe });
                    }
                }
                ok = Process32NextW(snapshot.0, &mut entry).is_ok();
            }
        }
        out
    }

    /// Terminates `pid` and waits up to 5 s for it to be gone (its files unlocked).
    pub fn kill(pid: u32) -> bool {
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, false, pid) else {
                return false;
            };
            let handle = Handle(handle);
            let killed = TerminateProcess(handle.0, 1).is_ok();
            WaitForSingleObject(handle.0, 5000);
            killed
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::RunningProcess;
    pub fn list() -> Vec<RunningProcess> {
        Vec::new()
    }
    pub fn kill(_pid: u32) -> bool {
        false
    }
}

pub use imp::{kill, list};

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, exe: &str) -> RunningProcess {
        RunningProcess { pid, exe: PathBuf::from(exe) }
    }

    #[test]
    fn only_processes_from_the_folder_app_first() {
        let dir = Path::new(r"C:\T\SCIP");
        let all = vec![
            p(1, r"C:\T\SCIP\resources\node\node.exe"),
            p(2, r"C:\Other\scip-desktop.exe"),
            p(3, r"C:\T\SCIP\scip-desktop.exe"),
            p(4, r"C:\Program Files\nodejs\node.exe"),
        ];
        let inside = running_in(all.clone(), dir);
        assert_eq!(inside.iter().map(|p| p.pid).collect::<Vec<_>>(), [3, 1]);
        assert!(app_running_in(all.clone(), dir));
        assert!(!app_running_in(all, Path::new(r"C:\Nowhere")));
        assert!(app_running_in(vec![p(9, r"C:\T\SCIP\SCIP.exe")], dir), "NSIS-era name");
    }

    #[cfg(windows)]
    #[test]
    fn lists_real_processes() {
        // At least explorer or this test runner's parent is visible; our own pid is skipped.
        let all = list();
        assert!(!all.is_empty());
        assert!(all.iter().all(|p| p.pid != std::process::id()));
    }
}
