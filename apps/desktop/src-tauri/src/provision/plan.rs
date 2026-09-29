//! What the installer sends on stdin: an `InstallPlan` (docs/installer.md) or `{"upgrade":true}`.
//!
//! Validation repeats the installer's screen rules on purpose: the plan crosses a process
//! boundary, and a bad value caught here is a clear message instead of an API 400 halfway through.

use serde::Deserialize;

use crate::secrets::DatabaseConfig;

#[derive(Debug, Clone, PartialEq)]
pub enum ProvisionRequest {
    /// Boxed: the plan is large next to `Upgrade`.
    Install(Box<InstallPlan>),
    /// Files were replaced; bring the schema up to date with the existing configuration.
    Upgrade,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Production,
    Demo,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPlan {
    pub kind: Kind,
    pub database: DatabasePlan,
    #[serde(default)]
    pub organisation: Option<Organisation>,
    #[serde(default)]
    pub sources: Sources,
    #[serde(default)]
    pub admin: Option<Admin>,
    // `desktopShortcut` belongs to the installer; unknown fields are ignored.
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum DatabasePlan {
    Embedded,
    External(ExternalDatabase),
}

#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalDatabase {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: String,
    #[serde(default)]
    pub ssl: bool,
}

/// Hand-written so a `{:?}` in a log line can never print the password.
impl std::fmt::Debug for ExternalDatabase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExternalDatabase")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("database", &self.database)
            .field("user", &self.user)
            .field("ssl", &self.ssl)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Organisation {
    pub name: String,
    pub country: String,
    pub currency: String,
    pub timezone: String,
    #[serde(default)]
    pub sites: Vec<Site>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Site {
    pub name: String,
    #[serde(default)]
    pub city: Option<String>,
    #[serde(default)]
    pub latitude: Option<f64>,
    #[serde(default)]
    pub longitude: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VehicleSource {
    Live,
    Simulation,
}

#[derive(Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sources {
    #[serde(default)]
    pub vehicles: Option<VehicleSource>,
    #[serde(default)]
    pub ais_stream_key: Option<String>,
    #[serde(default)]
    pub opensky_client_id: Option<String>,
    #[serde(default)]
    pub opensky_client_secret: Option<String>,
    #[serde(default)]
    pub tomtom_key: Option<String>,
}

impl std::fmt::Debug for Sources {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Sources").field("vehicles", &self.vehicles).finish_non_exhaustive()
    }
}

#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Admin {
    pub first_name: String,
    pub last_name: String,
    pub email: String,
    pub password: String,
}

impl std::fmt::Debug for Admin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Admin").field("email", &self.email).finish_non_exhaustive()
    }
}

/// Feed credentials to store, only those the user typed (blank means "leave as is").
#[derive(Clone, Default, PartialEq, Eq)]
pub struct FeedKeys {
    pub ais_stream_api_key: Option<String>,
    pub opensky_client_id: Option<String>,
    pub opensky_client_secret: Option<String>,
    pub tomtom_api_key: Option<String>,
}

impl FeedKeys {
    pub fn is_empty(&self) -> bool {
        self.ais_stream_api_key.is_none()
            && self.opensky_client_id.is_none()
            && self.opensky_client_secret.is_none()
            && self.tomtom_api_key.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct PlanError(pub String);

/// Parses the stdin document. Never echoes the input: it holds passwords.
pub fn parse(input: &str) -> Result<ProvisionRequest, PlanError> {
    let value: serde_json::Value =
        serde_json::from_str(input.trim_start_matches('\u{feff}')).map_err(|e| {
            PlanError(format!(
                "le plan n'est pas du JSON valide (ligne {}, colonne {})",
                e.line(),
                e.column()
            ))
        })?;
    if value.get("upgrade").and_then(serde_json::Value::as_bool) == Some(true) {
        return Ok(ProvisionRequest::Upgrade);
    }
    let plan: InstallPlan =
        serde_json::from_value(value).map_err(|e| PlanError(format!("plan invalide : {e}")))?;
    plan.validate()?;
    Ok(ProvisionRequest::Install(Box::new(plan)))
}

fn blank(value: &str) -> bool {
    value.trim().is_empty()
}

fn non_blank(value: &Option<String>) -> Option<String> {
    value.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(str::to_owned)
}

/// Same rule as the API's `RegisterDto` regex: 12+ characters and three of the four classes,
/// with the regex's ASCII meaning of `[a-z]`, `[A-Z]`, `\d` and `[^\w\s]`.
pub fn is_strong_password(password: &str) -> bool {
    let classes: usize = [
        password.chars().any(|c| c.is_ascii_lowercase()),
        password.chars().any(|c| c.is_ascii_uppercase()),
        password.chars().any(|c| c.is_ascii_digit()),
        password.chars().any(|c| !c.is_ascii_alphanumeric() && !c.is_whitespace() && c != '_'),
    ]
    .iter()
    .filter(|present| **present)
    .count();
    password.chars().count() >= 12 && password.chars().count() <= 128 && classes >= 3
}

impl InstallPlan {
    pub fn validate(&self) -> Result<(), PlanError> {
        let fail = |message: &str| Err(PlanError(message.to_owned()));
        if let DatabasePlan::External(db) = &self.database {
            if blank(&db.host) || blank(&db.database) || blank(&db.user) {
                return fail("base existante : hôte, base et utilisateur sont obligatoires");
            }
            if db.port == 0 {
                return fail("base existante : port invalide");
            }
        }
        if self.kind == Kind::Demo {
            return Ok(());
        }
        let Some(org) = &self.organisation else { return fail("organisation manquante") };
        if org.name.trim().chars().count() < 2 {
            return fail("le nom de l'organisation doit faire au moins 2 caractères");
        }
        if blank(&org.country) {
            return fail("le pays de l'organisation est obligatoire");
        }
        if !(org.currency.trim().len() == 3 && org.currency.trim().chars().all(|c| c.is_ascii_alphabetic())) {
            return fail("la devise doit être un code ISO à 3 lettres (ex. GHS)");
        }
        if blank(&org.timezone) {
            return fail("le fuseau horaire est obligatoire");
        }
        for site in &org.sites {
            if site.name.trim().chars().count() < 2 {
                return fail("chaque site doit avoir un nom d'au moins 2 caractères");
            }
            match (site.latitude, site.longitude) {
                (None, None) => {}
                (Some(lat), Some(lng))
                    if (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lng) => {}
                _ => return fail("coordonnées de site invalides (latitude et longitude vont ensemble)"),
            }
        }
        let Some(admin) = &self.admin else { return fail("administrateur manquant") };
        if blank(&admin.first_name) || blank(&admin.last_name) {
            return fail("prénom et nom de l'administrateur sont obligatoires");
        }
        if !admin.email.contains('@') || admin.email.trim().len() < 3 {
            return fail("adresse e-mail de l'administrateur invalide");
        }
        if !is_strong_password(&admin.password) {
            return fail("mot de passe administrateur trop faible (12 caractères, 3 types parmi minuscules, majuscules, chiffres, symboles)");
        }
        Ok(())
    }

    /// Simulation unless the user picked live devices; production defaults to live.
    pub fn simulator(&self) -> bool {
        match self.sources.vehicles {
            Some(VehicleSource::Simulation) => true,
            Some(VehicleSource::Live) => false,
            None => self.kind == Kind::Demo,
        }
    }

    pub fn database_config(&self) -> DatabaseConfig {
        match &self.database {
            DatabasePlan::Embedded => DatabaseConfig::Embedded,
            DatabasePlan::External(db) => DatabaseConfig::External { url: db.url() },
        }
    }

    pub fn feed_keys(&self) -> FeedKeys {
        FeedKeys {
            ais_stream_api_key: non_blank(&self.sources.ais_stream_key),
            opensky_client_id: non_blank(&self.sources.opensky_client_id),
            opensky_client_secret: non_blank(&self.sources.opensky_client_secret),
            tomtom_api_key: non_blank(&self.sources.tomtom_key),
        }
    }

    /// Every value that must never appear in the output, in any form we might print it.
    pub fn sensitive_values(&self) -> Vec<String> {
        let mut values: Vec<String> = Vec::new();
        if let Some(admin) = &self.admin {
            values.push(admin.password.clone());
        }
        if let DatabasePlan::External(db) = &self.database {
            values.push(db.password.clone());
            values.push(percent_encode(&db.password));
            values.push(db.url());
        }
        let keys = self.feed_keys();
        values.extend(
            [keys.ais_stream_api_key, keys.opensky_client_secret, keys.tomtom_api_key].into_iter().flatten(),
        );
        values
    }
}

impl ExternalDatabase {
    /// `postgresql://user:password@host:port/database?schema=public[&sslmode=require]`, every
    /// part percent-encoded: a password with `@`, `:` or `/` would otherwise be read as syntax.
    pub fn url(&self) -> String {
        let host: String = if self.host.contains(':') && !self.host.starts_with('[') {
            format!("[{}]", self.host.trim()) // IPv6 literal
        } else {
            self.host.trim().to_owned()
        };
        let mut url: String = format!(
            "postgresql://{}:{}@{host}:{}/{}?schema=public",
            percent_encode(self.user.trim()),
            percent_encode(&self.password),
            self.port,
            percent_encode(self.database.trim()),
        );
        if self.ssl {
            url.push_str("&sslmode=require");
        }
        url
    }
}

/// RFC 3986: everything but the unreserved set becomes `%XX` per UTF-8 byte.
pub fn percent_encode(value: &str) -> String {
    let mut out: String = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    pub const PRODUCTION: &str = r#"{
      "kind": "production",
      "database": { "mode": "embedded" },
      "organisation": { "name": "Test Org", "country": "GH", "currency": "GHS", "timezone": "Africa/Accra",
        "sites": [ { "name": "Tema DC", "city": "Tema", "latitude": 5.67, "longitude": -0.01 }, { "name": "Kumasi", "city": "Kumasi" } ] },
      "sources": { "vehicles": "live", "aisStreamKey": "ais-secret-key", "tomtomKey": "" },
      "admin": { "firstName": "Ama", "lastName": "Mensah", "email": "ama@test.org", "password": "Str0ng-Passphrase!" },
      "desktopShortcut": true
    }"#;

    fn production() -> InstallPlan {
        match parse(PRODUCTION).unwrap() {
            ProvisionRequest::Install(plan) => *plan,
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn parses_a_full_production_plan() {
        let plan = production();
        assert_eq!(plan.kind, Kind::Production);
        assert_eq!(plan.organisation.as_ref().unwrap().sites.len(), 2);
        assert!(!plan.simulator());
        assert_eq!(plan.database_config(), DatabaseConfig::Embedded);
        let keys = plan.feed_keys();
        assert_eq!(keys.ais_stream_api_key.as_deref(), Some("ais-secret-key"));
        assert_eq!(keys.tomtom_api_key, None, "blank means leave unchanged");
    }

    #[test]
    fn parses_upgrade_and_demo() {
        assert_eq!(parse(r#"{"upgrade":true}"#).unwrap(), ProvisionRequest::Upgrade);
        let demo = parse(r#"{"kind":"demo","database":{"mode":"embedded"},"sources":{}}"#).unwrap();
        let ProvisionRequest::Install(demo) = demo else { panic!() };
        assert!(demo.simulator(), "demo defaults to simulated vehicles");
        let demo_live =
            parse(r#"{"kind":"demo","database":{"mode":"embedded"},"sources":{"vehicles":"live"}}"#);
        let Ok(ProvisionRequest::Install(demo_live)) = demo_live else { panic!() };
        assert!(!demo_live.simulator());
    }

    #[test]
    fn production_without_vehicle_choice_is_live() {
        let mut plan = production();
        plan.sources.vehicles = None;
        assert!(!plan.simulator());
        plan.sources.vehicles = Some(VehicleSource::Simulation);
        assert!(plan.simulator());
    }

    #[test]
    fn rejects_bad_documents_without_echoing_them() {
        let err = parse(r#"{"kind":"production","admin":{"password":"hunter2"}"#).unwrap_err();
        assert!(!err.0.contains("hunter2"));
        assert!(parse(r#"{"kind":"weird","database":{"mode":"embedded"}}"#).is_err());
        assert!(parse(r#"{"upgrade":false}"#).is_err(), "not an upgrade and not a plan");
    }

    #[test]
    fn validation_rules() {
        let check = |edit: fn(&mut InstallPlan)| {
            let mut plan = production();
            edit(&mut plan);
            plan.validate()
        };
        assert!(check(|_| {}).is_ok());
        assert!(check(|p| p.admin.as_mut().unwrap().password = "short1A!".into()).is_err());
        assert!(check(|p| p.admin.as_mut().unwrap().password = "alllowercaseletters".into()).is_err());
        assert!(check(|p| p.admin.as_mut().unwrap().email = "nope".into()).is_err());
        assert!(check(|p| p.admin = None).is_err());
        assert!(check(|p| p.organisation = None).is_err());
        assert!(check(|p| p.organisation.as_mut().unwrap().currency = "CEDI".into()).is_err());
        assert!(check(|p| p.organisation.as_mut().unwrap().sites[1].latitude = Some(5.0)).is_err());
        assert!(check(|p| p.organisation.as_mut().unwrap().sites[0].latitude = Some(95.0)).is_err());
        assert!(check(|p| {
            p.kind = Kind::Demo;
            p.admin = None;
            p.organisation = None;
        })
        .is_ok());
        assert!(check(|p| p.database = DatabasePlan::External(ExternalDatabase {
            host: " ".into(),
            port: 5432,
            database: "scip".into(),
            user: "u".into(),
            password: "p".into(),
            ssl: false,
        }))
        .is_err());
    }

    #[test]
    fn password_strength_matches_the_api() {
        assert!(is_strong_password("Str0ng-Passphrase!"));
        assert!(is_strong_password("abcdefghij1!")); // lower + digit + symbol
        assert!(is_strong_password("abcdefghijK1")); // lower + upper + digit
        assert!(!is_strong_password("Abcdefghijk"), "11 characters");
        assert!(!is_strong_password("abcdefghijkl1"), "two classes only");
    }

    #[test]
    fn url_encodes_credentials_and_adds_ssl() {
        let db = ExternalDatabase {
            host: "db.example.com".into(),
            port: 6543,
            database: "scip prod".into(),
            user: "ops@corp".into(),
            password: "p@ss:w/rd#é".into(),
            ssl: true,
        };
        assert_eq!(
            db.url(),
            "postgresql://ops%40corp:p%40ss%3Aw%2Frd%23%C3%A9@db.example.com:6543/scip%20prod?schema=public&sslmode=require"
        );
        let v6 = ExternalDatabase { host: "::1".into(), ssl: false, ..db.clone() };
        assert!(v6.url().contains("@[::1]:6543/") && !v6.url().contains("sslmode"));
        assert!(!format!("{db:?}").contains("p@ss"), "Debug hides the password");
    }

    #[test]
    fn percent_encoding_keeps_unreserved() {
        assert_eq!(percent_encode("aZ09-._~"), "aZ09-._~");
        assert_eq!(percent_encode("a b+c"), "a%20b%2Bc");
    }

    #[test]
    fn sensitive_values_cover_passwords_and_keys() {
        let plan = production();
        let values = plan.sensitive_values();
        assert!(values.contains(&"Str0ng-Passphrase!".to_owned()));
        assert!(values.contains(&"ais-secret-key".to_owned()));
        assert!(!format!("{plan:?}").contains("Str0ng"), "Debug hides the admin password");
        assert!(!format!("{plan:?}").contains("ais-secret"), "Debug hides feed keys");
    }
}
