//! R58-IMPL-E: cold-start session seeding (claude + codex).
//!
//! Five of the six providers are purely event-driven: sessions that already
//! existed when this process started stay invisible until their NEXT hook
//! event, and a session parked on an idle prompt may not fire one for a long
//! time. dsh is the only provider whose watcher cold-replays its files. This
//! module absorbs the upstream Electron v1.2.0 boot backfill as a one-shot
//! scan started from the Tauri setup (upstream backend/core.js:375-413
//! `backfillFromTranscripts`, backend/codex-watch.js `backfill`/`seedRecent`,
//! backend/dsh-watch.js `BACKFILL_MAX_AGE_MS`):
//!
//!   * claude — `~/.claude/projects/*/<sessionId>.jsonl`, transcripts touched
//!     within the 30-minute window, newest 15, tail 128 KB scanned for the
//!     last cwd and assistant model.
//!   * codex — `~/.codex/sessions/**/*.jsonl` rollouts, same window and cap,
//!     first line (`session_meta`) for id/cwd/model; guardian/subagent thread
//!     rollouts are filtered like upstream `applyMeta`.
//!
//! REPLAY_QUIET discipline: every seed is a synthetic `SessionStart` body fed
//! through [`Runtime::ingest_with_ack`] ONLY. Ingestion never touches the pet
//! event channel, and the frame carries `timestamp_ms` = file mtime so the
//! ingest time anchor treats it as history (the emit-side freshness gate
//! would keep such a frame silent anyway). The caller refreshes the board
//! with one coalesced stats snapshot after seeding. Metering is deliberately
//! NOT replayed here — the transcript cursor ledger self-heals usage on the
//! next real hook event, and the seed body intentionally carries no
//! transcript path (so the claude ingest path never scans the history).
//!
//! Seeding is idempotent: sessions already present in the runtime map are
//! skipped, so a second scan returns zero.

use crate::model::{home_dir, now_ms, Runtime};
use serde_json::{json, Value};
use std::cmp::Reverse;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

/// Upstream core.js `BACKFILL_MAX_AGE_MS` — transcripts last modified before
/// this window are not seeded at boot (30 minutes, shared by the dsh watcher
/// cold-discovery prefilter).
const SEED_MAX_AGE_MS: u64 = 30 * 60 * 1000;
/// Upstream core.js `BACKFILL_MAX` — cap on seeded rows per provider.
const SEED_MAX_SESSIONS: usize = 15;
/// Upstream codex-watch.js `TAIL_PROBE_BYTES` — tail bytes scanned for the
/// claude cwd/model identity.
const TAIL_PROBE_BYTES: u64 = 128 * 1024;
/// The codex `session_meta` line can exceed 35 KB (base_instructions), so a
/// fixed small probe would truncate it and lose cwd/model entirely.
const CODEX_FIRST_LINE_MAX: u64 = 256 * 1024;
/// `~/.codex/sessions/YYYY/MM/DD/` plus one safety level.
const CODEX_WALK_DEPTH: usize = 4;
/// Upper bound on rollout files visited by the one-shot boot walk.
const CODEX_WALK_FILE_CAP: usize = 4_000;

/// Seed recently-active claude sessions from `~/.claude/projects` onto the
/// runtime board. Returns the number of sessions actually inserted.
pub fn seed_claude_sessions(runtime: &Arc<Runtime>) -> usize {
    let root = home_dir().join(".claude").join("projects");
    let candidates = collect_claude_candidates(&root, now_ms());
    seed_candidates(runtime, "claude", &candidates)
}

/// Seed recently-active codex sessions from `~/.codex/sessions` rollouts onto
/// the runtime board. Returns the number of sessions actually inserted.
pub fn seed_codex_sessions(runtime: &Arc<Runtime>) -> usize {
    let root = codex_home().join("sessions");
    let candidates = collect_codex_candidates(&root, now_ms());
    seed_candidates(runtime, "codex", &candidates)
}

/// Mirrors codex_rollout.rs (kept private there): `CODEX_HOME` wins, else
/// `~/.codex`. Duplicated instead of re-exported so neither module has to
/// depend on the other's private surface.
fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".codex"))
}

fn seed_candidates(runtime: &Arc<Runtime>, provider: &str, candidates: &[SeedCandidate]) -> usize {
    let mut seeded = 0;
    for candidate in candidates {
        if session_exists(runtime, &candidate.session_id) {
            continue;
        }
        let mut event = json!({
            "provider": provider,
            "hook_event_name": "SessionStart",
            "session_id": candidate.session_id.clone(),
            "cwd": candidate.cwd.clone(),
            "timestamp_ms": candidate.mtime_ms,
            "seed": true,
        });
        if let Some(model) = candidate.model.clone() {
            event["model"] = Value::String(model);
        }
        let _ = runtime.ingest_with_ack(&event);
        seeded += 1;
    }
    seeded
}

fn session_exists(runtime: &Arc<Runtime>, session_id: &str) -> bool {
    runtime
        .sessions
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .contains_key(session_id)
}

struct SeedCandidate {
    session_id: String,
    cwd: String,
    model: Option<String>,
    mtime_ms: u64,
}

struct FileStamp {
    path: PathBuf,
    mtime_ms: u64,
}

fn collect_claude_candidates(root: &Path, now_ms: u64) -> Vec<SeedCandidate> {
    let cutoff = now_ms.saturating_sub(SEED_MAX_AGE_MS);
    let mut stamps: Vec<FileStamp> = Vec::new();
    // Layout (transcript.rs TranscriptScanner / upstream core.js): one level
    // of escaped-project directories, each holding one or more
    // <sessionId>.jsonl transcripts.
    if let Ok(project_entries) = fs::read_dir(root) {
        for project_entry in project_entries.flatten() {
            if !project_entry
                .file_type()
                .is_ok_and(|file_type| file_type.is_dir())
            {
                continue;
            }
            let Ok(transcript_entries) = fs::read_dir(project_entry.path()) else {
                continue;
            };
            for entry in transcript_entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                    continue;
                }
                let Ok(metadata) = fs::metadata(&path) else {
                    continue;
                };
                if !metadata.is_file() {
                    continue;
                }
                let mtime_ms = file_mtime_ms(&metadata);
                if mtime_ms < cutoff {
                    continue;
                }
                stamps.push(FileStamp { path, mtime_ms });
            }
        }
    }
    stamps.sort_by_key(|stamp| Reverse(stamp.mtime_ms));
    stamps.truncate(SEED_MAX_SESSIONS);
    let mut candidates = Vec::new();
    for stamp in stamps {
        // The transcript file name (without .jsonl) IS the claude sessionId;
        // cap at the ingest clean_text limit so this id equals the map key.
        let Some(session_id) = stamp
            .path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(|stem| stem.chars().take(256).collect::<String>())
            .filter(|stem| !stem.is_empty())
        else {
            continue;
        };
        if let Some((cwd, model)) = read_claude_tail_identity(&stamp.path) {
            candidates.push(SeedCandidate {
                session_id,
                cwd,
                model,
                mtime_ms: stamp.mtime_ms,
            });
        }
    }
    candidates
}

/// Read the transcript tail and extract the last top-level cwd plus the last
/// assistant model. Returns `None` for files whose tail contains no
/// non-subagent line (sidechain transcripts live in the same project
/// directories and must not become top-level rows — the R50/R58-1c phantom
/// dot regression class).
fn read_claude_tail_identity(path: &Path) -> Option<(String, Option<String>)> {
    let mut file = File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    if length == 0 {
        return None;
    }
    let start = length.saturating_sub(TAIL_PROBE_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let mut lines: Vec<&[u8]> = bytes.split(|&byte| byte == b'\n').collect();
    if start > 0 {
        // The probe may land mid-line; the first segment can be half a row.
        lines.remove(0);
    }
    let mut cwd = String::new();
    let mut model: Option<String> = None;
    let mut saw_top_level_line = false;
    for raw in lines {
        let trimmed = trim_jsonl_line(raw);
        if trimmed.is_empty() || trimmed.first() != Some(&b'{') {
            continue;
        }
        let Ok(line) = serde_json::from_slice::<Value>(trimmed) else {
            continue;
        };
        if claude_line_is_subagent(&line) {
            continue;
        }
        saw_top_level_line = true;
        if let Some(value) = json_text(&line, &["cwd"], 4096) {
            cwd = value;
        }
        if line.get("type").and_then(Value::as_str) == Some("assistant") {
            if let Some(value) = line
                .get("message")
                .and_then(Value::as_object)
                .and_then(|message| message.get("model"))
                .and_then(Value::as_str)
            {
                model = Some(value.chars().take(256).collect());
            }
        }
    }
    if !saw_top_level_line {
        return None;
    }
    Some((cwd, model))
}

/// Mirrors transcript.rs `is_subagent` (kept private there): the sidechain
/// markers claude writes onto subagent transcript rows.
fn claude_line_is_subagent(line: &Value) -> bool {
    line.get("isSidechain").and_then(Value::as_bool) == Some(true)
        || line.get("isSubagent").and_then(Value::as_bool) == Some(true)
        || line.get("is_subagent").and_then(Value::as_bool) == Some(true)
        || line.get("agentId").and_then(Value::as_str).is_some()
        || line.get("agent_id").and_then(Value::as_str).is_some()
}

fn collect_codex_candidates(root: &Path, now_ms: u64) -> Vec<SeedCandidate> {
    let cutoff = now_ms.saturating_sub(SEED_MAX_AGE_MS);
    let mut paths: Vec<PathBuf> = Vec::new();
    walk_rollout_files(root, 0, &mut paths);
    let mut stamps: Vec<FileStamp> = Vec::new();
    for path in paths {
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let mtime_ms = file_mtime_ms(&metadata);
        if mtime_ms < cutoff {
            continue;
        }
        stamps.push(FileStamp { path, mtime_ms });
    }
    stamps.sort_by_key(|stamp| Reverse(stamp.mtime_ms));
    stamps.truncate(SEED_MAX_SESSIONS);
    let mut candidates = Vec::new();
    for stamp in stamps {
        if let Some(meta) = read_codex_session_meta(&stamp.path) {
            candidates.push(SeedCandidate {
                session_id: meta.session_id,
                cwd: meta.cwd,
                model: meta.model,
                mtime_ms: stamp.mtime_ms,
            });
        }
    }
    candidates
}

/// Recursive walk over `~/.codex/sessions/YYYY/MM/DD/*.jsonl` (the
/// codex_rollout.rs `collect_jsonl` layout), depth- and count-bounded.
fn walk_rollout_files(dir: &Path, depth: usize, output: &mut Vec<PathBuf>) {
    if depth > CODEX_WALK_DEPTH || output.len() >= CODEX_WALK_FILE_CAP {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if output.len() >= CODEX_WALK_FILE_CAP {
            break;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            walk_rollout_files(&path, depth + 1, output);
        } else if file_type.is_file()
            && path.extension().and_then(|value| value.to_str()) == Some("jsonl")
        {
            output.push(path);
        }
    }
}

struct CodexMeta {
    session_id: String,
    cwd: String,
    model: Option<String>,
}

/// Read the first line of a rollout file (type `session_meta`) and extract
/// id/cwd/model. Guardian / subagent thread rollouts (`thread_source` /
/// `source.subagent`, upstream codex-watch.js `applyMeta`) and files without
/// a parseable meta id are skipped — unlike the continuously-running upstream
/// watcher, a one-shot seed cannot validate a session without its header.
fn read_codex_session_meta(path: &Path) -> Option<CodexMeta> {
    let file = File::open(path).ok()?;
    let mut reader = file.take(CODEX_FIRST_LINE_MAX);
    let mut buffer = Vec::new();
    reader.read_to_end(&mut buffer).ok()?;
    let line_bytes = match buffer.iter().position(|&byte| byte == b'\n') {
        Some(newline) => &buffer[..newline],
        None => buffer.as_slice(),
    };
    let line = std::str::from_utf8(line_bytes).ok()?.trim();
    if line.is_empty() || !line.starts_with('{') {
        return None;
    }
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    let payload = value.get("payload")?;
    let subagent_source = payload
        .get("source")
        .and_then(Value::as_object)
        .and_then(|source| source.get("subagent"))
        .and_then(Value::as_bool)
        == Some(true);
    if payload.get("thread_source").and_then(Value::as_str) == Some("subagent") || subagent_source {
        return None;
    }
    let session_id = json_text(payload, &["id", "session_id", "sessionId"], 256)?;
    Some(CodexMeta {
        session_id,
        cwd: json_text(payload, &["cwd"], 4096).unwrap_or_default(),
        model: json_text(payload, &["model", "model_id"], 256),
    })
}

/// First non-empty text among `keys`, trimmed and capped at `max_chars`.
fn json_text(value: &Value, keys: &[&str], max_chars: usize) -> Option<String> {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.chars().take(max_chars).collect());
            }
        }
    }
    None
}

fn file_mtime_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis() as u64)
}

fn trim_jsonl_line(bytes: &[u8]) -> &[u8] {
    let mut start = 0;
    let mut end = bytes.len();
    while start < end && matches!(bytes[start], b'\n' | b'\r' | b' ' | b'\t') {
        start += 1;
    }
    while end > start && matches!(bytes[end - 1], b'\n' | b'\r' | b' ' | b'\t') {
        end -= 1;
    }
    &bytes[start..end]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "octopus-session-seed-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn age_file(path: &Path, seconds_ago: u64) {
        let file = fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(seconds_ago))
            .unwrap();
    }

    fn claude_transcript(session_id: &str, cwd: &str, model: &str) -> String {
        let user = json!({
            "type": "user",
            "sessionId": session_id,
            "cwd": cwd,
        });
        let assistant = json!({
            "type": "assistant",
            "sessionId": session_id,
            "cwd": cwd,
            "message": {
                "id": "msg-1",
                "model": model,
                "content": [{"type": "text", "text": "done"}],
            },
        });
        format!("{user}\n{assistant}\n")
    }

    #[test]
    fn claude_candidates_respect_window_and_skip_sidechain_files() {
        let root = temp_dir("claude-window");
        let project = root.join("-home-z-re-llmpet");
        fs::create_dir_all(&project).unwrap();

        let fresh = project.join("seed-session-a.jsonl");
        fs::write(
            &fresh,
            claude_transcript("seed-session-a", "/home/z/re-llmpet", "claude-sonnet-4-6"),
        )
        .unwrap();

        // > 128 KB: the probe lands inside the padding, the half-line head
        // must be dropped and the trailing identity rows still read.
        let padded = project.join("seed-session-padded.jsonl");
        let padding = format!("{}\"pad\":\"{}\"", "{", "x".repeat(200_000));
        fs::write(
            &padded,
            format!(
                "{padding}\n{}\n",
                claude_transcript(
                    "seed-session-padded",
                    "/home/z/re-llmpet",
                    "claude-sonnet-4-6"
                )
            ),
        )
        .unwrap();

        let stale = project.join("seed-session-stale.jsonl");
        fs::write(
            &stale,
            claude_transcript("seed-session-stale", "/home/z/old", "claude-sonnet-4-6"),
        )
        .unwrap();
        age_file(&stale, 2 * 60 * 60);

        let sidechain = project.join("seed-session-side.jsonl");
        let side = json!({
            "type": "assistant",
            "sessionId": "seed-session-side",
            "cwd": "/home/z/re-llmpet",
            "isSidechain": true,
            "message": {"model": "claude-haiku-4-5"},
        });
        fs::write(&sidechain, format!("{side}\n")).unwrap();

        let candidates = collect_claude_candidates(&root, now_ms());
        let ids: Vec<&str> = candidates
            .iter()
            .map(|row| row.session_id.as_str())
            .collect();
        assert!(
            ids.contains(&"seed-session-a"),
            "fresh transcript must seed: {ids:?}"
        );
        assert!(
            ids.contains(&"seed-session-padded"),
            "tail probe must drop the partial head line: {ids:?}"
        );
        assert!(
            !ids.contains(&"seed-session-stale"),
            "2h-old transcript is outside the window: {ids:?}"
        );
        assert!(
            !ids.contains(&"seed-session-side"),
            "sidechain-only file must not seed: {ids:?}"
        );
        let row = candidates
            .iter()
            .find(|row| row.session_id == "seed-session-a")
            .unwrap();
        assert_eq!(row.cwd, "/home/z/re-llmpet");
        assert_eq!(row.model.as_deref(), Some("claude-sonnet-4-6"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn claude_candidates_cap_at_fifteen() {
        let root = temp_dir("claude-cap");
        let project = root.join("-cap-project");
        fs::create_dir_all(&project).unwrap();
        for index in 0..17 {
            let path = project.join(format!("cap-session-{index:02}.jsonl"));
            fs::write(
                &path,
                claude_transcript(&format!("cap-{index}"), "/tmp/cap", "claude-sonnet-4-6"),
            )
            .unwrap();
        }
        assert_eq!(collect_claude_candidates(&root, now_ms()).len(), 15);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn codex_candidates_read_meta_and_filter_guardians() {
        let root = temp_dir("codex-meta");
        let day = root.join("2026").join("10").join("02");
        fs::create_dir_all(&day).unwrap();

        let live =
            day.join("rollout-2026-10-02T10-00-00-11111111-2222-3333-4444-555555555555.jsonl");
        fs::write(
            &live,
            concat!(
                r#"{"type":"session_meta","payload":{"id":"codex-live-1","cwd":"/tmp/proj-cx","model":"gpt-5.3-codex"}}"#,
                "\n",
                r#"{"timestamp":"2026-10-02T10:00:01Z","type":"event_msg","payload":{"type":"token_count","info":{}}}"#,
                "\n",
            ),
        )
        .unwrap();

        let stale =
            day.join("rollout-2026-10-02T09-00-00-99999999-2222-3333-4444-555555555555.jsonl");
        fs::write(
            &stale,
            concat!(
                r#"{"type":"session_meta","payload":{"id":"codex-stale","cwd":"/tmp/old"}}"#,
                "\n",
            ),
        )
        .unwrap();
        age_file(&stale, 2 * 60 * 60);

        let guardian =
            day.join("rollout-2026-10-02T09-30-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
        fs::write(&guardian, concat!(
            r#"{"type":"session_meta","payload":{"id":"codex-guardian","cwd":"/tmp/g","thread_source":"subagent"}}"#,
            "\n",
        ))
        .unwrap();

        let candidates = collect_codex_candidates(&root, now_ms());
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].session_id, "codex-live-1");
        assert_eq!(candidates[0].cwd, "/tmp/proj-cx");
        assert_eq!(candidates[0].model.as_deref(), Some("gpt-5.3-codex"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn codex_candidates_cap_at_fifteen() {
        let root = temp_dir("codex-cap");
        let day = root.join("2026").join("10").join("02");
        fs::create_dir_all(&day).unwrap();
        for index in 0..17 {
            let path = day.join(format!(
                "rollout-{index:02}-11111111-2222-3333-4444-555555{index:07}.jsonl"
            ));
            fs::write(
                &path,
                format!(
                    "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"codex-cap-{index}\",\"cwd\":\"/tmp/cap\"}}}}\n"
                ),
            )
            .unwrap();
        }
        assert_eq!(collect_codex_candidates(&root, now_ms()).len(), 15);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn seeds_fill_the_board_and_are_idempotent() {
        let home = temp_dir("glue-home");

        let project = home.join(".claude").join("projects").join("-tmp-glue");
        fs::create_dir_all(&project).unwrap();
        let fresh = project.join("glue-claude-1.jsonl");
        fs::write(
            &fresh,
            claude_transcript("glue-claude-1", "/tmp/glue", "claude-sonnet-4-6"),
        )
        .unwrap();
        let stale = project.join("glue-claude-stale.jsonl");
        fs::write(
            &stale,
            claude_transcript("glue-claude-stale", "/tmp/old", "claude-sonnet-4-6"),
        )
        .unwrap();
        age_file(&stale, 2 * 60 * 60);

        let day = home
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("10")
            .join("02");
        fs::create_dir_all(&day).unwrap();
        let rollout =
            day.join("rollout-2026-10-02T11-00-00-22222222-3333-4444-5555-666666666666.jsonl");
        fs::write(
            &rollout,
            concat!(
                r#"{"type":"session_meta","payload":{"id":"glue-codex-1","cwd":"/tmp/glue-cx","model":"gpt-5.3-codex"}}"#,
                "\n",
            ),
        )
        .unwrap();

        // Runtime construction goes through the real AppState against a temp
        // HOME. No sibling test module reads HOME (verified: the only
        // home_dir() callers in cfg(test) trees are production paths), and
        // the environment is restored before any assertion can panic.
        let previous_home = std::env::var_os("HOME");
        let previous_codex_home = std::env::var_os("CODEX_HOME");
        std::env::set_var("HOME", &home);
        std::env::remove_var("CODEX_HOME");
        let runtime = crate::model::AppState::new().runtime;
        let first_claude = seed_claude_sessions(&runtime);
        let first_codex = seed_codex_sessions(&runtime);
        let second_claude = seed_claude_sessions(&runtime);
        let second_codex = seed_codex_sessions(&runtime);
        let claude_row = runtime.session("glue-claude-1");
        let codex_row = runtime.session("glue-codex-1");
        let stale_row = runtime.session("glue-claude-stale");
        match previous_home {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        match previous_codex_home {
            Some(value) => std::env::set_var("CODEX_HOME", value),
            None => std::env::remove_var("CODEX_HOME"),
        }

        assert_eq!(first_claude, 1);
        assert_eq!(first_codex, 1);
        assert_eq!(second_claude, 0, "second claude seed must be a no-op");
        assert_eq!(second_codex, 0, "second codex seed must be a no-op");
        let claude_row = claude_row.expect("seeded claude row must be on the board");
        assert_eq!(claude_row.provider, "claude");
        assert_eq!(claude_row.state, "idle");
        assert_eq!(claude_row.cwd, "/tmp/glue");
        assert_eq!(claude_row.model.as_deref(), Some("claude-sonnet-4-6"));
        let codex_row = codex_row.expect("seeded codex row must be on the board");
        assert_eq!(codex_row.provider, "codex");
        assert_eq!(codex_row.state, "idle");
        assert_eq!(codex_row.cwd, "/tmp/glue-cx");
        assert_eq!(codex_row.model.as_deref(), Some("gpt-5.3-codex"));
        assert!(stale_row.is_none(), "stale transcript must not seed");
        let _ = fs::remove_dir_all(&home);
    }
}
