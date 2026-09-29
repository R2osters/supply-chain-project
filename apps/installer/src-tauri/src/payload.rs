//! The self-extracting payload: a tar.zst of `{ scip-desktop.exe, resources/ }` glued to the end
//! of the installer, followed by a 32-byte footer (docs/installer.md):
//!
//! ```text
//! [installer exe][payload tar.zst][ "SCIPPAY1" | offset u64 LE | len u64 LE | reserved u64 ]
//! ```
//!
//! Windows ignores bytes after the PE image, so the file still runs as a normal exe. Packing
//! (used by `payload-pack` at build time) and unpacking live together so the formats can't drift.

use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

pub const MAGIC: &[u8; 8] = b"SCIPPAY1";
pub const FOOTER_LEN: u64 = 32;

/// Callbacks are throttled to one per this many compressed bytes: one per read would flood the
/// window with hundreds of thousands of events.
const PROGRESS_STEP: u64 = 1 << 20;

#[derive(Debug, thiserror::Error)]
pub enum PayloadError {
    #[error("this installer has no payload (was it built with build-setup.mjs?)")]
    Missing,
    #[error("the installer file is damaged: {0}")]
    Corrupt(String),
    #[error("refusing to extract {0}: unsafe path in the archive")]
    UnsafePath(String),
    #[error("{path} is in use; close SCIP and try again ({source})")]
    Locked { path: PathBuf, source: io::Error },
    #[error("{0}")]
    Io(#[from] io::Error),
}

impl PayloadError {
    /// Stable code for the screens (`install://error.code`).
    pub fn code(&self) -> &'static str {
        match self {
            PayloadError::Missing => "payload_missing",
            PayloadError::Corrupt(_) | PayloadError::UnsafePath(_) => "payload_corrupt",
            PayloadError::Locked { .. } => "files_locked",
            PayloadError::Io(e) if e.kind() == io::ErrorKind::StorageFull => "disk_full",
            PayloadError::Io(_) => "io",
        }
    }

    /// A damaged download will not fix itself; everything else might after the user acts.
    pub fn retryable(&self) -> bool {
        !matches!(self, PayloadError::Missing | PayloadError::Corrupt(_) | PayloadError::UnsafePath(_))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Footer {
    /// Where the payload starts, which is also the size of the bare installer.
    pub offset: u64,
    pub len: u64,
}

impl Footer {
    pub fn encode(&self) -> [u8; FOOTER_LEN as usize] {
        let mut out = [0u8; FOOTER_LEN as usize];
        out[..8].copy_from_slice(MAGIC);
        out[8..16].copy_from_slice(&self.offset.to_le_bytes());
        out[16..24].copy_from_slice(&self.len.to_le_bytes());
        // 24..32 reserved, zero.
        out
    }

    /// `None` when the bytes are not a footer at all (a bare installer, e.g. `uninstall.exe`).
    pub fn decode(bytes: &[u8; FOOTER_LEN as usize]) -> Option<Footer> {
        if &bytes[..8] != MAGIC {
            return None;
        }
        let word = |at: usize| u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
        Some(Footer { offset: word(8), len: word(16) })
    }

    fn validate(&self, file_len: u64) -> Result<(), PayloadError> {
        let end = self.offset.checked_add(self.len).and_then(|v| v.checked_add(FOOTER_LEN));
        if end != Some(file_len) || self.len == 0 {
            return Err(PayloadError::Corrupt(format!(
                "footer says {}+{} bytes, file has {file_len}",
                self.offset, self.len
            )));
        }
        Ok(())
    }
}

/// Reads the footer of `file`, `Ok(None)` if there is none.
pub fn read_footer(file: &mut File) -> Result<Option<Footer>, PayloadError> {
    let file_len = file.metadata()?.len();
    if file_len < FOOTER_LEN {
        return Ok(None);
    }
    file.seek(SeekFrom::Start(file_len - FOOTER_LEN))?;
    let mut bytes = [0u8; FOOTER_LEN as usize];
    file.read_exact(&mut bytes)?;
    match Footer::decode(&bytes) {
        None => Ok(None),
        Some(footer) => footer.validate(file_len).map(|()| Some(footer)),
    }
}

#[derive(Debug, Clone)]
pub struct PayloadReader {
    path: PathBuf,
    footer: Footer,
}

impl PayloadReader {
    pub fn open(path: &Path) -> Result<Self, PayloadError> {
        let mut file = File::open(path)?;
        let footer = read_footer(&mut file)?.ok_or(PayloadError::Missing)?;
        Ok(Self { path: path.to_path_buf(), footer })
    }

    pub fn footer(&self) -> Footer {
        self.footer
    }

    /// Streams the archive into `to` (which must be empty or absent). `on_progress` receives
    /// (compressed bytes read, compressed total): the only total known without a first pass.
    pub fn extract(&self, to: &Path, on_progress: impl FnMut(u64, u64)) -> Result<u64, PayloadError> {
        let mut file = File::open(&self.path)?;
        file.seek(SeekFrom::Start(self.footer.offset))?;
        extract_stream(file.take(self.footer.len), self.footer.len, to, on_progress)
    }

    /// Writes the installer without its payload: that is `uninstall.exe` (same program, a few
    /// MB instead of hundreds, and it knows it has nothing to install).
    pub fn copy_stub(&self, to: &Path) -> io::Result<()> {
        copy_prefix(&self.path, self.footer.offset, to)
    }
}

/// Copies the first `len` bytes of `from` into `to`.
pub fn copy_prefix(from: &Path, len: u64, to: &Path) -> io::Result<()> {
    let mut input = File::open(from)?.take(len);
    let mut output = File::create(to)?;
    let copied = io::copy(&mut input, &mut output)?;
    if copied != len {
        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "installer shorter than its footer says"));
    }
    output.sync_all()
}

struct CountingReader<R, F> {
    inner: R,
    read: u64,
    reported: u64,
    total: u64,
    on_progress: F,
}

impl<R: Read, F: FnMut(u64, u64)> Read for CountingReader<R, F> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.read += n as u64;
        if self.read - self.reported >= PROGRESS_STEP || (n == 0 && self.read != self.reported) {
            self.reported = self.read;
            (self.on_progress)(self.read, self.total);
        }
        Ok(n)
    }
}

/// Unpacks a tar.zst stream of `total` compressed bytes into `to`; returns the file count.
pub fn extract_stream(
    input: impl Read,
    total: u64,
    to: &Path,
    on_progress: impl FnMut(u64, u64),
) -> Result<u64, PayloadError> {
    let counting = CountingReader { inner: input, read: 0, reported: 0, total, on_progress };
    let decoder = zstd::stream::read::Decoder::new(BufReader::new(counting))
        .map_err(|e| PayloadError::Corrupt(e.to_string()))?;
    let mut archive = tar::Archive::new(decoder);
    std::fs::create_dir_all(to)?;
    let mut files = 0u64;
    for entry in archive.entries().map_err(corrupt)? {
        let mut entry = entry.map_err(corrupt)?;
        let raw: PathBuf = entry.path().map_err(corrupt)?.into_owned();
        let relative = safe_relative_path(&raw)?;
        let kind = entry.header().entry_type();
        if !(kind.is_file() || kind.is_dir()) {
            // Links could point outside the install folder; SCIP's payload never has any.
            return Err(PayloadError::UnsafePath(raw.display().to_string()));
        }
        let dest = to.join(&relative);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        entry.unpack(&dest).map_err(|e| match e.kind() {
            io::ErrorKind::InvalidData | io::ErrorKind::UnexpectedEof => corrupt(e),
            _ => PayloadError::Io(e),
        })?;
        if kind.is_file() {
            files += 1;
        }
    }
    // tar stops at its end marker; reading on to the end of the stream verifies zstd's checksum
    // and brings the progress to exactly 100%.
    io::copy(&mut archive.into_inner(), &mut io::sink()).map_err(corrupt)?;
    Ok(files)
}

fn corrupt(e: io::Error) -> PayloadError {
    // The tar crate reports I/O failures of the destination as plain io errors too; only the
    // archive-format ones are "corrupt". A write error keeps its kind (e.g. disk full).
    match e.kind() {
        io::ErrorKind::InvalidData
        | io::ErrorKind::InvalidInput
        | io::ErrorKind::UnexpectedEof
        | io::ErrorKind::Other => PayloadError::Corrupt(e.to_string()),
        _ => PayloadError::Io(e),
    }
}

/// Only plain relative paths: no root, drive, `..`, or `:` (alternate data streams).
pub fn safe_relative_path(raw: &Path) -> Result<PathBuf, PayloadError> {
    let unsafe_path = || PayloadError::UnsafePath(raw.display().to_string());
    let mut out = PathBuf::new();
    for component in raw.components() {
        match component {
            Component::Normal(part) => {
                if part.to_string_lossy().contains(':') {
                    return Err(unsafe_path());
                }
                out.push(part);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return Err(unsafe_path()),
        }
    }
    if out.as_os_str().is_empty() {
        return Err(unsafe_path());
    }
    Ok(out)
}

fn sibling(dir: &Path, suffix: &str) -> PathBuf {
    let mut name = dir.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(suffix);
    dir.with_file_name(name)
}

/// Extracts next to `dir`, then swaps it in, so a failed upgrade leaves the old SCIP working:
/// `<dir>.new` is filled first; only then `dir` → `<dir>.old`, `<dir>.new` → `dir`.
pub fn install_payload(
    reader: &PayloadReader,
    dir: &Path,
    on_progress: impl FnMut(u64, u64),
) -> Result<u64, PayloadError> {
    let staging = sibling(dir, ".new");
    if staging.exists() {
        // Leftover from an interrupted attempt: never trust half-extracted files.
        remove_dir_with_retry(&staging, RETRIES, RETRY_DELAY)?;
    }
    let files = reader.extract(&staging, on_progress).inspect_err(|_| {
        let _ = std::fs::remove_dir_all(&staging);
    })?;
    swap_into_place(&staging, dir, RETRIES, RETRY_DELAY)?;
    Ok(files)
}

pub const RETRIES: u32 = 10;
pub const RETRY_DELAY: Duration = Duration::from_millis(500);

/// Moves `staging` to `dir`, keeping the previous `dir` until the new one is in place. Retries
/// because antivirus scanners and the search indexer briefly lock freshly written files.
pub fn swap_into_place(
    staging: &Path,
    dir: &Path,
    retries: u32,
    delay: Duration,
) -> Result<(), PayloadError> {
    let old = sibling(dir, ".old");
    if old.exists() {
        remove_dir_with_retry(&old, retries, delay)?;
    }
    let had_previous = dir.exists();
    if had_previous {
        rename_with_retry(dir, &old, retries, delay)?;
    }
    if let Err(error) = rename_with_retry(staging, dir, retries, delay) {
        if had_previous {
            // Put the working install back; the new files stay in `.new` for the next attempt.
            let _ = std::fs::rename(&old, dir);
        }
        return Err(error);
    }
    if had_previous {
        // Not fatal: the new version is in place; a leftover `.old` is removed next time.
        if let Err(e) = remove_dir_with_retry(&old, retries, delay) {
            log::warn!("could not remove {}: {e}", old.display());
        }
    }
    Ok(())
}

fn rename_with_retry(from: &Path, to: &Path, retries: u32, delay: Duration) -> Result<(), PayloadError> {
    retry(retries, delay, || std::fs::rename(from, to))
        .map_err(|source| PayloadError::Locked { path: from.to_path_buf(), source })
}

pub fn remove_dir_with_retry(dir: &Path, retries: u32, delay: Duration) -> Result<(), PayloadError> {
    retry(retries, delay, || match std::fs::remove_dir_all(dir) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    })
    .map_err(|source| PayloadError::Locked { path: dir.to_path_buf(), source })
}

fn retry(retries: u32, delay: Duration, mut op: impl FnMut() -> io::Result<()>) -> io::Result<()> {
    let mut attempt = 0;
    loop {
        match op() {
            Ok(()) => return Ok(()),
            Err(e) if attempt >= retries => return Err(e),
            Err(_) => {
                attempt += 1;
                std::thread::sleep(delay);
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Packing (build time, `payload-pack`)
// ---------------------------------------------------------------------------------------------

/// One thing to put in the archive: `source` (file or folder) stored under `name`.
#[derive(Debug, Clone)]
pub struct PackEntry {
    pub name: String,
    pub source: PathBuf,
}

#[derive(Debug, Clone)]
pub struct PackOptions {
    pub level: i32,
    /// 0 = single-threaded.
    pub threads: u32,
    /// Archive names (with `/`) to leave out, e.g. `resources/README.md`.
    pub skip: Vec<String>,
}

/// Writes a tar.zst of `entries` to `out`; returns the number of files. Folders are walked in
/// sorted order so two builds of the same tree give the same archive layout.
pub fn pack(
    out: impl Write,
    entries: &[PackEntry],
    options: &PackOptions,
    mut on_file: impl FnMut(&str),
) -> io::Result<u64> {
    let mut encoder = zstd::stream::write::Encoder::new(out, options.level)?;
    if options.threads > 0 {
        encoder.multithread(options.threads)?;
    }
    encoder.include_checksum(true)?;
    let mut builder = tar::Builder::new(encoder);
    let mut files = 0u64;
    for entry in entries {
        let mut stack: Vec<(String, PathBuf)> = vec![(entry.name.clone(), entry.source.clone())];
        while let Some((name, source)) = stack.pop() {
            if options.skip.iter().any(|s| s == &name) {
                continue;
            }
            if source.is_dir() {
                let mut children: Vec<(String, PathBuf)> = std::fs::read_dir(&source)?
                    .map(|child| {
                        let child = child?;
                        let child_name = format!("{name}/{}", child.file_name().to_string_lossy());
                        Ok((child_name, child.path()))
                    })
                    .collect::<io::Result<_>>()?;
                // Reverse so popping the stack visits them in ascending order.
                children.sort();
                children.reverse();
                stack.extend(children);
            } else {
                builder.append_path_with_name(&source, &name)?;
                on_file(&name);
                files += 1;
            }
        }
    }
    let encoder = builder.into_inner()?;
    encoder.finish()?.flush()?;
    Ok(files)
}

/// `stub` + `payload` + footer → `out`: the distributable SCIP-Setup-<version>.exe.
pub fn bundle(stub: &Path, payload: &Path, out: &Path) -> io::Result<Footer> {
    let mut output = io::BufWriter::new(File::create(out)?);
    let offset = io::copy(&mut File::open(stub)?, &mut output)?;
    let len = io::copy(&mut File::open(payload)?, &mut output)?;
    let footer = Footer { offset, len };
    output.write_all(&footer.encode())?;
    output.into_inner().map_err(|e| e.into_error())?.sync_all()?;
    Ok(footer)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// A fake "installer" with a small payload: exe bytes, then the archive, then the footer.
    fn build_setup(root: &Path) -> PathBuf {
        let src = root.join("src");
        write(&src.join("scip-desktop.exe"), "exe");
        write(&src.join("resources/node/node.exe"), "node");
        write(&src.join("resources/api/dist/main.js"), "js");
        write(&src.join("resources/README.md"), "skip me");
        let archive = root.join("payload.tar.zst");
        let entries = [
            PackEntry { name: "scip-desktop.exe".into(), source: src.join("scip-desktop.exe") },
            PackEntry { name: "resources".into(), source: src.join("resources") },
        ];
        let options = PackOptions { level: 3, threads: 2, skip: vec!["resources/README.md".into()] };
        let mut names = Vec::new();
        let files =
            pack(File::create(&archive).unwrap(), &entries, &options, |n| names.push(n.to_string())).unwrap();
        assert_eq!(files, 3);
        assert_eq!(names, ["scip-desktop.exe", "resources/api/dist/main.js", "resources/node/node.exe"]);
        let stub = root.join("stub.exe");
        write(&stub, "MZ-installer-bytes");
        let setup = root.join("setup.exe");
        let footer = bundle(&stub, &archive, &setup).unwrap();
        assert_eq!(footer.offset, 18);
        setup
    }

    #[test]
    fn footer_roundtrip_and_rejection() {
        let footer = Footer { offset: 1234, len: 99 };
        let bytes = footer.encode();
        assert_eq!(&bytes[..8], b"SCIPPAY1");
        assert_eq!(&bytes[24..], &[0u8; 8]);
        assert_eq!(Footer::decode(&bytes), Some(footer));
        let mut bad = bytes;
        bad[0] = b'X';
        assert_eq!(Footer::decode(&bad), None);
        assert!(footer.validate(1234 + 99 + 32).is_ok());
        assert!(matches!(footer.validate(5000), Err(PayloadError::Corrupt(_))));
    }

    #[test]
    fn pack_bundle_extract_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let setup = build_setup(tmp.path());
        let reader = PayloadReader::open(&setup).unwrap();
        let out = tmp.path().join("installed");
        let mut last = (0, 0);
        let files = reader.extract(&out, |done, total| last = (done, total)).unwrap();
        assert_eq!(files, 3);
        assert_eq!(last, (reader.footer().len, reader.footer().len), "final progress is 100%");
        assert_eq!(std::fs::read_to_string(out.join("resources/node/node.exe")).unwrap(), "node");
        assert!(!out.join("resources/README.md").exists());

        let stub = tmp.path().join("uninstall.exe");
        reader.copy_stub(&stub).unwrap();
        assert_eq!(std::fs::read_to_string(&stub).unwrap(), "MZ-installer-bytes");
        assert!(matches!(PayloadReader::open(&stub), Err(PayloadError::Missing)));
    }

    #[test]
    fn truncated_setup_is_corrupt() {
        let tmp = tempfile::tempdir().unwrap();
        let setup = build_setup(tmp.path());
        let mut bytes = std::fs::read(&setup).unwrap();
        bytes.remove(30); // shifts the payload: footer no longer matches the file length
        std::fs::write(&setup, &bytes).unwrap();
        assert!(matches!(PayloadReader::open(&setup), Err(PayloadError::Corrupt(_))));
    }

    #[test]
    fn rejects_path_traversal() {
        for bad in ["../evil.exe", "a/../../evil", "/abs/file", r"C:\Windows\x", "file.txt:stream", ""] {
            assert!(safe_relative_path(Path::new(bad)).is_err(), "{bad} must be rejected");
        }
        assert_eq!(safe_relative_path(Path::new("./resources/a.txt")).unwrap(), Path::new("resources/a.txt"));
    }

    #[test]
    fn extraction_stops_on_a_traversal_entry() {
        // Built by hand: tar::Builder itself refuses `..`, so write the header name directly.
        let mut raw = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.as_gnu_mut().unwrap().name[..11].copy_from_slice(b"../evil.txt");
        header.set_size(1);
        header.set_entry_type(tar::EntryType::Regular);
        header.set_cksum();
        raw.append(&header, &b"x"[..]).unwrap();
        let tar_bytes = raw.into_inner().unwrap();
        let compressed = zstd::encode_all(&tar_bytes[..], 1).unwrap();

        let tmp = tempfile::tempdir().unwrap();
        let out = tmp.path().join("inner").join("dir");
        let result = extract_stream(&compressed[..], compressed.len() as u64, &out, |_, _| {});
        assert!(matches!(result, Err(PayloadError::UnsafePath(_))), "{result:?}");
        assert!(!tmp.path().join("inner").join("evil.txt").exists());
    }

    #[test]
    fn swap_keeps_old_until_new_is_in_place() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("SCIP");
        write(&dir.join("old.txt"), "old");
        let staging = tmp.path().join("SCIP.new");
        write(&staging.join("new.txt"), "new");
        swap_into_place(&staging, &dir, 0, Duration::ZERO).unwrap();
        assert!(dir.join("new.txt").exists() && !dir.join("old.txt").exists());
        assert!(!staging.exists() && !tmp.path().join("SCIP.old").exists());
    }

    #[test]
    fn failed_swap_restores_the_previous_install() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("SCIP");
        write(&dir.join("old.txt"), "old");
        // Staging missing: the second rename fails, the old install must come back.
        let result = swap_into_place(&tmp.path().join("SCIP.new"), &dir, 1, Duration::from_millis(1));
        assert!(matches!(result, Err(PayloadError::Locked { .. })));
        assert_eq!(std::fs::read_to_string(dir.join("old.txt")).unwrap(), "old");
    }

    #[test]
    fn install_payload_replaces_a_previous_version() {
        let tmp = tempfile::tempdir().unwrap();
        let setup = build_setup(tmp.path());
        let reader = PayloadReader::open(&setup).unwrap();
        let dir = tmp.path().join("Programs").join("SCIP");
        write(&dir.join("stale.dll"), "old");
        write(&sibling(&dir, ".new").join("half.txt"), "interrupted");
        install_payload(&reader, &dir, |_, _| {}).unwrap();
        assert!(dir.join("scip-desktop.exe").exists());
        assert!(!dir.join("stale.dll").exists());
        assert!(!sibling(&dir, ".new").exists() && !sibling(&dir, ".old").exists());
    }

    #[test]
    fn error_codes() {
        assert_eq!(PayloadError::Missing.code(), "payload_missing");
        assert!(!PayloadError::Missing.retryable());
        let locked = PayloadError::Locked { path: "x".into(), source: io::Error::other("busy") };
        assert_eq!(locked.code(), "files_locked");
        assert!(locked.retryable());
    }
}
