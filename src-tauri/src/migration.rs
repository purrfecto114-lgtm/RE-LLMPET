use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const OFFICIAL_DIR_NAME: &str = ".octopus";
const MARKER_NAME: &str = ".official-import-v3.json";
const MAX_IMPORT_BYTES: u64 = 64 * 1024 * 1024;
const FILES: &[&str] = &[
    "config.json",
    "usage.json",
    "codex-usage.json",
    "pricing.json",
    "travel.json",
];

#[derive(Debug, Clone)]
pub struct MigrationReport {
    pub source: PathBuf,
    pub imported: Vec<String>,
    pub skipped: Vec<String>,
    pub error: Option<String>,
}

impl MigrationReport {
    pub fn as_json(&self) -> Value {
        json!({
            "source": self.source.to_string_lossy(),
            "imported": self.imported,
            "skipped": self.skipped,
            "error": self.error,
        })
    }
}

/// Incremental, non-destructive compatibility import from the official Electron
/// data directory (`~/.octopus`) into this Tauri fork (`~/.re-llmpet`).
/// Existing target files always win. Source handles are checked against their
/// pre-open metadata, symlinks/non-regular files are rejected, reads are hard
/// bounded, and publication uses a no-clobber hard link from a private temp
/// file. Transient failures intentionally leave the marker absent so the next
/// startup can retry only the files that are still missing.
pub fn import_official_data(home: &Path, target: &Path) -> MigrationReport {
    let source = home.join(OFFICIAL_DIR_NAME);
    let marker = target.join(MARKER_NAME);
    let mut report = MigrationReport {
        source: source.clone(),
        imported: Vec::new(),
        skipped: Vec::new(),
        error: None,
    };

    match fs::symlink_metadata(target) {
        Ok(meta) if meta.file_type().is_dir() && !meta.file_type().is_symlink() => {}
        Ok(_) => {
            report.error = Some("target data path is not a real directory".into());
            return report;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            if let Err(error) = fs::create_dir_all(target) {
                report.error = Some(format!("create target directory: {error}"));
                return report;
            }
        }
        Err(error) => {
            report.error = Some(format!("inspect target directory: {error}"));
            return report;
        }
    }
    if let Err(error) = set_private_directory(target) {
        report.error = Some(format!("secure target directory: {error}"));
        return report;
    }
    // The marker is a receipt, not a global lockout. Official apps may
    // create usage/travel files after config.json, so every startup performs
    // the same bounded no-clobber scan and imports only still-missing targets.
    let marker_exists = match fs::symlink_metadata(&marker) {
        Ok(meta) if meta.file_type().is_file() && !meta.file_type().is_symlink() => true,
        Ok(_) => {
            report.error = Some("migration marker is not a regular file".into());
            return report;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => {
            report.error = Some(format!("inspect migration marker: {error}"));
            return report;
        }
    };
    if marker_exists {
        report.skipped.push("incremental-scan".into());
    }
    match fs::symlink_metadata(&source) {
        Ok(meta) if meta.file_type().is_dir() && !meta.file_type().is_symlink() => {}
        Ok(_) => {
            report.error = Some("official data path is not a real directory".into());
            return report;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            report.skipped.push("official-data-not-found".into());
            return report;
        }
        Err(error) => {
            report.error = Some(format!("inspect official data directory: {error}"));
            return report;
        }
    }
    // The official pidwalk cache is a short-lived process-discovery cache keyed
    // by live PIDs/session paths. Moving it between applications or startups
    // can resurrect stale process identities, so it is deliberately excluded.
    if fs::symlink_metadata(source.join("pidwalk-cache.json")).is_ok() {
        report
            .skipped
            .push("pidwalk-cache.json:runtime-cache-not-migrated".into());
    }

    let mut retry_needed = false;
    let mut found_candidate = false;
    for name in FILES {
        let from = source.join(name);
        let to = target.join(name);
        let metadata = match fs::symlink_metadata(&from) {
            Ok(value) => value,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                report.skipped.push(format!("{name}:source-missing"));
                continue;
            }
            Err(error) => {
                retry_needed = true;
                report
                    .skipped
                    .push(format!("{name}:metadata-error:{error}"));
                continue;
            }
        };
        found_candidate = true;
        match fs::symlink_metadata(&to) {
            Ok(_) => {
                report.skipped.push(format!("{name}:target-exists"));
                continue;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                retry_needed = true;
                report
                    .skipped
                    .push(format!("{name}:target-metadata-error:{error}"));
                continue;
            }
        }
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            report.skipped.push(format!("{name}:not-regular-file"));
            continue;
        }
        if metadata.len() > MAX_IMPORT_BYTES {
            report.skipped.push(format!("{name}:too-large"));
            continue;
        }
        match copy_regular_private(&from, &to, &metadata, name) {
            Ok(()) => report.imported.push((*name).to_string()),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                report.skipped.push(format!("{name}:target-exists"));
            }
            Err(error) => {
                retry_needed = true;
                report.skipped.push(format!("{name}:copy-error:{error}"));
            }
        }
    }

    if retry_needed {
        report.error =
            Some("one or more official files could not be imported; startup will retry".into());
        return report;
    }
    if !found_candidate {
        report
            .skipped
            .push("no-importable-official-data-yet".into());
        return report;
    }

    if !marker_exists {
        let marker_value = json!({
            "version": 3,
            "mode": "incremental-nonblocking",
            "source": source.to_string_lossy(),
            "imported": report.imported.clone(),
            "skipped": report.skipped.clone(),
        });
        match serde_json::to_vec_pretty(&marker_value)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
            .and_then(|bytes| write_private_noclobber(&marker, &bytes, MARKER_NAME))
        {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => report.error = Some(format!("write migration marker: {error}")),
        }
    }
    report
}

fn copy_regular_private(
    from: &Path,
    to: &Path,
    expected: &fs::Metadata,
    name: &str,
) -> io::Result<()> {
    let source = File::open(from)?;
    let opened = source.metadata()?;
    if !opened.is_file()
        || opened.len() > MAX_IMPORT_BYTES
        || opened.len() != expected.len()
        || !same_file(expected, &opened)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "source changed or is not a bounded regular file",
        ));
    }
    let temp = to.with_file_name(format!(".{name}.official-import.{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut output = create_private_new(&temp)?;
        let mut limited = source.take(MAX_IMPORT_BYTES + 1);
        let copied = io::copy(&mut limited, &mut output)?;
        if copied > MAX_IMPORT_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "source grew beyond import limit",
            ));
        }
        output.flush()?;
        output.sync_all()?;
        set_private_permissions(&temp)?;
        publish_noclobber(&temp, to)
    })();
    let _ = fs::remove_file(&temp);
    result
}

fn write_private_noclobber(path: &Path, bytes: &[u8], name: &str) -> io::Result<()> {
    let temp = path.with_file_name(format!(".{name}.{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut output = create_private_new(&temp)?;
        output.write_all(bytes)?;
        output.flush()?;
        output.sync_all()?;
        set_private_permissions(&temp)?;
        publish_noclobber(&temp, path)
    })();
    let _ = fs::remove_file(&temp);
    result
}

fn create_private_new(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn publish_noclobber(temp: &Path, target: &Path) -> io::Result<()> {
    // Same-directory hard-link publication is atomic and fails rather than
    // replacing a target created by another process after our initial check.
    fs::hard_link(temp, target)
}

fn same_file(expected: &fs::Metadata, opened: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        expected.dev() == opened.dev() && expected.ino() == opened.ino()
    }
    #[cfg(not(unix))]
    {
        expected.len() == opened.len() && expected.is_file() == opened.is_file()
    }
}

fn set_private_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn set_private_permissions(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "octopus-migration-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn transient_pid_cache_is_not_copied() {
        let home = temp_root();
        let source = home.join(OFFICIAL_DIR_NAME);
        let target = home.join("target");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("config.json"), b"{}").unwrap();
        fs::write(source.join("pidwalk-cache.json"), b"{\"stale\":true}").unwrap();
        let report = import_official_data(&home, &target);
        assert!(report.error.is_none());
        assert!(target.join("config.json").is_file());
        assert!(!target.join("pidwalk-cache.json").exists());
        assert!(report
            .skipped
            .iter()
            .any(|value| value == "pidwalk-cache.json:runtime-cache-not-migrated"));
        assert!(target.join(MARKER_NAME).is_file());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn empty_official_directory_does_not_burn_one_time_marker() {
        let home = temp_root();
        let source = home.join(OFFICIAL_DIR_NAME);
        let target = home.join("target");
        fs::create_dir_all(&source).unwrap();
        let report = import_official_data(&home, &target);
        assert!(report.error.is_none());
        assert!(!target.join(MARKER_NAME).exists());
        assert!(report
            .skipped
            .iter()
            .any(|value| value == "no-importable-official-data-yet"));
        let _ = fs::remove_dir_all(home);
    }
    #[test]
    fn empty_official_directory_with_existing_app_files_still_retries_later() {
        let home = temp_root();
        let source = home.join(OFFICIAL_DIR_NAME);
        let target = home.join("target");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("config.json"), b"{\"ownedByRe\":true}").unwrap();
        let report = import_official_data(&home, &target);
        assert!(report.error.is_none());
        assert!(!target.join(MARKER_NAME).exists());
        assert!(report
            .skipped
            .iter()
            .any(|value| value == "no-importable-official-data-yet"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn later_official_files_import_even_after_receipt_exists() {
        let home = temp_root();
        let source = home.join(OFFICIAL_DIR_NAME);
        let target = home.join("target");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("config.json"), b"{}").unwrap();

        let first = import_official_data(&home, &target);
        assert!(first.error.is_none());
        assert!(target.join("config.json").is_file());
        assert!(target.join(MARKER_NAME).is_file());

        fs::write(source.join("usage.json"), b"{\"records\":[]}").unwrap();
        let second = import_official_data(&home, &target);
        assert!(second.error.is_none());
        assert!(target.join("usage.json").is_file());
        assert!(second.imported.iter().any(|value| value == "usage.json"));
        assert!(second
            .skipped
            .iter()
            .any(|value| value == "incremental-scan"));
        let _ = fs::remove_dir_all(home);
    }
}
