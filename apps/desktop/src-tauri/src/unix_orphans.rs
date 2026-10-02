//! What `win_job.rs` does on Windows, for macOS and Linux: no sidecar may outlive SCIP.
//!
//! There is no job object here. Two measures replace it:
//!
//! - **Linux**: every child asks the kernel for a signal when its parent dies
//!   (`PR_SET_PDEATHSIG`). The "parent" of that rule is the *thread* that started the child, so
//!   services are only started from threads that live as long as their supervisor: the
//!   supervisor thread of the window (`bridge::boot`, which monitors until shutdown) and the
//!   main thread of the headless modes.
//! - **macOS and Linux**: when the window starts, once the single-instance lock is held and
//!   before ports are picked, whatever a killed SCIP left behind is stopped (`stop_leftovers`):
//!   the processes of this user whose executable is in this installation's `resources/`.
//!   PostgreSQL would hold `pgdata`, the API port 3001, the AI its memory. They are found by
//!   executable rather than by a recorded pid: a pid file outlives a reboot and then names
//!   someone else's process.
//!
//! The headless modes never clean up: they refuse to run while SCIP is open.
//!
//! Children stay in SCIP's process group on purpose: a Ctrl-C in the terminal SCIP was started
//! from reaches them too.

use std::path::Path;
use std::process::Command;

/// Linux: the child gets SIGINT when the thread that started it dies. SIGINT is PostgreSQL's
/// fast shutdown (sessions ended, files left clean) and ends Node and Python like a Ctrl-C.
/// Nothing on macOS, which has no such request: `stop_leftovers` covers it at the next start.
pub fn die_with_parent(command: &mut Command) {
    #[cfg(target_os = "linux")]
    imp::die_with_parent(command);
    #[cfg(not(target_os = "linux"))]
    let _ = command;
}

/// Stops what a previous SCIP left running from `resources_root`. Best effort: a process that
/// will not stop is logged, and the startup step that needs its port or its files reports it.
/// Call only while holding the single-instance lock, or a second launch would stop the
/// services of the first.
pub fn stop_leftovers(resources_root: &Path) {
    #[cfg(unix)]
    imp::stop_leftovers(resources_root);
    #[cfg(not(unix))]
    let _ = resources_root;
}

#[cfg(any(unix, test))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct Process {
    pid: u32,
    parent: u32,
    executable: std::path::PathBuf,
}

/// What to stop, and how.
#[cfg(any(unix, test))]
#[derive(Debug, Default, PartialEq, Eq)]
struct Leftovers {
    /// The servers themselves: SIGINT (fast shutdown) takes their backends down with them.
    postmasters: Vec<u32>,
    /// Every PostgreSQL process, to wait for.
    postgres: Vec<u32>,
    /// API, AI and anything else started from `resources/`.
    others: Vec<u32>,
}

/// Sorts the processes started from `root` (already limited to this user). A PostgreSQL
/// process whose parent is not one is a server; its children are its backends.
#[cfg(any(unix, test))]
fn leftovers(processes: &[Process], root: &Path, own_pid: u32) -> Leftovers {
    let server: std::path::PathBuf = root.join("postgres").join("bin").join("postgres");
    let ours = || processes.iter().filter(|p| p.pid != own_pid && p.executable.starts_with(root));
    let postgres: Vec<u32> = ours().filter(|p| p.executable == server).map(|p| p.pid).collect();
    Leftovers {
        postmasters: ours()
            .filter(|p| p.executable == server && !postgres.contains(&p.parent))
            .map(|p| p.pid)
            .collect(),
        others: ours().filter(|p| p.executable != server).map(|p| p.pid).collect(),
        postgres,
    }
}

/// macOS: one process per line of `ps -xo pid=,ppid=,comm=`, where `comm` is the full path of
/// the executable (it may hold spaces, so it is everything after the two numbers).
#[cfg(any(target_os = "macos", test))]
fn parse_ps(listing: &str) -> Vec<Process> {
    listing
        .lines()
        .filter_map(|line: &str| {
            let (pid, rest) = line.trim_start().split_once(char::is_whitespace)?;
            let (parent, executable) = rest.trim_start().split_once(char::is_whitespace)?;
            Some(Process {
                pid: pid.parse().ok()?,
                parent: parent.parse().ok()?,
                executable: std::path::PathBuf::from(executable.trim()),
            })
        })
        .collect()
}

/// Linux: the parent pid in `/proc/<pid>/stat`, `pid (name) state ppid ...`. The name may hold
/// spaces and parentheses, so fields are counted from the last `)`.
#[cfg(any(target_os = "linux", test))]
fn parent_from_stat(stat: &str) -> Option<u32> {
    stat.rsplit_once(')')?.1.split_whitespace().nth(1)?.parse().ok()
}

#[cfg(unix)]
mod imp {
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use super::{leftovers, Leftovers, Process};

    /// A fast shutdown takes a second or two; a checkpoint on a slow disk can take longer.
    const POSTGRES_FAST: Duration = Duration::from_secs(20);
    const POSTGRES_IMMEDIATE: Duration = Duration::from_secs(10);
    const OTHERS: Duration = Duration::from_secs(5);

    #[cfg(target_os = "linux")]
    pub fn die_with_parent(command: &mut std::process::Command) {
        use std::os::unix::process::CommandExt;
        let parent: libc::pid_t = std::process::id() as libc::pid_t;
        // SAFETY: runs in the child between fork and exec, and only calls prctl and getppid,
        // both async-signal-safe; it touches no memory shared with the parent.
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGINT) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                // SCIP died between fork and prctl: the request came too late to be honoured.
                if libc::getppid() != parent {
                    return Err(std::io::Error::other("SCIP exited while starting this process"));
                }
                Ok(())
            });
        }
    }

    #[cfg(target_os = "linux")]
    fn processes() -> Vec<Process> {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: getuid has no failure mode and no argument.
        let own_uid: u32 = unsafe { libc::getuid() };
        let Ok(entries) = std::fs::read_dir("/proc") else { return Vec::new() };
        entries
            .flatten()
            .filter_map(|entry| {
                let pid: u32 = entry.file_name().to_str()?.parse().ok()?;
                // /usr/lib/SCIP is shared by every account of the computer: another user's
                // SCIP runs the same executables. Theirs are not ours to stop.
                if entry.metadata().ok()?.uid() != own_uid {
                    return None;
                }
                // The link, not the 15-character name: it is the whole path, and the kernel's.
                let executable: PathBuf = std::fs::read_link(entry.path().join("exe")).ok()?;
                let stat: String = std::fs::read_to_string(entry.path().join("stat")).ok()?;
                Some(Process { pid, parent: super::parent_from_stat(&stat)?, executable })
            })
            .collect()
    }

    #[cfg(target_os = "macos")]
    fn processes() -> Vec<Process> {
        // Without -a, ps lists the processes of the calling user only; -x adds those without
        // a terminal, which is all of ours.
        let listing = std::process::Command::new("/bin/ps")
            .args(["-xo", "pid=,ppid=,comm="])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output();
        match listing {
            Ok(output) => super::parse_ps(&String::from_utf8_lossy(&output.stdout)),
            Err(e) => {
                log::warn!("could not list processes to stop leftovers: {e}");
                Vec::new()
            }
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn processes() -> Vec<Process> {
        Vec::new()
    }

    fn signal(pid: u32, signal: libc::c_int) {
        // SAFETY: kill only takes integers; a pid that is gone returns ESRCH, ignored here.
        unsafe {
            libc::kill(pid as libc::pid_t, signal);
        }
    }

    fn alive(pid: u32) -> bool {
        // SAFETY: signal 0 checks for existence without sending anything.
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }

    /// Waits until none of `pids` remains; returns those still there at the deadline.
    fn wait_gone(pids: &[u32], timeout: Duration) -> Vec<u32> {
        let deadline: Instant = Instant::now() + timeout;
        loop {
            let remaining: Vec<u32> = pids.iter().copied().filter(|pid: &u32| alive(*pid)).collect();
            if remaining.is_empty() || Instant::now() >= deadline {
                return remaining;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    pub fn stop_leftovers(resources_root: &Path) {
        // The kernel reports real paths; Tauri's resource folder may be reached through a link.
        let root: PathBuf = resources_root.canonicalize().unwrap_or_else(|_| resources_root.to_path_buf());
        let found: Leftovers = leftovers(&processes(), &root, std::process::id());
        if found == Leftovers::default() {
            return;
        }
        log::warn!(
            "a previous SCIP did not stop its services: stopping PostgreSQL {:?} and {:?}",
            found.postmasters,
            found.others
        );

        found.postmasters.iter().for_each(|pid: &u32| signal(*pid, libc::SIGINT));
        found.others.iter().for_each(|pid: &u32| signal(*pid, libc::SIGTERM));

        let stuck: Vec<u32> = wait_gone(&found.others, OTHERS);
        stuck.iter().for_each(|pid: &u32| signal(*pid, libc::SIGKILL));

        // Never SIGKILL for PostgreSQL: SIGQUIT is its own emergency stop, which a later start
        // recovers from by replaying its journal.
        if !wait_gone(&found.postgres, POSTGRES_FAST).is_empty() {
            found.postmasters.iter().for_each(|pid: &u32| signal(*pid, libc::SIGQUIT));
            let left: Vec<u32> = wait_gone(&found.postgres, POSTGRES_IMMEDIATE);
            if !left.is_empty() {
                log::error!("PostgreSQL processes {left:?} of a previous SCIP are still running");
            }
        }
        let left: Vec<u32> = wait_gone(&stuck, OTHERS);
        if !left.is_empty() {
            log::error!("processes {left:?} of a previous SCIP are still running");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn process(pid: u32, parent: u32, executable: &str) -> Process {
        Process { pid, parent, executable: PathBuf::from(executable) }
    }

    #[test]
    fn only_processes_started_from_this_installation_are_stopped() {
        let root = Path::new("/usr/lib/SCIP/resources");
        let found = leftovers(
            &[
                process(10, 1, "/usr/lib/SCIP/resources/postgres/bin/postgres"),
                process(11, 10, "/usr/lib/SCIP/resources/postgres/bin/postgres"),
                process(12, 10, "/usr/lib/SCIP/resources/postgres/bin/postgres"),
                process(20, 1, "/usr/lib/SCIP/resources/node/node"),
                process(21, 1, "/usr/lib/SCIP/resources/ai/scip-ai"),
                process(30, 1, "/usr/bin/node"),
                process(31, 1, "/usr/lib/postgresql/16/bin/postgres"),
                process(32, 1, "/usr/lib/SCIP/resources-old/node/node"),
                process(33, 1, "/usr/bin/scip-desktop"),
            ],
            root,
            33,
        );
        assert_eq!(found.postmasters, vec![10], "the server, not its backends");
        assert_eq!(found.postgres, vec![10, 11, 12]);
        assert_eq!(found.others, vec![20, 21]);
    }

    #[test]
    fn nothing_is_stopped_on_a_clean_start_and_never_this_process() {
        let root = Path::new("/Applications/SCIP.app/Contents/Resources/resources");
        let running = [
            process(1, 0, "/sbin/launchd"),
            process(40, 1, "/Applications/SCIP.app/Contents/MacOS/scip-desktop"),
            // A headless mode started from resources/ would be this very process.
            process(41, 1, "/Applications/SCIP.app/Contents/Resources/resources/node/node"),
        ];
        assert_eq!(leftovers(&running[..2], root, 40), Leftovers::default());
        assert_eq!(leftovers(&running, root, 41), Leftovers::default());
        assert_eq!(leftovers(&running, root, 40).others, vec![41]);
    }

    #[test]
    fn two_servers_left_behind_are_both_stopped() {
        let root = Path::new("/r");
        let found = leftovers(
            &[
                process(5, 1, "/r/postgres/bin/postgres"),
                process(6, 5, "/r/postgres/bin/postgres"),
                process(7, 1, "/r/postgres/bin/postgres"),
            ],
            root,
            99,
        );
        assert_eq!(found.postmasters, vec![5, 7]);
    }

    #[test]
    fn ps_lines_keep_paths_with_spaces() {
        let listing: String = [
            "    1     0 /sbin/launchd",
            "  412     1 /Applications/SCIP.app/Contents/Resources/resources/node/node",
            " 7001   412 /Users/a/My Apps/SCIP.app/Contents/MacOS/scip-desktop",
            "",
            "not a line",
        ]
        .join("\n");
        assert_eq!(
            parse_ps(&listing),
            vec![
                process(1, 0, "/sbin/launchd"),
                process(412, 1, "/Applications/SCIP.app/Contents/Resources/resources/node/node"),
                process(7001, 412, "/Users/a/My Apps/SCIP.app/Contents/MacOS/scip-desktop"),
            ]
        );
    }

    #[test]
    fn parent_pid_is_read_after_a_name_with_spaces_and_parentheses() {
        assert_eq!(parent_from_stat("812 (node) S 1 812 812 0 -1 4194304"), Some(1));
        assert_eq!(parent_from_stat("44 (my (odd) name) R 7 44 44 0"), Some(7));
        assert_eq!(parent_from_stat("garbage"), None);
    }
}
