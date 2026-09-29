//! The stdout protocol read by the installer: one JSON object per line.
//!
//! ```text
//! {"step":"migrate","status":"running","label":"Mise à jour du schéma"}
//! {"log":"..."}
//! {"error":{"step":"migrate","code":"db-unreachable","message":"...","retryable":true}}
//! ```
//!
//! Every line goes through the redactor: the plan carries the administrator's password, the
//! database password and API keys, and none of them may reach the installer's journal.

use std::io::Write;
use std::sync::Mutex;

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StepId {
    Prepare,
    Database,
    Migrate,
    Services,
    Organisation,
    Admin,
    Sites,
    Sources,
    Demo,
    Stop,
}

impl StepId {
    pub fn label(self) -> &'static str {
        match self {
            Self::Prepare => "Préparation des dossiers et des secrets",
            Self::Database => "Préparation de la base de données",
            Self::Migrate => "Mise à jour du schéma",
            Self::Services => "Démarrage des services SCIP",
            Self::Organisation => "Création de l'organisation",
            Self::Admin => "Création du compte administrateur",
            Self::Sites => "Création des sites",
            Self::Sources => "Configuration des sources de données",
            Self::Demo => "Chargement des données de démonstration",
            Self::Stop => "Arrêt des services",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Running,
    Done,
    Skipped,
}

/// A failed step, as the installer shows it (screen 10b).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProvisionError {
    pub step: StepId,
    pub code: String,
    pub message: String,
    /// True when trying again may succeed without changing the plan (network, timeout, a
    /// database that is not reachable yet).
    pub retryable: bool,
}

impl ProvisionError {
    pub fn new(step: StepId, code: &str, message: impl Into<String>, retryable: bool) -> Self {
        Self { step, code: code.to_owned(), message: message.into(), retryable }
    }
}

/// Values shorter than this are not redacted: replacing every "a" in the output would make
/// it unreadable and hides nothing a four-character password would not already give away.
const MIN_REDACTED_LEN: usize = 4;
const MASK: &str = "***";

#[derive(Debug, Default, Clone)]
pub struct Redactor {
    /// Longest first, so a value that contains another is masked whole.
    secrets: Vec<String>,
}

impl Redactor {
    pub fn add(&mut self, values: impl IntoIterator<Item = String>) {
        for value in values {
            if value.chars().count() >= MIN_REDACTED_LEN && !self.secrets.contains(&value) {
                self.secrets.push(value);
            }
        }
        self.secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
    }

    pub fn redact(&self, text: &str) -> String {
        let mut out: String = text.to_owned();
        for secret in &self.secrets {
            if out.contains(secret.as_str()) {
                out = out.replace(secret.as_str(), MASK);
            }
        }
        redact_url_passwords(&out)
    }
}

/// Belt and braces for URLs we did not build ourselves (Prisma may echo a connection string):
/// `scheme://user:password@` loses the password.
fn redact_url_passwords(text: &str) -> String {
    let mut out: String = String::with_capacity(text.len());
    let mut rest: &str = text;
    while let Some(at) = rest.find("://") {
        let (before, after) = rest.split_at(at + 3);
        out.push_str(before);
        let authority_end: usize = after.find(['/', ' ', '"', '\'', '\n']).unwrap_or(after.len());
        let authority: &str = &after[..authority_end];
        match (authority.rfind('@'), authority.find(':')) {
            (Some(at_sign), Some(colon)) if colon < at_sign => {
                out.push_str(&authority[..=colon]);
                out.push_str(MASK);
                out.push_str(&authority[at_sign..]);
            }
            _ => out.push_str(authority),
        }
        rest = &after[authority_end..];
    }
    out.push_str(rest);
    out
}

#[derive(Serialize)]
struct StepLine<'a> {
    step: StepId,
    status: Status,
    label: &'a str,
}

#[derive(Serialize)]
struct LogLine<'a> {
    log: &'a str,
}

#[derive(Serialize)]
struct ErrorLine<'a> {
    error: &'a ProvisionError,
}

/// Thread-safe line writer; the supervisor's pump threads and the logger share it.
pub struct Emitter {
    out: Mutex<Box<dyn Write + Send>>,
    redactor: Mutex<Redactor>,
}

impl Emitter {
    pub fn new(out: Box<dyn Write + Send>) -> Self {
        Self { out: Mutex::new(out), redactor: Mutex::new(Redactor::default()) }
    }

    pub fn stdout() -> Self {
        Self::new(Box::new(std::io::stdout()))
    }

    pub fn add_secrets(&self, values: impl IntoIterator<Item = String>) {
        self.redactor.lock().unwrap().add(values);
    }

    pub fn redact(&self, text: &str) -> String {
        self.redactor.lock().unwrap().redact(text)
    }

    pub fn step(&self, step: StepId, status: Status) {
        self.write(&StepLine { step, status, label: step.label() });
    }

    pub fn log(&self, text: &str) {
        let clean: String = self.redact(text.trim_end());
        if !clean.is_empty() {
            self.write(&LogLine { log: &clean });
        }
    }

    pub fn error(&self, error: &ProvisionError) {
        let clean = ProvisionError { message: self.redact(&error.message), ..error.clone() };
        self.write(&ErrorLine { error: &clean });
    }

    fn write(&self, line: &impl Serialize) {
        let json: String = serde_json::to_string(line).expect("protocol lines always serialise");
        let mut out = self.out.lock().unwrap();
        // A closed pipe (installer gone) must not panic the provisioning half-way.
        let _ = writeln!(out, "{json}");
        let _ = out.flush();
    }
}

#[cfg(test)]
pub mod testing {
    use super::*;
    use std::sync::Arc;

    /// Captures lines for assertions.
    #[derive(Clone, Default)]
    pub struct Buffer(pub Arc<Mutex<Vec<u8>>>);

    impl Write for Buffer {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Buffer {
        pub fn lines(&self) -> Vec<serde_json::Value> {
            String::from_utf8(self.0.lock().unwrap().clone())
                .unwrap()
                .lines()
                .map(|l| serde_json::from_str(l).unwrap())
                .collect()
        }

        pub fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    pub fn emitter() -> (Emitter, Buffer) {
        let buffer = Buffer::default();
        (Emitter::new(Box::new(buffer.clone())), buffer)
    }
}

#[cfg(test)]
mod tests {
    use super::testing::emitter;
    use super::*;

    #[test]
    fn lines_follow_the_protocol() {
        let (out, buf) = emitter();
        out.step(StepId::Migrate, Status::Running);
        out.log("hello\n");
        out.error(&ProvisionError::new(StepId::Migrate, "db-unreachable", "down", true));
        assert_eq!(
            buf.text(),
            concat!(
                r#"{"step":"migrate","status":"running","label":"Mise à jour du schéma"}"#,
                "\n",
                r#"{"log":"hello"}"#,
                "\n",
                r#"{"error":{"step":"migrate","code":"db-unreachable","message":"down","retryable":true}}"#,
                "\n"
            )
        );
    }

    #[test]
    fn secrets_are_masked_in_logs_and_errors() {
        let (out, buf) = emitter();
        out.add_secrets(["Str0ng-Passphrase!".to_owned(), "abc".to_owned()]);
        out.log("login with Str0ng-Passphrase! failed (abc kept: too short to mask)");
        out.error(&ProvisionError::new(StepId::Admin, "x", "bad password Str0ng-Passphrase!", false));
        let text: String = buf.text();
        assert!(!text.contains("Str0ng-Passphrase!"), "{text}");
        assert!(text.contains("abc kept"));
        assert_eq!(text.matches("***").count(), 2);
    }

    #[test]
    fn longer_secret_is_masked_whole() {
        let mut r = Redactor::default();
        r.add(["pass".to_owned(), "password123".to_owned()]);
        assert_eq!(r.redact("x password123 y"), "x *** y");
    }

    #[test]
    fn url_passwords_are_masked_even_when_unknown() {
        let r = Redactor::default();
        assert_eq!(
            r.redact("Can't reach postgresql://ops:s3cr%40t@db:5432/scip now"),
            "Can't reach postgresql://ops:***@db:5432/scip now"
        );
        assert_eq!(r.redact("see http://127.0.0.1:3001/api/v1"), "see http://127.0.0.1:3001/api/v1");
    }

    #[test]
    fn every_step_has_a_label() {
        for step in [
            StepId::Prepare,
            StepId::Database,
            StepId::Migrate,
            StepId::Services,
            StepId::Organisation,
            StepId::Admin,
            StepId::Sites,
            StepId::Sources,
            StepId::Demo,
            StepId::Stop,
        ] {
            assert!(!step.label().is_empty());
        }
    }
}
