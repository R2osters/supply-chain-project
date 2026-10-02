//! The backup file: a plain tar (the dump is already compressed, the photos are JPEG).

use std::fs::File;
use std::io::{BufReader, BufWriter, Read};
use std::path::{Component, Path};

use super::manifest::{Manifest, DUMP_NAME, FILES_DIR, FORMAT, MANIFEST_NAME};
use super::BackupError;

/// Writes `out`: the manifest first (so listing reads a few bytes), then the dump, then `files/`.
pub fn write_archive(
    out: &Path,
    manifest: &Manifest,
    dump: &Path,
    files_dir: &Path,
) -> Result<(), BackupError> {
    let file: File =
        create_private(out).map_err(|e| BackupError::io(format!("création de {}", out.display()), e))?;
    let mut builder = tar::Builder::new(BufWriter::new(file));
    builder.follow_symlinks(false);

    let body: Vec<u8> =
        serde_json::to_vec_pretty(manifest).map_err(|e| BackupError::Format(e.to_string()))?;
    let mut header = tar::Header::new_gnu();
    header.set_size(body.len() as u64);
    header.set_mode(0o644);
    header.set_mtime(0);
    header.set_cksum();
    builder
        .append_data(&mut header, MANIFEST_NAME, body.as_slice())
        .map_err(|e| BackupError::io("écriture du manifeste", e))?;
    builder.append_path_with_name(dump, DUMP_NAME).map_err(|e| BackupError::io("écriture de la base", e))?;
    if files_dir.is_dir() {
        builder
            .append_dir_all(FILES_DIR, files_dir)
            .map_err(|e| BackupError::io("écriture des preuves de livraison", e))?;
    }
    builder
        .into_inner()
        .and_then(|mut writer| std::io::Write::flush(&mut writer))
        .map_err(|e| BackupError::io("finalisation de la sauvegarde", e))
}

/// `File::create`, and on macOS and Linux a file only its owner can read, wherever the backup
/// folder is: a backup holds every account and the business data.
fn create_private(path: &Path) -> std::io::Result<File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Reads only the manifest (the first entry of our backups).
pub fn read_manifest(archive: &Path) -> Result<Manifest, BackupError> {
    let file: File =
        File::open(archive).map_err(|e| BackupError::io(format!("ouverture de {}", archive.display()), e))?;
    let mut tar = tar::Archive::new(BufReader::new(file));
    let entries = tar.entries().map_err(|e| BackupError::io("lecture de la sauvegarde", e))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| BackupError::io("lecture de la sauvegarde", e))?;
        if entry.path().ok().is_some_and(|p| p.as_os_str() == MANIFEST_NAME) {
            let mut body = String::new();
            entry.read_to_string(&mut body).map_err(|e| BackupError::io("lecture du manifeste", e))?;
            return parse_manifest(&body);
        }
    }
    Err(BackupError::Format("ce fichier n'est pas une sauvegarde SCIP (manifeste absent)".into()))
}

fn parse_manifest(body: &str) -> Result<Manifest, BackupError> {
    let manifest: Manifest =
        serde_json::from_str(body).map_err(|e| BackupError::Format(format!("manifeste illisible : {e}")))?;
    if manifest.format != FORMAT {
        return Err(BackupError::Refused(format!(
            "format de sauvegarde {} inconnu de cette version de SCIP",
            manifest.format
        )));
    }
    Ok(manifest)
}

/// Only relative paths made of plain names: no `..`, no root, no drive.
fn is_safe(path: &Path) -> bool {
    path.components().all(|component| matches!(component, Component::Normal(_)))
        && path.components().next().is_some()
}

/// Extracts `archive` into `into` after checking every entry, and returns its manifest.
pub fn extract_archive(archive: &Path, into: &Path) -> Result<Manifest, BackupError> {
    let manifest: Manifest = read_manifest(archive)?;
    std::fs::create_dir_all(into)
        .map_err(|e| BackupError::io(format!("création de {}", into.display()), e))?;

    let file: File =
        File::open(archive).map_err(|e| BackupError::io(format!("ouverture de {}", archive.display()), e))?;
    let mut tar = tar::Archive::new(BufReader::new(file));
    let entries = tar.entries().map_err(|e| BackupError::io("lecture de la sauvegarde", e))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| BackupError::io("lecture de la sauvegarde", e))?;
        let path = entry.path().map_err(|e| BackupError::io("lecture d'un chemin", e))?.into_owned();
        let kind = entry.header().entry_type();
        if !is_safe(&path) || !(kind.is_file() || kind.is_dir()) {
            return Err(BackupError::Refused(format!(
                "sauvegarde refusée : entrée suspecte « {} »",
                path.display()
            )));
        }
        let first = path.components().next().map(|c| c.as_os_str().to_string_lossy().into_owned());
        if !matches!(first.as_deref(), Some(MANIFEST_NAME) | Some(DUMP_NAME) | Some(FILES_DIR)) {
            return Err(BackupError::Refused(format!(
                "sauvegarde refusée : entrée inattendue « {} »",
                path.display()
            )));
        }
        entry.unpack_in(into).map_err(|e| BackupError::io(format!("extraction de {}", path.display()), e))?;
    }
    if !into.join(DUMP_NAME).is_file() {
        return Err(BackupError::Format("sauvegarde incomplète : la base est absente".into()));
    }
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::manifest::Counts;

    fn manifest() -> Manifest {
        Manifest {
            format: FORMAT,
            app_version: "0.2.0".into(),
            created_at: "2026-09-30T14:15:02+02:00".into(),
            company: Some("Acme".into()),
            latest_migration: None,
            counts: Counts::default(),
            files: 2,
            safety: false,
            postgres_major: None,
        }
    }

    #[test]
    fn round_trip_keeps_manifest_dump_and_nested_files() {
        let dir = tempfile::tempdir().unwrap();
        let dump = dir.path().join("x.dump");
        std::fs::write(&dump, b"PGDMP-bytes").unwrap();
        let files = dir.path().join("files");
        std::fs::create_dir_all(files.join("deliveries").join("abc")).unwrap();
        std::fs::write(files.join("deliveries").join("abc").join("photo.jpg"), b"jpeg").unwrap();
        std::fs::write(files.join("sig.png"), b"png").unwrap();

        let archive = dir.path().join("SCIP-sauvegarde-t.scip-backup");
        write_archive(&archive, &manifest(), &dump, &files).unwrap();
        assert_eq!(read_manifest(&archive).unwrap(), manifest());

        let out = dir.path().join("out");
        assert_eq!(extract_archive(&archive, &out).unwrap(), manifest());
        assert_eq!(std::fs::read(out.join("database.dump")).unwrap(), b"PGDMP-bytes");
        assert_eq!(
            std::fs::read(out.join("files").join("deliveries").join("abc").join("photo.jpg")).unwrap(),
            b"jpeg"
        );
        assert_eq!(std::fs::read(out.join("files").join("sig.png")).unwrap(), b"png");
    }

    #[test]
    fn a_missing_files_folder_is_fine() {
        let dir = tempfile::tempdir().unwrap();
        let dump = dir.path().join("x.dump");
        std::fs::write(&dump, b"d").unwrap();
        let archive = dir.path().join("a.scip-backup");
        write_archive(&archive, &manifest(), &dump, &dir.path().join("no-files")).unwrap();
        let out = dir.path().join("out");
        extract_archive(&archive, &out).unwrap();
        assert!(!out.join("files").exists());
    }

    fn raw_archive(path: &Path, entries: &[(&str, &[u8])]) {
        let mut builder = tar::Builder::new(File::create(path).unwrap());
        for (name, body) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            // `set_path` refuses `..`: write the raw name, as a hostile archive would.
            let bytes = name.as_bytes();
            header.as_old_mut().name[..bytes.len()].copy_from_slice(bytes);
            header.set_cksum();
            builder.append(&header, *body).unwrap();
        }
        builder.finish().unwrap();
    }

    #[test]
    fn extraction_refuses_paths_that_leave_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let body = serde_json::to_vec(&manifest()).unwrap();
        for hostile in ["../evil.txt", "files/../../evil.txt", "/etc/evil", "C:/evil", "other.txt"] {
            let archive = dir.path().join("h.scip-backup");
            raw_archive(&archive, &[("manifest.json", &body), ("database.dump", b"d"), (hostile, b"x")]);
            let error = extract_archive(&archive, &dir.path().join("out")).unwrap_err();
            assert!(matches!(error, BackupError::Refused(_)), "{hostile}: {error}");
        }
        assert!(!dir.path().join("evil.txt").exists());
    }

    #[test]
    fn a_file_that_is_not_a_backup_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let not_ours = dir.path().join("n.scip-backup");
        raw_archive(&not_ours, &[("readme.txt", b"hello")]);
        assert!(matches!(read_manifest(&not_ours), Err(BackupError::Format(_))));

        let future = dir.path().join("f.scip-backup");
        let mut m = manifest();
        m.format = 99;
        raw_archive(&future, &[("manifest.json", &serde_json::to_vec(&m).unwrap())]);
        assert!(matches!(read_manifest(&future), Err(BackupError::Refused(_))));
    }
}
