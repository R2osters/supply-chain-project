//! Process spawning behind a trait, so the supervisor logic is tested with fakes and only
//! this file talks to the OS.

use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use super::spec::ProcessCommand;

/// Logs above this size are moved to `<name>.log.1` at the next start, so a chatty sidecar
/// cannot fill the disk over months of uptime.
const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitInfo {
    /// `None` when the process was killed without an exit code.
    pub code: Option<i32>,
}

impl ExitInfo {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }

    pub fn describe(&self) -> String {
        match self.code {
            Some(code) => format!("exit code {code}"),
            None => "terminated without an exit code".to_owned(),
        }
    }
}

pub trait ChildProcess: Send {
    fn try_wait(&mut self) -> io::Result<Option<ExitInfo>>;
    fn kill(&mut self) -> io::Result<()>;
}

pub trait ProcessSpawner: Send + Sync {
    /// Starts `command` with stdout/stderr appended to `log_file`.
    fn spawn(&self, command: &ProcessCommand, log_file: &Path) -> io::Result<Box<dyn ChildProcess>>;
}

/// The real implementation, backed by `std::process`.
pub struct StdSpawner;

impl ProcessSpawner for StdSpawner {
    fn spawn(&self, command: &ProcessCommand, log_file: &Path) -> io::Result<Box<dyn ChildProcess>> {
        rotate_if_large(log_file, MAX_LOG_BYTES)?;
        let log: Arc<Mutex<File>> = Arc::new(Mutex::new(open_append(log_file)?));
        let mut child: Child = build_command(command).spawn()?;
        crate::win_job::adopt(&child);
        if let (Some(input), Some(mut stdin)) = (command.stdin.clone(), child.stdin.take()) {
            // A separate thread, because a large script could fill the pipe while we wait.
            std::thread::spawn(move || {
                let _ = stdin.write_all(input.as_bytes());
            });
        }
        if let Some(out) = child.stdout.take() {
            pump_to_log(out, Arc::clone(&log), "");
        }
        if let Some(err) = child.stderr.take() {
            pump_to_log(err, Arc::clone(&log), "[stderr] ");
        }
        Ok(Box::new(StdChild { child }))
    }
}

struct StdChild {
    child: Child,
}

impl ChildProcess for StdChild {
    fn try_wait(&mut self) -> io::Result<Option<ExitInfo>> {
        Ok(self.child.try_wait()?.map(|status| ExitInfo { code: status.code() }))
    }

    fn kill(&mut self) -> io::Result<()> {
        match self.child.kill() {
            // Already exited: nothing to kill, not an error.
            Err(e) if e.kind() == io::ErrorKind::InvalidInput => Ok(()),
            other => other,
        }?;
        self.child.wait().map(|_| ())
    }
}

pub(crate) fn build_command(command: &ProcessCommand) -> Command {
    let mut cmd = Command::new(&command.program);
    for key in &command.env_remove {
        cmd.env_remove(key);
    }
    cmd.args(&command.args)
        .envs(&command.env)
        .stdin(if command.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = &command.cwd {
        cmd.current_dir(dir);
    }
    hide_console_window(&mut cmd);
    crate::unix_orphans::die_with_parent(&mut cmd);
    cmd
}

#[cfg(windows)]
fn hide_console_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    // Otherwise every console sidecar (postgres, node, the AI) pops a black window.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console_window(_cmd: &mut Command) {}

fn open_append(path: &Path) -> io::Result<File> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    OpenOptions::new().create(true).append(true).open(path)
}

fn rotate_if_large(path: &Path, max_bytes: u64) -> io::Result<()> {
    match std::fs::metadata(path) {
        Ok(meta) if meta.len() > max_bytes => {
            let rotated: PathBuf = path.with_extension("log.1");
            std::fs::rename(path, rotated)
        }
        _ => Ok(()),
    }
}

/// Copies a pipe to the log line by line. Bytes are decoded lossily because Postgres on a
/// French Windows writes cp1252, and an invalid UTF-8 byte must not stop the logging.
fn pump_to_log(source: impl Read + Send + 'static, log: Arc<Mutex<File>>, prefix: &'static str) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(source);
        let mut line: Vec<u8> = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let text = String::from_utf8_lossy(&line);
                    if let Ok(mut file) = log.lock() {
                        let _ = write!(file, "{prefix}{}", text);
                        if !text.ends_with('\n') {
                            let _ = writeln!(file);
                        }
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn rotates_only_when_over_the_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let log: PathBuf = tmp.path().join("api.log");
        std::fs::write(&log, "small").unwrap();
        rotate_if_large(&log, 100).unwrap();
        assert!(log.exists());
        std::fs::write(&log, "x".repeat(200)).unwrap();
        rotate_if_large(&log, 100).unwrap();
        assert!(!log.exists());
        assert!(tmp.path().join("api.log.1").exists());
    }

    #[test]
    fn rotation_ignores_a_missing_log() {
        let tmp = tempfile::tempdir().unwrap();
        rotate_if_large(&tmp.path().join("none.log"), 1).unwrap();
    }

    #[test]
    fn exit_info_reports_success_and_text() {
        assert!(ExitInfo { code: Some(0) }.success());
        assert!(!ExitInfo { code: Some(3) }.success());
        assert_eq!(ExitInfo { code: None }.describe(), "terminated without an exit code");
    }

    /// Runs a real process to check the stdout/stderr → log plumbing end to end.
    #[cfg(windows)]
    #[test]
    fn real_process_output_lands_in_the_log() {
        let tmp = tempfile::tempdir().unwrap();
        let log: PathBuf = tmp.path().join("logs").join("echo.log");
        let cmd = ProcessCommand::new("cmd").args(["/C", "echo hello & echo oops 1>&2"]);
        let mut child = StdSpawner.spawn(&cmd, &log).unwrap();
        let deadline: Instant = Instant::now() + Duration::from_secs(10);
        let exit: ExitInfo = loop {
            if let Some(exit) = child.try_wait().unwrap() {
                break exit;
            }
            assert!(Instant::now() < deadline, "cmd did not exit");
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(exit.success());
        // Pump threads may still be flushing right after exit.
        let mut content: String = String::new();
        for _ in 0..50 {
            content = std::fs::read_to_string(&log).unwrap_or_default();
            if content.contains("hello") && content.contains("[stderr] oops") {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(content.contains("hello"), "log was: {content}");
        assert!(content.contains("[stderr] oops"), "log was: {content}");
    }

    /// The same check on macOS and Linux, where the shell is `sh`. On Linux it also proves a
    /// child still starts with the request to die with its parent (`unix_orphans`).
    #[cfg(unix)]
    #[test]
    fn real_process_output_lands_in_the_log_on_unix() {
        let tmp = tempfile::tempdir().unwrap();
        let log: PathBuf = tmp.path().join("logs").join("echo.log");
        let cmd = ProcessCommand::new("sh").args(["-c", "echo hello; echo oops 1>&2"]);
        let mut child = StdSpawner.spawn(&cmd, &log).unwrap();
        let deadline: Instant = Instant::now() + Duration::from_secs(10);
        let exit: ExitInfo = loop {
            if let Some(exit) = child.try_wait().unwrap() {
                break exit;
            }
            assert!(Instant::now() < deadline, "sh did not exit");
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(exit.success());
        // Pump threads may still be flushing right after exit.
        let mut content: String = String::new();
        for _ in 0..50 {
            content = std::fs::read_to_string(&log).unwrap_or_default();
            if content.contains("hello") && content.contains("[stderr] oops") {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(content.contains("hello"), "log was: {content}");
        assert!(content.contains("[stderr] oops"), "log was: {content}");
    }
}
