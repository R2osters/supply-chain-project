//! What the installer tells the screens: the `install://*` events of docs/installer.md, the
//! `{ code, message, detail? }` command error, and the journal behind "Voir le journal".
//!
//! Everything here is Tauri-free: the window and the headless `--silent` mode plug their own
//! [`EventSink`] in, so the install and uninstall logic is tested with a recording sink.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;

pub const STEP_EVENT: &str = "install://step";
pub const PROGRESS_EVENT: &str = "install://progress";
pub const LOG_EVENT: &str = "install://log";
pub const ERROR_EVENT: &str = "install://error";
pub const DONE_EVENT: &str = "install://done";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StepStatus {
    Pending,
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StepEvent {
    pub id: String,
    pub status: StepStatus,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProgressEvent {
    /// Whole run, 0 to 1 (not per step), so the bar only ever moves forward.
    pub fraction: f64,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LogEvent {
    pub line: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ErrorEvent {
    pub step: String,
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum InstallEvent {
    Step(StepEvent),
    Progress(ProgressEvent),
    Log(LogEvent),
    Error(ErrorEvent),
    Done,
}

impl InstallEvent {
    pub fn name(&self) -> &'static str {
        match self {
            InstallEvent::Step(_) => STEP_EVENT,
            InstallEvent::Progress(_) => PROGRESS_EVENT,
            InstallEvent::Log(_) => LOG_EVENT,
            InstallEvent::Error(_) => ERROR_EVENT,
            InstallEvent::Done => DONE_EVENT,
        }
    }

    pub fn payload(&self) -> serde_json::Value {
        let value = match self {
            InstallEvent::Step(e) => serde_json::to_value(e),
            InstallEvent::Progress(e) => serde_json::to_value(e),
            InstallEvent::Log(e) => serde_json::to_value(e),
            InstallEvent::Error(e) => serde_json::to_value(e),
            InstallEvent::Done => Ok(serde_json::Value::Null),
        };
        value.unwrap_or(serde_json::Value::Null)
    }
}

pub trait EventSink: Send + Sync {
    fn emit(&self, event: InstallEvent);
}

/// Error shape of every command (docs/installer.md: `{ code, message, detail? }`). `code` is
/// stable and language-neutral so the screens can translate it; `message` is a readable fallback.
#[derive(Debug, Clone, PartialEq, Serialize, thiserror::Error)]
#[error("{code}: {message}")]
pub struct CommandError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl CommandError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into(), detail: None }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

/// Full text of the run, for `read_log` and for support. Kept in memory because the log file may
/// not be writable yet (or, on uninstall, may be deleted with the data folder).
pub struct Journal {
    started: Instant,
    text: Mutex<String>,
    file: Mutex<Option<PathBuf>>,
}

impl Journal {
    pub fn new(file: Option<PathBuf>) -> Self {
        Self { started: Instant::now(), text: Mutex::new(String::new()), file: Mutex::new(file) }
    }

    pub fn append(&self, line: &str) {
        let stamped = format!("[{:>7.1}s] {line}\n", self.started.elapsed().as_secs_f64());
        self.text.lock().unwrap().push_str(&stamped);
        let file: Option<PathBuf> = self.file.lock().unwrap().clone();
        if let Some(path) = file {
            // Best effort: losing the file copy must never fail the install.
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
                let _ = f.write_all(stamped.as_bytes());
            }
        }
    }

    /// Stops writing to disk, e.g. before the uninstaller deletes the folder the file is in.
    pub fn detach_file(&self) {
        *self.file.lock().unwrap() = None;
    }

    pub fn text(&self) -> String {
        self.text.lock().unwrap().clone()
    }
}

/// Emits events and mirrors them into the journal, so the log the user sees after an error
/// tells the same story as the screen did.
#[derive(Clone)]
pub struct Reporter {
    sink: Arc<dyn EventSink>,
    journal: Arc<Journal>,
}

impl Reporter {
    pub fn new(sink: Arc<dyn EventSink>, journal: Arc<Journal>) -> Self {
        Self { sink, journal }
    }

    pub fn journal(&self) -> &Arc<Journal> {
        &self.journal
    }

    pub fn step(&self, id: &str, status: StepStatus, label: &str) {
        if status != StepStatus::Pending {
            let status = format!("{status:?}").to_lowercase();
            self.journal.append(&format!("[{id}] {status}: {label}"));
        }
        self.sink.emit(InstallEvent::Step(StepEvent { id: id.into(), status, label: label.into() }));
    }

    pub fn progress(&self, fraction: f64, detail: &str) {
        let fraction = fraction.clamp(0.0, 1.0);
        self.sink.emit(InstallEvent::Progress(ProgressEvent { fraction, detail: detail.into() }));
    }

    pub fn log(&self, line: &str) {
        self.journal.append(line);
        self.sink.emit(InstallEvent::Log(LogEvent { line: line.into() }));
    }

    pub fn error(&self, step: &str, code: &str, message: &str, retryable: bool) {
        self.journal.append(&format!("ERROR [{step}] {code}: {message}"));
        self.sink.emit(InstallEvent::Error(ErrorEvent {
            step: step.into(),
            code: code.into(),
            message: message.into(),
            retryable,
        }));
    }

    pub fn done(&self) {
        self.journal.append("done");
        self.sink.emit(InstallEvent::Done);
    }
}

/// Test double shared by the module tests.
#[cfg(test)]
#[derive(Default)]
pub struct RecordingSink {
    pub events: Mutex<Vec<InstallEvent>>,
}

#[cfg(test)]
impl EventSink for RecordingSink {
    fn emit(&self, event: InstallEvent) {
        self.events.lock().unwrap().push(event);
    }
}

#[cfg(test)]
impl RecordingSink {
    pub fn steps(&self) -> Vec<(String, StepStatus)> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                InstallEvent::Step(s) => Some((s.id.clone(), s.status)),
                _ => None,
            })
            .collect()
    }

    pub fn errors(&self) -> Vec<ErrorEvent> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                InstallEvent::Error(e) => Some(e.clone()),
                _ => None,
            })
            .collect()
    }

    pub fn logs(&self) -> Vec<String> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                InstallEvent::Log(l) => Some(l.line.clone()),
                _ => None,
            })
            .collect()
    }

    pub fn is_done(&self) -> bool {
        self.events.lock().unwrap().iter().any(|e| matches!(e, InstallEvent::Done))
    }
}

#[cfg(test)]
pub fn test_reporter() -> (Reporter, Arc<RecordingSink>) {
    let sink = Arc::new(RecordingSink::default());
    (Reporter::new(sink.clone(), Arc::new(Journal::new(None))), sink)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payloads_match_the_contract() {
        let step = InstallEvent::Step(StepEvent {
            id: "extract".into(),
            status: StepStatus::Running,
            label: "Fichiers".into(),
        });
        assert_eq!(step.name(), "install://step");
        assert_eq!(step.payload(), serde_json::json!({"id":"extract","status":"running","label":"Fichiers"}));
        let error = InstallEvent::Error(ErrorEvent {
            step: "provision".into(),
            code: "db".into(),
            message: "m".into(),
            retryable: true,
        });
        assert_eq!(
            error.payload(),
            serde_json::json!({"step":"provision","code":"db","message":"m","retryable":true})
        );
        assert_eq!(InstallEvent::Done.name(), "install://done");
    }

    #[test]
    fn command_error_omits_empty_detail() {
        let e = CommandError::new("busy", "x");
        assert_eq!(serde_json::to_value(&e).unwrap(), serde_json::json!({"code":"busy","message":"x"}));
        let e = e.with_detail("d");
        assert_eq!(serde_json::to_value(&e).unwrap()["detail"], "d");
    }

    #[test]
    fn journal_keeps_text_and_writes_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("logs").join("install.log");
        let journal = Journal::new(Some(path.clone()));
        journal.append("hello");
        journal.detach_file();
        journal.append("memory only");
        assert!(journal.text().contains("hello") && journal.text().contains("memory only"));
        let on_disk = std::fs::read_to_string(path).unwrap();
        assert!(on_disk.contains("hello") && !on_disk.contains("memory only"));
    }

    #[test]
    fn progress_is_clamped() {
        let (reporter, sink) = test_reporter();
        reporter.progress(1.7, "x");
        let events = sink.events.lock().unwrap();
        assert!(matches!(&events[0], InstallEvent::Progress(p) if p.fraction == 1.0));
    }
}
