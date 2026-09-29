//! Runs `scip-desktop.exe --provision` (docs/installer.md, "Provisionnement"): the installed SCIP
//! sets up its own database and applies the plan, reusing its supervisor. The plan goes on stdin,
//! never in a file, because it carries the administrator and database passwords.
//!
//! The child reports one JSON object per stdout line:
//! `{"step","status","label"}`, `{"log"}`, and on failure a last `{"error":{step,code,message,retryable}}`.
//! Spawning is behind [`ProcessLauncher`] so the reading logic is tested with a scripted child.

use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;

use serde::Deserialize;

use crate::events::Reporter;

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ChildError {
    #[serde(default)]
    pub step: String,
    #[serde(default = "default_code")]
    pub code: String,
    #[serde(default)]
    pub message: String,
    #[serde(default = "default_true")]
    pub retryable: bool,
}

fn default_code() -> String {
    "provision_failed".into()
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProvisionMessage {
    Step { step: String, status: String, label: String },
    Log(String),
    Error(ChildError),
}

#[derive(Deserialize)]
struct RawLine {
    step: Option<String>,
    status: Option<String>,
    label: Option<String>,
    log: Option<String>,
    error: Option<ChildError>,
}

/// Anything that is not one of the documented shapes (a stray `println!`, a panic message) is
/// kept as a log line rather than dropped: it is exactly what support will need.
pub fn parse_line(line: &str) -> Option<ProvisionMessage> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let Ok(raw) = serde_json::from_str::<RawLine>(trimmed) else {
        return Some(ProvisionMessage::Log(trimmed.to_string()));
    };
    if let Some(error) = raw.error {
        return Some(ProvisionMessage::Error(error));
    }
    if let Some(step) = raw.step {
        let status = raw.status.unwrap_or_else(|| "running".into());
        let label = raw.label.unwrap_or_else(|| step.clone());
        return Some(ProvisionMessage::Step { step, status, label });
    }
    Some(ProvisionMessage::Log(raw.log.unwrap_or_else(|| trimmed.to_string())))
}

pub enum ChildLine {
    Stdout(String),
    Stderr(String),
}

pub trait ProvisionChild: Send {
    /// Next line from either stream; `None` once both are closed.
    fn next_line(&mut self) -> Option<ChildLine>;
    /// Exit code (`None` if killed without one).
    fn wait(&mut self) -> io::Result<Option<i32>>;
}

#[derive(Clone)]
pub struct LaunchRequest {
    pub exe: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
    /// Written to stdin, which is then closed so the child sees end of input.
    pub stdin: Vec<u8>,
}

pub trait ProcessLauncher: Send + Sync {
    fn launch(&self, request: &LaunchRequest) -> io::Result<Box<dyn ProvisionChild>>;
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProvisionFailure {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

/// Reads the child to the end, forwarding what it says; `on_step` gets each step label as it
/// starts (for the progress bar).
pub fn run(
    launcher: &dyn ProcessLauncher,
    request: &LaunchRequest,
    reporter: &Reporter,
    mut on_step: impl FnMut(&str),
) -> Result<(), ProvisionFailure> {
    let mut child = launcher.launch(request).map_err(|e| ProvisionFailure {
        code: "provision_launch".into(),
        message: format!("{}: {e}", request.exe.display()),
        retryable: true,
    })?;
    let mut last_error: Option<ChildError> = None;
    while let Some(line) = child.next_line() {
        match line {
            ChildLine::Stderr(text) => {
                if !text.trim().is_empty() {
                    reporter.log(&format!("scip: {}", text.trim_end()));
                }
            }
            ChildLine::Stdout(text) => match parse_line(&text) {
                None => {}
                Some(ProvisionMessage::Log(line)) => reporter.log(&line),
                Some(ProvisionMessage::Step { step, status, label }) => {
                    reporter.log(&format!("[provision:{step}] {status}: {label}"));
                    if status == "running" {
                        on_step(&label);
                    }
                }
                Some(ProvisionMessage::Error(error)) => {
                    reporter.log(&format!("[provision:{}] {}: {}", error.step, error.code, error.message));
                    last_error = Some(error);
                }
            },
        }
    }
    let code = child.wait().map_err(|e| ProvisionFailure {
        code: "provision_failed".into(),
        message: e.to_string(),
        retryable: true,
    })?;
    match (code, last_error) {
        (Some(0), _) => Ok(()),
        (_, Some(error)) => Err(ProvisionFailure {
            code: error.code,
            message: if error.message.is_empty() {
                format!("provisioning failed at {}", error.step)
            } else {
                error.message
            },
            retryable: error.retryable,
        }),
        (code, None) => Err(ProvisionFailure {
            code: "provision_failed".into(),
            message: match code {
                Some(c) => format!("scip-desktop.exe --provision exited with code {c}"),
                None => "scip-desktop.exe --provision was terminated".into(),
            },
            retryable: true,
        }),
    }
}

/// Spawns the real exe, hidden (no console flashes up over the installer).
pub struct StdLauncher;

struct StdChild {
    child: std::process::Child,
    lines: mpsc::Receiver<ChildLine>,
}

impl ProvisionChild for StdChild {
    fn next_line(&mut self) -> Option<ChildLine> {
        self.lines.recv().ok()
    }
    fn wait(&mut self) -> io::Result<Option<i32>> {
        Ok(self.child.wait()?.code())
    }
}

fn forward<R: io::Read + Send + 'static>(
    stream: R,
    tx: mpsc::Sender<ChildLine>,
    wrap: fn(String) -> ChildLine,
) {
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines() {
            let Ok(line) = line else { break };
            if tx.send(wrap(line)).is_err() {
                break;
            }
        }
    });
}

impl ProcessLauncher for StdLauncher {
    fn launch(&self, request: &LaunchRequest) -> io::Result<Box<dyn ProvisionChild>> {
        let mut command = Command::new(&request.exe);
        command
            .args(&request.args)
            .current_dir(&request.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in &request.env {
            command.env(key, value);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn()?;
        // Both streams are drained on their own threads, started before writing stdin: a child
        // blocked on a full stdout or stderr pipe would never get to read its input.
        let (tx, rx) = mpsc::channel();
        if let Some(stdout) = child.stdout.take() {
            forward(stdout, tx.clone(), ChildLine::Stdout);
        }
        if let Some(stderr) = child.stderr.take() {
            forward(stderr, tx, ChildLine::Stderr);
        }
        if let Some(mut stdin) = child.stdin.take() {
            // Ignored on purpose: a child that exits before reading reports why on stdout, which
            // says more than "broken pipe". Dropping `stdin` closes the pipe (end of input).
            let _ = stdin.write_all(&request.stdin);
        }
        Ok(Box::new(StdChild { child, lines: rx }))
    }
}

#[cfg(test)]
pub mod fakes {
    use super::*;
    use std::sync::Mutex;

    /// A child that prints scripted lines and exits with a given code; records what it was sent.
    pub struct ScriptedLauncher {
        pub lines: Vec<String>,
        pub exit: Option<i32>,
        pub received: Mutex<Vec<LaunchRequest>>,
    }

    impl ScriptedLauncher {
        pub fn new(lines: &[&str], exit: Option<i32>) -> Self {
            Self {
                lines: lines.iter().map(|s| s.to_string()).collect(),
                exit,
                received: Mutex::new(Vec::new()),
            }
        }
    }

    struct Scripted {
        lines: std::vec::IntoIter<String>,
        exit: Option<i32>,
    }

    impl ProvisionChild for Scripted {
        fn next_line(&mut self) -> Option<ChildLine> {
            self.lines.next().map(|l| match l.strip_prefix("ERR:") {
                Some(rest) => ChildLine::Stderr(rest.to_string()),
                None => ChildLine::Stdout(l),
            })
        }
        fn wait(&mut self) -> io::Result<Option<i32>> {
            Ok(self.exit)
        }
    }

    impl ProcessLauncher for ScriptedLauncher {
        fn launch(&self, request: &LaunchRequest) -> io::Result<Box<dyn ProvisionChild>> {
            self.received.lock().unwrap().push(request.clone());
            Ok(Box::new(Scripted { lines: self.lines.clone().into_iter(), exit: self.exit }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fakes::ScriptedLauncher;
    use super::*;
    use crate::events::test_reporter;

    fn request() -> LaunchRequest {
        LaunchRequest {
            exe: "scip-desktop.exe".into(),
            args: vec!["--provision".into()],
            env: vec![],
            cwd: ".".into(),
            stdin: b"{}".to_vec(),
        }
    }

    #[test]
    fn parses_every_documented_shape() {
        assert_eq!(
            parse_line(r#"{"step":"migrate","status":"running","label":"Mise à jour du schéma"}"#),
            Some(ProvisionMessage::Step {
                step: "migrate".into(),
                status: "running".into(),
                label: "Mise à jour du schéma".into()
            })
        );
        assert_eq!(parse_line(r#"{"log":"initdb ok"}"#), Some(ProvisionMessage::Log("initdb ok".into())));
        assert_eq!(
            parse_line(
                r#"{"error":{"step":"db","code":"pg_start","message":"port busy","retryable":false}}"#
            ),
            Some(ProvisionMessage::Error(ChildError {
                step: "db".into(),
                code: "pg_start".into(),
                message: "port busy".into(),
                retryable: false
            }))
        );
        assert_eq!(
            parse_line("thread 'main' panicked"),
            Some(ProvisionMessage::Log("thread 'main' panicked".into()))
        );
        assert_eq!(parse_line("   "), None);
    }

    #[test]
    fn success_forwards_logs_and_steps() {
        let launcher = ScriptedLauncher::new(
            &[
                r#"{"step":"db","status":"running","label":"Base de données"}"#,
                r#"{"log":"initdb done"}"#,
                "ERR:warning from node",
                r#"{"step":"db","status":"done","label":"Base de données"}"#,
            ],
            Some(0),
        );
        let (reporter, sink) = test_reporter();
        let mut steps = Vec::new();
        run(&launcher, &request(), &reporter, |label| steps.push(label.to_string())).unwrap();
        assert_eq!(steps, ["Base de données"]);
        let logs = sink.logs();
        assert!(logs.contains(&"initdb done".to_string()));
        assert!(logs.contains(&"scip: warning from node".to_string()));
        assert_eq!(launcher.received.lock().unwrap()[0].stdin, b"{}");
    }

    #[test]
    fn failure_uses_the_last_error_line() {
        let launcher = ScriptedLauncher::new(
            &[
                r#"{"error":{"step":"admin","code":"admin_exists","message":"email taken","retryable":false}}"#,
            ],
            Some(1),
        );
        let (reporter, _) = test_reporter();
        let failure = run(&launcher, &request(), &reporter, |_| {}).unwrap_err();
        assert_eq!(
            failure,
            ProvisionFailure { code: "admin_exists".into(), message: "email taken".into(), retryable: false }
        );
    }

    #[test]
    fn failure_without_error_line_is_generic_and_retryable() {
        let launcher = ScriptedLauncher::new(&["not json"], Some(3));
        let (reporter, _) = test_reporter();
        let failure = run(&launcher, &request(), &reporter, |_| {}).unwrap_err();
        assert_eq!(failure.code, "provision_failed");
        assert!(failure.retryable && failure.message.contains('3'));
    }

    #[test]
    fn real_launcher_pipes_stdin_to_stdout() {
        // `sort` echoes its stdin back once stdin is closed: proves the pipe is closed.
        let (exe, args): (&str, Vec<String>) =
            if cfg!(windows) { ("sort.exe", vec![]) } else { ("cat", vec![]) };
        let request = LaunchRequest {
            exe: exe.into(),
            args,
            env: vec![("SCIP_TEST".into(), "1".into())],
            cwd: std::env::temp_dir(),
            stdin: b"{\"log\":\"hello\"}\n".to_vec(),
        };
        let (reporter, sink) = test_reporter();
        run(&StdLauncher, &request, &reporter, |_| {}).unwrap();
        assert!(sink.logs().contains(&"hello".to_string()), "{:?}", sink.logs());
    }
}
