use serde::Deserialize;
use serde_json::{Map, Value};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Duration;

const MAX_STDIN_BYTES: usize = 1024 * 1024;

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
    let body: Value = if codewhale_env_only {
        Value::Object(Map::new())
    } else {
        let mut raw = Vec::new();
        std::io::stdin()
            .take((MAX_STDIN_BYTES + 1) as u64)
            .read_to_end(&mut raw)
            .map_err(|e| e.to_string())?;
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
    // ev.emotion to show matching expressions. This is a lightweight
    // keyword-based sniffer — never blocks, returns None when in doubt.
    let event_name_str = object
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
    let role = if event_name_str == "UserPromptSubmit" || event_name_str == "message_submit" {
        "user"
    } else if event_name_str == "PostToolUse"
        || event_name_str == "turn_end"
        || event_name_str == "Stop"
    {
        "assistant"
    } else {
        ""
    };
    if !text.is_empty() && !role.is_empty() {
        if let Some(emotion) = crate::emotion::detect_emotion(&text, role) {
            object.insert("emotion".into(), Value::from(emotion.as_str()));
        }
    }

    let event = event_name_str;
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
        let output = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script,
                &std::process::id().to_string(),
            ])
            .output()
            .ok()?;
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
        .or_else(|| object.get("hook_event_name").and_then(Value::as_str))
        .or_else(|| object.get("event").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();

    if provider == "codewhale" {
        apply_codewhale_env_fallback(object);
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
    } else {
        if !object.contains_key("hook_event_name") && !native_event.is_empty() {
            object.insert("hook_event_name".into(), Value::String(native_event));
        }
    }
    Ok(body)
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
    let meta = fs::metadata(&path).map_err(|e| format!("runtime unavailable: {e}"))?;
    if meta.len() > 16 * 1024 {
        return Err("runtime file too large".into());
    }
    let runtime: RuntimeFile = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
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
    let mut stream = TcpStream::connect(("127.0.0.1", runtime.port)).map_err(|e| e.to_string())?;
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
}
