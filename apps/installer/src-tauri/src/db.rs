//! Screen 05b "Tester la connexion": can SCIP use this existing PostgreSQL?
//!
//! Requirements (docs/installer.md): reachable, version ≥ 14, PostGIS installed or available,
//! and the right to create objects in the database (migrations create schemas and extensions).

use std::time::Duration;

use serde::{Deserialize, Deserializer, Serialize};

use crate::context::Locale;
use crate::events::CommandError;

pub const TIMEOUT: Duration = Duration::from_secs(8);
pub const MIN_SERVER_VERSION_NUM: i32 = 140000;

#[derive(Clone, Deserialize)]
pub struct DbParams {
    pub host: String,
    #[serde(deserialize_with = "port_from_number_or_text")]
    pub port: u16,
    pub database: String,
    pub user: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub ssl: bool,
}

/// Never prints the password.
impl std::fmt::Debug for DbParams {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}@{}:{}/{} ssl={}", self.user, self.host, self.port, self.database, self.ssl)
    }
}

/// Form fields often arrive as text; accept `5432` and `"5432"`.
pub fn port_from_number_or_text<'de, D: Deserializer<'de>>(d: D) -> Result<u16, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Port {
        Number(u16),
        Text(String),
    }
    match Port::deserialize(d)? {
        Port::Number(n) => Ok(n),
        Port::Text(t) => t.trim().parse().map_err(serde::de::Error::custom),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Postgis {
    Installed,
    Available,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbReport {
    pub ok: bool,
    pub server_version: String,
    pub postgis: Postgis,
    pub can_create: bool,
    pub message: String,
    /// Why `ok` is false (`version_too_old`, `postgis_missing`, `no_create_privilege`), for
    /// the screens to translate. Absent when ok.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'static str>,
}

/// Server facts gathered in one round trip.
#[derive(Debug, Clone)]
pub struct ServerFacts {
    pub version: String,
    pub version_num: i32,
    pub postgis_installed: bool,
    pub postgis_available: bool,
    pub can_create: bool,
}

pub fn assess(facts: &ServerFacts, l: Locale) -> DbReport {
    let postgis = match (facts.postgis_installed, facts.postgis_available) {
        (true, _) => Postgis::Installed,
        (false, true) => Postgis::Available,
        (false, false) => Postgis::Missing,
    };
    let problem: Option<(&'static str, String)> = if facts.version_num < MIN_SERVER_VERSION_NUM {
        Some((
            "version_too_old",
            format!(
                "PostgreSQL {} : {}",
                facts.version,
                l.pick("version 14 ou plus récente requise", "version 14 or later required")
            ),
        ))
    } else if postgis == Postgis::Missing {
        Some((
            "postgis_missing",
            l.pick(
                "L'extension PostGIS n'est pas disponible sur ce serveur",
                "The PostGIS extension is not available on this server",
            )
            .into(),
        ))
    } else if !facts.can_create {
        Some((
            "no_create_privilege",
            l.pick(
                "Cet utilisateur n'a pas le droit CREATE sur la base",
                "This user lacks the CREATE privilege on the database",
            )
            .into(),
        ))
    } else {
        None
    };
    let (code, message) = match problem {
        Some((code, message)) => (Some(code), message),
        None => {
            (None, format!("PostgreSQL {} · {}", facts.version, l.pick("connexion réussie", "connection OK")))
        }
    };
    DbReport {
        ok: code.is_none(),
        server_version: facts.version.clone(),
        postgis,
        can_create: facts.can_create,
        message,
        code,
    }
}

/// Maps a connection failure to a stable code. Inputs are what tokio-postgres exposes: the
/// SQLSTATE sent by the server (if any), the full error text, and whether it was a socket error.
pub fn classify(sqlstate: Option<&str>, text: &str, io_error: bool) -> &'static str {
    let lower = text.to_lowercase();
    match sqlstate {
        Some("28P01") => "auth_failed",
        Some("3D000") => "db_not_found",
        // pg_hba rejects non-TLS connections with 28000 "... no encryption" / "SSL off".
        Some("28000") if lower.contains("ssl off") || lower.contains("no encryption") => "ssl_required",
        Some("28000") => "auth_failed",
        _ if lower.contains("server does not support tls")
            || lower.contains("server does not support ssl") =>
        {
            "ssl_not_supported"
        }
        _ if lower.contains("password authentication failed") => "auth_failed",
        _ if io_error
            || lower.contains("error connecting")
            || lower.contains("no such host")
            || lower.contains("refused")
            || lower.contains("failed to lookup") =>
        {
            "host_unreachable"
        }
        _ => "connection_failed",
    }
}

fn friendly(code: &str, l: Locale) -> &'static str {
    match code {
        "auth_failed" => l.pick("Utilisateur ou mot de passe refusé", "User or password rejected"),
        "db_not_found" => l.pick("Cette base n'existe pas sur le serveur", "This database does not exist"),
        "ssl_required" => {
            l.pick("Le serveur exige SSL : cochez « SSL »", "The server requires SSL: tick \"SSL\"")
        }
        "ssl_not_supported" => l.pick("Le serveur n'accepte pas SSL", "The server does not accept SSL"),
        "host_unreachable" => {
            l.pick("Serveur injoignable (hôte ou port)", "Server unreachable (host or port)")
        }
        "timeout" => l.pick("Pas de réponse du serveur en 8 s", "No answer from the server within 8 s"),
        _ => l.pick("Connexion impossible", "Could not connect"),
    }
}

fn describe(e: &tokio_postgres::Error) -> String {
    // The top-level text is often just "error connecting to server"; the cause says why.
    let mut text = e.to_string();
    let mut source = std::error::Error::source(e);
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

fn connection_error(e: &tokio_postgres::Error, l: Locale) -> CommandError {
    let text = describe(e);
    let is_io = std::error::Error::source(e).is_some_and(|s| s.is::<std::io::Error>());
    let code = classify(e.code().map(|c| c.code()), &text, is_io);
    CommandError::new(code, friendly(code, l)).with_detail(text)
}

const FACTS_QUERY: &str = "SELECT current_setting('server_version'), \
    current_setting('server_version_num')::int, \
    EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis'), \
    EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'postgis'), \
    has_database_privilege(current_user, current_database(), 'CREATE')";

async fn gather(params: &DbParams, timeout: Duration, l: Locale) -> Result<ServerFacts, CommandError> {
    let mut config = tokio_postgres::Config::new();
    config
        .host(&params.host)
        .port(params.port)
        .dbname(&params.database)
        .user(&params.user)
        .password(&params.password)
        .application_name("SCIP Setup")
        .connect_timeout(timeout);
    let client = if params.ssl {
        // Like libpq's sslmode=require: encrypted, certificate not verified. Self-hosted servers
        // mostly use self-signed certificates, and the installer has no CA to check them against.
        let tls = native_tls::TlsConnector::builder()
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true)
            .build()
            .map_err(|e| CommandError::new("ssl_setup", e.to_string()))?;
        config.ssl_mode(tokio_postgres::config::SslMode::Require);
        let (client, connection) = config
            .connect(postgres_native_tls::MakeTlsConnector::new(tls))
            .await
            .map_err(|e| connection_error(&e, l))?;
        tokio::spawn(connection);
        client
    } else {
        config.ssl_mode(tokio_postgres::config::SslMode::Disable);
        let (client, connection) =
            config.connect(tokio_postgres::NoTls).await.map_err(|e| connection_error(&e, l))?;
        tokio::spawn(connection);
        client
    };
    let row = client.query_one(FACTS_QUERY, &[]).await.map_err(|e| connection_error(&e, l))?;
    let version: String = row.get(0);
    Ok(ServerFacts {
        // "16.4 (Debian 16.4-1.pgdg120+1)" → "16.4"
        version: version.split_whitespace().next().unwrap_or_default().to_string(),
        version_num: row.get(1),
        postgis_installed: row.get(2),
        postgis_available: row.get(3),
        can_create: row.get(4),
    })
}

pub async fn test_database(
    params: &DbParams,
    timeout: Duration,
    l: Locale,
) -> Result<DbReport, CommandError> {
    match tokio::time::timeout(timeout, gather(params, timeout, l)).await {
        Ok(facts) => Ok(assess(&facts?, l)),
        Err(_) => Err(CommandError::new("timeout", friendly("timeout", l))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(version_num: i32, installed: bool, available: bool, can_create: bool) -> ServerFacts {
        ServerFacts {
            version: "16.4".into(),
            version_num,
            postgis_installed: installed,
            postgis_available: available,
            can_create,
        }
    }

    #[test]
    fn assessment_order_and_contract_shape() {
        let good = assess(&facts(160004, false, true, true), Locale::Fr);
        assert!(good.ok && good.postgis == Postgis::Available && good.code.is_none());
        let json = serde_json::to_value(&good).unwrap();
        assert_eq!(json["serverVersion"], "16.4");
        assert_eq!(json["canCreate"], true);
        assert_eq!(json["postgis"], "available");
        assert!(json.get("code").is_none());

        assert_eq!(assess(&facts(130009, true, true, true), Locale::Fr).code, Some("version_too_old"));
        assert_eq!(assess(&facts(140000, false, false, true), Locale::Fr).code, Some("postgis_missing"));
        let no_create = assess(&facts(170000, true, true, false), Locale::En);
        assert_eq!(
            (no_create.ok, no_create.code, no_create.postgis),
            (false, Some("no_create_privilege"), Postgis::Installed)
        );
    }

    #[test]
    fn error_codes() {
        assert_eq!(classify(Some("28P01"), "password authentication failed", false), "auth_failed");
        assert_eq!(classify(Some("3D000"), "database \"x\" does not exist", false), "db_not_found");
        assert_eq!(
            classify(
                Some("28000"),
                "no pg_hba.conf entry for host \"1.2.3.4\", user \"u\", database \"d\", SSL off",
                false
            ),
            "ssl_required"
        );
        assert_eq!(classify(Some("28000"), "role \"x\" is not permitted to log in", false), "auth_failed");
        assert_eq!(
            classify(None, "error performing TLS handshake: server does not support TLS", false),
            "ssl_not_supported"
        );
        assert_eq!(
            classify(None, "error connecting to server: No connection could be made", true),
            "host_unreachable"
        );
        assert_eq!(classify(None, "something odd", false), "connection_failed");
    }

    #[test]
    fn port_accepts_text() {
        let p: DbParams = serde_json::from_value(serde_json::json!({
            "host": "h", "port": "5433", "database": "d", "user": "u", "password": "secret", "ssl": true
        }))
        .unwrap();
        assert_eq!(p.port, 5433);
        assert!(!format!("{p:?}").contains("secret"));
        let p: DbParams = serde_json::from_value(
            serde_json::json!({"host": "h", "port": 5432, "database": "d", "user": "u"}),
        )
        .unwrap();
        assert!(!p.ssl && p.password.is_empty());
    }

    /// Port 1 on localhost is closed: the refusal must come back as a coded error, fast.
    #[tokio::test]
    async fn closed_port_is_unreachable() {
        let params = DbParams {
            host: "127.0.0.1".into(),
            port: 1,
            database: "d".into(),
            user: "u".into(),
            password: "p".into(),
            ssl: false,
        };
        let error = test_database(&params, Duration::from_secs(5), Locale::Fr).await.unwrap_err();
        assert!(matches!(error.code.as_str(), "host_unreachable" | "timeout"), "{error:?}");
    }
}
