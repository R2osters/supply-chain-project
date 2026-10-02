//! Per-installation secrets, generated on first run and kept in `config.json`.
//!
//! There is no server to issue them and no operator to type them, so the app mints its own.
//! They never leave the machine: the sidecars receive them through environment variables.
//! The file sits in the user's `%LOCALAPPDATA%`, whose ACL already restricts it to that user.
//! macOS and Linux have no such ACL: there the file is created readable by its owner only, in a
//! data folder closed to other accounts (`paths.rs`).

use std::io;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};

/// 48 bytes = 384 bits, comfortably above the 256-bit floor for HMAC-SHA256 JWT keys.
const SECRET_BYTES: usize = 48;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Secrets {
    pub jwt_access_secret: String,
    pub jwt_refresh_secret: String,
    pub ai_service_token: String,
    pub postgres_password: String,
    /// Lets this desktop shell reset an administrator's password when it was forgotten (no
    /// e-mail on a desktop install). Added after 0.2.0: `fill_missing` generates it for older
    /// configs on their next start.
    pub local_recovery_token: String,
}

/// Where the SCIP database lives. Written by the installer (`--provision`); absent means embedded.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum DatabaseConfig {
    /// The bundled PostgreSQL cluster in `pgdata`, started and stopped by SCIP.
    #[default]
    Embedded,
    /// A server the customer already runs. The URL carries the password, which is why it
    /// lives here (user-only ACL) and is never logged.
    External { url: String },
}

impl std::fmt::Debug for DatabaseConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Embedded => f.write_str("Embedded"),
            Self::External { .. } => f.write_str("External { url: <redacted> }"),
        }
    }
}

/// The whole `config.json`. Unknown keys are preserved on purpose: later lots (SMTP settings,
/// first-run wizard) will add sections and an older build must not erase them.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalConfig {
    pub secrets: Secrets,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database: Option<DatabaseConfig>,
    /// Simulated vehicle movements (demo) instead of real trackers. `None` keeps the API default
    /// (on), which is what installs made before the installer existed have always had.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub simulator: Option<bool>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, thiserror::Error)]
pub enum SecretsError {
    #[error("cannot read {path}: {source}")]
    Read { path: PathBuf, source: io::Error },
    #[error("{path} is not valid JSON ({source}); fix or delete it (deleting resets the database password)")]
    Parse { path: PathBuf, source: serde_json::Error },
    #[error("cannot write {path}: {source}")]
    Write { path: PathBuf, source: io::Error },
    #[error("the OS random generator failed: {0}")]
    Random(String),
}

pub fn generate_secret() -> Result<String, SecretsError> {
    let mut bytes: [u8; SECRET_BYTES] = [0; SECRET_BYTES];
    getrandom::fill(&mut bytes).map_err(|e| SecretsError::Random(e.to_string()))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

impl Secrets {
    /// Generates any blank secret. Returns whether something changed, so the caller only
    /// rewrites the file when needed. Existing values are never rotated: the Postgres
    /// password is baked into the cluster at `initdb` time.
    pub fn fill_missing(&mut self) -> Result<bool, SecretsError> {
        let mut changed: bool = false;
        for slot in [
            &mut self.jwt_access_secret,
            &mut self.jwt_refresh_secret,
            &mut self.ai_service_token,
            &mut self.postgres_password,
            &mut self.local_recovery_token,
        ] {
            if slot.trim().is_empty() {
                *slot = generate_secret()?;
                changed = true;
            }
        }
        Ok(changed)
    }
}

/// Reads `config.json`, creating it or completing it as needed.
pub fn load_or_create(path: &Path) -> Result<LocalConfig, SecretsError> {
    let mut config: LocalConfig = read_config(path)?.unwrap_or_default();
    if config.secrets.fill_missing()? {
        write_config(path, &config)?;
    }
    Ok(config)
}

fn read_config(path: &Path) -> Result<Option<LocalConfig>, SecretsError> {
    let raw: String = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(SecretsError::Read { path: path.to_path_buf(), source }),
    };
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|source| SecretsError::Parse { path: path.to_path_buf(), source })
}

/// Rewrites `config.json` (the installer records the database mode and the simulator choice).
pub fn save(path: &Path, config: &LocalConfig) -> Result<(), SecretsError> {
    write_config(path, config)
}

/// Writes through a temp file and a rename so a crash mid-write cannot leave a truncated
/// file, which would lose the Postgres password and lock the user out of their own data.
fn write_config(path: &Path, config: &LocalConfig) -> Result<(), SecretsError> {
    let to_err = |source: io::Error| SecretsError::Write { path: path.to_path_buf(), source };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(to_err)?;
    }
    let json: String = serde_json::to_string_pretty(config).expect("config is always serialisable");
    let tmp: PathBuf = path.with_extension("json.tmp");
    write_private(&tmp, json.as_bytes()).map_err(to_err)?;
    std::fs::rename(&tmp, path).map_err(to_err)
}

/// macOS and Linux: a file only its owner can read. The mode is given when the file is created,
/// so the secrets are never on disk under a wider one; the leftover of an interrupted write is
/// removed first, because an existing file would keep the mode it has.
#[cfg(unix)]
fn write_private(path: &Path, contents: &[u8]) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?.write_all(contents)
}

/// Windows: the profile's ACL already keeps the folder to its user.
#[cfg(not(unix))]
fn write_private(path: &Path, contents: &[u8]) -> io::Result<()> {
    std::fs::write(path, contents)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_secret_is_long_url_safe_and_unique() {
        let a: String = generate_secret().unwrap();
        let b: String = generate_secret().unwrap();
        assert_ne!(a, b);
        assert_eq!(URL_SAFE_NO_PAD.decode(&a).unwrap().len(), SECRET_BYTES);
        assert!(a.chars().all(|c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn first_run_creates_file_with_all_secrets() {
        let tmp = tempfile::tempdir().unwrap();
        let path: PathBuf = tmp.path().join("config.json");
        let config: LocalConfig = load_or_create(&path).unwrap();
        assert!(path.exists());
        let s: &Secrets = &config.secrets;
        for value in [&s.jwt_access_secret, &s.jwt_refresh_secret, &s.ai_service_token, &s.postgres_password]
        {
            assert!(value.len() >= 43, "secret too short: {value}");
        }
    }

    #[test]
    fn second_run_returns_the_same_secrets() {
        let tmp = tempfile::tempdir().unwrap();
        let path: PathBuf = tmp.path().join("config.json");
        let first: LocalConfig = load_or_create(&path).unwrap();
        let second: LocalConfig = load_or_create(&path).unwrap();
        assert_eq!(first.secrets, second.secrets);
    }

    #[test]
    fn config_from_0_2_0_gains_a_recovery_token_and_keeps_its_secrets() {
        let tmp = tempfile::tempdir().unwrap();
        let path: PathBuf = tmp.path().join("config.json");
        std::fs::write(
            &path,
            r#"{"secrets":{"jwtAccessSecret":"a","jwtRefreshSecret":"r","aiServiceToken":"t","postgresPassword":"p"}}"#,
        )
        .unwrap();
        let config: LocalConfig = load_or_create(&path).unwrap();
        assert_eq!(config.secrets.postgres_password, "p");
        assert_eq!(config.secrets.local_recovery_token.len(), 64, "48 random bytes, base64url");
        assert_eq!(
            load_or_create(&path).unwrap().secrets.local_recovery_token,
            config.secrets.local_recovery_token
        );
    }

    #[test]
    fn blank_secret_is_completed_and_others_kept() {
        let tmp = tempfile::tempdir().unwrap();
        let path: PathBuf = tmp.path().join("config.json");
        std::fs::write(
            &path,
            r#"{"secrets":{"postgresPassword":"keep-me","jwtAccessSecret":""},"smtp":{"host":"x"}}"#,
        )
        .unwrap();
        let config: LocalConfig = load_or_create(&path).unwrap();
        assert_eq!(config.secrets.postgres_password, "keep-me");
        assert!(!config.secrets.jwt_access_secret.is_empty());
        assert!(config.extra.contains_key("smtp"), "unknown sections must survive a rewrite");
        let reread: LocalConfig = load_or_create(&path).unwrap();
        assert_eq!(reread, config);
    }

    #[test]
    fn database_mode_and_simulator_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let path: PathBuf = tmp.path().join("config.json");
        let mut config: LocalConfig = load_or_create(&path).unwrap();
        assert_eq!(config.database, None, "absent means embedded");
        config.database = Some(DatabaseConfig::External { url: "postgresql://u:p@h:5432/d".into() });
        config.simulator = Some(false);
        save(&path, &config).unwrap();
        let raw: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["database"]["mode"], "external");
        assert_eq!(raw["simulator"], false);
        assert_eq!(load_or_create(&path).unwrap(), config);
        assert!(!format!("{:?}", config.database).contains("u:p"), "Debug must not print the URL");
    }

    #[test]
    fn embedded_mode_parses() {
        let config: LocalConfig = serde_json::from_str(r#"{"database":{"mode":"embedded"}}"#).unwrap();
        assert_eq!(config.database, Some(DatabaseConfig::Embedded));
        assert!(config.extra.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_readable_by_its_owner_only_from_creation_and_after_a_rewrite() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let tmp = tempfile::tempdir().unwrap();
        let path: PathBuf = tmp.path().join("config.json");
        let mut config: LocalConfig = load_or_create(&path).unwrap();
        assert_eq!(mode(&path), 0o600);

        // An interrupted write left a world-readable temp file behind: it must not set the mode.
        let leftover: PathBuf = path.with_extension("json.tmp");
        std::fs::write(&leftover, "{}").unwrap();
        std::fs::set_permissions(&leftover, std::fs::Permissions::from_mode(0o644)).unwrap();
        config.simulator = Some(false);
        save(&path, &config).unwrap();
        assert_eq!(mode(&path), 0o600);
        assert!(!leftover.exists());
    }

    #[test]
    fn corrupt_file_is_reported_not_overwritten() {
        let tmp = tempfile::tempdir().unwrap();
        let path: PathBuf = tmp.path().join("config.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert!(matches!(load_or_create(&path), Err(SecretsError::Parse { .. })));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
    }
}
