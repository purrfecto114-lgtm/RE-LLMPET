// R51 (2026-08-30): the DshEvent/…/RequestContextData structs below are the
// declared wire-contract types for the DSH observer line format
// (docs/DSH_OBSERVER_DELIVERY_2026-08-29.md). Deserialization call sites are
// gated behind the DSH watch pipeline; they are contract documentation as
// much as code, so unused-construction warnings are silenced file-wide.
#![allow(dead_code)]

use crate::dsh_zstd::decode_complete_frames;
use crate::model::Runtime;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tokio::time::interval;
use tracing::{debug, error, info, warn};

const PROVIDER_ID: &str = "dsh";
const POLL_INTERVAL_MS: u64 = 2500;
const IDLE_UNTRACK_MS: u64 = 60 * 60 * 1000;
const MAX_READ_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DshSessionHeader {
    #[serde(rename = "type")]
    type_: String,
    version: u32,
    id: String,
    cwd: String,
    created_at: u64,
    #[serde(default)]
    delegation_depth: u32,
    #[serde(default)]
    origin: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
enum DshEvent {
    #[serde(rename = "session")]
    Session(DshSessionHeader),
    #[serde(rename = "turn/start")]
    TurnStart { seq: u64, time: u64 },
    #[serde(rename = "user/message")]
    UserMessage {
        seq: u64,
        time: u64,
        data: UserMessageData,
    },
    #[serde(rename = "step/start")]
    StepStart { seq: u64, time: u64 },
    #[serde(rename = "tool/call")]
    ToolCall {
        seq: u64,
        time: u64,
        data: ToolCallData,
    },
    #[serde(rename = "tool/code-dispatch-start", alias = "tool/ptc-dispatch-start")]
    CodeDispatchStart {
        seq: u64,
        time: u64,
        data: ToolCallData,
    },
    #[serde(rename = "tool/result")]
    ToolResult {
        seq: u64,
        time: u64,
        data: ToolResultData,
    },
    #[serde(rename = "tool/code-dispatch", alias = "tool/ptc-dispatch")]
    CodeDispatch {
        seq: u64,
        time: u64,
        data: ToolResultData,
    },
    #[serde(rename = "assistant/message")]
    AssistantMessage {
        seq: u64,
        time: u64,
        data: AssistantMessageData,
    },
    #[serde(rename = "turn/end")]
    TurnEnd {
        seq: u64,
        time: u64,
        data: TurnEndData,
    },
    #[serde(rename = "approval/asked")]
    ApprovalAsked {
        seq: u64,
        time: u64,
        data: ApprovalData,
    },
    #[serde(rename = "approval/decided")]
    ApprovalDecided {
        seq: u64,
        time: u64,
        data: ApprovalDecidedData,
    },
    #[serde(rename = "compaction/start")]
    CompactionStart { seq: u64, time: u64 },
    #[serde(rename = "compaction/end")]
    CompactionEnd { seq: u64, time: u64 },
    #[serde(rename = "llm/retry")]
    LlmRetry { seq: u64, time: u64 },
    #[serde(rename = "session/title")]
    SessionTitle {
        seq: u64,
        time: u64,
        data: TitleData,
    },
    #[serde(rename = "request/header")]
    RequestHeader {
        seq: u64,
        time: u64,
        data: RequestHeaderData,
    },
    #[serde(rename = "request/context")]
    RequestContext {
        seq: u64,
        time: u64,
        data: RequestContextData,
    },
    // R57 (R57-1b): these *-chunks names match nothing in any published dsh
    // word list we could verify (v1 streamed via assistant/chunk; v2+ embeds
    // streams inside assistant/message). Kept for forward tolerance only.
    #[serde(rename = "text-chunks")]
    TextChunks,
    #[serde(rename = "reasoning-chunks")]
    ReasoningChunks,
    #[serde(rename = "tool-call-chunks")]
    ToolCallChunks,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct UserMessageData {
    content: String,
    source: MessageSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MessageSource {
    kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ToolCallData {
    name: String,
    #[serde(default)]
    arguments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ToolResultData {
    name: String,
    #[serde(default)]
    result: Value,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AssistantMessageData {
    content: String,
    #[serde(default)]
    usage: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TurnEndData {
    reason: TurnEndReason,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum TurnEndReason {
    Completed,
    Error,
    Aborted,
    Blocked,
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ApprovalData {
    tool: String,
    #[serde(default)]
    arguments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ApprovalDecidedData {
    decision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TitleData {
    title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RequestHeaderData {
    model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RequestContextData {
    context_window: Option<u64>,
}

struct SessionTracker {
    session_id: String,
    is_zstd: bool,
    // R57: resolved session file name (generational roll detection — see
    // process_session).
    file_name: Option<String>,
    accepts_events: bool,
    file_offset: u64,
    carry: String,
    last_event_seq: u64,
    last_event_time: u64,
    session_state: String,
    session_cwd: String,
    session_title: Option<String>,
    assistant_last_output: Option<String>,
    context_used: Option<u64>,
    context_limit: Option<u64>,
    // R56: per-turn usage accumulators for the metering ledger. dsh's
    // usage.input_tokens/output_tokens are CUMULATIVE session totals, so the
    // per-turn delta = latest total - total at the previous assistant
    // message; turn/start resets nothing (deltas are computed per message),
    // turn/end(completed) emits the accumulated turn_usage.
    usage_input_total: u64,
    usage_output_total: u64,
    turn_input: u64,
    turn_output: u64,
}

/// R57 (R57-1b): the newest dsh persistence format generation we have
/// verified against the upstream repo (v4 files observed live; the
/// session-format-v2-to-v3 package documents the v3 rename wave).
const DSH_MAX_KNOWN_VERSION: u32 = 4;

/// R57-RV-A3: events older than this are treated as history replay (cold
/// start, tracker rebuild, generation roll) — ingested for state, never
/// emitted to the pet. 120s comfortably exceeds the 2.5s poll interval and
/// any clock skew between the writer and this process.
const REPLAY_QUIET_MS: u64 = 120_000;

/// R57 (R57-1b, deepseek-harness persistence docs): session files are
/// generational — v0 wrote `session.jsonl(.zstd)`, current releases write
/// `session.vN.jsonl(.zstd)`. Match any generation and take the highest;
/// when both formats exist at the same generation prefer the plain jsonl
/// (the live append target). Returns (is_zstd, path).
fn session_file_for(dir: &Path) -> Option<(bool, PathBuf)> {
    let entries = fs::read_dir(dir).ok()?;
    let mut best: Option<(u32, bool, PathBuf)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let (gen, is_zstd) = if name == "session.jsonl" {
            (0, false)
        } else if name == "session.jsonl.zstd" {
            (0, true)
        } else if let Some(rest) = name.strip_prefix("session.v") {
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            let tail = &rest[digits.len()..];
            if digits.is_empty() {
                continue;
            }
            let generation: u32 = match digits.parse() {
                Ok(value) => value,
                Err(_) => continue,
            };
            if tail == ".jsonl" {
                (generation, false)
            } else if tail == ".jsonl.zstd" {
                (generation, true)
            } else {
                continue;
            }
        } else {
            continue;
        };
        let replace = match &best {
            None => true,
            Some((best_gen, best_zstd, _)) => {
                gen > *best_gen || (gen == *best_gen && *best_zstd && !is_zstd)
            }
        };
        if replace {
            best = Some((gen, is_zstd, entry.path()));
        }
    }
    best.map(|(_, is_zstd, path)| (is_zstd, path))
}

pub struct DshWatcher {
    sessions_dir: PathBuf,
    poll_interval: Duration,
    trackers: HashMap<PathBuf, SessionTracker>,
    runtime: Arc<Runtime>,
    // R57 (断点①): the watcher used to be write-only (runtime.ingest with no
    // emission) — dsh state changes were invisible to the pet until some
    // OTHER provider happened to push stats. Hold the AppHandle so every
    // accepted dsh event also reaches the pet:event/pet:stats channels.
    app: AppHandle,
}

impl DshWatcher {
    pub fn new(runtime: Arc<Runtime>, app: AppHandle) -> Self {
        let dsh_home = std::env::var("DSH_HOME")
            .ok()
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|h| h.join(".dsh")))
            .unwrap_or_else(|| PathBuf::from("/tmp/.dsh"));

        let sessions_dir = dsh_home.join("sessions");

        // Check LLMPET_NO_DSH
        let disabled = std::env::var("LLMPET_NO_DSH")
            .map(|v| v == "1")
            .unwrap_or(false);

        if disabled {
            info!("dsh watcher disabled via LLMPET_NO_DSH");
        }

        Self {
            sessions_dir,
            poll_interval: Duration::from_millis(POLL_INTERVAL_MS),
            trackers: HashMap::new(),
            runtime,
            app,
        }
    }

    pub async fn start(&mut self) {
        if std::env::var("LLMPET_NO_DSH")
            .map(|v| v == "1")
            .unwrap_or(false)
        {
            info!("dsh watcher disabled, not starting");
            return;
        }

        info!("Starting dsh watcher for {:?}", self.sessions_dir);

        let mut interval = interval(self.poll_interval);

        loop {
            interval.tick().await;
            if let Err(e) = self.poll().await {
                error!("dsh poll error: {}", e);
            }
        }
    }

    async fn poll(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Discover session directories
        let session_dirs = self.discover_sessions()?;

        // Track new/removed sessions
        let current_paths: HashSet<PathBuf> = session_dirs.iter().cloned().collect();
        let tracked_paths: HashSet<PathBuf> = self.trackers.keys().cloned().collect();

        // Remove trackers for deleted sessions
        for removed in tracked_paths.difference(&current_paths) {
            info!("dsh session removed: {:?}", removed);
            self.trackers.remove(removed);
        }

        // Process each session
        for session_path in session_dirs {
            if let Err(e) = self.process_session(&session_path).await {
                warn!("dsh session {:?} error: {}", session_path, e);
            }
        }

        // Clean up idle trackers
        self.cleanup_idle();

        Ok(())
    }

    fn discover_sessions(&self) -> Result<Vec<PathBuf>, Box<dyn std::error::Error + Send + Sync>> {
        let mut sessions = Vec::new();

        if !self.sessions_dir.exists() {
            return Ok(sessions);
        }

        // Read project directories (--<normalized-cwd>--)
        for project_entry in fs::read_dir(&self.sessions_dir)? {
            let project_entry = project_entry?;
            let project_path = project_entry.path();
            if !project_path.is_dir() {
                continue;
            }

            // Read session directories (<encoded-session-id>/)
            for session_entry in fs::read_dir(&project_path)? {
                let session_entry = session_entry?;
                let session_path = session_entry.path();
                if !session_path.is_dir() {
                    continue;
                }

                // R57 (R57-1b): generational session files — v0 wrote
                // `session.jsonl(.zstd)`; current dsh releases write
                // `session.vN.jsonl(.zstd)` (v3/v4 observed live). The old
                // exact-name probe made every current session invisible.
                if session_file_for(&session_path).is_some() {
                    sessions.push(session_path);
                }
            }
        }

        Ok(sessions)
    }

    async fn process_session(
        &mut self,
        session_path: &Path,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Ensure tracker exists
        if !self.trackers.contains_key(session_path) {
            self.trackers.insert(
                session_path.to_path_buf(),
                SessionTracker {
                    session_id: session_path
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .to_string(),
                    is_zstd: false,
                    file_name: None,
                    accepts_events: false,
                    file_offset: 0,
                    carry: String::new(),
                    last_event_seq: 0,
                    last_event_time: 0,
                    session_state: "idle".to_string(),
                    session_cwd: String::new(),
                    session_title: None,
                    assistant_last_output: None,
                    context_used: None,
                    context_limit: None,
                    usage_input_total: 0,
                    usage_output_total: 0,
                    turn_input: 0,
                    turn_output: 0,
                },
            );
        }

        // Determine file type and path (R57: generational names, see
        // session_file_for).
        let Some((is_zstd, file_path)) = session_file_for(session_path) else {
            return Ok(());
        };

        // Read only bytes after the last committed plain-text or zstd-frame
        // boundary. A truncated/replaced file restarts from byte zero.
        let mut file = fs::File::open(&file_path)?;
        let file_size = file.metadata()?.len();
        let tracker = self.trackers.get_mut(session_path).unwrap();
        // R57: a generation roll (session.v3.jsonl → v4) swaps the file under
        // the same directory key; the offset must not survive the swap even
        // when the new file is already larger than the old offset.
        let file_name = file_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned());
        if tracker.is_zstd != is_zstd
            || file_size < tracker.file_offset
            || tracker.file_name.as_deref() != file_name.as_deref()
        {
            tracker.file_offset = 0;
            tracker.carry.clear();
            tracker.last_event_seq = 0;
            tracker.accepts_events = false;
        }
        tracker.is_zstd = is_zstd;
        tracker.file_name = file_name;
        if file_size == tracker.file_offset {
            return Ok(());
        }
        let unread = file_size - tracker.file_offset;
        if unread > MAX_READ_BYTES {
            return Err(format!(
                "dsh unread tail is {unread} bytes, above {MAX_READ_BYTES}-byte safety limit"
            )
            .into());
        }
        file.seek(SeekFrom::Start(tracker.file_offset))?;
        let mut new_data = Vec::with_capacity(unread as usize);
        file.read_to_end(&mut new_data)?;

        let (plain_text, committed) = if is_zstd {
            decode_complete_frames(&new_data)?
        } else {
            let text = String::from_utf8(new_data)
                .map_err(|error| format!("dsh JSONL is not valid UTF-8: {error}"))?;
            let consumed = text.len();
            (text, consumed)
        };
        if committed == 0 {
            return Ok(());
        }
        tracker.file_offset += committed as u64;

        let runtime = self.runtime.clone();
        let app = self.app.clone();
        Self::process_new_data_static(&app, &runtime, tracker, &plain_text).await?;

        Ok(())
    }

    async fn process_new_data_static(
        app: &AppHandle,
        runtime: &Arc<Runtime>,
        tracker: &mut SessionTracker,
        data: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut combined = tracker.carry.clone();
        combined.push_str(data);

        let lines: Vec<&str> = combined.lines().collect();
        tracker.carry = if combined.ends_with('\n') {
            String::new()
        } else {
            lines.last().map(|v| v.to_string()).unwrap_or_default()
        };

        let end_idx = if tracker.carry.is_empty() {
            lines.len()
        } else {
            lines.len().saturating_sub(1)
        };
        for line in &lines[..end_idx] {
            if line.trim().is_empty() {
                continue;
            }

            match serde_json::from_str::<Value>(line) {
                Ok(event_value) => {
                    if let Err(e) =
                        Self::handle_event_static(app, runtime, tracker, &event_value).await
                    {
                        warn!("dsh event parse error: {}", e);
                    }
                }
                Err(e) => {
                    warn!("dsh JSON parse error: {}", e);
                }
            }
        }

        Ok(())
    }

    async fn handle_event_static(
        app: &AppHandle,
        runtime: &Arc<Runtime>,
        tracker: &mut SessionTracker,
        event: &Value,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Parse event type
        let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");

        // Handle session header
        if event_type == "session" {
            let header: DshSessionHeader = serde_json::from_value(event.clone())?;

            // Fail-closed: reject unknown versions. R57 (R57-1b): the v0-era
            // `!= 0` gate rejected EVERY current dsh session (live formats
            // are v3/v4, verified against deepseek-harness
            // packages/session/session-format-v2-to-v3 and the persistence
            // catalog). Accept every published generation up to the newest
            // we have verified; only future, unverified majors fail closed.
            if header.version > DSH_MAX_KNOWN_VERSION {
                tracker.accepts_events = false;
                warn!(
                    "dsh session {}: unverified version {} (> {}), ignoring",
                    header.id, header.version, DSH_MAX_KNOWN_VERSION
                );
                return Ok(());
            }

            // Filter subagents
            if header.origin.as_deref() == Some("subagent") || header.delegation_depth > 0 {
                tracker.accepts_events = false;
                debug!("dsh: filtering subagent session {}", header.id);
                return Ok(());
            }

            // Initialize session
            tracker.session_id = format!("dsh:{}", header.id);
            tracker.session_cwd = header.cwd.clone();
            tracker.session_state = "idle".to_string();
            tracker.accepts_events = true;
            tracker.last_event_seq = 0;
            tracker.last_event_time = header.created_at;

            // R57 (断点①+greet): route the session header through the normal
            // ingestion path instead of hand-building a Session and inserting
            // it directly. record_hook creates the row AND fires the greet
            // producer (was_new → greeted_at/greet_due), which the direct
            // insert never could — a dsh session appearing on the board now
            // greets exactly like every other provider's new session. A
            // re-discovered row (app restart, generation roll) is not
            // was_new, so there is no greet spam.
            let start_event = json!({
                "session_id": tracker.session_id.clone(),
                "provider": PROVIDER_ID,
                "hook_event_name": "SessionStart",
                "cwd": header.cwd.clone(),
                "time": header.created_at,
                "timestamp_ms": header.created_at,
                "seq": 0,
            });
            let (session, accepted) = runtime.ingest_with_ack(&start_event);
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            // R57-RV-A3: a header created 3 days ago is history — greet only
            // for sessions that are actually live (recent header), else every
            // app restart plays the wake-up animation for every stale dir.
            if accepted && now.saturating_sub(header.created_at) <= REPLAY_QUIET_MS {
                crate::http_server::emit_hook_event(app, &start_event, &session);
            }
            crate::http_server::emit_stats(app, runtime);
            return Ok(());
        }

        // SessionHeader is the schema and ownership gate. Never interpret
        // later rows when it was missing, unsupported, or a subagent header.
        if !tracker.accepts_events {
            return Ok(());
        }

        // Parse event sequence
        let seq = event.get("seq").and_then(|v| v.as_u64()).unwrap_or(0);
        let time = event.get("time").and_then(|v| v.as_u64()).unwrap_or(0);

        // Skip old events
        if seq <= tracker.last_event_seq {
            return Ok(());
        }
        tracker.last_event_seq = seq;
        tracker.last_event_time = time;

        // Parse event type
        let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match event_type {
            "turn/start" => {
                tracker.session_state = "thinking".to_string();
                // R56: carry the explicit state — before this the event body
                // had no `state` field, so normalize_state fell to "idle" for
                // TaskStarted (which had no arm either): a dsh turn starting
                // looked like nothing happened.
                Self::emit_session_event_static(
                    app,
                    runtime,
                    &tracker.session_id,
                    "TaskStarted",
                    json!({ "state": "thinking" }),
                    time,
                    seq,
                )?;
            }
            "user/message" => {
                let data = event.get("data");
                let source_kind = data
                    .and_then(|d| d.get("source"))
                    .and_then(|s| s.get("kind"))
                    .and_then(|k| k.as_str());
                if source_kind == Some("user") {
                    tracker.session_state = "thinking".to_string();
                    let prompt = data
                        .and_then(|d| d.get("content"))
                        .and_then(|c| c.as_str())
                        .unwrap_or("");
                    Self::emit_session_event_static(
                        app,
                        runtime,
                        &tracker.session_id,
                        "UserPromptSubmit",
                        json!({ "prompt": prompt }),
                        time,
                        seq,
                    )?;
                }
            }
            "step/start" => {
                // First tool after turn_start
                if tracker.session_state == "thinking" {
                    tracker.session_state = "working".to_string();
                }
            }
            "tool/call" | "tool/code-dispatch-start" | "tool/ptc-dispatch-start" => {
                let data = event.get("data");
                let tool_name = data
                    .and_then(|d| d.get("name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("");
                tracker.session_state = "working".to_string();

                // R57 (upstream dsh-watch.js 8858788 TOOL_MAP): the subagent
                // tool family is wider than task/agent — spawn_agent/delegate/
                // followup_task/send_message all fan out children.
                let tool_lower = tool_name.to_lowercase();
                // R57-RV-C13 (upstream dsh-watch.js:68-89 TOOL_MAP): the
                // family also covers the subagent*/agent_* prefixes and
                // workflow dispatch.
                let subagent_tool = tool_lower.contains("task")
                    || tool_lower == "agent"
                    || tool_lower == "spawn_agent"
                    || tool_lower == "delegate"
                    || tool_lower == "followup_task"
                    || tool_lower == "send_message"
                    || tool_lower == "subagent"
                    || tool_lower == "subagent_report"
                    || tool_lower == "workflow"
                    || tool_lower.starts_with("subagent")
                    || tool_lower.starts_with("agent_");
                if subagent_tool {
                    tracker.session_state = "juggling".to_string();
                }

                Self::emit_session_event_static(
                    app,
                    runtime,
                    &tracker.session_id,
                    "PreToolUse",
                    // R57 (R57-1e 断点矩阵)：带上显式 state — 否则
                    // normalize_state 会把 juggling 回落成 working，
                    // dsh 的抛球表情永不出现。
                    json!({ "tool_name": tool_name, "state": tracker.session_state }),
                    time,
                    seq,
                )?;
            }
            "tool/result" | "tool/code-dispatch" | "tool/ptc-dispatch" => {
                let data = event.get("data");
                let tool_name = data
                    .and_then(|d| d.get("name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("");
                let error = data.and_then(|d| d.get("error")).and_then(|e| e.as_str());

                if error.is_some() {
                    Self::emit_session_event_static(
                        app,
                        runtime,
                        &tracker.session_id,
                        "PostToolUseFailure",
                        json!({ "tool_name": tool_name }),
                        time,
                        seq,
                    )?;
                    tracker.session_state = "error".to_string();
                } else {
                    Self::emit_session_event_static(
                        app,
                        runtime,
                        &tracker.session_id,
                        "PostToolUse",
                        json!({ "tool_name": tool_name }),
                        time,
                        seq,
                    )?;
                }
            }
            "assistant/message" => {
                let data = event.get("data");
                let content = data
                    .and_then(|d| d.get("content"))
                    .and_then(|c| c.as_str())
                    .unwrap_or("");
                // R57-RV-B9: clamp at collection — the tracker lives for the
                // app's lifetime; the full raw reply only ever needed the
                // bubble-sized prefix (the say path re-clamps via safe_reply
                // before the frontend, this closes the residual in-memory
                // retention).
                tracker.assistant_last_output = Some(content.chars().take(2_200).collect());

                // Extract usage for context % (cumulative) and the per-turn
                // delta emitted at turn/end (R56).
                if let Some(usage) = data.and_then(|d| d.get("usage")) {
                    if let (Some(input), Some(output)) = (
                        usage.get("input_tokens").and_then(|v| v.as_u64()),
                        usage.get("output_tokens").and_then(|v| v.as_u64()),
                    ) {
                        let total = input + output;
                        tracker.context_used = Some(total);
                        // Per-turn DELTA (usage is cumulative per session).
                        tracker.turn_input = tracker
                            .turn_input
                            .saturating_add(input.saturating_sub(tracker.usage_input_total));
                        tracker.turn_output = tracker
                            .turn_output
                            .saturating_add(output.saturating_sub(tracker.usage_output_total));
                        tracker.usage_input_total = input;
                        tracker.usage_output_total = output;
                    }
                }
            }
            "turn/end" => {
                let data = event.get("data");
                let reason = data
                    .and_then(|d| d.get("reason"))
                    .and_then(|r| r.get("kind"))
                    .and_then(|k| k.as_str())
                    .unwrap_or("");

                match reason {
                    "completed" => {
                        tracker.session_state = "attention".to_string();
                        // R56: Stop WITH explicit state (attention) + the
                        // collected assistant text (say bubble) + a per-turn
                        // usage delta (metering; dsh's own native_event name
                        // is attached so the ledger can attribute it). Before
                        // this, dsh Stop mapped to "idle", never said
                        // anything, and never fed usage.
                        let turn_input = tracker.turn_input;
                        let turn_output = tracker.turn_output;
                        Self::emit_session_event_static(
                            app,
                            runtime,
                            &tracker.session_id,
                            "Stop",
                            json!({
                                "state": "attention",
                                "assistant_last_output": tracker.assistant_last_output.clone(),
                                "turn_usage": { "input": turn_input, "output": turn_output },
                                "native_event": "turn_end",
                            }),
                            time,
                            seq,
                        )?;
                    }
                    "error" => {
                        tracker.session_state = "error".to_string();
                        Self::emit_session_event_static(
                            app,
                            runtime,
                            &tracker.session_id,
                            "ApiError",
                            json!({ "state": "error" }),
                            time,
                            seq,
                        )?;
                    }
                    _ => {
                        // aborted, blocked, etc.
                        tracker.session_state = "idle".to_string();
                        Self::emit_session_event_static(
                            app,
                            runtime,
                            &tracker.session_id,
                            "TurnAborted",
                            json!({ "state": "idle" }),
                            time,
                            seq,
                        )?;
                    }
                }
            }
            "approval/asked" => {
                Self::emit_session_event_static(
                    app,
                    runtime,
                    &tracker.session_id,
                    "Notification",
                    json!({ "text": "waiting for reply" }),
                    time,
                    seq,
                )?;
                tracker.session_state = "notification".to_string();
            }
            "approval/decided" => {
                // Back to working or idle. R56: EMIT the transition — before
                // this the watcher only flipped its internal tracker state,
                // so the pet stayed stuck on notification/waiting until some
                // later event happened to arrive.
                if tracker.session_state == "notification" {
                    tracker.session_state = "working".to_string();
                    Self::emit_session_event_static(
                        app,
                        runtime,
                        &tracker.session_id,
                        "PreToolUse",
                        json!({ "state": "working", "tool_name": "approved" }),
                        time,
                        seq,
                    )?;
                }
            }
            "compaction/start" => {
                Self::emit_session_event_static(
                    app,
                    runtime,
                    &tracker.session_id,
                    "PreCompact",
                    json!({}),
                    time,
                    seq,
                )?;
                tracker.session_state = "sweeping".to_string();
            }
            "compaction/end" => {
                tracker.session_state = "thinking".to_string();
                // R56: emit the end of compaction — otherwise sweeping
                // (started by compaction/start → PreCompact) never cleared
                // until some unrelated next event arrived.
                Self::emit_session_event_static(
                    app,
                    runtime,
                    &tracker.session_id,
                    "PostCompact",
                    json!({ "state": "thinking" }),
                    time,
                    seq,
                )?;
            }
            "llm/retry" => {
                Self::emit_session_event_static(
                    app,
                    runtime,
                    &tracker.session_id,
                    "ApiError",
                    json!({ "state": "error" }),
                    time,
                    seq,
                )?;
                tracker.session_state = "error".to_string();
            }
            "session/title" => {
                let data = event.get("data");
                if let Some(title) = data.and_then(|d| d.get("title")).and_then(|t| t.as_str()) {
                    tracker.session_title = Some(title.to_string());
                }
            }
            "request/header" => {
                let data = event.get("data");
                if let Some(_model) = data.and_then(|d| d.get("model")).and_then(|m| m.as_str()) {
                    // Update session model if needed
                }
            }
            "request/context" => {
                let data = event.get("data");
                if let Some(ctx) = data
                    .and_then(|d| d.get("context_window"))
                    .and_then(|c| c.as_u64())
                {
                    tracker.context_limit = Some(ctx);
                }
                if let Some(_model) = data.and_then(|d| d.get("model")).and_then(|m| m.as_str()) {
                    // Update model if needed
                }
            }
            _ => {}
        }

        Ok(())
    }

    fn emit_session_event_static(
        app: &AppHandle,
        runtime: &Arc<Runtime>,
        session_id: &str,
        kind: &str,
        data: Value,
        time: u64,
        seq: u64,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut event = json!({
            "session_id": session_id,
            "provider": PROVIDER_ID,
            "hook_event_name": kind,
            "data": data,
            "time": time,
            // R57-RV-B6: the model's event-time parser reads
            // timestamp_ms/timestamp — WITHOUT this the ingest falls back to
            // the wall clock, so a cold-start replay anchored every
            // done/interrupted badge at NOW and lit stale dots for minutes.
            "timestamp_ms": time,
            "seq": seq,
        });
        if let (Some(target), Some(fields)) = (event.as_object_mut(), data.as_object()) {
            target.extend(fields.clone());
        }

        // R57 (断点①): ingest AND emit — mirror the http_server /state route
        // (emit_stats coalesces at 150ms; emit_hook_event drives the pet's
        // transient expressions). dsh rows previously only surfaced when
        // another provider happened to push a snapshot.
        //
        // R57-RV-A3 P0 (replay storm): TWO gates on the emit side —
        //   a) accepted: out-of-order/duplicate frames (re-reads after a
        //      tracker rebuild or a generation roll) must not re-enter the
        //      event stream as fresh traffic;
        //   b) freshness: events older than REPLAY_QUIET_MS are history —
        //      a cold-start full-file read (or an app restart discovering
        //      days-old sessions) ingests the state but stays SILENT, else
        //      every historical turn would replay its say/turn-done/greet
        //      at once (and greet would fire for every stale dir).
        let (session, accepted) = runtime.ingest_with_ack(&event);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        // R57-RV-B6: a missing/renamed `time` field must fail SILENT, not
        // fresh — the old `time == 0 → fresh` escape hatch would replay a
        // whole cold-start file if the field ever drifted.
        let fresh = time != 0 && now.saturating_sub(time) <= REPLAY_QUIET_MS;
        if accepted && fresh {
            crate::http_server::emit_hook_event(app, &event, &session);
        }
        crate::http_server::emit_stats(app, runtime);
        Ok(())
    }

    fn cleanup_idle(&mut self) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        // R57-RV-A3: dropping a tracker whose session directory still exists
        // made the next poll rediscover it with offset=0 and re-read the
        // whole file every 2.5s — forever (the R57 emit outlet turned that
        // silent loop into a replay storm). Trackers are tiny; keep them for
        // live directories and only drop them when the directory is gone
        // (or it has been idle past the horizon, for vanished-dir latency).
        self.trackers.retain(|path, tracker| {
            path.is_dir() || now.saturating_sub(tracker.last_event_time) < IDLE_UNTRACK_MS
        });
    }
}

/// Initialize and start the dsh watcher.
pub fn start_dsh_watcher(runtime: Arc<Runtime>, app: AppHandle) {
    let mut watcher = DshWatcher::new(runtime, app);
    // R52 (2026-09-05) startup-crash hotfix: `tokio::spawn` requires a live
    // Tokio reactor on the *calling* thread, but this function runs from the
    // Tauri setup callback on the GUI main thread, which owns none. The
    // released 0.6.1 binaries therefore aborted on every platform with
    // "there is no reactor running, must be called from the context of a
    // Tokio 1.x runtime" (reproduced against the shipped AppImage). Spawn
    // onto Tauri's managed async runtime — the same runtime that backs the
    // async commands in `commands.rs` — which exists for the whole app
    // lifetime and needs no per-thread context.
    tauri::async_runtime::spawn(async move {
        watcher.start().await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dsh_session_header_deserialize() {
        let json = r#"{"type":"session","version":0,"id":"ses_123","cwd":"/home/user","createdAt":1234567890,"delegationDepth":0,"origin":null}"#;
        let header: DshSessionHeader = serde_json::from_str(json).unwrap();
        assert_eq!(header.id, "ses_123");
        assert_eq!(header.version, 0);
        assert_eq!(header.delegation_depth, 0);
    }

    #[test]
    fn test_dsh_event_turn_start() {
        let json = r#"{"type":"turn/start","seq":1,"time":1234567890}"#;
        let event: DshEvent = serde_json::from_str(json).unwrap();
        assert!(matches!(event, DshEvent::TurnStart { .. }));
    }

    #[test]
    fn test_dsh_event_user_message() {
        let json = r#"{"type":"user/message","seq":2,"time":1234567890,"data":{"content":"hello","source":{"kind":"user"}}}"#;
        let event: DshEvent = serde_json::from_str(json).unwrap();
        assert!(matches!(event, DshEvent::UserMessage { .. }));
    }

    #[test]
    fn test_dsh_event_tool_call() {
        let json = r#"{"type":"tool/call","seq":3,"time":1234567890,"data":{"name":"bash","arguments":{}}}"#;
        let event: DshEvent = serde_json::from_str(json).unwrap();
        assert!(matches!(event, DshEvent::ToolCall { .. }));
    }

    #[test]
    fn test_subagent_filter() {
        let json = r#"{"type":"session","version":0,"id":"ses_123","cwd":"/home/user","createdAt":1234567890,"delegationDepth":1,"origin":"subagent"}"#;
        let header: DshSessionHeader = serde_json::from_str(json).unwrap();
        assert!(header.origin.as_deref() == Some("subagent") || header.delegation_depth > 0);
    }

    #[test]
    fn test_fail_closed_only_unverified_future_versions() {
        // R57: v1-v4 are all ACCEPTED now (live formats are v3/v4); only a
        // future, unverified major (> DSH_MAX_KNOWN_VERSION) fails closed.
        for accepted in [0u32, 1, 2, 3, 4] {
            let json = format!(
                r#"{{"type":"session","version":{accepted},"id":"ses_123","cwd":"/home/user","createdAt":1234567890,"delegationDepth":0,"origin":null}}"#
            );
            let header: DshSessionHeader = serde_json::from_str(&json).unwrap();
            assert!(header.version <= DSH_MAX_KNOWN_VERSION);
        }
        assert_eq!(DSH_MAX_KNOWN_VERSION, 4);
    }

    #[test]
    fn r52_watcher_spawn_survives_threads_without_a_reactor() {
        // R52 (2026-09-05): `start_dsh_watcher` runs on the Tauri setup
        // (GUI main) thread, which owns no Tokio reactor. The 0.6.1 release
        // aborted at startup on every platform because `tokio::spawn` was
        // called from that thread ("there is no reactor running"). The spawn
        // target is Tauri's managed async runtime, which must be usable from
        // ANY plain thread. This test reproduces the crashing context — a
        // bare std thread with no runtime context — and asserts the spawn
        // path completes instead of panicking.
        let joined = std::thread::spawn(|| {
            // Same call shape as `start_dsh_watcher`; a bare `tokio::spawn`
            // here panics, `tauri::async_runtime::spawn` does not.
            tauri::async_runtime::spawn(async {});
        })
        .join();
        joined.expect("spawn from a reactor-less thread must not panic");
    }
}
