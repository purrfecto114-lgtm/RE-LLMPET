use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

/// Reads a small security-sensitive file without following a path-level
/// symlink or accepting a different file after the metadata check.
///
/// The caller still owns format validation. This helper only guarantees that
/// the bytes came from the same bounded regular file that was inspected.
pub(crate) fn read_regular_bounded(
    path: &Path,
    max_bytes: u64,
    label: &str,
) -> Result<Vec<u8>, String> {
    let expected =
        fs::symlink_metadata(path).map_err(|error| format!("{label} unavailable: {error}"))?;
    if expected.file_type().is_symlink() || !expected.is_file() {
        return Err(format!("{label} is not a regular file"));
    }
    if expected.len() > max_bytes {
        return Err(format!("{label} exceeds {max_bytes} bytes"));
    }

    let file = File::open(path).map_err(|error| format!("{label} open failed: {error}"))?;
    let opened = file
        .metadata()
        .map_err(|error| format!("{label} metadata failed: {error}"))?;
    if !opened.is_file() || opened.len() != expected.len() || !same_opened_file(&expected, &opened)
    {
        return Err(format!("{label} changed while opening"));
    }

    let mut bytes = Vec::with_capacity(expected.len().min(max_bytes) as usize);
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("{label} read failed: {error}"))?;
    if bytes.len() as u64 != expected.len() {
        return Err(format!("{label} changed while reading"));
    }
    Ok(bytes)
}

#[cfg(unix)]
fn same_opened_file(expected: &fs::Metadata, opened: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    expected.dev() == opened.dev() && expected.ino() == opened.ino()
}

#[cfg(not(unix))]
fn same_opened_file(expected: &fs::Metadata, opened: &fs::Metadata) -> bool {
    expected.len() == opened.len() && expected.is_file() == opened.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "octopus-secure-file-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn bounded_regular_file_round_trips() {
        let path = temp_path("ok");
        fs::write(&path, b"runtime").expect("write fixture");
        assert_eq!(
            read_regular_bounded(&path, 64, "runtime").expect("read fixture"),
            b"runtime"
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn oversized_file_is_rejected_before_reading() {
        let path = temp_path("large");
        fs::write(&path, vec![0u8; 65]).expect("write fixture");
        assert!(read_regular_bounded(&path, 64, "runtime").is_err());
        let _ = fs::remove_file(path);
    }

    #[cfg(unix)]
    #[test]
    fn path_symlink_is_rejected() {
        use std::os::unix::fs::symlink;
        let target = temp_path("target");
        let link = temp_path("link");
        fs::write(&target, b"runtime").expect("write target");
        symlink(&target, &link).expect("create symlink");
        assert!(read_regular_bounded(&link, 64, "runtime").is_err());
        let _ = fs::remove_file(link);
        let _ = fs::remove_file(target);
    }
}
