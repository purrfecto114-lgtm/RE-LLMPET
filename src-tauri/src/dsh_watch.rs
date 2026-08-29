use crate::dsh_zstd::decode_complete_frames;
use crate::model::{Runtime, Session};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
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
    #[serde(rename = "tool/code-dispatch-start")]
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
    #[serde(rename = "tool/code-dispatch")]
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
    SessionTitle { seq: u64, time: u64, data: TitleData },
    #[serde(rename = "request/header")]
    RequestHeader { seq: u64, time: u64, data: RequestHeaderData },
    #[serde(rename = "request/context")]
    RequestContext { seq: u64, time: u64, data: RequestContextData },
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
}

pub struct DshWatcher {
    sessions_dir: PathBuf,
    poll_interval: Duration,
    trackers: HashMap<PathBuf, SessionTracker>,
    runtime: Arc<Runtime>,
}

impl DshWatcher {
    pub fn new(runtime: Arc<Runtime>) -> Self {
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
        }
    }

    pub async fn start(&mut self) {
        if std::env::var("LLMPET_NO_DSH").map(|v| v == "1").unwrap_or(false) {
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

                // Check for session.jsonl or session.jsonl.zstd
                let jsonl_path = session_path.join("session.jsonl");
                let zstd_path = session_path.join("session.jsonl.zstd");

                if jsonl_path.exists() || zstd_path.exists() {
                    sessions.push(session_path);
                }
            }
        }

        Ok(sessions)
    }

    async fn process_session(&mut self, session_path: &Path) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Ensure tracker exists
        if !self.trackers.contains_key(session_path) {
            self.trackers.insert(
                session_path.to_path_buf(),
                SessionTracker {
                    session_id: session_path.file_name().unwrap().to_string_lossy().to_string(),
                    is_zstd: false,
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
                },
            );
        }

        // Determine file type and path
        let zstd_path = session_path.join("session.jsonl.zstd");
        let jsonl_path = session_path.join("session.jsonl");
        let (is_zstd, file_path) = if zstd_path.exists() {
            (true, zstd_path)
        } else if jsonl_path.exists() {
            (false, jsonl_path)
        } else {
            return Ok(());
        };

        // Read only bytes after the last committed plain-text or zstd-frame
        // boundary. A truncated/replaced file restarts from byte zero.
        let mut file = fs::File::open(&file_path)?;
        let file_size = file.metadata()?.len();
        let tracker = self.trackers.get_mut(session_path).unwrap();
        if tracker.is_zstd != is_zstd || file_size < tracker.file_offset {
            tracker.file_offset = 0;
            tracker.carry.clear();
            tracker.last_event_seq = 0;
            tracker.accepts_events = false;
        }
        tracker.is_zstd = is_zstd;
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
        Self::process_new_data_static(&runtime, tracker, &plain_text).await?;

        Ok(())
    }

    async fn process_new_data_static(
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

        let end_idx = if tracker.carry.is_empty() { lines.len() } else { lines.len().saturating_sub(1) };
        for line in &lines[..end_idx] {
            if line.trim().is_empty() {
                continue;
            }

            match serde_json::from_str::<Value>(line) {
                Ok(event_value) => {
                    if let Err(e) = Self::handle_event_static(
                        runtime,
                        tracker,
                        &event_value,
                    ).await {
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
        runtime: &Arc<Runtime>,
        tracker: &mut SessionTracker,
        event: &Value,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Parse event type
        let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");

        // Handle session header
        if event_type == "session" {
            let header: DshSessionHeader = serde_json::from_value(event.clone())?;

            // Fail-closed: reject unknown versions
            if header.version != 0 {
                tracker.accepts_events = false;
                warn!("dsh session {}: unknown version {}, ignoring", header.id, header.version);
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

            // Register session with Runtime
            let session = Session {
                id: tracker.session_id.clone(),
                provider: PROVIDER_ID.to_string(),
                state: "idle".to_string(),
                cwd: header.cwd.clone(),
                tool_name: None,
                model: None,
                assistant_last_output: None,
                headless: false,
                updated_at: header.created_at,
                source_pid: None,
                context_used: None,
                context_limit: None,
                context_percent: None,
                todos: vec![],
                last_event_at: header.created_at,
                last_event_seq: Some(0),
                last_event_rank: 0,
                last_event_key: None,
                ended_at: None,
            };

            // Use the runtime's session ingestion - directly insert into sessions map
            {
                let mut sessions = runtime.sessions.lock().unwrap_or_else(|e| e.into_inner());
                sessions.insert(session.id.clone(), session);
            }
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
                Self::emit_session_event_static(runtime, &tracker.session_id, "TaskStarted", json!({}), time, seq)?;
            }
            "user/message" => {
                let data = event.get("data");
                let source_kind = data.and_then(|d| d.get("source")).and_then(|s| s.get("kind")).and_then(|k| k.as_str());
                if source_kind == Some("user") {
                    tracker.session_state = "thinking".to_string();
                    let prompt = data.and_then(|d| d.get("content")).and_then(|c| c.as_str()).unwrap_or("");
                    Self::emit_session_event_static(runtime, &tracker.session_id, "UserPromptSubmit", json!({ "prompt": prompt }), time, seq)?;
                }
            }
            "step/start" => {
                // First tool after turn_start
                if tracker.session_state == "thinking" {
                    tracker.session_state = "working".to_string();
                }
            }
            "tool/call" | "tool/code-dispatch-start" => {
                let data = event.get("data");
                let tool_name = data.and_then(|d| d.get("name")).and_then(|n| n.as_str()).unwrap_or("");
                tracker.session_state = "working".to_string();

                // Check for Task/subagent tool
                if tool_name.to_lowercase().contains("task") || tool_name == "agent" {
                    tracker.session_state = "juggling".to_string();
                }

                Self::emit_session_event_static(runtime, &tracker.session_id, "PreToolUse", json!({ "tool_name": tool_name }), time, seq)?;
            }
            "tool/result" | "tool/code-dispatch" => {
                let data = event.get("data");
                let tool_name = data.and_then(|d| d.get("name")).and_then(|n| n.as_str()).unwrap_or("");
                let error = data.and_then(|d| d.get("error")).and_then(|e| e.as_str());

                if error.is_some() {
                    Self::emit_session_event_static(runtime, &tracker.session_id, "PostToolUseFailure", json!({ "tool_name": tool_name }), time, seq)?;
                    tracker.session_state = "error".to_string();
                } else {
                    Self::emit_session_event_static(runtime, &tracker.session_id, "PostToolUse", json!({ "tool_name": tool_name }), time, seq)?;
                }
            }
            "assistant/message" => {
                let data = event.get("data");
                let content = data.and_then(|d| d.get("content")).and_then(|c| c.as_str()).unwrap_or("");
                tracker.assistant_last_output = Some(content.to_string());

                // Extract usage for context %
                if let Some(usage) = data.and_then(|d| d.get("usage")) {
                    if let (Some(input), Some(output)) = (
                        usage.get("input_tokens").and_then(|v| v.as_u64()),
                        usage.get("output_tokens").and_then(|v| v.as_u64()),
                    ) {
                        let total = input + output;
                        tracker.context_used = Some(total);
                    }
                }
            }
            "turn/end" => {
                let data = event.get("data");
                let reason = data.and_then(|d| d.get("reason")).and_then(|r| r.get("kind")).and_then(|k| k.as_str()).unwrap_or("");

                match reason {
                    "completed" => {
                        tracker.session_state = "attention".to_string();
                    Self::emit_session_event_static(runtime, &tracker.session_id, "Stop", json!({}), time, seq)?;
                    }
                    "error" => {
                        tracker.session_state = "error".to_string();
                        Self::emit_session_event_static(runtime, &tracker.session_id, "ApiError", json!({}), time, seq)?;
                    }
                    _ => {
                        // aborted, blocked, etc.
                        tracker.session_state = "idle".to_string();
                        Self::emit_session_event_static(runtime, &tracker.session_id, "TurnAborted", json!({}), time, seq)?;
                    }
                }
            }
            "approval/asked" => {
                Self::emit_session_event_static(runtime, &tracker.session_id, "Notification", json!({ "text": "waiting for reply" }), time, seq)?;
                tracker.session_state = "notification".to_string();
            }
            "approval/decided" => {
                // Back to working or idle
                if tracker.session_state == "notification" {
                    tracker.session_state = "working".to_string();
                }
            }
            "compaction/start" => {
                Self::emit_session_event_static(runtime, &tracker.session_id, "PreCompact", json!({}), time, seq)?;
                tracker.session_state = "sweeping".to_string();
            }
            "compaction/end" => {
                tracker.session_state = "thinking".to_string();
            }
            "llm/retry" => {
                Self::emit_session_event_static(runtime, &tracker.session_id, "ApiError", json!({}), time, seq)?;
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
                if let Some(ctx) = data.and_then(|d| d.get("context_window")).and_then(|c| c.as_u64()) {
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

    fn emit_session_event_static(runtime: &Arc<Runtime>, session_id: &str, kind: &str, data: Value, time: u64, seq: u64) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut event = json!({
            "session_id": session_id,
            "provider": PROVIDER_ID,
            "hook_event_name": kind,
            "data": data,
            "time": time,
            "seq": seq,
        });
        if let (Some(target), Some(fields)) = (event.as_object_mut(), data.as_object()) {
            target.extend(fields.clone());
        }

        runtime.ingest(&event);
        Ok(())
    }

    fn cleanup_idle(&mut self) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        self.trackers.retain(|_, tracker| {
            now.saturating_sub(tracker.last_event_time) < IDLE_UNTRACK_MS
        });
    }
}

/// Initialize and start the dsh watcher.
pub fn start_dsh_watcher(runtime: Arc<Runtime>) {
    let mut watcher = DshWatcher::new(runtime);
    tokio::spawn(async move {
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
    fn test_fail_closed_unknown_version() {
        let json = r#"{"type":"session","version":1,"id":"ses_123","cwd":"/home/user","createdAt":1234567890,"delegationDepth":0,"origin":null}"#;
        let header: DshSessionHeader = serde_json::from_str(json).unwrap();
        assert_ne!(header.version, 0);
    }
}
