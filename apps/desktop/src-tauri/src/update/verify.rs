//! The signature contract shared with `scripts/release/sign.mjs`:
//! Ed25519 over the UTF-8 of `scip-update-v1\n{version}\n{sha256}\n{size}`, base64 standard;
//! the public key is the base64 of its 32 raw bytes.

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

use super::{UpdateError, UpdateManifest};

pub fn update_message(version: &str, sha256: &str, size: u64) -> String {
    format!("scip-update-v1\n{version}\n{sha256}\n{size}")
}

pub fn verify_signature(public_key_b64: &str, message: &[u8], signature_b64: &str) -> Result<(), UpdateError> {
    let key_bytes: Vec<u8> = STANDARD
        .decode(public_key_b64.trim())
        .map_err(|_| UpdateError::Verification("clé publique de mise à jour illisible".into()))?;
    let key_array: [u8; 32] = key_bytes
        .try_into()
        .map_err(|_| UpdateError::Verification("clé publique de mise à jour de mauvaise taille".into()))?;
    let key = VerifyingKey::from_bytes(&key_array)
        .map_err(|_| UpdateError::Verification("clé publique de mise à jour invalide".into()))?;
    let signature_bytes: Vec<u8> = STANDARD
        .decode(signature_b64.trim())
        .map_err(|_| UpdateError::Verification("signature illisible".into()))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| UpdateError::Verification("signature de mauvaise taille".into()))?;
    key.verify_strict(message, &signature)
        .map_err(|_| UpdateError::Verification("signature invalide : cet installeur n'a pas été publié par l'éditeur de SCIP".into()))
}

/// SHA-256 (lowercase hex) and size of a file, read in chunks: an installer is ~330 MB.
pub fn sha256_file(path: &Path) -> Result<(String, u64), UpdateError> {
    let file: File = File::open(path).map_err(|e| UpdateError::Io(format!("lecture de {} : {e}", path.display())))?;
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    let mut size: u64 = 0;
    loop {
        let read: usize = reader.read(&mut buffer).map_err(|e| UpdateError::Io(format!("lecture : {e}")))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size += read as u64;
    }
    let digest = hasher.finalize();
    Ok((digest.iter().map(|b| format!("{b:02x}")).collect(), size))
}

/// Size, checksum, then the signature binding them to the version.
pub fn verify_download(path: &Path, manifest: &UpdateManifest, public_key_b64: &str) -> Result<(), UpdateError> {
    let (sha256, size) = sha256_file(path)?;
    if size != manifest.size {
        return Err(UpdateError::Verification(format!("taille inattendue ({size} octets au lieu de {})", manifest.size)));
    }
    if sha256 != manifest.sha256 {
        return Err(UpdateError::Verification("empreinte SHA-256 différente : fichier altéré ou incomplet".into()));
    }
    let message: String = update_message(&manifest.version, &manifest.sha256, manifest.size);
    verify_signature(public_key_b64, message.as_bytes(), &manifest.signature)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    pub fn test_key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    pub fn public_b64(key: &SigningKey) -> String {
        STANDARD.encode(key.verifying_key().to_bytes())
    }

    pub fn sign(key: &SigningKey, version: &str, sha256: &str, size: u64) -> String {
        STANDARD.encode(key.sign(update_message(version, sha256, size).as_bytes()).to_bytes())
    }

    fn signed_file(dir: &Path, body: &[u8], version: &str) -> (std::path::PathBuf, UpdateManifest) {
        let path = dir.join("SCIP-Setup.exe");
        std::fs::write(&path, body).unwrap();
        let (sha256, size) = sha256_file(&path).unwrap();
        let manifest = UpdateManifest {
            version: version.into(),
            pub_date: None,
            notes: None,
            url: "https://x/SCIP-Setup.exe".into(),
            size,
            sha256: sha256.clone(),
            signature: sign(&test_key(), version, &sha256, size),
        };
        (path, manifest)
    }

    #[test]
    fn the_message_format_is_the_contract() {
        assert_eq!(update_message("0.3.0", "ab", 12), "scip-update-v1\n0.3.0\nab\n12");
    }

    /// Made by scripts/release/sign.mjs (Node) with the same seed: what the release script signs,
    /// SCIP accepts (scripts/release/sign.test.mjs holds the mirror of this test).
    #[test]
    fn accepts_a_signature_from_the_release_script() {
        const PUBLIC: &str = "6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=";
        const SIGNATURE: &str = "XT8m7PZ/9BCQ0A0czOYby2gh/r8flnCyc649HWD2af7PZyujTLf0YZyH8xO54seA7oo7wffQN2v1ZTN149xAAQ==";
        assert_eq!(public_b64(&test_key()), PUBLIC);
        let message = update_message("0.3.0", &"ab".repeat(32), 1234);
        assert!(verify_signature(PUBLIC, message.as_bytes(), SIGNATURE).is_ok());
        let other = update_message("0.3.0", &"ab".repeat(32), 1235);
        assert!(verify_signature(PUBLIC, other.as_bytes(), SIGNATURE).is_err());
    }

    #[test]
    fn sha256_matches_a_known_digest() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f");
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(
            sha256_file(&path).unwrap(),
            ("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".to_owned(), 3)
        );
    }

    #[test]
    fn a_genuine_installer_passes() {
        let dir = tempfile::tempdir().unwrap();
        let (path, manifest) = signed_file(dir.path(), b"installer bytes", "0.3.0");
        assert_eq!(verify_download(&path, &manifest, &public_b64(&test_key())), Ok(()));
    }

    #[test]
    fn any_change_is_caught() {
        let dir = tempfile::tempdir().unwrap();
        let key = public_b64(&test_key());
        let (path, manifest) = signed_file(dir.path(), b"installer bytes", "0.3.0");

        // The file changed after signing.
        std::fs::write(&path, b"installer bytez").unwrap();
        assert!(matches!(verify_download(&path, &manifest, &key), Err(UpdateError::Verification(_))));
        std::fs::write(&path, b"installer bytes").unwrap();

        // A genuine signature presented under another version.
        let mut relabelled = manifest.clone();
        relabelled.version = "9.9.9".into();
        assert!(verify_download(&path, &relabelled, &key).is_err());

        // A forged checksum matching a different file.
        let mut forged = manifest.clone();
        forged.signature = sign(&SigningKey::from_bytes(&[9u8; 32]), "0.3.0", &manifest.sha256, manifest.size);
        assert!(verify_download(&path, &forged, &key).is_err());

        // Garbage signature and garbage key.
        let mut garbage = manifest.clone();
        garbage.signature = "bm9w".into();
        assert!(verify_download(&path, &garbage, &key).is_err());
        assert!(verify_download(&path, &manifest, "bm90IGEga2V5").is_err());

        assert_eq!(verify_download(&path, &manifest, &key), Ok(()));
    }
}
