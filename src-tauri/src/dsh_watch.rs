//! DeepSeek Harness (dsh) session watcher — read-only monitoring of
//! `~/.dsh/sessions/*/session.jsonl`.
//!
//! Mirrors upstream `backend/dsh-watch.js` design: dsh emits session logs
//! as append-only JSONL under `~/.dsh/sessions/--<normalized cwd>--/<encodeSegment(sessionId)>/session.jsonl`
//! (or `session.jsonl.zstd` when compression is enabled). This module
//! provides a cheap metadata probe + session-list enumeration used by the
//! diagnostics panel and the unified session HUD.
//!
//! Design choices (divergent from upstream):
//!   * **Read-only, zero-touch** — dsh's own hook bridge plugins
//!     (@deepseek-ai/dsh-hooks-claude-code) are not in the base bundle and
//!     requiring users to patch their dsh profile is too invasive for a
//!     desktop pet. tail-ing session logs is zero-config and leaves no trace
//!     on uninstall — same rationale as the Codex rollout watcher.
//!   * **No zstd decompression** — upstream uses Node's zstd bindings to
//!     decode compressed frames. Rust's zstd crate would add a heavy dep
//!     for a feature that only matters when dsh's compression is enabled
//!     (default is off). We probe the header line of uncompressed logs
//!     only; compressed logs are reported as "present but compressed" so
//!     the UI can show the session exists without parsing its events.
//!   * **mtime-based cache** — `snapshot()` is called frequently by both
//!     pet windows and the panel, so we cache the directory listing for
//!     `SNAPSHOT_CACHE_MS`. The cache is keyed by the sessions dir mtime;
//!     any new session changes the dir mtime and invalidates the cache.
//!   * **Subagent filter** — header `origin === "subagent"` or
//!     `delegationDepth > 0` rows are skipped (they are internal subagent
//!     threads, not user sessions).

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::model::home_dir;

const SNAPSHOT_CACHE_MS: u64 = 3_000;
const MAX_SESSION_DIRS: usize = 4_000;
const HEADER_PROBE_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Default)]
struct CacheEntry {
    dir_mtime: Option<SystemTime>,
    snapshot: (Option<Value>, Option<Value>),
    captured_at_ms: u64,
}

static CACHE: OnceLock<Mutex<CacheEntry>> = OnceLock::new();

fn cache() -> &'static Mutex<CacheEntry> {
    CACHE.get_or_init(|| Mutex::new(CacheEntry::default()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn sessions_dir() -> Option<PathBuf> {
    let base = std::env::var_os("DSH_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".dsh"));
    let dir = base.join("sessions");
    fs::metadata(&dir).ok().filter(|m| m.is_dir()).map(|_| dir)
}

fn read_header_line(path: &Path) -> Option<Value> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 {
        return None;
    }
    if path.extension().and_then(|e| e.to_str()) == Some("zstd") {
        return None;
    }
    let mut file = fs::File::open(path).ok()?;
    use std::io::Read;
    let mut buf = Vec::with_capacity(HEADER_PROBE_BYTES as usize);
    (&mut file)
        .take(HEADER_PROBE_BYTES)
        .read_to_end(&mut buf)
        .ok()?;
    let text = String::from_utf8_lossy(&buf);
    let first_line = text.lines().next()?;
    serde_json::from_str(first_line).ok()
}

fn is_subagent_header(header: &Value) -> bool {
    let origin = header.get("origin").and_then(Value::as_str);
    if origin == Some("subagent") {
        return true;
    }
    header
        .get("delegationDepth")
        .and_then(Value::as_u64)
        .map(|d| d > 0)
        .unwrap_or(false)
}

fn probe_session(session_dir: &Path) -> Option<Value> {
    let plain = session_dir.join("session.jsonl");
    let zstd = session_dir.join("session.jsonl.zstd");
    let (log_path, compressed) = if plain.exists() {
        (plain, false)
    } else if zstd.exists() {
        (zstd, true)
    } else {
        return None;
    };

    let metadata = fs::metadata(&log_path).ok()?;
    let updated_at = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or_else(now_ms);

    if compressed {
        return Some(json!({
            "id": session_dir.file_name().and_then(|n| n.to_str()).unwrap_or(""),
            "cwd": "",
            "createdAt": updated_at,
            "updatedAt": updated_at,
            "title": "",
            "model": "",
            "compressed": true,
        }));
    }

    let header = read_header_line(&log_path)?;
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }
    if is_subagent_header(&header) {
        return None;
    }
    let id = header
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return None;
    }
    let cwd = header
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let created_at = header
        .get("createdAt")
        .and_then(Value::as_f64)
        .map(|t| t as u64)
        .unwrap_or(updated_at);

    Some(json!({
        "id": id,
        "cwd": cwd,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "title": "",
        "model": "",
        "compressed": false,
    }))
}

fn enumerate_sessions(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with("--") {
            if let Ok(inner) = fs::read_dir(&p) {
                for inner_entry in inner.flatten() {
                    let ip = inner_entry.path();
                    if ip.is_dir() {
                        out.push(ip);
                        if out.len() >= MAX_SESSION_DIRS {
                            return out;
                        }
                    }
                }
            }
        } else {
            out.push(p);
            if out.len() >= MAX_SESSION_DIRS {
                return out;
            }
        }
    }
    out
}

pub fn snapshot(_app_dir: &Path) -> (Option<Value>, Option<Value>) {
    let dir = match sessions_dir() {
        Some(d) => d,
        None => return (None, Some(json!({"installed": false, "sessionCount": 0}))),
    };
    let dir_mtime = fs::metadata(&dir).ok().and_then(|m| m.modified().ok());

    let now = now_ms();
    let mut guard = cache().lock().unwrap_or_else(|e| e.into_inner());
    if let (Some(cached_mtime), Some(current_mtime)) = (guard.dir_mtime, dir_mtime) {
        if cached_mtime == current_mtime && now - guard.captured_at_ms < SNAPSHOT_CACHE_MS {
            return guard.snapshot.clone();
        }
    }

    let session_dirs = enumerate_sessions(&dir);
    let mut sessions = Vec::with_capacity(session_dirs.len());
    let mut oldest: Option<u64> = None;
    for sd in &session_dirs {
        if let Some(meta) = probe_session(sd) {
            if let Some(updated) = meta.get("updatedAt").and_then(Value::as_u64) {
                oldest = Some(oldest.map_or(updated, |o: u64| o.min(updated)));
            }
            sessions.push(meta);
        }
    }
    sessions.sort_by(|a, b| {
        let au = a.get("updatedAt").and_then(Value::as_u64).unwrap_or(0);
        let bu = b.get("updatedAt").and_then(Value::as_u64).unwrap_or(0);
        bu.cmp(&au)
    });

    let sessions_json = Value::Array(sessions);
    let summary = json!({
        "installed": true,
        "sessionCount": sessions_json.as_array().map(|a| a.len()).unwrap_or(0),
        "oldestUpdatedAtMs": oldest,
    });
    let result = (Some(sessions_json), Some(summary));
    *guard = CacheEntry {
        dir_mtime,
        snapshot: result.clone(),
        captured_at_ms: now,
    };
    result
}

pub fn is_present() -> bool {
    sessions_dir()
        .map(|d| {
            fs::read_dir(&d)
                .ok()
                .map(|mut e| e.next().is_some())
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn snapshot_returns_none_when_dsh_absent() {
        std::env::set_var("DSH_HOME", "/tmp/octopus-dsh-test-nonexistent");
        let (sessions, summary) = snapshot(Path::new("/tmp"));
        assert!(sessions.is_none());
        assert_eq!(
            summary.and_then(|s| s.get("installed").and_then(Value::as_bool)),
            Some(false)
        );
        std::env::remove_var("DSH_HOME");
    }

    #[test]
    fn snapshot_enumerates_uncompressed_sessions() {
        let tmp = std::env::temp_dir().join(format!("octopus-dsh-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let session_dir = tmp.join("sessions").join("--tmp-test--").join("abc123");
        fs::create_dir_all(&session_dir).unwrap();
        let header = json!({
            "type": "session",
            "id": "abc123",
            "cwd": "/tmp/test",
            "createdAt": 1700000000_u64,
            "version": 0,
        });
        fs::write(session_dir.join("session.jsonl"), header.to_string()).unwrap();
        std::env::set_var("DSH_HOME", &tmp);
        let (sessions, summary) = snapshot(Path::new("/tmp"));
        let sessions = sessions.expect("sessions should be present");
        let arr = sessions.as_array().expect("sessions should be array");
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0].get("id").and_then(Value::as_str), Some("abc123"));
        assert_eq!(
            summary
                .as_ref()
                .and_then(|s| s.get("installed").and_then(Value::as_bool)),
            Some(true)
        );
        std::env::remove_var("DSH_HOME");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn snapshot_filters_subagent_headers() {
        let tmp = std::env::temp_dir().join(format!("octopus-dsh-subagent-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let session_dir = tmp.join("sessions").join("sub-agent-1");
        fs::create_dir_all(&session_dir).unwrap();
        let header = json!({"type":"session","id":"sub1","origin":"subagent","cwd":"/tmp"});
        fs::write(session_dir.join("session.jsonl"), header.to_string()).unwrap();
        std::env::set_var("DSH_HOME", &tmp);
        let (sessions, _) = snapshot(Path::new("/tmp"));
        let arr = sessions
            .map(|s| s.as_array().map(|a| a.len()).unwrap_or(0))
            .unwrap_or(0);
        assert_eq!(arr, 0, "subagent sessions must be filtered");
        std::env::remove_var("DSH_HOME");
        let _ = fs::remove_dir_all(&tmp);
    }
}
