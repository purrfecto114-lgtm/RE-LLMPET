use crate::secure_file::read_regular_bounded;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::Duration;

const MAX_STDIN_BYTES: usize = 1024 * 1024;

// R3-E3 fix (R5): cache PPID after first lookup to avoid spawning ps/powershell
// on every hook invocation. OnceLock is thread-safe and zero-cost after init.
// None means "lookup failed" (avoid re-spawning); Some(n) is the actual PPID.
static CACHED_PPID: OnceLock<Option<u32>> = OnceLock::new();

#[derive(Debug, Deserialize)]
struct RuntimeFile {
    app: String,
    port: u16,
    token: String,
}

/// Entry point shared by the standalone `octopus-hook` helper and the packaged
/// GUI executable's `--octopus-hook` mode (the legacy `--re-llmpet-hook`
/// alias is still accepted during upgrades). Errors are intentionally silent in
/// normal use because hooks must not corrupt an agent's stdout protocol.
pub fn entry() {
    if let Err(error) = run() {
        if std::env::var("OCTOPUS_HOOK_DEBUG").as_deref() == Ok("1") {
            eprintln!("octopus-hook: {error}");
        }
        // A successful exit with empty stdout is interpreted as permission by
        // several provider hook contracts. Unexpected helper failures must not
        // silently become an allow. Observer hooks are configured best-effort;
        // strict permission hooks use the non-zero exit as a fail-closed signal.
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let provider = option_value(&args, "--provider").unwrap_or_else(|| "claude".into());
    let force_permission = args.iter().any(|arg| arg == "--permission");
    let pretool = args.iter().any(|arg| arg == "--pretool");
    let positional_event = positional_value(&args);
    let requested_permission = force_permission
        || positional_event.as_deref() == Some("PermissionRequest")
        || (provider == "codewhale" && positional_event.as_deref() == Some("tool_call_before"));

    // Current CodeWhale sends these events through environment variables only.
    // Reading stdin for them is both unnecessary and risky: a provider build
    // that leaves the pipe open can stall the hook and make the pet appear to
    // miss the entire working transition.
    //
    // R53 (2026-09-13): the four NEW upstream events (session_idle,
    // session_error, waiting_for_user, session_busy) are state observers
    // whose payloads (from/to/reason/last_turn_status/error) may arrive on
    // stdin OR via env — the upstream docs describe both channels. They stay
    // OUT of the env-only list so the stdin payload (notably the
    // waiting_for_user `reason`) is read when present; the reader below
    // treats a stuck pipe as an empty body for codewhale observers so a
    // wrong guess costs one missed transition, never a hung hook.
    let codewhale_env_only = provider == "codewhale"
        && matches!(
            positional_event.as_deref(),
            Some(
                "session_start"
                    | "session_end"
                    | "tool_call_before"
                    | "tool_call_after"
                    | "mode_change"
                    | "on_error"
            )
        );
    let codewhale_observer = provider == "codewhale"
        && matches!(
            positional_event.as_deref(),
            Some(
                "turn_end"
                    | "subagent_spawn"
                    | "subagent_complete"
                    | "message_submit"
                    | "session_idle"
                    | "session_error"
                    | "waiting_for_user"
                    | "session_busy"
            )
        );
    let body: Value = if codewhale_env_only {
        Value::Object(Map::new())
    } else {
        // R4-E1 fix: spawn stdin reader thread with timeout to prevent
        // permanent hang when provider (claude/aider) doesn't close stdin
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let reader_handle = std::thread::spawn(move || {
            let mut raw = Vec::new();
            let result = std::io::stdin()
                .take((MAX_STDIN_BYTES + 1) as u64)
                .read_to_end(&mut raw);
            let _ = tx.send(raw);
            result
        });
        let stdin_timeout = Duration::from_secs(10);
        let (raw, reader_stuck) = match rx.recv_timeout(stdin_timeout) {
            Ok(raw) => (raw, false),
            Err(_) if codewhale_observer => {
                // R53: codewhale state observers may legitimately deliver their
                // payload env-only. A stuck stdin pipe must not kill the event
                // (the old path aborted the whole hook): fall through with an
                // empty body and let apply_codewhale_env_fallback fill in what
                // the environment carries. The blocked reader thread is left
                // detached — it dies with the process at the end of run().
                (Vec::new(), true)
            }
            Err(_) => {
                return permission_fallback(
                    &provider,
                    requested_permission,
                    "stdin read timed out (10s)",
                );
            }
        };
        if !reader_stuck {
            let _ = reader_handle
                .join()
                .map_err(|e| eprintln!("stdin reader thread panicked: {e:?}"));
        }
        if raw.len() > MAX_STDIN_BYTES {
            return permission_fallback(&provider, requested_permission, "stdin payload too large");
        }
        if raw.iter().all(|byte| byte.is_ascii_whitespace()) {
            Value::Object(Map::new())
        } else {
            match serde_json::from_slice(&raw) {
                Ok(value) => value,
                Err(error) => {
                    return permission_fallback(
                        &provider,
                        requested_permission,
                        &format!("invalid stdin JSON: {error}"),
                    )
                }
            }
        }
    };
    if pretool {
        return run_pretool(&provider, &body);
    }

    let mut body = normalize_provider_body(&provider, positional_event.as_deref(), body)?;
    let object = body.as_object_mut().ok_or("stdin JSON must be an object")?;
    object.entry("source_pid").or_insert(Value::from(
        parent_process_id().unwrap_or_else(std::process::id),
    ));

    // R29 (2026-07-31): detect emotion from the message text and inject
    // it into the event body. The frontend (pet.js) already consumes
    // ev.emotion to show matching expressions. R54: extracted into
    // inject_emotion so the HTTP /state path (OpenCode plugin) shares it.
    let object = body.as_object_mut().ok_or("stdin JSON must be an object")?;
    inject_emotion(object);

    let event = object
        .get("hook_event_name")
        .or_else(|| object.get("event"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if provider == "codewhale"
        && event == "PreToolUse"
        && object
            .get("session_id")
            .and_then(Value::as_str)
            .map(str::is_empty)
            .unwrap_or(true)
    {
        return permission_fallback(
            &provider,
            true,
            "missing CodeWhale session id in hook environment",
        );
    }
    let permission = force_permission
        || event == "PermissionRequest"
        || (provider == "codewhale" && event == "PreToolUse");
    let path = if permission && provider == "codewhale" {
        "/codewhale-permission"
    } else if permission {
        "/permission"
    } else {
        "/state"
    };

    let runtime = match read_runtime() {
        Ok(runtime) => runtime,
        Err(error) => return permission_fallback(&provider, permission, &error),
    };
    let response = match post_json(&runtime, path, &body, permission) {
        Ok(response) => response,
        Err(error) => return permission_fallback(&provider, permission, &error),
    };
    if permission && !response.is_empty() {
        std::io::stdout()
            .write_all(&response)
            .map_err(|e| e.to_string())?;
        std::io::stdout()
            .write_all(b"\n")
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn parent_process_id() -> Option<u32> {
    // R3-E3 fix (R5): return cached PPID if available, avoiding costly
    // ps/powershell spawn on every hook call. First call does the real lookup.
    CACHED_PPID.get().copied().unwrap_or_else(|| {
        let ppid = resolve_ppid();
        let _ = CACHED_PPID.set(ppid);
        ppid
    })
}

/// Actual PPID resolution via ps (Unix) or powershell (Windows).
/// Called at most once thanks to CACHED_PPID.
fn resolve_ppid() -> Option<u32> {
    #[cfg(unix)]
    {
        let output = std::process::Command::new("ps")
            .args(["-o", "ppid=", "-p", &std::process::id().to_string()])
            .output()
            .ok()?;
        if output.status.success() {
            return String::from_utf8_lossy(&output.stdout).trim().parse().ok();
        }
    }
    #[cfg(windows)]
    {
        let script =
            "(Get-CimInstance Win32_Process -Filter ('ProcessId=' + $args[0])).ParentProcessId";
        let mut command = std::process::Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
            &std::process::id().to_string(),
        ]);
        // R22: hide the flashing PowerShell console window on first hook invocation.
        crate::platform::hide_console_window(&mut command);
        let output = command.output().ok()?;
        if output.status.success() {
            return String::from_utf8_lossy(&output.stdout).trim().parse().ok();
        }
    }
    None
}

fn permission_fallback(provider: &str, permission: bool, reason: &str) -> Result<(), String> {
    // CodeWhale treats empty stdout as allow, and `ask` does not downgrade
    // Full Access. Emit an explicit deny so an unavailable desktop permission
    // service is fail-closed in every native approval posture.
    if provider == "codewhale" && permission {
        let payload = serde_json::to_vec(&serde_json::json!({
            "decision":"deny",
            "reason":format!("Octopus permission service unavailable ({})", reason.chars().take(160).collect::<String>())
        })).map_err(|e| e.to_string())?;
        std::io::stdout()
            .write_all(&payload)
            .map_err(|e| e.to_string())?;
        std::io::stdout()
            .write_all(b"\n")
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    Err(reason.into())
}

fn normalize_provider_body(
    provider: &str,
    event_arg: Option<&str>,
    mut body: Value,
) -> Result<Value, String> {
    let object = body.as_object_mut().ok_or("stdin JSON must be an object")?;
    // CodeWhale's native payload uses `provider` for the actual billing route
    // (for example deepseek/openai). Preserve it before normalizing the source
    // adapter to `provider=codewhale`, otherwise metering loses provenance.
    let native_billing_provider = if provider == "codewhale" {
        object
            .get("provider")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty() && *value != "codewhale")
            .map(|value| value.chars().take(64).collect::<String>())
    } else {
        None
    };
    object.insert("provider".into(), Value::String(provider.into()));
    if let Some(billing_provider) = native_billing_provider {
        object
            .entry("billing_provider")
            .or_insert(Value::String(billing_provider));
    }
    let native_event = event_arg
        // R54 (2026-09-22): the OpenCode plugin v5 posts provider-native
        // event names under `event_type` (dotted lowercase namespace —
        // never Claude's PascalCase, never CodeWhale's snake_case). This
        // field is read for opencode only so no other provider's payload
        // can be reinterpreted through the opencode dictionary.
        .or_else(|| {
            (provider == "opencode")
                .then(|| object.get("event_type"))
                .flatten()
                .and_then(Value::as_str)
        })
        .or_else(|| object.get("hook_event_name").and_then(Value::as_str))
        .or_else(|| object.get("event").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();

    if provider == "codewhale" {
        apply_codewhale_env_fallback(object);
        // R53 (2026-09-13): four new upstream state observers (HOOKS.md grew
        // from 10 to 15 lifecycle events). waiting_for_user carries `reason`
        // (approval / user_input / goal_continuation) which selects the pet
        // expression: 等你处理 vs 等你回复 — previously CodeWhale sessions
        // could never show either because no event mapped onto them.
        let wait_reason = object
            .get("reason")
            .and_then(Value::as_str)
            .map(|value| value.trim().to_ascii_lowercase())
            .unwrap_or_default();
        let (event, state): (String, &str) = match native_event.as_str() {
            "session_start" => ("SessionStart".into(), "idle"),
            "session_end" => ("SessionEnd".into(), "sleeping"),
            "message_submit" => ("UserPromptSubmit".into(), "thinking"),
            "tool_call_before" => ("PreToolUse".into(), "working"),
            "tool_call_after" => ("PostToolUse".into(), "working"),
            "turn_end" => ("Stop".into(), "attention"),
            "on_error" => ("StopFailure".into(), "error"),
            "subagent_spawn" => ("SubagentStart".into(), "juggling"),
            "subagent_complete" => ("SubagentStop".into(), "working"),
            "mode_change" => ("Notification".into(), "idle"),
            "session_idle" => ("SessionIdle".into(), "loafing"),
            "session_error" => ("StopFailure".into(), "error"),
            "waiting_for_user" => {
                let state = match wait_reason.as_str() {
                    "user_input" => "needsinput",
                    // approval + goal_continuation both park the agent on the
                    // operator: the 等你处理 expression is the honest reading.
                    _ => "waiting",
                };
                ("WaitingForUser".into(), state)
            }
            "session_busy" => ("SessionBusy".into(), "working"),
            _ => (native_event.clone(), "idle"),
        };
        object.insert("native_event".into(), Value::String(native_event.clone()));
        object.insert("hook_event_name".into(), Value::String(event));
        object.entry("state").or_insert(Value::String(state.into()));
        alias(object, "workspace", "cwd");
        alias(object, "tool", "tool_name");
        if !object.contains_key("tool_input") {
            if let Some(raw) = object.get("tool_input_json").and_then(Value::as_str) {
                if let Ok(value) = serde_json::from_str::<Value>(raw) {
                    object.insert("tool_input".into(), value);
                }
            }
        }
        if native_event == "turn_end" {
            normalize_codewhale_turn_end(object);
        }
    } else if provider == "aider" {
        let cwd = std::env::current_dir()
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        object.entry("cwd").or_insert(Value::String(cwd.clone()));
        object
            .entry("session_id")
            .or_insert(Value::String(stable_session("aider", &cwd)));
        object.insert("hook_event_name".into(), Value::String("Stop".into()));
        object
            .entry("state")
            .or_insert(Value::String("attention".into()));
    } else if provider == "codex" {
        // R51 (2026-08-30): codex 0.151 emits `Interrupt` when the user aborts
        // the running turn. Map it to Stop/attention so the pet stops
        // "working" after an abort instead of staying busy forever. Other
        // codex events already carry canonical hook_event_name payloads
        // (verified live: SessionStart/UserPromptSubmit/PreToolUse/
        // PostToolUse/Stop/SessionEnd with turn_id + tool_input/tool_response).
        if native_event == "Interrupt" {
            object.insert("native_event".into(), Value::String("Interrupt".into()));
            object.insert("hook_event_name".into(), Value::String("Stop".into()));
            object
                .entry("state".to_string())
                .or_insert(Value::String("attention".into()));
        }
    } else if provider == "opencode" {
        // R54 (2026-09-22): OpenCode's event namespace is translated HERE —
        // at the Rust normalize layer — never inside the provider plugin.
        // The v4 plugin translated at the source (session.idle -> "Stop",
        // permission.asked -> "Notification", ...), which is exactly the
        // cross-provider name mixing this round removes: the pet pipeline
        // received Claude-spelled names from an OpenCode process with no way
        // to recover the native event. v5 plugin bodies carry `event_type`
        // (native) and this dictionary is the single translator. v4 bodies
        // (no `event_type`, already translated) pass through unchanged for
        // upgrade compatibility.
        if object.contains_key("event_type") {
            object.insert("native_event".into(), Value::String(native_event.clone()));
            normalize_opencode_native(object);
        }
    } else {
        if !object.contains_key("hook_event_name") && !native_event.is_empty() {
            object.insert("hook_event_name".into(), Value::String(native_event));
        }
    }
    Ok(body)
}

/// R54 (2026-09-22): OpenCode native event dictionary — the third namespace
/// in this codebase after Claude's PascalCase (also codex's, by codex's own
/// `ClaudeHooksEngine` design — verified from openai/codex source at tag
/// rust-v0.151.0) and CodeWhale's snake_case. Every provider's events are
/// kept in their own spelling; this table is the only place OpenCode's
/// dotted names meet the internal canonical vocabulary.
///
/// Ground truth (2026-09-22, two independent sources):
///  1. Live smoke tap of opencode 1.18.32 driven against a mock model —
///     raw event manifest captured in the provider-real-opencode evidence
///     (session.created/updated/idle/status/diff, message.updated,
///     message.part.updated/delta, permission.asked/replied observed).
///  2. Upstream schema cross-check (subagent R54-c):
///     sst/opencode@1.18.32 packages/schema/src — `message.updated` is the
///     role-discriminated user/assistant message event (the true
///     UserPromptSubmit + turn-end equivalents R40 wrongly believed absent);
///     `session.status` union is ONLY idle|busy|retry (no waiting/error);
///     `session.idle` is upstream-deprecated but still published;
///     `permission.v2.*`/`question.*` are the newer permission surfaces.
///
/// Deliberately NOT mapped (verified to exist upstream, no pet-state value):
///   session.updated (metadata churn, ~7 fires/turn), message.part.*
///   (streaming deltas — the say-bubble already fires at turn completion),
///   session.diff, todo.updated, pty.*, file.*, tui.*, catalog.*.
/// Unmapped native events are dropped by [`prepare_http_state_body`] so the
/// ingest state machine never sees noise it would flatten to "idle".
fn normalize_opencode_native(object: &mut Map<String, Value>) -> bool {
    let native_event = object
        .get("event_type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    // Owned: `role` is read again after the mutable `object.insert` below, so
    // an &str borrow here would violate E0502 across the mutation.
    let role = object
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let completed = object
        .get("completed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let tool_name = object
        .get("tool_name")
        .or_else(|| object.get("tool"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let status_raw = object
        .get("status_raw")
        .or_else(|| object.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let (event, state): (&str, Option<&str>) = match native_event.as_str() {
        "session.created" => ("SessionStart", Some("idle")),
        "session.deleted" => ("SessionEnd", Some("sleeping")),
        "session.error" => ("StopFailure", Some("error")),
        // Deprecated upstream (status.idle still publishes it); keep for
        // pre-1.18 builds and as the plain idle signal.
        "session.idle" => ("Stop", Some("attention")),
        "session.compacted" => ("PreCompact", Some("sweeping")),
        // status union is idle|busy|retry — the v4 plugin's waiting/error
        // branches were dead code, removed here.
        "session.status" => (
            "SessionStatus",
            Some(match status_raw {
                "busy" | "working" | "running" => "working",
                "retry" => "error",
                _ => "attention",
            }),
        ),
        // The real user-prompt / turn-end pair R40 could not find: role-
        // discriminated message lifecycle. `completed` is the assistant
        // turn-completion marker (time.completed upstream).
        "message.updated" => {
            if role == "user" {
                ("UserPromptSubmit", Some("thinking"))
            } else if role == "assistant" && completed {
                ("Stop", Some("attention"))
            } else {
                ("", None)
            }
        }
        "permission.asked" | "permission.v2.asked" => ("Notification", Some("needsinput")),
        "permission.replied" | "permission.v2.replied" => ("PreToolUse", Some("working")),
        "question.asked" | "question.v2.asked" => ("Notification", Some("needsinput")),
        "question.replied" | "question.v2.replied" => ("PreToolUse", Some("working")),
        "tool.execute.before" => {
            if tool_name == "task" || tool_name == "agent" {
                ("SubagentStart", Some("juggling"))
            } else {
                ("PreToolUse", Some("working"))
            }
        }
        "tool.execute.after" => {
            if tool_name == "task" || tool_name == "agent" {
                ("SubagentStop", Some("working"))
            } else {
                ("PostToolUse", Some("working"))
            }
        }
        _ => ("", None),
    };
    if event.is_empty() {
        return false;
    }
    object.insert("hook_event_name".into(), Value::String(event.into()));
    if let Some(state) = state {
        object
            .entry("state".to_string())
            .or_insert(Value::String(state.into()));
    }
    // Metering: assistant turn completion carries opencode's tokens object
    // ({input, output, reasoning, cache{read, write}}). Normalize it into the
    // same `turn_usage` shape codewhale turn_end uses so the ledger accepts
    // both without provider branching.
    if native_event == "message.updated" && role == "assistant" && completed {
        if let Some(tokens) = object.get("tokens").and_then(Value::as_object) {
            let read_u64 = |name: &str| tokens.get(name).and_then(Value::as_u64).unwrap_or(0);
            let cache_read = tokens
                .get("cache")
                .and_then(Value::as_object)
                .and_then(|cache| cache.get("read"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let cache_write = tokens
                .get("cache")
                .and_then(Value::as_object)
                .and_then(|cache| cache.get("write"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            object.insert(
                "turn_usage".into(),
                serde_json::json!({
                    "input": read_u64("input"),
                    "output": read_u64("output"),
                    "reasoning": read_u64("reasoning"),
                    "cache_read": cache_read,
                    "cache_write": cache_write,
                }),
            );
            object
                .entry("turn_duration_ms")
                .or_insert(Value::from(0_u64));
        }
    }
    true
}

/// R54 (2026-09-22): HTTP `/state` ingest normalization. The OpenCode plugin
/// (v5) is the only integration that POSTs provider-native payloads straight
/// to the control plane (every other provider arrives pre-normalized from
/// the octopus-hook binary). Translate native events here and drop the ones
/// with no pet-state semantics; then run the shared emotion sniffer so
/// OpenCode message text gets the same expression treatment as claude/
/// codewhale prompts (R29 previously only ran on the hook-binary path).
pub fn prepare_http_state_body(body: Value) -> Option<Value> {
    let mut body = body;
    let object = body.as_object_mut()?;
    let is_opencode = object
        .get("provider")
        .and_then(Value::as_str)
        .map(|value| value.eq_ignore_ascii_case("opencode"))
        .unwrap_or(false);
    if !is_opencode {
        return Some(body);
    }
    if !object.contains_key("event_type") {
        // v4 plugin compatibility: already-translated bodies pass through.
        return Some(body);
    }
    if !normalize_opencode_native(object) {
        return None;
    }
    inject_emotion(object);
    Some(body)
}

/// R29 (2026-07-31) emotion sniffer, extracted in R54 so both the
/// hook-binary path and the HTTP `/state` path share one implementation.
/// Detects emotion from message text and injects it into the event body;
/// never blocks, returns nothing when in doubt.
fn inject_emotion(object: &mut Map<String, Value>) {
    let event_name = object
        .get("hook_event_name")
        .or_else(|| object.get("event"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let text = object
        .get("text")
        .or_else(|| object.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let role = if event_name == "UserPromptSubmit" || event_name == "message_submit" {
        "user"
    } else if event_name == "PostToolUse" || event_name == "turn_end" || event_name == "Stop" {
        "assistant"
    } else {
        ""
    };
    if !text.is_empty() && !role.is_empty() {
        if let Some(emotion) = crate::emotion::detect_emotion(&text, role) {
            object.insert("emotion".into(), Value::from(emotion.as_str()));
        }
    }
}

fn normalize_codewhale_turn_end(object: &mut Map<String, Value>) {
    let normalized_usage = object.get("usage").and_then(Value::as_object).map(|usage| {
        let read = |name: &str| usage.get(name).and_then(json_u64).unwrap_or(0);
        serde_json::json!({
            "input": read("input_tokens"),
            "output": read("output_tokens"),
            "cache_read": read("prompt_cache_hit_tokens"),
            "cache_create": read("prompt_cache_miss_tokens"),
            "cache_write": read("prompt_cache_write_tokens"),
            "reasoning": read("reasoning_tokens"),
            "reasoning_replay": read("reasoning_replay_tokens")
        })
    });
    if let Some(usage) = normalized_usage {
        object.entry("turn_usage").or_insert(usage);
    }
    if let Some(used) = object
        .get("totals")
        .and_then(Value::as_object)
        .and_then(|totals| totals.get("conversation_tokens"))
        .and_then(json_u64)
    {
        object.entry("context_usage").or_insert_with(|| {
            serde_json::json!({
                "used": used,
                "limit": Value::Null,
                "percent": Value::Null,
                "source": "codewhale"
            })
        });
    }
    if let Some(duration) = object.get("duration_ms").cloned() {
        object.entry("turn_duration_ms").or_insert(duration);
    }
    let failed = object
        .get("status")
        .and_then(Value::as_str)
        .map(|status| matches!(status, "failed" | "interrupted"))
        .unwrap_or(false);
    if failed {
        object.insert(
            "hook_event_name".into(),
            Value::String("StopFailure".into()),
        );
        object.insert("state".into(), Value::String("error".into()));
        if let Some(error) = object.get("error").cloned() {
            object.entry("api_error_type").or_insert(error);
        }
    }
}

fn json_u64(value: &Value) -> Option<u64> {
    match value {
        Value::Number(number) => number.as_u64().or_else(|| {
            number
                .as_f64()
                .filter(|value| value.is_finite() && *value >= 0.0)
                .map(|value| value.min(u64::MAX as f64) as u64)
        }),
        Value::String(text) => text.parse::<u64>().ok(),
        _ => None,
    }
}

fn apply_codewhale_env_fallback(object: &mut Map<String, Value>) {
    for (key, names) in [
        (
            "session_id",
            ["DEEPSEEK_SESSION_ID", "CODEWHALE_SESSION_ID"],
        ),
        // R50: subagent streams expose their owning session (when the CLI
        // provides it) so the backend marks them headless children instead
        // of spawning a top-level pseudo session per tool call.
        (
            "parent_id",
            ["CODEWHALE_PARENT_SESSION_ID", "DEEPSEEK_PARENT_SESSION_ID"],
        ),
        ("workspace", ["DEEPSEEK_WORKSPACE", "CODEWHALE_WORKSPACE"]),
        ("mode", ["DEEPSEEK_MODE", "CODEWHALE_MODE"]),
        ("model", ["DEEPSEEK_MODEL", "CODEWHALE_MODEL"]),
        ("tool_name", ["DEEPSEEK_TOOL_NAME", "CODEWHALE_TOOL_NAME"]),
        (
            "tool_input_json",
            ["DEEPSEEK_TOOL_ARGS", "CODEWHALE_TOOL_ARGS"],
        ),
        ("text", ["DEEPSEEK_MESSAGE", "CODEWHALE_MESSAGE"]),
        ("error", ["DEEPSEEK_ERROR", "CODEWHALE_ERROR"]),
        (
            "previous_mode",
            ["DEEPSEEK_PREVIOUS_MODE", "CODEWHALE_PREVIOUS_MODE"],
        ),
        ("reason", ["DEEPSEEK_REASON", "CODEWHALE_REASON"]),
        (
            "tool_call_id",
            ["DEEPSEEK_TOOL_CALL_ID", "CODEWHALE_TOOL_CALL_ID"],
        ),
        (
            "tool_result",
            ["DEEPSEEK_TOOL_RESULT", "CODEWHALE_TOOL_RESULT"],
        ),
        (
            "tool_success",
            ["DEEPSEEK_TOOL_SUCCESS", "CODEWHALE_TOOL_SUCCESS"],
        ),
        // R51 (2026-08-30): verified against Hmbown/CodeWhale docs/HOOKS.md —
        // these three env vars exist on current builds but were missing from
        // the fallback table, so metering/receipts lost free data.
        (
            "tool_exit_code",
            ["DEEPSEEK_TOOL_EXIT_CODE", "CODEWHALE_TOOL_EXIT_CODE"],
        ),
        (
            "session_tokens",
            ["DEEPSEEK_TOTAL_TOKENS", "CODEWHALE_TOTAL_TOKENS"],
        ),
        (
            "session_cost_usd",
            ["DEEPSEEK_SESSION_COST", "CODEWHALE_SESSION_COST"],
        ),
    ] {
        if object
            .get(key)
            .and_then(Value::as_str)
            .map(str::is_empty)
            .unwrap_or(true)
        {
            if let Some(value) = names
                .iter()
                .find_map(|name| std::env::var(name).ok())
                .filter(|value| !value.is_empty())
            {
                object.insert(key.into(), Value::String(value));
            }
        }
    }
}

fn alias(object: &mut Map<String, Value>, from: &str, to: &str) {
    if !object.contains_key(to) {
        if let Some(value) = object.get(from).cloned() {
            object.insert(to.into(), value);
        }
    }
}

fn stable_session(prefix: &str, value: &str) -> String {
    // FNV-1a is stable across processes and requires no extra dependency.
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{prefix}:{hash:016x}")
}

fn run_pretool(provider: &str, body: &Value) -> Result<(), String> {
    let object = body.as_object().ok_or("stdin JSON must be an object")?;
    let tool = object
        .get("tool_name")
        .or_else(|| object.get("toolName"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();

    // Claude's AskUserQuestion and ExitPlanMode are interactive tools. The
    // PreToolUse contract requires an allow decision together with updatedInput
    // when another UI collects the interaction. Route only those tools through
    // the blocking local approval queue; every failure returns no hook decision
    // so Claude falls back to its native terminal UI instead of faking success.
    if provider == "claude" && matches!(tool, "AskUserQuestion" | "ExitPlanMode") {
        let mut request = normalize_provider_body(provider, Some("PreToolUse"), body.clone())?;
        request
            .as_object_mut()
            .ok_or("stdin JSON must be an object")?
            .entry("source_pid")
            .or_insert(Value::from(
                parent_process_id().unwrap_or_else(std::process::id),
            ));
        let runtime = match read_runtime() {
            Ok(runtime) => runtime,
            Err(_) => return Ok(()),
        };
        let response = match post_json(&runtime, "/permission", &request, true) {
            Ok(response) => response,
            Err(_) => return Ok(()),
        };
        let output = translate_claude_permission_to_pretool(&response)?;
        std::io::stdout()
            .write_all(&output)
            .map_err(|e| e.to_string())?;
        std::io::stdout()
            .write_all(b"\n")
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    let input = object
        .get("tool_input")
        .or_else(|| object.get("toolInput"))
        .and_then(Value::as_object);
    let decision = pretool_decision(tool, input);
    if let Some(decision) = decision {
        let reason = if decision == "deny" {
            "Octopus denied an unsafe or unsupported automatic operation"
        } else {
            "Octopus auto-approved an explicitly read-only operation"
        };
        let output = serde_json::to_vec(&serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": decision,
                "permissionDecisionReason": reason
            }
        }))
        .map_err(|e| e.to_string())?;
        std::io::stdout()
            .write_all(&output)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn translate_claude_permission_to_pretool(response: &[u8]) -> Result<Vec<u8>, String> {
    let value: Value = serde_json::from_slice(response).map_err(|e| e.to_string())?;
    let decision = value
        .get("hookSpecificOutput")
        .and_then(|value| value.get("decision"))
        .and_then(Value::as_object)
        .ok_or("invalid Claude permission response")?;
    let behavior = decision
        .get("behavior")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "allow" | "deny"))
        .ok_or("invalid Claude permission behavior")?;
    let mut hook = serde_json::Map::new();
    hook.insert("hookEventName".into(), Value::String("PreToolUse".into()));
    hook.insert("permissionDecision".into(), Value::String(behavior.into()));
    if let Some(updated_input) = decision.get("updatedInput") {
        hook.insert("updatedInput".into(), updated_input.clone());
    }
    if behavior == "deny" {
        if let Some(message) = decision.get("message").and_then(Value::as_str) {
            hook.insert(
                "permissionDecisionReason".into(),
                Value::String(
                    message
                        .chars()
                        .filter(|c| !c.is_control())
                        .take(4_000)
                        .collect(),
                ),
            );
        }
    }
    serde_json::to_vec(&serde_json::json!({
        "hookSpecificOutput": Value::Object(hook)
    }))
    .map_err(|e| e.to_string())
}

fn pretool_decision(tool: &str, input: Option<&Map<String, Value>>) -> Option<&'static str> {
    // Keep this list intentionally narrow. TaskCreate/TaskUpdate/TaskStop,
    // TodoWrite and Skill can mutate state or execute arbitrary workflows.
    const READ_ONLY: [&str; 9] = [
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
    if READ_ONLY.contains(&tool) {
        return Some("allow");
    }
    if tool == "WebFetch" {
        let url = input
            .and_then(|map| map.get("url"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if url.is_empty() {
            return None;
        }
        // Clear-text fetches are always rejected. HTTPS is deliberately delegated
        // to the provider's native permission flow: scheme checks alone cannot
        // prove that a hostname is public, stable after DNS resolution, or safe.
        if !url.to_ascii_lowercase().starts_with("https://") {
            return Some("deny");
        }
        return None;
    }
    // Shell syntax and command options are too broad for a sound lexical
    // read-only allow-list. Bash always remains in the provider-native prompt.
    None
}

fn positional_value(args: &[String]) -> Option<String> {
    let mut skip_next = false;
    for arg in args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if arg == "--provider" {
            skip_next = true;
            continue;
        }
        if matches!(
            arg.as_str(),
            "--octopus-hook" | "--re-llmpet-hook" | "--permission" | "--pretool"
        ) {
            continue;
        }
        if !arg.starts_with('-') {
            return Some(arg.clone());
        }
    }
    None
}

fn option_value(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == flag)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

fn read_runtime() -> Result<RuntimeFile, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or("home directory unavailable")?;
    let path = home.join(".re-llmpet").join("runtime.json");
    let raw = read_regular_bounded(&path, 16 * 1024, "runtime file")?;
    let runtime: RuntimeFile = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    if runtime.app != "re-llmpet" || !(41330..=41334).contains(&runtime.port) {
        return Err("invalid runtime file".into());
    }
    if runtime.token.len() < 32
        || runtime.token.len() > 128
        || !runtime
            .token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("invalid runtime token".into());
    }
    Ok(runtime)
}

fn post_json(
    runtime: &RuntimeFile,
    path: &str,
    body: &Value,
    blocking: bool,
) -> Result<Vec<u8>, String> {
    let payload = serde_json::to_vec(body).map_err(|e| e.to_string())?;
    // R4-E2 fix: connect_timeout prevents 75s OS-default hang when main process not running
    let addr = std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, runtime.port));
    let mut stream =
        TcpStream::connect_timeout(&addr, Duration::from_millis(500)).map_err(|e| e.to_string())?;
    let timeout = if blocking {
        Duration::from_secs(9 * 60)
    } else {
        Duration::from_millis(250)
    };
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    write!(
        stream,
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-Re-Llmpet-Token: {}\r\nX-Re-Llmpet-Server: re-llmpet\r\nConnection: close\r\n\r\n",
        runtime.port,
        payload.len(),
        runtime.token
    )
    .map_err(|e| e.to_string())?;
    stream.write_all(&payload).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;

    // R25 (2026-07-30): bound the response read to 1 MiB to prevent unbounded
    // memory growth if the loopback server misbehaves. The old code used
    // read_to_end which has no cap — a blocking permission hook (9-minute
    // timeout) could OOM the hook process.
    let mut response = Vec::with_capacity(8192);
    let mut chunk = [0u8; 4096];
    let max_response = 1024 * 1024; // 1 MiB
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if response.len() + n > max_response {
                    return Err("hook response exceeds 1 MiB cap".into());
                }
                response.extend_from_slice(&chunk[..n]);
            }
            Err(e) => return Err(format!("read error: {e}")),
        }
    }
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or("invalid HTTP response")?;
    let head = String::from_utf8_lossy(&response[..split]);
    if !head.starts_with("HTTP/1.1 200 ")
        || !head
            .to_ascii_lowercase()
            .contains("x-re-llmpet-server: re-llmpet")
    {
        return Err(format!(
            "server rejected hook: {}",
            head.lines().next().unwrap_or("unknown")
        ));
    }
    Ok(response[split + 4..].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn codewhale_turn_fixture() -> Value {
        serde_json::from_str(include_str!("../../test/fixtures/codewhale-turn-end.json"))
            .expect("fixture must be valid")
    }

    #[test]
    fn codewhale_normalization_preserves_billing_provider_and_usage() {
        let mut payload = codewhale_turn_fixture();
        payload["provider"] = Value::String("deepseek".into());
        payload.as_object_mut().unwrap().remove("billing_provider");
        payload.as_object_mut().unwrap().remove("turn_usage");
        payload.as_object_mut().unwrap().remove("context_usage");
        let normalized = normalize_provider_body("codewhale", Some("turn_end"), payload).unwrap();
        assert_eq!(normalized["provider"], "codewhale");
        assert_eq!(normalized["billing_provider"], "deepseek");
        assert_eq!(normalized["native_event"], "turn_end");
        assert_eq!(normalized["turn_usage"]["input"], 1200);
        assert_eq!(normalized["turn_usage"]["cache_read"], 900);
        assert_eq!(normalized["context_usage"]["used"], 1380);
    }

    #[test]
    fn failed_codewhale_turn_maps_to_error() {
        let mut payload = codewhale_turn_fixture();
        payload["status"] = Value::String("failed".into());
        payload["error"] = Value::String("provider timeout".into());
        let normalized = normalize_provider_body("codewhale", Some("turn_end"), payload).unwrap();
        assert_eq!(normalized["hook_event_name"], "StopFailure");
        assert_eq!(normalized["state"], "error");
        assert_eq!(normalized["api_error_type"], "provider timeout");
    }

    // ── R53 (2026-09-13): upstream HOOKS.md grew to 15 lifecycle events ───

    #[test]
    fn codewhale_session_idle_maps_to_loafing() {
        let payload = serde_json::json!({
            "session_id": "cw-1",
            "workspace": "/repo",
            "from": "in_progress",
            "to": "idle",
            "last_turn_status": "success"
        });
        let normalized =
            normalize_provider_body("codewhale", Some("session_idle"), payload).unwrap();
        assert_eq!(normalized["hook_event_name"], "SessionIdle");
        assert_eq!(normalized["state"], "loafing");
    }

    #[test]
    fn codewhale_session_error_maps_to_error() {
        let payload = serde_json::json!({
            "session_id": "cw-1",
            "workspace": "/repo",
            "error": "context window exhausted"
        });
        let normalized =
            normalize_provider_body("codewhale", Some("session_error"), payload).unwrap();
        assert_eq!(normalized["hook_event_name"], "StopFailure");
        assert_eq!(normalized["state"], "error");
    }

    #[test]
    fn codewhale_waiting_for_user_reason_selects_expression() {
        for (reason, expected_state) in [
            ("approval", "waiting"),
            ("goal_continuation", "waiting"),
            ("user_input", "needsinput"),
        ] {
            let payload = serde_json::json!({
                "session_id": "cw-1",
                "workspace": "/repo",
                "reason": reason,
                "from": "in_progress",
                "to": "waiting"
            });
            let normalized =
                normalize_provider_body("codewhale", Some("waiting_for_user"), payload).unwrap();
            assert_eq!(normalized["hook_event_name"], "WaitingForUser");
            assert_eq!(
                normalized["state"], expected_state,
                "reason {reason} must map to {expected_state}"
            );
        }
    }

    #[test]
    fn codewhale_session_busy_maps_to_working() {
        let payload = serde_json::json!({
            "session_id": "cw-1",
            "workspace": "/repo",
            "from": "idle",
            "to": "in_progress"
        });
        let normalized =
            normalize_provider_body("codewhale", Some("session_busy"), payload).unwrap();
        assert_eq!(normalized["hook_event_name"], "SessionBusy");
        assert_eq!(normalized["state"], "working");
    }

    #[test]
    fn codewhale_waiting_reason_falls_back_to_waiting_without_reason() {
        // Env-only delivery (no stdin payload): the reason is absent, so the
        // safe default is 等你处理 (waiting) — never a raw passthrough.
        let payload = serde_json::json!({ "session_id": "cw-1", "workspace": "/repo" });
        let normalized =
            normalize_provider_body("codewhale", Some("waiting_for_user"), payload).unwrap();
        assert_eq!(normalized["state"], "waiting");
    }

    #[test]
    fn claude_interaction_response_becomes_pretool_updated_input() {
        let response = serde_json::to_vec(&serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": {
                    "behavior": "allow",
                    "updatedInput": {
                        "questions": [{"question":"Framework?"}],
                        "answers": {"Framework?":"Rust"}
                    }
                }
            }
        }))
        .unwrap();
        let translated: Value =
            serde_json::from_slice(&translate_claude_permission_to_pretool(&response).unwrap())
                .unwrap();
        assert_eq!(
            translated["hookSpecificOutput"]["hookEventName"],
            "PreToolUse"
        );
        assert_eq!(
            translated["hookSpecificOutput"]["permissionDecision"],
            "allow"
        );
        assert_eq!(
            translated["hookSpecificOutput"]["updatedInput"]["answers"]["Framework?"],
            "Rust"
        );
    }

    #[test]
    fn claude_plan_rejection_becomes_pretool_reason() {
        let response = serde_json::to_vec(&serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": {"behavior":"deny","message":"Add rollback steps"}
            }
        }))
        .unwrap();
        let translated: Value =
            serde_json::from_slice(&translate_claude_permission_to_pretool(&response).unwrap())
                .unwrap();
        assert_eq!(
            translated["hookSpecificOutput"]["permissionDecision"],
            "deny"
        );
        assert_eq!(
            translated["hookSpecificOutput"]["permissionDecisionReason"],
            "Add rollback steps"
        );
        assert!(translated["hookSpecificOutput"]
            .get("updatedInput")
            .is_none());
    }

    #[test]
    fn bash_is_never_auto_approved() {
        let input = serde_json::json!({"command": "git status"});
        assert_eq!(
            pretool_decision("Bash", input.as_object()),
            None,
            "shell commands must stay in the provider-native permission flow"
        );
    }

    #[test]
    fn https_fetch_requires_native_approval() {
        let input = serde_json::json!({"url": "https://127.0.0.1/admin"});
        assert_eq!(pretool_decision("WebFetch", input.as_object()), None);
    }

    #[test]
    fn cleartext_fetch_is_denied() {
        let input = serde_json::json!({"url": "http://example.test"});
        assert_eq!(
            pretool_decision("WebFetch", input.as_object()),
            Some("deny")
        );
    }

    // ── R54 (2026-09-22): OpenCode native event dictionary ────────────────
    // Every case below mirrors the live 1.18.32 smoke tap and the upstream
    // schema manifest (see normalize_opencode_native for sources).

    fn opencode_body(event_type: &str, extra: Value) -> Value {
        let mut body = serde_json::json!({
            "provider": "opencode",
            "event_type": event_type,
            "session_id": "ses_test",
            "cwd": "/tmp/work",
        });
        if let (Some(target), Some(source)) = (body.as_object_mut(), extra.as_object()) {
            for (key, value) in source {
                target.insert(key.clone(), value.clone());
            }
        }
        body
    }

    #[test]
    fn opencode_lifecycle_native_events_map_to_canonical() {
        // (native, extra, expected canonical, expected state)
        let cases: Vec<(&str, Value, &str, &str)> = vec![
            ("session.created", json!({}), "SessionStart", "idle"),
            ("session.deleted", json!({}), "SessionEnd", "sleeping"),
            ("session.error", json!({}), "StopFailure", "error"),
            ("session.idle", json!({}), "Stop", "attention"),
            ("session.compacted", json!({}), "PreCompact", "sweeping"),
            (
                "session.status",
                json!({"status_raw": "busy"}),
                "SessionStatus",
                "working",
            ),
            (
                "session.status",
                json!({"status_raw": "retry"}),
                "SessionStatus",
                "error",
            ),
            (
                "session.status",
                json!({"status_raw": "idle"}),
                "SessionStatus",
                "attention",
            ),
            ("permission.asked", json!({}), "Notification", "needsinput"),
            (
                "permission.v2.asked",
                json!({}),
                "Notification",
                "needsinput",
            ),
            ("permission.replied", json!({}), "PreToolUse", "working"),
            ("permission.v2.replied", json!({}), "PreToolUse", "working"),
            ("question.asked", json!({}), "Notification", "needsinput"),
            ("question.replied", json!({}), "PreToolUse", "working"),
            (
                "tool.execute.before",
                json!({"tool_name": "read"}),
                "PreToolUse",
                "working",
            ),
            (
                "tool.execute.before",
                json!({"tool_name": "task"}),
                "SubagentStart",
                "juggling",
            ),
            (
                "tool.execute.before",
                json!({"tool_name": "agent"}),
                "SubagentStart",
                "juggling",
            ),
            (
                "tool.execute.after",
                json!({"tool_name": "bash"}),
                "PostToolUse",
                "working",
            ),
            (
                "tool.execute.after",
                json!({"tool_name": "task"}),
                "SubagentStop",
                "working",
            ),
        ];
        for (native, extra, event, state) in cases {
            let body = opencode_body(native, extra);
            let normalized =
                normalize_provider_body("opencode", None, body).expect("opencode body");
            assert_eq!(normalized["native_event"], *native, "native {native}");
            assert_eq!(normalized["hook_event_name"], *event, "event {native}");
            assert_eq!(normalized["state"], *state, "state {native}");
        }
    }

    #[test]
    fn opencode_message_updated_role_discriminates_user_vs_assistant() {
        // role=user is the REAL user-prompt producer (R40 believed absent).
        let user = opencode_body("message.updated", json!({"role": "user", "text": "fix it"}));
        let normalized = normalize_provider_body("opencode", None, user).unwrap();
        assert_eq!(normalized["hook_event_name"], "UserPromptSubmit");
        assert_eq!(normalized["state"], "thinking");

        // assistant without completed = streaming — dropped, not ingested.
        let streaming = opencode_body(
            "message.updated",
            json!({"role": "assistant", "completed": false}),
        );
        assert!(prepare_http_state_body(streaming).is_none());

        // assistant with completed = turn end + metering payload.
        let done = opencode_body(
            "message.updated",
            json!({
                "role": "assistant",
                "completed": true,
                "last_assistant_message": "done",
                "tokens": {"input": 10, "output": 5, "reasoning": 1,
                           "cache": {"read": 2, "write": 3}},
            }),
        );
        let normalized = normalize_provider_body("opencode", None, done).unwrap();
        assert_eq!(normalized["hook_event_name"], "Stop");
        assert_eq!(normalized["state"], "attention");
        assert_eq!(normalized["turn_usage"]["input"], 10);
        assert_eq!(normalized["turn_usage"]["cache_read"], 2);
        assert_eq!(normalized["turn_usage"]["cache_write"], 3);
    }

    #[test]
    fn opencode_v4_bodies_pass_through_without_event_type() {
        // Upgrade compatibility: the v4 plugin posts Claude-spelled
        // hook_event_name with no event_type field — untouched.
        let v4_body = serde_json::json!({
            "provider": "opencode",
            "hook_event_name": "Stop",
            "state": "attention",
            "session_id": "ses_old",
            "cwd": "/tmp/work",
        });
        let normalized = normalize_provider_body("opencode", None, v4_body.clone()).unwrap();
        assert_eq!(normalized["hook_event_name"], "Stop");
        assert_eq!(normalized["state"], "attention");
        // The HTTP wrapper must keep it (no drop).
        assert!(prepare_http_state_body(normalized).is_some());
    }

    #[test]
    fn opencode_unknown_native_events_are_dropped() {
        // session.updated / message.part.* / catalog.* have no pet-state
        // semantics — dropping keeps the state machine from flattening a
        // working session to idle.
        for noise in ["session.updated", "message.part.delta", "catalog.updated"] {
            let body = opencode_body(noise, json!({}));
            assert!(
                prepare_http_state_body(body).is_none(),
                "{noise} must be dropped"
            );
        }
    }

    #[test]
    fn opencode_state_is_never_overwritten_by_dictionary() {
        // entry().or_insert: an explicit state from the plugin wins.
        let body = opencode_body(
            "session.status",
            json!({"status_raw": "busy", "state": "working"}),
        );
        let normalized = normalize_provider_body("opencode", None, body).unwrap();
        assert_eq!(normalized["state"], "working");
    }

    #[test]
    fn non_opencode_providers_never_read_event_type() {
        // The event_type hook is opencode-only: a (hypothetical) claude body
        // carrying event_type must not be reinterpreted through the opencode
        // dictionary.
        let body = serde_json::json!({
            "provider": "claude",
            "event_type": "session.idle",
            "hook_event_name": "Stop",
        });
        let normalized = normalize_provider_body("claude", None, body).unwrap();
        assert_eq!(normalized["hook_event_name"], "Stop");
        assert!(normalized.get("native_event").is_none());
    }
}
