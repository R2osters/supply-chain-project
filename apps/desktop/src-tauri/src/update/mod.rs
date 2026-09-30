//! Automatic updates from the GitHub releases of R2osters/supply-chain-project
//! (docs/superpowers/specs/2026-09-30-auto-update-design.md).
//!
//! SCIP reads `latest.json` of the latest release, downloads a newer `SCIP-Setup-x.y.z.exe` in
//! the background and installs it only after checking its size, SHA-256 and an Ed25519
//! signature made with the publisher's private key, which never leaves the publisher's PC. A
//! hijacked GitHub account alone cannot push code to the installed SCIPs.

pub mod cli;
pub mod launch;
pub mod manifest;
pub mod updater;
pub mod verify;
pub mod version;

pub use manifest::UpdateManifest;
pub use version::Version;

/// Where the latest release describes itself (no API rate limit, no token: the repository is public).
pub const FEED_URL: &str =
    "https://github.com/R2osters/supply-chain-project/releases/latest/download/latest.json";
/// Installers are only ever downloaded from the releases of this repository.
pub const ALLOWED_PREFIX: &str = "https://github.com/R2osters/supply-chain-project/releases/download/";
/// A local feed for tests. Harmless in production: whatever it serves must still be signed with
/// the publisher's key and come from the feed's own origin.
pub const FEED_ENV: &str = "SCIP_UPDATE_FEED";
/// Another public key: debug builds and builds with the `update-test` feature only, so that no
/// environment variable can make a released SCIP trust someone else's installers.
pub const PUBLIC_KEY_ENV: &str = "SCIP_UPDATE_PUBLIC_KEY";
const KEY_OVERRIDE_ALLOWED: bool = cfg!(any(debug_assertions, feature = "update-test"));

/// Written by `npm run release:keygen`; empty in a build made before the key existed.
const EMBEDDED_PUBLIC_KEY: &str = include_str!("../../update-key.pub");

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum UpdateError {
    #[error("{0}")]
    Manifest(String),
    #[error("{0}")]
    Verification(String),
    #[error("{0}")]
    Network(String),
    #[error("{0}")]
    Io(String),
}

/// Where to look and whom to trust.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateConfig {
    pub feed: String,
    pub allowed_prefix: String,
    pub public_key: String,
}

impl UpdateConfig {
    /// `None` when no public key is compiled in nor given: a development build never updates.
    pub fn from_env() -> Option<Self> {
        let key_override: Option<String> =
            if KEY_OVERRIDE_ALLOWED { std::env::var(PUBLIC_KEY_ENV).ok() } else { None };
        Self::resolve(std::env::var(FEED_ENV).ok(), key_override, EMBEDDED_PUBLIC_KEY)
    }

    fn resolve(feed: Option<String>, key: Option<String>, embedded: &str) -> Option<Self> {
        let public_key: String =
            key.filter(|k| !k.trim().is_empty()).unwrap_or_else(|| embedded.to_owned()).trim().to_owned();
        if public_key.is_empty() {
            return None;
        }
        match feed.filter(|f| !f.trim().is_empty()) {
            Some(feed) => {
                let allowed_prefix: String = origin(&feed)?;
                Some(Self { feed, allowed_prefix, public_key })
            }
            None => Some(Self {
                feed: FEED_URL.to_owned(),
                allowed_prefix: ALLOWED_PREFIX.to_owned(),
                public_key,
            }),
        }
    }
}

/// `http://127.0.0.1:8765/x/latest.json` → `http://127.0.0.1:8765/`.
fn origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let host: &str = rest.split('/').next().filter(|h| !h.is_empty())?;
    Some(format!("{scheme}://{host}/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_build_without_key_never_updates() {
        assert_eq!(UpdateConfig::resolve(None, None, ""), None);
        assert_eq!(UpdateConfig::resolve(None, Some("  ".into()), "\n"), None);
    }

    #[test]
    fn the_release_feed_is_used_by_default() {
        let config = UpdateConfig::resolve(None, None, "a2V5\n").unwrap();
        assert_eq!(config.feed, FEED_URL);
        assert_eq!(config.allowed_prefix, ALLOWED_PREFIX);
        assert_eq!(config.public_key, "a2V5");
    }

    #[test]
    fn a_test_feed_only_allows_its_own_origin() {
        let config = UpdateConfig::resolve(
            Some("http://127.0.0.1:8765/feed/latest.json".into()),
            Some("dGVzdA==".into()),
            "",
        )
        .unwrap();
        assert_eq!(config.allowed_prefix, "http://127.0.0.1:8765/");
        assert_eq!(config.public_key, "dGVzdA==");
        assert_eq!(UpdateConfig::resolve(Some("file:///c/latest.json".into()), Some("k".into()), ""), None);
    }
}
