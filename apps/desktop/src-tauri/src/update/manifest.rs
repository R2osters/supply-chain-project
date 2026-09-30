//! `latest.json`, the description a release gives of itself.

use serde::{Deserialize, Serialize};

use super::{UpdateError, Version};

/// Larger than any SCIP installer will ever be; a bigger announced size is a broken manifest.
const MAX_INSTALLER_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateManifest {
    pub version: String,
    #[serde(default)]
    pub pub_date: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    pub url: String,
    pub size: u64,
    pub sha256: String,
    pub signature: String,
}

impl UpdateManifest {
    pub fn parse(body: &str) -> Result<Self, UpdateError> {
        serde_json::from_str(body).map_err(|e| UpdateError::Manifest(format!("latest.json illisible : {e}")))
    }

    /// Everything checkable before downloading: the version, where the file comes from, and the
    /// shape of the checksum and signature.
    pub fn validate(&self, allowed_prefix: &str) -> Result<Version, UpdateError> {
        let version: Version = Version::parse(&self.version)
            .ok_or_else(|| UpdateError::Manifest(format!("version « {} » invalide", self.version)))?;
        let rest: &str = self
            .url
            .strip_prefix(allowed_prefix)
            .ok_or_else(|| UpdateError::Manifest("l'installeur ne vient pas des releases de SCIP".into()))?;
        if rest.is_empty()
            || rest.contains("..")
            || rest.contains('\\')
            || !rest.to_ascii_lowercase().ends_with(".exe")
        {
            return Err(UpdateError::Manifest("adresse d'installeur invalide".into()));
        }
        if self.size == 0 || self.size > MAX_INSTALLER_BYTES {
            return Err(UpdateError::Manifest("taille d'installeur invalide".into()));
        }
        if self.sha256.len() != 64
            || !self.sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(UpdateError::Manifest("empreinte SHA-256 invalide".into()));
        }
        if self.signature.trim().is_empty() {
            return Err(UpdateError::Manifest("signature absente".into()));
        }
        Ok(version)
    }

    /// The file name the installer is saved under: taken from the version, never from the URL.
    pub fn file_name(&self, version: &Version) -> String {
        format!("SCIP-Setup-{version}.exe")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::update::ALLOWED_PREFIX;

    pub fn manifest() -> UpdateManifest {
        UpdateManifest {
            version: "0.3.0".into(),
            pub_date: Some("2026-10-01T10:00:00Z".into()),
            notes: Some("Nouveautés".into()),
            url: format!("{ALLOWED_PREFIX}v0.3.0/SCIP-Setup-0.3.0.exe"),
            size: 341_891_258,
            sha256: "a".repeat(64),
            signature: "c2ln".into(),
        }
    }

    #[test]
    fn a_good_manifest_passes() {
        assert_eq!(manifest().validate(ALLOWED_PREFIX).unwrap().to_string(), "0.3.0");
        let parsed = UpdateManifest::parse(&serde_json::to_string(&manifest()).unwrap()).unwrap();
        assert_eq!(parsed, manifest());
        assert!(UpdateManifest::parse(
            r#"{"version":"0.3.0","url":"x","size":1,"sha256":"a","signature":"s"}"#
        )
        .is_ok());
    }

    #[test]
    fn a_file_from_elsewhere_is_refused() {
        for url in [
            "https://github.com/someone-else/supply-chain-project/releases/download/v0.3.0/SCIP-Setup-0.3.0.exe".to_owned(),
            "https://evil.example/SCIP-Setup-0.3.0.exe".to_owned(),
            format!("{ALLOWED_PREFIX}v0.3.0/../../x.exe"),
            format!("{ALLOWED_PREFIX}v0.3.0/notes.txt"),
            ALLOWED_PREFIX.to_owned(),
        ] {
            let mut m = manifest();
            m.url = url.clone();
            assert!(m.validate(ALLOWED_PREFIX).is_err(), "{url}");
        }
    }

    #[test]
    fn malformed_fields_are_refused() {
        let cases: [fn(&mut UpdateManifest); 6] = [
            |m| m.version = "latest".into(),
            |m| m.size = 0,
            |m| m.size = 3 * 1024 * 1024 * 1024,
            |m| m.sha256 = "A".repeat(64),
            |m| m.sha256 = "a".repeat(63),
            |m| m.signature = " ".into(),
        ];
        for change in cases {
            let mut m = manifest();
            change(&mut m);
            assert!(m.validate(ALLOWED_PREFIX).is_err(), "{m:?}");
        }
    }

    #[test]
    fn the_saved_name_comes_from_the_version() {
        let m = manifest();
        assert_eq!(m.file_name(&m.validate(ALLOWED_PREFIX).unwrap()), "SCIP-Setup-0.3.0.exe");
    }
}
