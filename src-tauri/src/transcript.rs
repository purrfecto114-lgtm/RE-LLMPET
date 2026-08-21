use crate::metering::{UsageIngest, UsageLedger};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const CURSOR_FILE_NAME: &str = "transcript-cursors.json";
const MAX_CURSOR_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SCAN_BYTES: u64 = 8 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;
const MAX_CURSORS: usize = 5_000;

#[derive(Debug, Clone, Default)]
pub struct TranscriptScanResult {
    pub usage: UsageIngest,
    pub assistant_text: Option<String>,
    pub model: Option<String>,
    /// v0.5.70: true if the scan detected an `interruptedAfter` event
    /// (user pressed ESC to cancel a response). Surfaced to the pet UI
    /// so the pet can react with a "paused" animation.
    pub interrupted: bool,
    /// v0.5.70: true if the scan detected an `apiErrorAfter` event
    /// (API error such as rate limit or server error). Surfaced to the
    /// pet UI so the pet can react with an "error" animation.
    pub api_error: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CursorState {
    #[serde(default)]
    cursors: HashMap<String, u64>,
}

pub struct TranscriptScanner {
    projects_root: PathBuf,
    cursor_path: PathBuf,
    cursors: HashMap<String, u64>,
    scanned_files: u64,
    scanned_bytes: u64,
    malformed_lines: u64,
    oversized_lines: u64,
    rejected_paths: u64,
    truncated_files: u64,
    scan_errors: u64,
    save_error: Option<String>,
}

impl TranscriptScanner {
    pub fn open(app_dir: &Path, projects_root: PathBuf) -> Self {
        let cursor_path = app_dir.join(CURSOR_FILE_NAME);
        let (cursors, save_error) = load_cursors(&cursor_path);
        Self {
            projects_root,
            cursor_path,
            cursors,
            scanned_files: 0,
            scanned_bytes: 0,
            malformed_lines: 0,
            oversized_lines: 0,
            rejected_paths: 0,
            truncated_files: 0,
            scan_errors: 0,
            save_error,
        }
    }

    pub fn scan_from_hook(
        &mut self,
        body: &Value,
        session_id: &str,
        ledger: &mut UsageLedger,
        observed_at: u64,
        reply_limit: Option<usize>,
    ) -> TranscriptScanResult {
        let path = body
            .get("transcript_path")
            .or_else(|| body.get("transcriptPath"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let Some(path) = path else {
            return TranscriptScanResult::default();
        };
        match self.scan_path(
            Path::new(path),
            session_id,
            ledger,
            observed_at,
            reply_limit,
        ) {
            Ok(result) => result,
            Err(_) => {
                self.scan_errors = self.scan_errors.saturating_add(1);
                TranscriptScanResult::default()
            }
        }
    }

    pub fn diagnostics(&self) -> Value {
        json!({
            "cursorFiles": self.cursors.len(),
            "scannedFiles": self.scanned_files,
            "scannedBytes": self.scanned_bytes,
            "malformedLines": self.malformed_lines,
            "oversizedLines": self.oversized_lines,
            "rejectedPaths": self.rejected_paths,
            "truncatedFiles": self.truncated_files,
            "scanErrors": self.scan_errors,
            "saveError": self.save_error.clone(),
        })
    }

    fn scan_path(
        &mut self,
        requested: &Path,
        session_id: &str,
        ledger: &mut UsageLedger,
        observed_at: u64,
        reply_limit: Option<usize>,
    ) -> Result<TranscriptScanResult, String> {
        let path = match validate_transcript_path(&self.projects_root, requested) {
            Ok(path) => path,
            Err(error) => {
                self.rejected_paths = self.rejected_paths.saturating_add(1);
                return Err(error);
            }
        };
        let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
        if !metadata.is_file() {
            return Err("transcript is not a regular file".into());
        }
        let key = path.to_string_lossy().to_string();
        let mut offset = self.cursors.get(&key).copied().unwrap_or(0);
        if offset > metadata.len() {
            offset = 0;
            self.truncated_files = self.truncated_files.saturating_add(1);
        }
        if offset == metadata.len() {
            return Ok(TranscriptScanResult::default());
        }

        let file = File::open(&path).map_err(|error| error.to_string())?;
        let mut reader = BufReader::new(file);
        reader
            .seek(SeekFrom::Start(offset))
            .map_err(|error| error.to_string())?;
        let mut consumed = 0_u64;
        let mut cursor = offset;
        let mut result = TranscriptScanResult::default();
        let mut buffer = Vec::new();

        while consumed < MAX_SCAN_BYTES {
            buffer.clear();
            let line_start = cursor;
            let read = reader
                .by_ref()
                .take((MAX_LINE_BYTES + 1) as u64)
                .read_until(b'\n', &mut buffer)
                .map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            consumed = consumed.saturating_add(read as u64);
            cursor = cursor.saturating_add(read as u64);

            if buffer.len() > MAX_LINE_BYTES {
                self.oversized_lines = self.oversized_lines.saturating_add(1);
                let remaining = MAX_SCAN_BYTES
                    .saturating_sub(consumed)
                    .min(16 * 1024 * 1024);
                let extra = discard_to_newline(&mut reader, remaining)?;
                consumed = consumed.saturating_add(extra);
                cursor = cursor.saturating_add(extra);
                continue;
            }
            if buffer.last() != Some(&b'\n') {
                // Claude may still be streaming the final JSON object. Keep the
                // cursor at the start of this line and retry on the next hook.
                cursor = line_start;
                break;
            }
            let trimmed = trim_line(&buffer);
            if trimmed.is_empty() || trimmed.first() != Some(&b'{') {
                continue;
            }
            let line: Value = match serde_json::from_slice(trimmed) {
                Ok(value) => value,
                Err(_) => {
                    self.malformed_lines = self.malformed_lines.saturating_add(1);
                    continue;
                }
            };
            if !matches_session(&line, session_id) || is_subagent(&line) {
                continue;
            }
            if let Some(model) = line
                .get("message")
                .and_then(Value::as_object)
                .and_then(|message| message.get("model"))
                .and_then(Value::as_str)
                .map(|value| value.chars().take(256).collect::<String>())
            {
                result.model = Some(model);
            }
            if let Some(limit) = reply_limit {
                if let Some(text) = safe_assistant_text(&line, limit) {
                    result.assistant_text = Some(text);
                }
            }
            // R4-F2 fix: don't let record_claude_assistant error block cursor
            match ledger.record_claude_assistant(&line, session_id, observed_at) {
                Ok(usage) => merge_usage(&mut result.usage, usage),
                Err(_) => {
                    self.malformed_lines = self.malformed_lines.saturating_add(1);
                }
            }
            // v0.5.70: detect interruptedAfter (ESC cancel) and apiErrorAfter
            // (API error). These appear as keys on the message object of user
            // type lines in Claude transcript JSONL. Surfaced to the pet UI
            // so the pet can react with paused/error animations.
            if !result.interrupted && line_has_interrupted_after(&line) {
                result.interrupted = true;
            }
            if !result.api_error && line_has_api_error_after(&line) {
                result.api_error = true;
            }
        }

        self.scanned_files = self.scanned_files.saturating_add(1);
        self.scanned_bytes = self.scanned_bytes.saturating_add(consumed);
        self.cursors.insert(key, cursor);
        trim_cursors(&mut self.cursors);
        if let Err(error) = save_cursors(&self.cursor_path, &self.cursors) {
            self.save_error = Some(error);
        } else {
            self.save_error = None;
        }
        Ok(result)
    }
}

fn validate_transcript_path(root: &Path, requested: &Path) -> Result<PathBuf, String> {
    if requested.extension().and_then(|value| value.to_str()) != Some("jsonl") {
        return Err("transcript must be a .jsonl file".into());
    }
    let root =
        fs::canonicalize(root).map_err(|error| format!("transcript root unavailable: {error}"))?;
    let path =
        fs::canonicalize(requested).map_err(|error| format!("transcript unavailable: {error}"))?;
    if !path.starts_with(&root) {
        return Err("transcript path escapes ~/.claude/projects".into());
    }
    Ok(path)
}

fn matches_session(line: &Value, session_id: &str) -> bool {
    if session_id.is_empty() {
        return true;
    }
    line.get("sessionId")
        .or_else(|| line.get("session_id"))
        .and_then(Value::as_str)
        .map(|value| value == session_id)
        .unwrap_or(true)
}

/// v0.5.70: Detect ESC cancellation. Claude transcript JSONL user messages
/// may carry `message.interruptedAfter` (string, names the block that was
/// interrupted) or `message.content[].type == "interrupted"` to signal that
/// the user pressed ESC to stop a response.
fn line_has_interrupted_after(line: &Value) -> bool {
    let message = match line.get("message") {
        Some(msg) => msg,
        None => return false,
    };
    // Primary signal: message.interruptedAfter is a non-null string
    if message
        .get("interruptedAfter")
        .or_else(|| message.get("interrupted_after"))
        .and_then(Value::as_str)
        .is_some()
    {
        return true;
    }
    // Secondary signal: content array contains a block with type "interrupted"
    if let Some(content) = message.get("content").and_then(Value::as_array) {
        for block in content.iter().take(128) {
            if block.get("type").and_then(Value::as_str) == Some("interrupted") {
                return true;
            }
        }
    }
    false
}

/// v0.5.70: Detect API errors. Claude transcript JSONL user messages may
/// carry `message.apiErrorAfter` (string, names the block after which the
/// error occurred) or set `isApiErrorMessage: true` on the line to signal
/// a rate-limit, server error, or other API failure.
fn line_has_api_error_after(line: &Value) -> bool {
    // Fast path: isApiErrorMessage flag on the line itself
    if line.get("isApiErrorMessage").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    let message = match line.get("message") {
        Some(msg) => msg,
        None => return false,
    };
    // Primary signal: message.apiErrorAfter is a non-null string
    if message
        .get("apiErrorAfter")
        .or_else(|| message.get("api_error_after"))
        .and_then(Value::as_str)
        .is_some()
    {
        return true;
    }
    false
}

fn is_subagent(line: &Value) -> bool {
    line.get("isSidechain").and_then(Value::as_bool) == Some(true)
        || line.get("isSubagent").and_then(Value::as_bool) == Some(true)
        || line.get("is_subagent").and_then(Value::as_bool) == Some(true)
        || line.get("agentId").and_then(Value::as_str).is_some()
        || line.get("agent_id").and_then(Value::as_str).is_some()
}

fn safe_assistant_text(line: &Value, max_chars: usize) -> Option<String> {
    if line.get("type").and_then(Value::as_str) != Some("assistant")
        || line.get("isApiErrorMessage").and_then(Value::as_bool) == Some(true)
    {
        return None;
    }
    let content = line.get("message")?.get("content")?;
    let mut text = String::new();
    match content {
        Value::String(value) => text.push_str(value),
        Value::Array(blocks) => {
            for block in blocks.iter().take(128) {
                let Some(object) = block.as_object() else {
                    continue;
                };
                let kind = object.get("type").and_then(Value::as_str).unwrap_or("");
                if kind != "text" && kind != "output_text" {
                    continue;
                }
                if let Some(value) = object.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(value);
                }
            }
        }
        _ => return None,
    }
    safe_reply(&text, max_chars)
}

pub fn safe_reply(value: &str, max_chars: usize) -> Option<String> {
    let clean = sanitize_text(value)?;
    if looks_sensitive(&clean) {
        return None;
    }
    let max_chars = max_chars.clamp(120, 2_200);
    let count = clean.chars().count();
    if count <= max_chars {
        return Some(clean);
    }
    let tail = clean.chars().skip(count - max_chars).collect::<String>();
    Some(format!("…{tail}"))
}

fn sanitize_text(value: &str) -> Option<String> {
    let clean = value
        .chars()
        .map(|character| {
            if character.is_control() && character != '\n' && character != '\t' {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let clean = clean.trim();
    if clean.is_empty() {
        return None;
    }
    Some(clean.to_string())
}

fn looks_sensitive(value: &str) -> bool {
    // R3-F4 fix (R6): trim leading/trailing whitespace to prevent bypass
    // via indentation (e.g. " api_key=..." in markdown code blocks).
    let lower = value.trim().to_ascii_lowercase();
    [
        "-----begin private key",
        "-----begin rsa private key",
        "authorization: bearer ",
        "password=",
        "passwd=",
        "api_key=",
        "api-key=",
        "secret_key=",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
        || value.contains("AKIA")
        || value.contains("ghp_")
        || value.contains("sk-ant-")
        || value.contains("sk-proj-")
}

fn merge_usage(target: &mut UsageIngest, source: UsageIngest) {
    target.inserted |= source.inserted;
    target.duplicate |= source.duplicate;
    if source.context_used.is_some() {
        target.context_used = source.context_used;
        target.context_limit = source.context_limit.or(target.context_limit);
    }
}

fn load_cursors(path: &Path) -> (HashMap<String, u64>, Option<String>) {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (HashMap::new(), None)
        }
        Err(error) => return (HashMap::new(), Some(error.to_string())),
    };
    if metadata.len() > MAX_CURSOR_FILE_BYTES {
        return (
            HashMap::new(),
            Some("transcript cursor file is oversized".into()),
        );
    }
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) => return (HashMap::new(), Some(error.to_string())),
    };
    match serde_json::from_reader::<_, CursorState>(file) {
        Ok(mut state) => {
            state
                .cursors
                .retain(|path, _| path.len() <= 4096 && path.ends_with(".jsonl"));
            trim_cursors(&mut state.cursors);
            (state.cursors, None)
        }
        Err(error) => (HashMap::new(), Some(error.to_string())),
    }
}

fn save_cursors(path: &Path, cursors: &HashMap<String, u64>) -> Result<(), String> {
    let parent = path.parent().ok_or("cursor path has no parent")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    let temp = parent.join(format!(".transcript-cursors.{}.tmp", std::process::id()));
    {
        let mut file = File::create(&temp).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))
                .map_err(|error| error.to_string())?;
        }
        serde_json::to_writer(
            &mut file,
            &CursorState {
                cursors: cursors.clone(),
            },
        )
        .map_err(|error| error.to_string())?;
        file.flush().map_err(|error| error.to_string())?;
        let _ = file.sync_all();
    }
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    fs::rename(temp, path).map_err(|error| error.to_string())
}

fn trim_cursors(cursors: &mut HashMap<String, u64>) {
    if cursors.len() <= MAX_CURSORS {
        return;
    }
    let mut keys = cursors.keys().cloned().collect::<Vec<_>>();
    keys.sort();
    let remove = keys.len().saturating_sub(MAX_CURSORS);
    for key in keys.into_iter().take(remove) {
        cursors.remove(&key);
    }
}

fn trim_line(bytes: &[u8]) -> &[u8] {
    let mut end = bytes.len();
    while end > 0 && matches!(bytes[end - 1], b'\n' | b'\r' | b' ' | b'\t') {
        end -= 1;
    }
    &bytes[..end]
}

// R4-F1 fix: added max_bytes to prevent unbounded read on giant single-line inputs
fn discard_to_newline(reader: &mut BufReader<File>, max_bytes: u64) -> Result<u64, String> {
    let mut total = 0_u64;
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        let chunk_limit = (MAX_LINE_BYTES + 1).min(max_bytes.saturating_sub(total) as usize);
        if chunk_limit == 0 {
            return Ok(total);
        }
        let read = reader
            .by_ref()
            .take(chunk_limit as u64)
            .read_until(b'\n', &mut buffer)
            .map_err(|error| error.to_string())?;
        total = total.saturating_add(read as u64);
        if read == 0 || buffer.last() == Some(&b'\n') {
            return Ok(total);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "re-llmpet-transcript-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn assistant_line(id: &str, output: u64, text: &str) -> Value {
        json!({
            "type":"assistant",
            "sessionId":"session-1",
            "requestId":"request-1",
            "timestamp":chrono::Utc::now().to_rfc3339(),
            "message":{
                "id":id,
                "model":"claude-sonnet-4-6",
                "usage":{
                    "input_tokens":100,
                    "output_tokens":output,
                    "cache_read_input_tokens":50,
                    "cache_creation_input_tokens":10
                },
                "content":[{"type":"text","text":text}]
            }
        })
    }

    #[test]
    fn incremental_scan_deduplicates_streaming_rows_and_keeps_reply_in_memory_only() {
        let root = temp_dir("root");
        let app = temp_dir("app");
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        let transcript = project.join("session-1.jsonl");
        let line = assistant_line("msg-1", 20, "完成了。不会保存整段对话。");
        fs::write(
            &transcript,
            format!(
                "{}\n{}\n",
                serde_json::to_string(&line).unwrap(),
                serde_json::to_string(&line).unwrap()
            ),
        )
        .unwrap();
        let now = crate::model::now_ms();
        let mut ledger = UsageLedger::open(&app, now);
        let mut scanner = TranscriptScanner::open(&app, root.clone());
        let result = scanner
            .scan_path(&transcript, "session-1", &mut ledger, now, Some(800))
            .unwrap();
        assert!(result.usage.inserted);
        assert!(result.usage.duplicate);
        assert_eq!(
            result.assistant_text.as_deref(),
            Some("完成了。不会保存整段对话。")
        );
        assert_eq!(ledger.snapshot(now)["today"]["messages"], 1);
        let second = scanner
            .scan_path(&transcript, "session-1", &mut ledger, now + 1, Some(800))
            .unwrap();
        assert!(!second.usage.inserted);
        assert_eq!(ledger.snapshot(now + 1)["today"]["messages"], 1);
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(app);
    }

    #[test]
    fn path_escape_and_sensitive_reply_are_rejected() {
        let root = temp_dir("safe-root");
        let app = temp_dir("safe-app");
        let outside = temp_dir("outside").join("escape.jsonl");
        fs::write(&outside, "{}\n").unwrap();
        let now = crate::model::now_ms();
        let mut ledger = UsageLedger::open(&app, now);
        let mut scanner = TranscriptScanner::open(&app, root.clone());
        assert!(scanner
            .scan_path(&outside, "session-1", &mut ledger, now, Some(800))
            .is_err());
        let secret = assistant_line("msg-secret", 1, "Authorization: Bearer secret-token");
        assert!(safe_assistant_text(&secret, 800).is_none());
        let long = format!("prefix-{}-tail", "x".repeat(300));
        let clipped = safe_reply(&long, 120).unwrap();
        assert!(clipped.starts_with('…'));
        assert!(clipped.ends_with("-tail"));
        assert!(clipped.chars().count() <= 121);
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(app);
        let _ = fs::remove_file(outside);
    }

    #[test]
    fn interrupted_after_is_detected() {
        // Claude transcript user line with message.interruptedAfter
        let line = serde_json::json!({
            "type": "user",
            "sessionId": "s1",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "stop"}],
                "interruptedAfter": "tool_use_block_id"
            }
        });
        assert!(line_has_interrupted_after(&line));
        // snake_case variant
        let line2 = serde_json::json!({
            "type": "user",
            "message": {"interrupted_after": "block-2"}
        });
        assert!(line_has_interrupted_after(&line2));
        // content array with interrupted block type
        let line3 = serde_json::json!({
            "type": "user",
            "message": {
                "content": [{"type": "interrupted"}]
            }
        });
        assert!(line_has_interrupted_after(&line3));
    }

    #[test]
    fn interrupted_after_absent_when_no_signal() {
        let line = serde_json::json!({
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": "hello"}]}
        });
        assert!(!line_has_interrupted_after(&line));
        assert!(!line_has_api_error_after(&line));
    }

    #[test]
    fn api_error_after_is_detected() {
        // isApiErrorMessage flag on line
        let line = serde_json::json!({
            "type": "user",
            "isApiErrorMessage": true,
            "message": {"content": []}
        });
        assert!(line_has_api_error_after(&line));
        // message.apiErrorAfter string
        let line2 = serde_json::json!({
            "type": "user",
            "message": {"apiErrorAfter": "assistant_block_1"}
        });
        assert!(line_has_api_error_after(&line2));
        // snake_case variant
        let line3 = serde_json::json!({
            "type": "user",
            "message": {"api_error_after": "block-x"}
        });
        assert!(line_has_api_error_after(&line3));
    }

    #[test]
    fn scan_surfaces_interrupted_and_api_error_flags() {
        let root = temp_dir("scan-flags-root");
        let app = temp_dir("scan-flags-app");
        let transcript = root.join("proj").join("session-flags.jsonl");
        fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        // Write a normal assistant line + a user line with interruptedAfter
        let assistant = assistant_line("msg-flag-1", 100, "working on it");
        let interrupted_line = serde_json::json!({
            "type": "user",
            "sessionId": "session-flags",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "esc"}],
                "interruptedAfter": "tool_use_1"
            }
        });
        let mut content = String::new();
        content.push_str(&assistant.to_string());
        content.push('\n');
        content.push_str(&interrupted_line.to_string());
        content.push('\n');
        fs::write(&transcript, content).unwrap();
        let now = crate::model::now_ms();
        let mut ledger = UsageLedger::open(&app, now);
        let mut scanner = TranscriptScanner::open(&app, root.clone());
        let result = scanner
            .scan_path(&transcript, "session-flags", &mut ledger, now, Some(800))
            .unwrap();
        assert!(result.interrupted, "interrupted flag should be set");
        assert!(!result.api_error, "api_error flag should NOT be set");
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(app);
    }
}
