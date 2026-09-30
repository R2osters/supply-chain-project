//! The update cycle: check the feed, download a newer installer, verify it, keep it ready.
//!
//! Network access goes through `Fetcher` so the cycle is tested without a network. Nothing here
//! installs anything: `ready_installer` hands a freshly re-verified, locked file to the caller,
//! which starts the installer while the lock holds.

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use super::manifest::UpdateManifest;
use super::verify::{open_locked, verify_download, verify_open};
use super::{UpdateConfig, UpdateError, Version};

pub trait Fetcher: Send + Sync {
    fn text(&self, url: &str) -> Result<String, UpdateError>;
    /// Writes the body of `url` to `to`, calling `progress(received, total)` along the way; stops
    /// with an error past `max_bytes`.
    fn download(
        &self,
        url: &str,
        to: &Path,
        max_bytes: u64,
        progress: &dyn Fn(u64),
    ) -> Result<(), UpdateError>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum UpdateState {
    /// A build without the publisher's public key never updates.
    Disabled,
    Idle,
    Checking,
    UpToDate,
    #[serde(rename_all = "camelCase")]
    Downloading {
        version: String,
        received: u64,
        total: u64,
    },
    #[serde(rename_all = "camelCase")]
    Ready {
        version: String,
        notes: Option<String>,
        pub_date: Option<String>,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current: String,
    #[serde(flatten)]
    pub state: UpdateState,
    /// RFC 3339 time of the last completed check (successful or offline).
    pub last_check: Option<String>,
    /// The last check could not reach GitHub (offline, or no release yet): not an alarm.
    pub offline: bool,
}

struct Inner {
    state: UpdateState,
    /// The verified installer on disk, whatever the state shows (a later check may be running).
    ready: Option<Version>,
    last_check: Option<String>,
    offline: bool,
    busy: bool,
}

/// An installer checked through `lock`, which nobody can replace until it is dropped: keep it
/// until the installer has started.
pub struct ReadyInstaller {
    pub path: PathBuf,
    pub version: Version,
    pub lock: File,
}

pub struct Updater {
    config: Option<UpdateConfig>,
    current: Version,
    dir: PathBuf,
    fetcher: Arc<dyn Fetcher>,
    inner: Mutex<Inner>,
    on_change: Box<dyn Fn(&UpdateStatus) + Send + Sync>,
}

fn now_rfc3339() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
}

impl Updater {
    pub fn new(
        config: Option<UpdateConfig>,
        current: Version,
        dir: PathBuf,
        fetcher: Arc<dyn Fetcher>,
        on_change: Box<dyn Fn(&UpdateStatus) + Send + Sync>,
    ) -> Self {
        let state = if config.is_some() { UpdateState::Idle } else { UpdateState::Disabled };
        Self {
            config,
            current,
            dir,
            fetcher,
            inner: Mutex::new(Inner { state, ready: None, last_check: None, offline: false, busy: false }),
            on_change,
        }
    }

    pub fn enabled(&self) -> bool {
        self.config.is_some()
    }

    pub fn status(&self) -> UpdateStatus {
        let inner = self.inner.lock().unwrap();
        UpdateStatus {
            current: self.current.to_string(),
            state: inner.state.clone(),
            last_check: inner.last_check.clone(),
            offline: inner.offline,
        }
    }

    fn set(&self, state: UpdateState) {
        self.inner.lock().unwrap().state = state;
        (self.on_change)(&self.status());
    }

    /// A version holds only `[0-9A-Za-z.-]` (version.rs), so these names never leave `dir`.
    fn installer_path(&self, version: &Version) -> PathBuf {
        self.dir.join(format!("SCIP-Setup-{version}.exe"))
    }

    fn manifest_path(&self, version: &Version) -> PathBuf {
        self.dir.join(format!("SCIP-Setup-{version}.json"))
    }

    /// The manifest saved next to an installer, valid for this feed and for this very version:
    /// a genuine old release renamed to a higher version is refused.
    fn saved_manifest(
        &self,
        config: &UpdateConfig,
        version: &Version,
    ) -> Result<UpdateManifest, UpdateError> {
        let body = std::fs::read_to_string(self.manifest_path(version))
            .map_err(|e| UpdateError::Io(e.to_string()))?;
        let manifest = UpdateManifest::parse(&body)?;
        if manifest.validate(&config.allowed_prefix)? != *version {
            return Err(UpdateError::Verification(format!(
                "le manifeste enregistré annonce {} et non {version}",
                manifest.version
            )));
        }
        Ok(manifest)
    }

    /// Whether a verified installer is waiting (the state may show a check in progress).
    pub fn has_ready(&self) -> bool {
        self.inner.lock().unwrap().ready.is_some()
    }

    fn set_ready(&self, version: &Version, manifest: &UpdateManifest) {
        self.inner.lock().unwrap().ready = Some(version.clone());
        self.set(ready_state(version, manifest));
    }

    /// At startup: drops installers that are not newer than this SCIP, and offers a newer one
    /// downloaded earlier if it still verifies.
    pub fn restore(&self) {
        let Some(config) = &self.config else { return };
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return };
        let mut best: Option<(Version, UpdateManifest)> = None;
        for entry in entries.flatten() {
            let name: String = entry.file_name().to_string_lossy().into_owned();
            let Some(version) = name
                .strip_prefix("SCIP-Setup-")
                .and_then(|rest| rest.strip_suffix(".json"))
                .and_then(Version::parse)
            else {
                if name.ends_with(".part") {
                    let _ = std::fs::remove_file(entry.path());
                }
                continue;
            };
            let manifest: Option<UpdateManifest> = self.saved_manifest(config, &version).ok();
            let usable = version > self.current
                && manifest.as_ref().is_some_and(|m| {
                    verify_download(&self.installer_path(&version), m, &config.public_key).is_ok()
                });
            match manifest {
                Some(manifest) if usable => {
                    if best.as_ref().map_or(true, |(v, _)| version > *v) {
                        best = Some((version, manifest));
                    }
                }
                _ => self.discard(&version),
            }
        }
        if let Some((version, manifest)) = best {
            self.set_ready(&version, &manifest);
        }
    }

    fn discard(&self, version: &Version) {
        let _ = std::fs::remove_file(self.installer_path(version));
        let _ = std::fs::remove_file(self.manifest_path(version));
        let mut inner = self.inner.lock().unwrap();
        if inner.ready.as_ref() == Some(version) {
            inner.ready = None;
        }
    }

    /// One full check: feed, comparison, download and verification. Blocking; returns the new
    /// status. A check already running makes this a no-op.
    pub fn check_now(&self) -> UpdateStatus {
        let Some(config) = self.config.clone() else { return self.status() };
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.busy {
                return UpdateStatus {
                    current: self.current.to_string(),
                    state: inner.state.clone(),
                    last_check: inner.last_check.clone(),
                    offline: inner.offline,
                };
            }
            inner.busy = true;
        }
        let previous: UpdateState = self.status().state;
        // A ready update stays on screen (and installable) while the next check runs.
        if !matches!(previous, UpdateState::Ready { .. }) {
            self.set(UpdateState::Checking);
        }
        let outcome: Result<UpdateState, UpdateError> = self.run_check(&config);
        {
            let mut inner = self.inner.lock().unwrap();
            inner.busy = false;
            inner.last_check = Some(now_rfc3339());
            inner.offline = matches!(outcome, Err(UpdateError::Network(_)));
        }
        let state = match outcome {
            // Nothing newer than what is ready: keep offering it.
            Ok(UpdateState::UpToDate) if matches!(previous, UpdateState::Ready { .. }) => previous,
            Ok(state) => state,
            // Offline or no release yet: keep what we had (a ready update stays ready).
            Err(UpdateError::Network(e)) => {
                log::info!("update check: {e}");
                match previous {
                    UpdateState::Ready { .. } => previous,
                    _ => UpdateState::Idle,
                }
            }
            Err(e) => {
                log::warn!("update check failed: {e}");
                UpdateState::Error { message: e.to_string() }
            }
        };
        self.set(state);
        self.status()
    }

    fn run_check(&self, config: &UpdateConfig) -> Result<UpdateState, UpdateError> {
        let body: String = self.fetcher.text(&config.feed)?;
        let manifest: UpdateManifest = UpdateManifest::parse(&body)?;
        let version: Version = manifest.validate(&config.allowed_prefix)?;
        if version <= self.current {
            return Ok(UpdateState::UpToDate);
        }
        std::fs::create_dir_all(&self.dir)
            .map_err(|e| UpdateError::Io(format!("dossier des mises à jour : {e}")))?;
        let installer: PathBuf = self.installer_path(&version);
        if verify_download(&installer, &manifest, &config.public_key).is_err() {
            let part: PathBuf = self.dir.join(format!("SCIP-Setup-{version}.exe.part"));
            let total: u64 = manifest.size;
            self.set(UpdateState::Downloading { version: version.to_string(), received: 0, total });
            let last_reported = Mutex::new(0u64);
            let progress = |received: u64| {
                let mut last = last_reported.lock().unwrap();
                // One event per ~2 %: enough for a progress bar, not a flood.
                if received == total || received.saturating_sub(*last) >= total / 50 {
                    *last = received;
                    self.set(UpdateState::Downloading { version: version.to_string(), received, total });
                }
            };
            let downloaded = self.fetcher.download(&manifest.url, &part, total.saturating_add(1), &progress);
            let verified = downloaded.and_then(|()| verify_download(&part, &manifest, &config.public_key));
            if let Err(e) = verified {
                let _ = std::fs::remove_file(&part);
                return Err(e);
            }
            let _ = std::fs::remove_file(&installer);
            std::fs::rename(&part, &installer)
                .map_err(|e| UpdateError::Io(format!("installeur téléchargé : {e}")))?;
        }
        let saved = serde_json::to_string_pretty(&manifest).map_err(|e| UpdateError::Io(e.to_string()))?;
        std::fs::write(self.manifest_path(&version), saved).map_err(|e| UpdateError::Io(e.to_string()))?;
        self.inner.lock().unwrap().ready = Some(version.clone());
        Ok(ready_state(&version, &manifest))
    }

    /// The ready installer, verified once more through a handle that locks it: the caller keeps
    /// `lock` until the installer has started, so the file checked is the file run.
    pub fn ready_installer(&self) -> Result<ReadyInstaller, UpdateError> {
        let config = self
            .config
            .as_ref()
            .ok_or_else(|| UpdateError::Verification("mises à jour désactivées".into()))?;
        let ready: Option<Version> = self.inner.lock().unwrap().ready.clone();
        let version: Version =
            ready.ok_or_else(|| UpdateError::Verification("aucune mise à jour prête".into()))?;
        let path = self.installer_path(&version);
        let verified = self.saved_manifest(config, &version).and_then(|manifest| {
            let mut lock = open_locked(&path)?;
            verify_open(&mut lock, &manifest, &config.public_key).map(|()| lock)
        });
        match verified {
            Ok(lock) => Ok(ReadyInstaller { path, version, lock }),
            Err(e) => {
                self.discard(&version);
                self.set(UpdateState::Error { message: e.to_string() });
                Err(e)
            }
        }
    }
}

fn ready_state(version: &Version, manifest: &UpdateManifest) -> UpdateState {
    UpdateState::Ready {
        version: version.to_string(),
        notes: manifest.notes.clone(),
        pub_date: manifest.pub_date.clone(),
    }
}

/// Real network access (ureq): redirects to GitHub's storage are followed.
pub struct HttpFetcher;

impl HttpFetcher {
    fn agent(timeout: std::time::Duration) -> ureq::Agent {
        ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .http_status_as_error(false)
            .user_agent(concat!("SCIP/", env!("CARGO_PKG_VERSION"), " (updater)"))
            .build()
            .into()
    }
}

impl Fetcher for HttpFetcher {
    fn text(&self, url: &str) -> Result<String, UpdateError> {
        let mut response = Self::agent(std::time::Duration::from_secs(20))
            .get(url)
            .call()
            .map_err(|e| UpdateError::Network(format!("GitHub injoignable : {e}")))?;
        let status: u16 = response.status().as_u16();
        if status != 200 {
            return Err(UpdateError::Network(format!(
                "GitHub a répondu {status} (aucune version publiée ?)"
            )));
        }
        response
            .body_mut()
            .with_config()
            .limit(1024 * 1024)
            .read_to_string()
            .map_err(|e| UpdateError::Network(format!("réponse illisible : {e}")))
    }

    fn download(
        &self,
        url: &str,
        to: &Path,
        max_bytes: u64,
        progress: &dyn Fn(u64),
    ) -> Result<(), UpdateError> {
        use std::io::{Read, Write};
        let mut response = Self::agent(std::time::Duration::from_secs(60 * 60))
            .get(url)
            .call()
            .map_err(|e| UpdateError::Network(format!("téléchargement impossible : {e}")))?;
        if response.status().as_u16() != 200 {
            return Err(UpdateError::Network(format!(
                "téléchargement refusé ({})",
                response.status().as_u16()
            )));
        }
        let mut reader = response.body_mut().with_config().limit(max_bytes).reader();
        let mut file = std::fs::File::create(to)
            .map_err(|e| UpdateError::Io(format!("création de {} : {e}", to.display())))?;
        let mut buffer = vec![0u8; 1 << 20];
        let mut received: u64 = 0;
        loop {
            let read = reader
                .read(&mut buffer)
                .map_err(|e| UpdateError::Network(format!("téléchargement interrompu : {e}")))?;
            if read == 0 {
                break;
            }
            file.write_all(&buffer[..read]).map_err(|e| UpdateError::Io(e.to_string()))?;
            received += read as u64;
            progress(received);
        }
        file.flush().map_err(|e| UpdateError::Io(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::update::verify::sha256_file;
    use crate::update::verify::tests::{public_b64, sign, test_key};
    use std::sync::atomic::{AtomicUsize, Ordering};

    const PREFIX: &str = "http://127.0.0.1:1/";

    struct FakeFetcher {
        feed: Mutex<Result<String, UpdateError>>,
        body: Vec<u8>,
        downloads: AtomicUsize,
    }

    impl Fetcher for FakeFetcher {
        fn text(&self, _url: &str) -> Result<String, UpdateError> {
            self.feed.lock().unwrap().clone()
        }
        fn download(
            &self,
            _url: &str,
            to: &Path,
            _max: u64,
            progress: &dyn Fn(u64),
        ) -> Result<(), UpdateError> {
            self.downloads.fetch_add(1, Ordering::SeqCst);
            std::fs::write(to, &self.body).unwrap();
            progress(self.body.len() as u64);
            Ok(())
        }
    }

    fn manifest_for(body: &[u8], version: &str, signed_body: &[u8]) -> String {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("b");
        std::fs::write(&path, signed_body).unwrap();
        let (sha256, size) = sha256_file(&path).unwrap();
        let _ = body;
        serde_json::to_string(&UpdateManifest {
            version: version.into(),
            pub_date: Some("2026-10-01T10:00:00Z".into()),
            notes: Some("Nouveautés".into()),
            url: format!("{PREFIX}v{version}/SCIP-Setup-{version}.exe"),
            size,
            sha256: sha256.clone(),
            signature: sign(&test_key(), version, &sha256, size),
        })
        .unwrap()
    }

    fn updater(dir: &Path, feed: Result<String, UpdateError>, body: &[u8]) -> (Updater, Arc<FakeFetcher>) {
        let fetcher = Arc::new(FakeFetcher {
            feed: Mutex::new(feed),
            body: body.to_vec(),
            downloads: AtomicUsize::new(0),
        });
        let config = UpdateConfig {
            feed: format!("{PREFIX}latest.json"),
            allowed_prefix: PREFIX.into(),
            public_key: public_b64(&test_key()),
        };
        let updater = Updater::new(
            Some(config),
            Version::parse("0.2.0").unwrap(),
            dir.to_path_buf(),
            fetcher.clone(),
            Box::new(|_| {}),
        );
        (updater, fetcher)
    }

    #[test]
    fn same_version_is_up_to_date() {
        let dir = tempfile::tempdir().unwrap();
        let (u, fetcher) = updater(dir.path(), Ok(manifest_for(b"x", "0.2.0", b"x")), b"x");
        assert_eq!(u.check_now().state, UpdateState::UpToDate);
        assert_eq!(fetcher.downloads.load(Ordering::SeqCst), 0);
        assert!(u.status().last_check.is_some());
    }

    #[test]
    fn a_newer_signed_version_is_downloaded_then_ready() {
        let dir = tempfile::tempdir().unwrap();
        let (u, fetcher) = updater(dir.path(), Ok(manifest_for(b"setup", "0.3.0", b"setup")), b"setup");
        let status = u.check_now();
        assert!(
            matches!(&status.state, UpdateState::Ready { version, .. } if version == "0.3.0"),
            "{status:?}"
        );
        assert!(dir.path().join("SCIP-Setup-0.3.0.exe").is_file());
        assert!(dir.path().join("SCIP-Setup-0.3.0.json").is_file());
        assert_eq!(u.ready_installer().unwrap().version.to_string(), "0.3.0");

        // A second check reuses the verified file.
        u.check_now();
        assert_eq!(fetcher.downloads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_tampered_download_is_refused_and_removed() {
        let dir = tempfile::tempdir().unwrap();
        let (u, _) = updater(dir.path(), Ok(manifest_for(b"setup", "0.3.0", b"setup")), b"malware");
        assert!(matches!(u.check_now().state, UpdateState::Error { .. }));
        assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none(), "nothing may stay behind");
    }

    #[test]
    fn offline_is_not_an_error_and_keeps_a_ready_update() {
        let dir = tempfile::tempdir().unwrap();
        let (u, fetcher) = updater(dir.path(), Err(UpdateError::Network("offline".into())), b"setup");
        let status = u.check_now();
        assert_eq!(status.state, UpdateState::Idle);
        assert!(status.offline);

        *fetcher.feed.lock().unwrap() = Ok(manifest_for(b"setup", "0.3.0", b"setup"));
        assert!(matches!(u.check_now().state, UpdateState::Ready { .. }));
        *fetcher.feed.lock().unwrap() = Err(UpdateError::Network("offline".into()));
        assert!(
            matches!(u.check_now().state, UpdateState::Ready { .. }),
            "a ready update survives going offline"
        );
    }

    #[test]
    fn a_bad_manifest_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let (u, _) = updater(dir.path(), Ok("{not json".into()), b"");
        assert!(matches!(u.check_now().state, UpdateState::Error { .. }));
    }

    #[test]
    fn restart_offers_a_verified_download_and_prunes_old_ones() {
        let dir = tempfile::tempdir().unwrap();
        {
            let (u, _) = updater(dir.path(), Ok(manifest_for(b"setup", "0.3.0", b"setup")), b"setup");
            u.check_now();
        }
        // Leftovers of an update already installed, and an interrupted download.
        std::fs::write(dir.path().join("SCIP-Setup-0.1.0.exe"), b"old").unwrap();
        std::fs::write(dir.path().join("SCIP-Setup-0.1.0.json"), manifest_for(b"old", "0.1.0", b"old"))
            .unwrap();
        std::fs::write(dir.path().join("SCIP-Setup-0.4.0.exe.part"), b"half").unwrap();

        let (u, fetcher) = updater(dir.path(), Err(UpdateError::Network("offline".into())), b"");
        u.restore();
        assert!(matches!(u.status().state, UpdateState::Ready { ref version, .. } if version == "0.3.0"));
        assert!(!dir.path().join("SCIP-Setup-0.1.0.exe").exists());
        assert!(!dir.path().join("SCIP-Setup-0.4.0.exe.part").exists());
        assert_eq!(fetcher.downloads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_file_altered_after_download_is_caught_before_running() {
        let dir = tempfile::tempdir().unwrap();
        let (u, _) = updater(dir.path(), Ok(manifest_for(b"setup", "0.3.0", b"setup")), b"setup");
        u.check_now();
        std::fs::write(dir.path().join("SCIP-Setup-0.3.0.exe"), b"swapped").unwrap();
        assert!(u.ready_installer().is_err());
        assert!(matches!(u.status().state, UpdateState::Error { .. }));
    }

    #[test]
    fn a_genuine_old_release_renamed_higher_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        // A real, correctly signed 0.1.0, renamed as if it were 0.9.9.
        std::fs::write(dir.path().join("SCIP-Setup-0.9.9.exe"), b"old").unwrap();
        std::fs::write(dir.path().join("SCIP-Setup-0.9.9.json"), manifest_for(b"old", "0.1.0", b"old"))
            .unwrap();
        let (u, _) = updater(dir.path(), Err(UpdateError::Network("offline".into())), b"");
        u.restore();
        assert!(!matches!(u.status().state, UpdateState::Ready { .. }));
        assert!(!u.has_ready());
        assert!(u.ready_installer().is_err());
        assert!(!dir.path().join("SCIP-Setup-0.9.9.exe").exists(), "discarded");
    }

    #[test]
    fn a_version_cannot_write_outside_the_updates_folder() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("updates");
        std::fs::create_dir(&dir).unwrap();
        let mut manifest: UpdateManifest =
            serde_json::from_str(&manifest_for(b"setup", "0.3.0", b"setup")).unwrap();
        manifest.version = "0.3.0-a/../../x".into();
        let (u, fetcher) = updater(&dir, Ok(serde_json::to_string(&manifest).unwrap()), b"setup");
        assert!(matches!(u.check_now().state, UpdateState::Error { .. }));
        assert_eq!(fetcher.downloads.load(Ordering::SeqCst), 0, "refused before any download");
        assert!(!root.path().join("x.exe.part").exists());
    }

    #[test]
    fn a_ready_update_stays_ready_while_the_next_check_runs() {
        let dir = tempfile::tempdir().unwrap();
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let fetcher = Arc::new(FakeFetcher {
            feed: Mutex::new(Ok(manifest_for(b"setup", "0.3.0", b"setup"))),
            body: b"setup".to_vec(),
            downloads: AtomicUsize::new(0),
        });
        let config = UpdateConfig {
            feed: format!("{PREFIX}latest.json"),
            allowed_prefix: PREFIX.into(),
            public_key: public_b64(&test_key()),
        };
        let log = Arc::clone(&seen);
        let u = Updater::new(
            Some(config),
            Version::parse("0.2.0").unwrap(),
            dir.path().to_path_buf(),
            fetcher.clone(),
            Box::new(move |status: &UpdateStatus| {
                let name = serde_json::to_value(status).unwrap()["state"].as_str().unwrap().to_owned();
                log.lock().unwrap().push(name);
            }),
        );
        u.check_now();
        assert!(u.has_ready());
        seen.lock().unwrap().clear();

        u.check_now();
        *fetcher.feed.lock().unwrap() = Err(UpdateError::Network("offline".into()));
        u.check_now();
        assert!(!seen.lock().unwrap().iter().any(|s| s == "checking"), "{:?}", seen.lock().unwrap());
        assert!(matches!(u.status().state, UpdateState::Ready { .. }));
        assert_eq!(u.ready_installer().unwrap().version.to_string(), "0.3.0");
    }

    #[test]
    fn without_key_nothing_happens() {
        let dir = tempfile::tempdir().unwrap();
        let fetcher = Arc::new(FakeFetcher {
            feed: Mutex::new(Err(UpdateError::Network("x".into()))),
            body: vec![],
            downloads: AtomicUsize::new(0),
        });
        let u = Updater::new(
            None,
            Version::parse("0.2.0").unwrap(),
            dir.path().to_path_buf(),
            fetcher,
            Box::new(|_| {}),
        );
        assert_eq!(u.check_now().state, UpdateState::Disabled);
        assert!(!u.enabled());
    }

    /// Needs the internet: `cargo test -- --ignored the_real_feed`. Proves the HTTPS stack
    /// reaches GitHub; any HTTP answer (a release, or 404 before the first one) is a pass.
    #[test]
    #[ignore]
    fn the_real_feed_is_reachable_over_https() {
        match HttpFetcher.text(crate::update::FEED_URL) {
            Ok(body) => assert!(UpdateManifest::parse(&body).is_ok(), "{body}"),
            Err(UpdateError::Network(message)) => {
                assert!(message.starts_with("GitHub a répondu"), "no HTTP answer: {message}")
            }
            Err(other) => panic!("{other}"),
        }
    }
}
