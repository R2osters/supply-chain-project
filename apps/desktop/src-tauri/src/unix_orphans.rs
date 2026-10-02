//! What `win_job.rs` does on Windows, for macOS and Linux: no sidecar may outlive SCIP.
//!
//! There is no job object here. Three measures replace it:
//!
//! - **Linux**: every child asks the kernel for a signal when its parent dies
//!   (`PR_SET_PDEATHSIG`). The "parent" of that rule is the *thread* that started the child,
//!   which is why sidecars are started from one thread that lives as long as the process
//!   (`supervisor::process`).
//! - **macOS**, which has no such request: the window starts a watcher, `scip-desktop --reap`,
//!   that waits for SCIP to die and then stops what it left (`watch_over_this_process`).
//! - **Both**: when the window starts, once the single-instance lock is held and before ports
//!   are picked, what a killed SCIP left behind is stopped (`stop_leftovers`). PostgreSQL would
//!   hold `pgdata`, the API port 3001, the AI its memory.
//!
//! A leftover is a process of this user whose executable is in this installation's
//! `resources/` and that has no living SCIP above it. Processes are found by executable, not
//! by a recorded pid: a pid file outlives a reboot and then names someone else's process.
//! A service that does have a living SCIP above it (a backup or a restore running without a
//! window) is never touched: the window then refuses to start, as it does on Windows when it
//! finds `pgdata` locked.
//!
//! The headless modes never clean up: they refuse to run while SCIP is open.
//!
//! Children stay in SCIP's process group on purpose: a Ctrl-C in the terminal SCIP was started
//! from reaches them too.

use std::path::Path;
use std::process::Command;

/// Linux: the child gets SIGINT when the thread that started it dies. SIGINT is PostgreSQL's
/// fast shutdown (sessions ended, files left clean) and ends Node and Python like a Ctrl-C.
/// Nothing on macOS: the watcher and `stop_leftovers` cover it.
pub fn die_with_parent(command: &mut Command) {
    #[cfg(target_os = "linux")]
    imp::die_with_parent(command);
    #[cfg(not(target_os = "linux"))]
    let _ = command;
}

/// Another SCIP is alive and has services running from this installation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlreadyRunning {
    /// The SCIP processes found above those services.
    pub pids: Vec<u32>,
}

/// Stops what a previous SCIP left running from `resources_root`. Best effort: a process that
/// will not stop is logged, and the startup step that needs its port or its files reports it.
/// Refuses, touching nothing, when a living SCIP still owns services there.
/// Call only while holding the single-instance lock, or a second launch would stop the
/// services of the first.
pub fn stop_leftovers(resources_root: &Path) -> Result<(), AlreadyRunning> {
    #[cfg(unix)]
    {
        imp::stop_leftovers(resources_root)
    }
    #[cfg(not(unix))]
    {
        let _ = resources_root;
        Ok(())
    }
}

/// macOS: starts the watcher that stops this SCIP's services if it dies without stopping them
/// (a crash, a Force Quit). Linux needs none: the kernel signals the services itself.
pub fn watch_over_this_process() {
    #[cfg(target_os = "macos")]
    imp::watch_over_this_process();
}

/// `--reap <pid>`: the watcher's command line. `None` when the arguments ask for something else.
#[cfg(any(unix, test))]
pub fn reap_request(args: &[String]) -> Option<u32> {
    let at: usize = args.iter().position(|a| a == "--reap")?;
    args.get(at + 1)?.parse().ok()
}

/// The watcher: waits until `parent` is no longer this process's parent (SCIP exited, crashed or
/// was killed), then stops what it left running. After a normal exit there is nothing left.
#[cfg(unix)]
pub fn run_reaper(parent: u32) -> i32 {
    imp::run_reaper(parent)
}

#[cfg(any(unix, test))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct Process {
    pid: u32,
    parent: u32,
    executable: std::path::PathBuf,
}

/// What to stop and how, and what must be left alone.
#[cfg(any(unix, test))]
#[derive(Debug, Default, PartialEq, Eq)]
struct Leftovers {
    /// The servers themselves: SIGINT (fast shutdown) takes their backends down with them.
    postmasters: Vec<u32>,
    /// Every orphaned PostgreSQL process, to wait for.
    postgres: Vec<u32>,
    /// API, AI and anything else orphaned that was started from `resources/`.
    others: Vec<u32>,
    /// Living SCIPs, other than this process, that still have services under them.
    running: Vec<u32>,
}

/// A parent chain longer than this is a loop in a corrupted listing.
#[cfg(any(unix, test))]
const MAX_ANCESTORS: usize = 64;

/// Sorts this user's processes started from `root`. A service with a living SCIP among its
/// ancestors belongs to that SCIP: reported in `running` when it is another process than this
/// one, ignored when it is this one. A service with none is a leftover: a PostgreSQL process
/// whose parent is not one is a server, its children are its backends.
#[cfg(any(unix, test))]
fn leftovers(processes: &[Process], root: &Path, own_pid: u32, scip: &Path) -> Leftovers {
    let server: std::path::PathBuf = root.join("postgres").join("bin").join("postgres");
    let find = |pid: u32| processes.iter().find(|p: &&Process| p.pid == pid);
    // By full path, or by file name when the listing gives the path SCIP was launched with.
    let is_scip = |p: &Process| {
        p.executable == scip || (scip.file_name().is_some() && p.executable.file_name() == scip.file_name())
    };
    let owner = |service: &Process| -> Option<u32> {
        let mut current: &Process = service;
        for _ in 0..MAX_ANCESTORS {
            let parent: &Process = find(current.parent).filter(|p: &&Process| p.pid != current.pid)?;
            if is_scip(parent) {
                return Some(parent.pid);
            }
            current = parent;
        }
        None
    };

    let mut found = Leftovers::default();
    let mut orphans: Vec<&Process> = Vec::new();
    for service in processes.iter().filter(|p| p.pid != own_pid && p.executable.starts_with(root)) {
        match owner(service) {
            None => orphans.push(service),
            Some(pid) if pid == own_pid => {}
            Some(pid) => {
                if !found.running.contains(&pid) {
                    found.running.push(pid);
                }
            }
        }
    }
    found.postgres = orphans.iter().filter(|p| p.executable == server).map(|p| p.pid).collect();
    found.postmasters = orphans
        .iter()
        .filter(|p| p.executable == server && !found.postgres.contains(&p.parent))
        .map(|p| p.pid)
        .collect();
    found.others = orphans.iter().filter(|p| p.executable != server).map(|p| p.pid).collect();
    found
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

    use super::{leftovers, AlreadyRunning, Leftovers, Process};

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

    pub fn stop_leftovers(resources_root: &Path) -> Result<(), AlreadyRunning> {
        // The kernel reports real paths; Tauri's resource folder may be reached through a link.
        let root: PathBuf = resources_root.canonicalize().unwrap_or_else(|_| resources_root.to_path_buf());
        let scip: PathBuf = std::env::current_exe().and_then(|exe| exe.canonicalize()).unwrap_or_default();
        let found: Leftovers = leftovers(&processes(), &root, std::process::id(), &scip);
        if !found.running.is_empty() {
            return Err(AlreadyRunning { pids: found.running });
        }
        if found == Leftovers::default() {
            return Ok(());
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
        Ok(())
    }

    #[cfg(target_os = "macos")]
    pub fn watch_over_this_process() {
        use std::process::{Command, Stdio};
        // Never waited for: it outlives this process by design.
        let started = std::env::current_exe().and_then(|exe| {
            Command::new(exe)
                .args(["--reap", &std::process::id().to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map(|_| ())
        });
        if let Err(e) = started {
            log::warn!("no watcher for this SCIP's services, a crash would leave them running: {e}");
        }
    }

    pub fn run_reaper(parent: u32) -> i32 {
        // When the parent dies this process is handed to another one: no pid to poll, so no
        // risk of watching a stranger that was given the same number.
        // SAFETY: getppid has no failure mode and no argument.
        while unsafe { libc::getppid() } as u32 == parent {
            std::thread::sleep(Duration::from_secs(1));
        }
        let bundled: Option<PathBuf> = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(crate::services::bundled_resource_dir));
        let resources = crate::services::resolve_resources_root(
            std::env::var(crate::services::RESOURCES_DIR_ENV).ok(),
            bundled.as_deref(),
        );
        // A service that another living SCIP owns is not this one's to stop: nothing to do then.
        if let Some(root) = resources {
            let _ = stop_leftovers(&root);
        }
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const SCIP: &str = "/usr/bin/scip-desktop";

    fn process(pid: u32, parent: u32, executable: &str) -> Process {
        Process { pid, parent, executable: PathBuf::from(executable) }
    }

    fn sorted(processes: &[Process], root: &str, own_pid: u32) -> Leftovers {
        leftovers(processes, Path::new(root), own_pid, Path::new(SCIP))
    }

    #[test]
    fn only_processes_started_from_this_installation_are_stopped() {
        let found = sorted(
            &[
                process(1, 0, "/usr/lib/systemd/systemd"),
                process(10, 1, "/usr/lib/SCIP/resources/postgres/bin/postgres"),
                process(11, 10, "/usr/lib/SCIP/resources/postgres/bin/postgres"),
                process(12, 10, "/usr/lib/SCIP/resources/postgres/bin/postgres"),
                process(20, 1, "/usr/lib/SCIP/resources/node/node"),
                process(21, 1, "/usr/lib/SCIP/resources/ai/scip-ai"),
                process(30, 1, "/usr/bin/node"),
                process(31, 1, "/usr/lib/postgresql/16/bin/postgres"),
                process(32, 1, "/usr/lib/SCIP/resources-old/node/node"),
                process(33, 1, SCIP),
            ],
            "/usr/lib/SCIP/resources",
            33,
        );
        assert_eq!(found.postmasters, vec![10], "the server, not its backends");
        assert_eq!(found.postgres, vec![10, 11, 12]);
        assert_eq!(found.others, vec![20, 21]);
        assert!(found.running.is_empty());
    }

    #[test]
    fn a_service_handed_to_another_parent_is_a_leftover() {
        // Reparented to init (pid 1), to a session manager, or to a parent that is not listed
        // because it belongs to root: in each case no SCIP stands above it any more.
        let found = sorted(
            &[
                process(1, 0, "/sbin/launchd"),
                process(900, 1, "/usr/lib/systemd/systemd"),
                process(20, 1, "/r/node/node"),
                process(21, 900, "/r/ai/scip-ai"),
                process(22, 4242, "/r/node/node"),
            ],
            "/r",
            99,
        );
        assert_eq!(found.others, vec![20, 21, 22]);
        assert!(found.running.is_empty());
    }

    #[test]
    fn services_under_a_living_scip_are_left_alone_and_reported() {
        // A backup running without a window: its PostgreSQL is not ours to stop.
        let running = [
            process(1, 0, "/sbin/launchd"),
            process(50, 1, SCIP),
            process(51, 50, "/r/postgres/bin/postgres"),
            process(52, 51, "/r/postgres/bin/postgres"),
            process(53, 50, "/r/node/node"),
            process(60, 1, "/r/ai/scip-ai"),
            process(99, 1, SCIP),
        ];
        let found = sorted(&running, "/r", 99);
        assert_eq!(found.running, vec![50], "one SCIP, named once");
        assert_eq!(found.others, vec![60], "the orphan next to it is still a leftover");
        assert!(found.postmasters.is_empty() && found.postgres.is_empty());

        // SCIP launched through a link or a relative path: recognised by its file name.
        let relative = [process(50, 1, "./scip-desktop"), process(53, 50, "/r/node/node")];
        assert_eq!(sorted(&relative, "/r", 99).running, vec![50]);
    }

    #[test]
    fn nothing_is_stopped_on_a_clean_start_nor_among_this_process_s_own_services() {
        let root = "/Applications/SCIP.app/Contents/Resources/resources";
        let scip = "/Applications/SCIP.app/Contents/MacOS/scip-desktop";
        let running = [
            process(1, 0, "/sbin/launchd"),
            process(40, 1, scip),
            // After a restore, the window boots again in the same process.
            process(41, 40, "/Applications/SCIP.app/Contents/Resources/resources/node/node"),
        ];
        let sort = |own: u32| leftovers(&running, Path::new(root), own, Path::new(scip));
        assert_eq!(leftovers(&running[..2], Path::new(root), 40, Path::new(scip)), Leftovers::default());
        assert_eq!(sort(40), Leftovers::default(), "its own service is the supervisor's to manage");
        assert_eq!(sort(41), Leftovers::default(), "never this very process");
    }

    #[test]
    fn two_servers_left_behind_are_both_stopped() {
        let found = sorted(
            &[
                process(5, 1, "/r/postgres/bin/postgres"),
                process(6, 5, "/r/postgres/bin/postgres"),
                process(7, 1, "/r/postgres/bin/postgres"),
            ],
            "/r",
            99,
        );
        assert_eq!(found.postmasters, vec![5, 7]);
    }

    #[test]
    fn a_looping_parent_chain_ends() {
        let found = sorted(&[process(5, 6, "/r/node/node"), process(6, 5, "/bin/sh")], "/r", 99);
        assert_eq!(found.others, vec![5]);
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

    #[test]
    fn the_watcher_is_asked_for_by_its_own_flag() {
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<String>>();
        assert_eq!(reap_request(&args(&["--reap", "4821"])), Some(4821));
        assert_eq!(reap_request(&args(&["--reap"])), None);
        assert_eq!(reap_request(&args(&["--reap", "x"])), None);
        assert_eq!(reap_request(&args(&["--backup"])), None);
        assert_eq!(reap_request(&args(&[])), None);
    }
}
