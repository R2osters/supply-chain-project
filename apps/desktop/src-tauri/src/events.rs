//! Events sent from the supervisor to the webview, and the snapshot that lets a page that
//! loads late (or reloads) catch up on what it missed.

use serde::Serialize;

pub const PROGRESS_EVENT: &str = "supervisor://progress";
pub const ERROR_EVENT: &str = "supervisor://error";
pub const READY_EVENT: &str = "supervisor://ready";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StepStatus {
    Running,
    Done,
    Skipped,
    Restarting,
    /// An optional service did not start; the app continues without it.
    Degraded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    /// Stable id (`postgres`, `migrate`, ...) the UI can key on.
    pub step: String,
    pub label: String,
    pub status: StepStatus,
    /// 1-based position in the startup sequence, 0 when not part of it (restarts).
    pub index: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    DataDir,
    Config,
    Ports,
    MissingResources,
    SpawnFailed,
    TaskFailed,
    Unhealthy,
    Crashed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorEvent {
    pub code: ErrorCode,
    pub message: String,
    /// Extra lines shown under the message (missing files, exit code...).
    pub details: Vec<String>,
    /// Log to open for this failure, when there is one.
    pub log_file: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyEvent {
    pub api_base_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SupervisorEvent {
    Progress(ProgressEvent),
    Error(ErrorEvent),
    Ready(ReadyEvent),
}

/// Where events go. The app forwards them to the webview; tests collect them.
pub trait EventSink: Send + Sync {
    fn emit(&self, event: SupervisorEvent);
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupSnapshot {
    /// Latest status of each step, in first-seen order.
    pub steps: Vec<ProgressEvent>,
    pub error: Option<ErrorEvent>,
    pub ready: Option<ReadyEvent>,
}

impl StartupSnapshot {
    pub fn apply(&mut self, event: &SupervisorEvent) {
        match event {
            SupervisorEvent::Progress(progress) => self.upsert_step(progress),
            SupervisorEvent::Error(error) => self.error = Some(error.clone()),
            SupervisorEvent::Ready(ready) => self.ready = Some(ready.clone()),
        }
    }

    fn upsert_step(&mut self, progress: &ProgressEvent) {
        match self.steps.iter_mut().find(|s: &&mut ProgressEvent| s.step == progress.step) {
            Some(existing) => *existing = progress.clone(),
            None => self.steps.push(progress.clone()),
        }
    }
}

#[cfg(test)]
pub mod testing {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct CollectingSink {
        pub events: Mutex<Vec<SupervisorEvent>>,
    }

    impl EventSink for CollectingSink {
        fn emit(&self, event: SupervisorEvent) {
            self.events.lock().unwrap().push(event);
        }
    }

    impl CollectingSink {
        pub fn errors(&self) -> Vec<ErrorEvent> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter_map(|e| match e {
                    SupervisorEvent::Error(err) => Some(err.clone()),
                    _ => None,
                })
                .collect()
        }

        pub fn progress(&self) -> Vec<(String, StepStatus)> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter_map(|e| match e {
                    SupervisorEvent::Progress(p) => Some((p.step.clone(), p.status)),
                    _ => None,
                })
                .collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn progress(step: &str, status: StepStatus) -> SupervisorEvent {
        SupervisorEvent::Progress(ProgressEvent {
            step: step.into(),
            label: step.into(),
            status,
            index: 1,
            total: 2,
        })
    }

    #[test]
    fn snapshot_keeps_latest_status_per_step_in_order() {
        let mut snap = StartupSnapshot::default();
        snap.apply(&progress("postgres", StepStatus::Running));
        snap.apply(&progress("api", StepStatus::Running));
        snap.apply(&progress("postgres", StepStatus::Done));
        let steps: Vec<(&str, StepStatus)> = snap.steps.iter().map(|s| (s.step.as_str(), s.status)).collect();
        assert_eq!(steps, vec![("postgres", StepStatus::Done), ("api", StepStatus::Running)]);
    }

    #[test]
    fn payloads_serialise_in_camel_case_for_the_webview() {
        let ready = ReadyEvent { api_base_url: "http://127.0.0.1:1/api/v1".into() };
        let json: String = serde_json::to_string(&ready).unwrap();
        assert_eq!(json, r#"{"apiBaseUrl":"http://127.0.0.1:1/api/v1"}"#);
        let code: String = serde_json::to_string(&ErrorCode::MissingResources).unwrap();
        assert_eq!(code, r#""missingResources""#);
    }
}
