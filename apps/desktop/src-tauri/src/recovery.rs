//! "Mot de passe oublié ?" on this computer.
//!
//! A desktop install has no mail server, so the usual reset-by-e-mail link cannot work. Instead,
//! the shell — the only process that knows the local recovery token, generated into the user's
//! own `config.json` — asks the API to give an administrator a temporary password, which the
//! sign-in screen shows once and the administrator must change at the next sign-in.
//!
//! This grants nothing new: whoever can run SCIP on this PC can already read its database.

use std::time::Duration;

use serde::{Deserialize, Serialize};

pub const RECOVERY_HEADER: &str = "x-local-recovery-token";
const TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveredAccount {
    pub email: String,
    pub temporary_password: String,
}

#[derive(Debug, Clone, Serialize)]
struct RecoveryRequest<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<&'a str>,
}

/// What the sign-in screen shows when recovery fails; never an internal detail.
pub fn message_for_status(status: u16) -> &'static str {
    match status {
        400 | 404 => "Aucun compte administrateur actif ne correspond à cette adresse.",
        403 => "La récupération n'est possible que depuis l'application SCIP de cet ordinateur.",
        429 => "Trop de tentatives. Patientez une minute avant de réessayer.",
        _ => "La récupération du mot de passe a échoué. Réessayez dans un instant.",
    }
}

/// Blank or whitespace-only e-mail means "the first administrator".
pub fn normalise_email(email: Option<&str>) -> Option<String> {
    email.map(str::trim).filter(|e: &&str| !e.is_empty()).map(str::to_lowercase)
}

/// Calls `POST {api}/auth/local-recovery`. Blocking: run it off the UI thread.
pub fn request(api_base_url: &str, token: &str, email: Option<&str>) -> Result<RecoveredAccount, String> {
    let email: Option<String> = normalise_email(email);
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        // Statuses are mapped to messages below instead of surfacing as transport errors.
        .http_status_as_error(false)
        .build()
        .into();
    let mut response = agent
        .post(&format!("{api_base_url}/auth/local-recovery"))
        .header(RECOVERY_HEADER, token)
        .send_json(RecoveryRequest { email: email.as_deref() })
        .map_err(|_| "Le serveur local de SCIP ne répond pas.".to_owned())?;
    let status: u16 = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(message_for_status(status).to_owned());
    }
    response.body_mut().read_json::<RecoveredAccount>().map_err(|_| message_for_status(500).to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_email_means_first_administrator() {
        assert_eq!(normalise_email(None), None);
        assert_eq!(normalise_email(Some("   ")), None);
        assert_eq!(normalise_email(Some(" Admin@Example.COM ")), Some("admin@example.com".to_owned()));
    }

    #[test]
    fn statuses_become_user_facing_messages() {
        assert!(message_for_status(404).contains("Aucun compte"));
        assert!(message_for_status(403).contains("cet ordinateur"));
        assert!(message_for_status(429).contains("Trop de tentatives"));
        assert!(message_for_status(502).contains("a échoué"));
    }

    #[test]
    fn request_body_omits_a_missing_email() {
        let body = serde_json::to_string(&RecoveryRequest { email: None }).unwrap();
        assert_eq!(body, "{}");
        let body = serde_json::to_string(&RecoveryRequest { email: Some("a@b.c") }).unwrap();
        assert_eq!(body, r#"{"email":"a@b.c"}"#);
    }

    #[test]
    fn unreachable_api_is_reported_plainly() {
        // Port 9 (discard) on loopback is closed on Windows and Linux alike.
        let error = request("http://127.0.0.1:9/api/v1", "t", None).unwrap_err();
        assert!(error.contains("ne répond pas"), "{error}");
    }
}
