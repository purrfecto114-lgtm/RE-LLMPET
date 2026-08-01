use crate::model::{
    now_ms, permission_signature, PendingPermission, PermissionDecision, Runtime, Session,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const SERVER_ID: &str = "octopus";
const SERVER_HEADER: &str = "x-octopus-server";
const TOKEN_HEADER: &str = "x-octopus-token";
const BASE_PORT: u16 = 41330;
const PORT_COUNT: u16 = 5;
const MAX_HEADER_BYTES: usize = 32 * 1024;
const MAX_STATE_BYTES: usize = 16 * 1024;
const MAX_PERMISSION_BYTES: usize = 1024 * 1024;
const PERMISSION_WAIT: Duration = Duration::from_secs(8 * 60);
const MAX_CLIENT_THREADS: usize = 32;

#[derive(Debug)]
struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct ServerInfo {
    pub port: u16,
    pub token: String,
}

struct ActiveClient(Arc<AtomicUsize>);

impl Drop for ActiveClient {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

pub fn start(runtime: Arc<Runtime>, app: AppHandle) -> Result<ServerInfo, String> {
    let (listener, port) = bind_first_free()?;
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    write_runtime_file(&runtime, port, &token)?;
    runtime.write_log("server", &format!("listening on 127.0.0.1:{port}"));

    let thread_token = token.clone();
    let active_clients = Arc::new(AtomicUsize::new(0));
    thread::Builder::new()
        .name("octopus-http".into())
        .spawn(move || {
            for incoming in listener.incoming() {
                match incoming {
                    Ok(mut stream) => {
                        if active_clients.fetch_add(1, Ordering::AcqRel) >= MAX_CLIENT_THREADS {
                            active_clients.fetch_sub(1, Ordering::AcqRel);
                            let _ = respond(&mut stream, 503, "text/plain", b"server busy");
                            continue;
                        }
                        let runtime = runtime.clone();
                        let runtime_for_error = runtime.clone();
                        let app = app.clone();
                        let token = thread_token.clone();
                        let guard = ActiveClient(active_clients.clone());
                        let spawn = thread::Builder::new()
                            .name("octopus-http-client".into())
                            .spawn(move || {
                                let _guard = guard;
                                handle_client(stream, runtime, app, &token, port);
                            });
                        if let Err(error) = spawn {
                            // `guard` is dropped with the failed closure, so the
                            // active-client counter is decremented exactly once.
                            runtime_for_error
                                .write_log("server", &format!("client thread failed: {error}"));
                        }
                    }
                    Err(err) => runtime.write_log("server", &format!("accept failed: {err}")),
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(ServerInfo { port, token })
}

fn bind_first_free() -> Result<(TcpListener, u16), String> {
    let mut last = None;
    for port in BASE_PORT..BASE_PORT + PORT_COUNT {
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => return Ok((listener, port)),
            Err(err) => last = Some(err),
        }
    }
    Err(format!(
        "ports {}-{} unavailable: {}",
        BASE_PORT,
        BASE_PORT + PORT_COUNT - 1,
        last.map(|e| e.to_string())
            .unwrap_or_else(|| "unknown".into())
    ))
}

fn write_runtime_file(runtime: &Runtime, port: u16, token: &str) -> Result<(), String> {
    let body = serde_json::to_vec(&json!({
        "app":SERVER_ID,
        "port":port,
        "token":token,
        "pid":std::process::id()
    }))
    .map_err(|e| e.to_string())?;
    let tmp = runtime
        .runtime_path
        .with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        return fs::rename(tmp, &runtime.runtime_path).map_err(|e| e.to_string());
    }
    #[cfg(windows)]
    {
        let backup = runtime
            .runtime_path
            .with_extension(format!("octopus-backup.{}", std::process::id()));
        let had_original = runtime.runtime_path.exists();
        if had_original {
            let _ = fs::remove_file(&backup);
            fs::rename(&runtime.runtime_path, &backup).map_err(|e| e.to_string())?;
        }
        match fs::rename(&tmp, &runtime.runtime_path) {
            Ok(()) => {
                let _ = fs::remove_file(&backup);
                Ok(())
            }
            Err(error) => {
                let _ = fs::remove_file(&tmp);
                if had_original {
                    let _ = fs::rename(&backup, &runtime.runtime_path);
                }
                Err(error.to_string())
            }
        }
    }
}

fn handle_client(
    mut stream: TcpStream,
    runtime: Arc<Runtime>,
    app: AppHandle,
    token: &str,
    port: u16,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let peer_ok = stream
        .peer_addr()
        .map(|addr| addr.ip().is_loopback())
        .unwrap_or(false);
    if !peer_ok {
        let _ = respond(&mut stream, 403, "text/plain", b"forbidden");
        return;
    }
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err((status, message)) => {
            let _ = respond(&mut stream, status, "text/plain", message.as_bytes());
            return;
        }
    };
    if !host_allowed(request.headers.get("host"))
        || request.headers.contains_key("origin")
        || request.headers.contains_key("referer")
    {
        let _ = respond(&mut stream, 403, "text/plain", b"forbidden");
        return;
    }

    if request.method == "GET" && request.path == "/state" {
        let body =
            serde_json::to_vec(&json!({"ok":true,"app":SERVER_ID,"port":port})).unwrap_or_default();
        let _ = respond(&mut stream, 200, "application/json", &body);
        return;
    }

    if request.method == "GET" && request.path == "/debug" {
        if !client_identity_allowed(&request) || !authorized(&request, token) {
            let _ = respond(&mut stream, 401, "text/plain", b"unauthorized");
            return;
        }
        let body = serde_json::to_vec_pretty(&runtime.stats()).unwrap_or_default();
        let _ = respond(&mut stream, 200, "application/json", &body);
        return;
    }

    if request.method != "POST" {
        let _ = respond(&mut stream, 404, "text/plain", b"not found");
        return;
    }
    if !client_identity_allowed(&request) || !authorized(&request, token) {
        let _ = respond(&mut stream, 401, "text/plain", b"unauthorized");
        return;
    }
    if !request
        .headers
        .get("content-type")
        .map(|v| v.to_ascii_lowercase().starts_with("application/json"))
        .unwrap_or(false)
    {
        let _ = respond(&mut stream, 415, "text/plain", b"application/json required");
        return;
    }
    let body: Value = match serde_json::from_slice(&request.body) {
        Ok(body) => body,
        Err(_) => {
            let _ = respond(&mut stream, 400, "text/plain", b"invalid json");
            return;
        }
    };

    match request.path.as_str() {
        "/state" => {
            let session = runtime.ingest(&body);
            emit_stats(&app, &runtime);
            emit_hook_event(&app, &body, &session);
            let _ = respond(&mut stream, 200, "application/json", br#"{"ok":true}"#);
        }
        "/permission" => handle_permission(stream, runtime, app, body, false),
        "/codewhale-permission" => handle_permission(stream, runtime, app, body, true),
        _ => {
            let _ = respond(&mut stream, 404, "text/plain", b"not found");
        }
    }
}

fn handle_permission(
    mut stream: TcpStream,
    runtime: Arc<Runtime>,
    app: AppHandle,
    body: Value,
    codewhale: bool,
) {
    let provider = if codewhale {
        "codewhale".to_string()
    } else {
        text_field(&body, &["provider"], 32).unwrap_or_else(|| "claude".into())
    };
    let session_id = text_field(&body, &["session_id", "sessionId", "conversation_id"], 256)
        .unwrap_or_else(|| "default".into());
    let tool_name = text_field(&body, &["tool_name", "toolName", "tool"], 256)
        .unwrap_or_else(|| "Unknown".into());
    let tool_input = body
        .get("tool_input")
        .or_else(|| body.get("toolInput"))
        .cloned()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let permission_suggestions = body
        .get("permission_suggestions")
        .or_else(|| body.get("permissionSuggestions"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| item.is_object())
                .take(16)
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if let Some(decision) = automatic_decision(&tool_name, &tool_input) {
        let payload = permission_payload(
            &provider,
            &PermissionDecision {
                behavior: decision.into(),
                message: None,
                updated_input: None,
                updated_permissions: Vec::new(),
            },
        );
        let body = serde_json::to_vec(&payload).unwrap_or_default();
        let _ = respond(&mut stream, 200, "application/json", &body);
        return;
    }
    if codewhale && runtime.matching_batch_rule(&session_id, &tool_name) {
        let payload = permission_payload(
            "codewhale",
            &PermissionDecision {
                behavior: "allow".into(),
                message: None,
                updated_input: None,
                updated_permissions: Vec::new(),
            },
        );
        let body = serde_json::to_vec(&payload).unwrap_or_default();
        let _ = respond(&mut stream, 200, "application/json", &body);
        return;
    }

    let signature = permission_signature(&provider, &session_id, &tool_name, &tool_input);
    let candidate = PendingPermission {
        id: Uuid::new_v4().simple().to_string(),
        signature,
        session_id: session_id.clone(),
        provider: provider.clone(),
        tool_name: tool_name.clone(),
        tool_input,
        permission_suggestions,
        created_at: now_ms(),
        response: Arc::new((Mutex::new(None), Condvar::new())),
    };
    let (registered, duplicate_retry) = runtime.register_permission(candidate);
    let id = registered.id.clone();
    let response = registered.response.clone();
    if !duplicate_retry {
        emit_stats(&app, &runtime);
        let _ = app.emit(
            "pet:event",
            json!({
                "kind":"waiting",
                "sessionId":session_id,
                "permId":id,
                "provider":if provider == "claude" { Value::Null } else { Value::String(provider.clone()) }
            }),
        );
    }

    let (lock, cv) = &*response;
    let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let (guard, timeout) = cv
        .wait_timeout_while(guard, PERMISSION_WAIT, |decision| decision.is_none())
        .unwrap_or_else(|e| e.into_inner());
    let decision = guard.clone();
    drop(guard);
    let decision = decision.unwrap_or_else(|| {
        let message = if timeout.timed_out() {
            "Octopus permission request timed out"
        } else {
            "Octopus permission request closed"
        };
        let fallback = PermissionDecision {
            behavior: "deny".into(),
            message: Some(message.into()),
            updated_input: None,
            updated_permissions: Vec::new(),
        };
        let _ = runtime.resolve_timeout(&id, message.into());
        fallback
    });
    emit_stats(&app, &runtime);

    let payload = permission_payload(&provider, &decision);
    let body = serde_json::to_vec(&payload).unwrap_or_default();
    let _ = respond(&mut stream, 200, "application/json", &body);
}

fn automatic_decision(tool: &str, input: &Value) -> Option<&'static str> {
    // Only operations that are unambiguously read-only are auto-approved.
    const PASS: &[&str] = &[
        "TaskGet",
        "TaskList",
        "TaskOutput",
        "Read",
        "Glob",
        "Grep",
        "LS",
        "WebSearch",
        "NotebookRead",
    ];
    if PASS.contains(&tool) {
        return Some("allow");
    }
    if tool == "WebFetch" {
        let url = input
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if url.is_empty() {
            return None;
        }
        if !url.to_ascii_lowercase().starts_with("https://") {
            return Some("deny");
        }
        // HTTPS alone is not proof that the destination is public or safe.
        // Delegate it to the user/provider permission flow instead of silently
        // allowing loopback, private-network, metadata or DNS-rebound targets.
        return None;
    }
    None
}

fn permission_payload(provider: &str, decision: &PermissionDecision) -> Value {
    let safe = if decision.behavior == "deny" {
        "deny"
    } else {
        "allow"
    };
    match provider {
        "codewhale" => {
            let mut obj = json!({"decision":safe});
            if let (Some(map), Some(message)) = (obj.as_object_mut(), decision.message.as_deref()) {
                map.insert("reason".into(), json!(message));
            }
            obj
        }
        "claude" => {
            let mut native = json!({"behavior":safe});
            if let Some(map) = native.as_object_mut() {
                if safe == "deny" {
                    if let Some(message) = decision.message.as_deref() {
                        map.insert("message".into(), json!(message));
                    }
                }
                if safe == "allow" {
                    if let Some(updated_input) = decision.updated_input.clone() {
                        map.insert("updatedInput".into(), updated_input);
                    }
                    if !decision.updated_permissions.is_empty() {
                        map.insert(
                            "updatedPermissions".into(),
                            json!(decision.updated_permissions),
                        );
                    }
                }
            }
            json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":native}})
        }
        "codex" => {
            // Codex currently fails closed when PermissionRequest returns
            // updatedInput/updatedPermissions, so keep the envelope minimal.
            let mut native = json!({"behavior":safe});
            if safe == "deny" {
                if let (Some(map), Some(message)) =
                    (native.as_object_mut(), decision.message.as_deref())
                {
                    map.insert("message".into(), json!(message));
                }
            }
            json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":native}})
        }
        _ => {
            json!({"decision":"native","reason":"This provider keeps permission decisions in its native terminal UI"})
        }
    }
}

fn emit_stats(app: &AppHandle, runtime: &Arc<Runtime>) {
    // R40.1 (audit P0-4): consolidated StatsCoalescer. The 0.5.19
    // split-mutex design (last_stats_emit + stats_dirty + stats_scheduled
    // as separate Mutexes) had a race where dirty=true but no timer was
    // scheduled — the trailing timer cleared `scheduled` between the new
    // event's dirty-set and scheduled-check, so the new event saw
    // scheduled=true and didn't schedule a new timer. Result: dirty=true
    // permanently, final stats event lost.
    //
    // Fix: all three flags are now under a single `stats_coalescer`
    // Mutex<StatsCoalescerState>. The trailing timer's "read dirty, clear
    // dirty, clear scheduled, decide to emit" sequence is atomic. A new
    // event arriving during the trailing critical section must wait for
    // the lock; when it gets it, scheduled=false, so it correctly
    // schedules a new timer.
    const STATS_THROTTLE_MS: u128 = 150;
    let now = std::time::Instant::now();

    // Atomic check-and-set under the consolidated lock.
    let action = {
        let mut guard = runtime
            .stats_coalescer
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let within_window = guard
            .last_emit
            .map(|last| now.duration_since(last).as_millis() < STATS_THROTTLE_MS)
            .unwrap_or(false);
        if within_window {
            // Throttle: mark dirty. Schedule a trailing timer ONLY if one
            // isn't already pending. Both operations are atomic under
            // this lock — no race possible.
            guard.dirty = true;
            if !guard.scheduled {
                guard.scheduled = true;
                CoalescerAction::ScheduleTrailing
            } else {
                CoalescerAction::Skip
            }
        } else {
            // Leading emit: update last_emit now so concurrent events
            // see the throttle window as active.
            guard.last_emit = Some(now);
            CoalescerAction::EmitNow
        }
    };

    match action {
        CoalescerAction::EmitNow => {
            do_emit_stats(app, runtime);
        }
        CoalescerAction::ScheduleTrailing => {
            let app_clone = app.clone();
            let runtime_clone = runtime.clone();
            tauri::async_runtime::spawn_blocking(move || {
                std::thread::sleep(std::time::Duration::from_millis(STATS_THROTTLE_MS as u64));
                // Atomic: read dirty, clear dirty, clear scheduled, and
                // decide whether to emit + reschedule. All under one lock.
                let trailing_action = {
                    let mut guard = runtime_clone
                        .stats_coalescer
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    let was_dirty = guard.dirty;
                    guard.dirty = false;
                    guard.scheduled = false;
                    // If a new event arrived while we were sleeping (it set
                    // dirty=true but couldn't schedule because scheduled was
                    // true), we need to reschedule. But since we just
                    // cleared scheduled, the new event would have scheduled
                    // itself if it got the lock first. With the single
                    // mutex, either:
                    //   (a) we get the lock first → was_dirty=true, we emit,
                    //       and if dirty was set by a concurrent event that
                    //       hasn't acquired the lock yet, it will get the
                    //       lock after us, see scheduled=false, and schedule.
                    //   (b) concurrent event gets lock first → it sets
                    //       dirty=true, sees scheduled=true (we haven't
                    //       cleared it), doesn't schedule, releases lock.
                    //       We then get the lock, see was_dirty=true, emit,
                    //       clear scheduled. But dirty is now true (from
                    //       the concurrent event) and scheduled is false.
                    //       We need to reschedule!
                    // Case (b) is the key: after clearing scheduled, check
                    // if dirty is STILL true (set by a concurrent event
                    // that couldn't schedule). If so, reschedule.
                    if guard.dirty && !guard.scheduled {
                        guard.scheduled = true;
                        TrailingAction::EmitAndReschedule
                    } else if was_dirty {
                        TrailingAction::Emit
                    } else {
                        TrailingAction::Done
                    }
                };
                match trailing_action {
                    TrailingAction::Done => {}
                    TrailingAction::Emit => {
                        do_emit_stats(&app_clone, &runtime_clone);
                    }
                    TrailingAction::EmitAndReschedule => {
                        do_emit_stats(&app_clone, &runtime_clone);
                        // Recurse to schedule the next trailing timer.
                        // This is safe because we're in a spawn_blocking
                        // task; the next timer will fire after another
                        // STATS_THROTTLE_MS.
                        let app_clone2 = app_clone.clone();
                        let runtime_clone2 = runtime_clone.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            std::thread::sleep(std::time::Duration::from_millis(
                                STATS_THROTTLE_MS as u64,
                            ));
                            emit_stats(&app_clone2, &runtime_clone2);
                        });
                    }
                }
            });
        }
        CoalescerAction::Skip => {
            // Already scheduled; dirty was set. Nothing to do.
        }
    }
}

enum CoalescerAction {
    EmitNow,
    ScheduleTrailing,
    Skip,
}

enum TrailingAction {
    Done,
    Emit,
    EmitAndReschedule,
}

/// R38.1: Actual emit — generates stats, bumps revision, emits to both windows.
fn do_emit_stats(app: &AppHandle, runtime: &Arc<Runtime>) {
    // Update last_emit timestamp in BOTH the legacy field and the
    // consolidated coalescer state. R40.1: the consolidated state is
    // the source of truth; the legacy field is kept for smoke-test
    // compatibility.
    let now = std::time::Instant::now();
    {
        let mut guard = runtime
            .last_stats_emit
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        *guard = Some(now);
    }
    {
        let mut guard = runtime
            .stats_coalescer
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        guard.last_emit = Some(now);
    }
    // Bump revision.
    let revision = {
        let mut guard = runtime
            .stats_revision
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        *guard += 1;
        *guard
    };
    let stats = runtime.stats();
    // Attach revision so frontend can reject stale messages.
    let mut stats_with_rev = stats.clone();
    if let Some(obj) = stats_with_rev.as_object_mut() {
        obj.insert("__revision".into(), json!(revision));
    }
    let _ = app.emit("pet:stats", stats_with_rev.clone());
    let _ = app.emit("panel:stats", stats_with_rev);
}

fn emit_hook_event(app: &AppHandle, body: &Value, session: &Session) {
    let event = body
        .get("hook_event_name")
        .or_else(|| body.get("event"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let tool = body
        .get("tool_name")
        .or_else(|| body.get("toolName"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if event == "Stop" {
        if let Some(text) = session
            .assistant_last_output
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            let _ = app.emit(
                "pet:event",
                json!({"kind":"say","text":text,"sessionId":session.id.clone(),"provider":session.provider.clone()}),
            );
        }
        let _ = app.emit("pet:event", json!({"kind":"turn-done"}));
        return;
    }
    let payload = match event {
        "UserPromptSubmit" => json!({"kind":"user-turn"}),
        "PreToolUse" | "PostToolUse" => json!({
            "kind":"operation",
            "tool":tool,
            "icon":"🔧",
            "detail":if tool.is_empty() { "正在执行工具" } else { tool }
        }),
        "StopFailure" | "PostToolUseFailure" => json!({"kind":"error","text":"Agent 执行失败"}),
        "Notification" | "PermissionDenied" | "Elicitation" => json!({"kind":"needsinput"}),
        "TaskCreated" => {
            json!({"kind":"operation","tool":"Task","icon":"🤹","detail":"已创建并行任务"})
        }
        "TaskCompleted" => {
            json!({"kind":"operation","tool":"Task","icon":"✅","detail":"并行任务已完成"})
        }
        "TeammateIdle" => json!({"kind":"state","state":"loafing"}),
        _ => json!({"kind":"state","state":session.state.clone()}),
    };
    let _ = app.emit("pet:event", payload);
}

fn client_identity_allowed(request: &Request) -> bool {
    request
        .headers
        .get(SERVER_HEADER)
        .map(|value| value.eq_ignore_ascii_case(SERVER_ID))
        .unwrap_or(false)
}

fn authorized(request: &Request, token: &str) -> bool {
    // Tokens in URLs leak into config files, logs and process diagnostics.
    // Only the dedicated header is accepted.
    request
        .headers
        .get(TOKEN_HEADER)
        .map(|candidate| constant_time_eq(candidate.as_bytes(), token.as_bytes()))
        .unwrap_or(false)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (left, right) in a.iter().zip(b) {
        diff |= left ^ right;
    }
    diff == 0
}

fn host_allowed(value: Option<&String>) -> bool {
    let Some(raw) = value else { return false };
    let raw = raw.trim().to_ascii_lowercase();
    if raw.len() > 128 || raw.chars().any(char::is_whitespace) {
        return false;
    }
    let host = if raw.starts_with('[') {
        raw.split(']').next().map(|s| format!("{s}]"))
    } else {
        Some(raw.split(':').next().unwrap_or("").to_string())
    };
    matches!(host.as_deref(), Some("127.0.0.1" | "localhost" | "[::1]"))
}

fn read_request(stream: &mut TcpStream) -> Result<Request, (u16, String)> {
    let mut raw = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let n = stream
            .read(&mut chunk)
            .map_err(|_| (400, "read failed".into()))?;
        if n == 0 {
            return Err((400, "empty request".into()));
        }
        raw.extend_from_slice(&chunk[..n]);
        if raw.len() > MAX_HEADER_BYTES {
            return Err((431, "headers too large".into()));
        }
        if let Some(pos) = find_bytes(&raw, b"\r\n\r\n") {
            break pos + 4;
        }
    };
    let header_text =
        std::str::from_utf8(&raw[..header_end]).map_err(|_| (400, "invalid headers".into()))?;
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().ok_or((400, "missing request line".into()))?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();
    if method.is_empty() || target.is_empty() {
        return Err((400, "bad request line".into()));
    }
    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err((400, "bad header".into()));
        };
        let name = name.trim().to_ascii_lowercase();
        if name.len() > 128 || value.chars().any(|c| matches!(c, '\r' | '\n' | '\0')) {
            return Err((400, "bad header".into()));
        }
        if headers.contains_key(&name)
            && matches!(
                name.as_str(),
                "host" | "content-length" | "transfer-encoding"
            )
        {
            return Err((400, "duplicate critical header".into()));
        }
        headers.insert(name, value.trim().to_string());
    }
    if headers.contains_key("transfer-encoding") {
        return Err((400, "transfer-encoding unsupported".into()));
    }
    let length = headers
        .get("content-length")
        .map(|value| {
            value
                .parse::<usize>()
                .map_err(|_| (400, "bad content-length".into()))
        })
        .transpose()?
        .unwrap_or(0);
    let path_only = target.split('?').next().unwrap_or("/");
    let cap = if path_only == "/state" {
        MAX_STATE_BYTES
    } else {
        MAX_PERMISSION_BYTES
    };
    if length > cap {
        return Err((413, "payload too large".into()));
    }
    let mut body = raw[header_end..].to_vec();
    if body.len() > length {
        body.truncate(length);
    }
    if body.len() < length {
        let mut rest = vec![0u8; length - body.len()];
        stream
            .read_exact(&mut rest)
            .map_err(|_| (400, "body read failed".into()))?;
        body.extend_from_slice(&rest);
    }
    let path = parse_target(&target);
    Ok(Request {
        method,
        path,
        headers,
        body,
    })
}

/// Extract the path component from an HTTP request target (strips any query
/// string — no handler reads query params, so we don't waste cycles parsing
/// them into a map that would just be dead code).
fn parse_target(target: &str) -> String {
    target.split('?').next().unwrap_or("/").to_string()
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn respond(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        431 => "Request Header Fields Too Large",
        503 => "Service Unavailable",
        _ => "Error",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n{}: {}\r\nConnection: close\r\n\r\n",
        body.len(),
        SERVER_HEADER,
        SERVER_ID
    )?;
    stream.write_all(body)?;
    stream.flush()
}

fn text_field(body: &Value, keys: &[&str], max: usize) -> Option<String> {
    for key in keys {
        if let Some(value) = body.get(*key).and_then(Value::as_str) {
            let clean: String = value
                .chars()
                .map(|c| if c.is_control() { ' ' } else { c })
                .collect::<String>()
                .trim()
                .chars()
                .take(max)
                .collect();
            if !clean.is_empty() {
                return Some(clean);
            }
        }
    }
    None
}
