//! Declarative description of what the supervisor runs. Pure data: building a spec never
//! touches the disk or the network, which keeps `services.rs` trivially testable.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

/// How to launch one OS process.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProcessCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Added on top of the parent environment; a key here always wins.
    pub env: BTreeMap<String, String>,
    /// Removed from the inherited environment, for settings whose mere presence changes
    /// behaviour (e.g. `SMTP_HOST` turns mail on in the API).
    pub env_remove: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// Written to the child's stdin, which is then closed (psql scripts).
    pub stdin: Option<String>,
}

impl ProcessCommand {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self { program: program.into(), ..Self::default() }
    }

    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    pub fn env(mut self, key: &str, value: impl Into<String>) -> Self {
        self.env.insert(key.to_owned(), value.into());
        self
    }

    pub fn unset(mut self, key: &str) -> Self {
        self.env_remove.push(key.to_owned());
        self
    }

    pub fn envs(mut self, vars: &BTreeMap<String, String>) -> Self {
        self.env.extend(vars.iter().map(|(k, v)| (k.clone(), v.clone())));
        self
    }

    pub fn cwd(mut self, dir: impl Into<PathBuf>) -> Self {
        self.cwd = Some(dir.into());
        self
    }

    pub fn stdin(mut self, input: impl Into<String>) -> Self {
        self.stdin = Some(input.into());
        self
    }
}

/// How the supervisor decides a service is ready to take traffic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HealthCheck {
    /// `GET http://{host}:{port}{path}` answers 2xx.
    Http { host: String, port: u16, path: String },
    /// Something accepts TCP connections on 127.0.0.1:`port`.
    Tcp { port: u16 },
    /// The command exits with status 0 (e.g. `pg_isready`).
    Command(ProcessCommand),
}

impl HealthCheck {
    pub fn http_local(port: u16, path: &str) -> Self {
        Self::Http { host: "127.0.0.1".to_owned(), port, path: path.to_owned() }
    }
}

/// Windows has no SIGTERM, so "graceful" has to be spelled out per service.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopMethod {
    /// Run this command (e.g. `pg_ctl stop -m fast`), then wait for the process to exit.
    Command(ProcessCommand),
    /// Terminate right away. Fine for stateless processes whose state lives in Postgres.
    Kill,
}

/// A long-running sidecar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceSpec {
    pub name: String,
    pub command: ProcessCommand,
    pub health: HealthCheck,
    pub start_timeout: Duration,
    pub stop: StopMethod,
    /// How long `stop` may take before the process is killed.
    pub stop_timeout: Duration,
}

/// A file that exists only while a task runs (e.g. `initdb --pwfile`), so a secret is never
/// passed on a command line where any process could read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TempFile {
    pub path: PathBuf,
    pub contents: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkipCondition {
    PathExists(PathBuf),
}

/// A one-shot command in the startup sequence (initdb, migrations, ...).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSpec {
    pub name: String,
    pub command: ProcessCommand,
    pub timeout: Duration,
    pub skip_if: Option<SkipCondition>,
    pub temp_files: Vec<TempFile>,
}

impl TaskSpec {
    pub fn new(name: &str, command: ProcessCommand, timeout: Duration) -> Self {
        Self { name: name.to_owned(), command, timeout, skip_if: None, temp_files: Vec::new() }
    }

    pub fn should_skip(&self) -> bool {
        match &self.skip_if {
            Some(SkipCondition::PathExists(path)) => path.exists(),
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builder_accumulates_args_and_env() {
        let cmd = ProcessCommand::new("node").args(["a", "b"]).env("K", "1").env("K", "2").cwd("/tmp");
        assert_eq!(cmd.args, vec!["a", "b"]);
        assert_eq!(cmd.env.get("K").map(String::as_str), Some("2"));
        assert_eq!(cmd.cwd, Some(PathBuf::from("/tmp")));
    }

    #[test]
    fn skip_condition_follows_the_filesystem() {
        let tmp = tempfile::tempdir().unwrap();
        let marker: PathBuf = tmp.path().join("PG_VERSION");
        let mut task = TaskSpec::new("initdb", ProcessCommand::new("initdb"), Duration::from_secs(1));
        assert!(!task.should_skip());
        task.skip_if = Some(SkipCondition::PathExists(marker.clone()));
        assert!(!task.should_skip());
        std::fs::write(&marker, "16").unwrap();
        assert!(task.should_skip());
    }
}
