use crate::model::{home_dir, ProviderStatus, Runtime};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

/// R22 (2026-07-30): get the current executable path with the Windows
/// `\\?\` prefix stripped. The prefix is added by `std::env::current_exe()`
/// on Windows for long-path support, but it breaks hook command execution
/// because CodeWhale's `cmd /C` wrapper and Claude's direct execution both
/// fail to parse the `\\?\` prefix correctly in quoted paths.
fn current_exe_clean() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        let s = exe.to_string_lossy();
        // R30: handle \\?\UNC\ as well as \\?\
        if let Some(stripped) = s.strip_prefix(r"\\?\UNC\") {
            return Ok(PathBuf::from(format!(r"\\{stripped}")));
        }
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            return Ok(PathBuf::from(stripped));
        }
    }
    Ok(exe)
}

const MAX_CONFIG_BYTES: u64 = 16 * 1024 * 1024;
const MARKER: &str = "--octopus-hook";
// Install only observer-safe lifecycle events. Claude Code exposes additional
// decision/replacement hooks (for example ConfigChange, UserPromptExpansion,
// WorktreeCreate and FileChanged), but registering a generic desktop observer
// there would silently participate in policy or high-volume content paths.
// MessageDisplay and PostToolBatch are also intentionally excluded because they
// may contain rendered conversation/tool payloads that are unnecessary for pet
// state and expand the privacy/size surface.
const CLAUDE_EVENTS: [&str; 23] = [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "Notification",
    "Elicitation",
    "ElicitationResult",
    "PermissionDenied",
    "TaskCreated",
    "TaskCompleted",
    "TeammateIdle",
    // R27 (2026-07-30): 5 new observer events added in Claude Code v2.1.219+.
    // These are non-blocking observer events — the hook runs in background
    // and the result is discarded. PermissionRequest is NOT here because it
    // is already installed separately with a 600s timeout and --permission flag.
    "Setup",
    "InstructionsLoaded",
    "CwdChanged",
    "WorktreeRemove",
    "DirectoryAdded",
];
const CODEX_EVENTS: [&str; 11] = [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Stop",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
];
// Current maintained CodeWhale events used by the fork. shell_env is
// intentionally excluded: it is a credential/environment mutation contract,
// not a lifecycle observer, and invoking the pet there would add shell latency.
// R22 (2026-07-30): message_submit removed from CODEWHALE_EVENTS — it is
// a STEERING event in CodeWhale (can block or replace the submitted text),
// not an observer. Our hook runs in background and posts to /state for
// observation, but CodeWhale treats message_submit as foreground-blocking.
// When the hook fails (e.g. HTTP server not yet up), CodeWhale reports
// "hook failed and blocked" and prevents the message from being sent.
const CODEWHALE_EVENTS: [&str; 9] = [
    "session_start",
    "session_end",
    "tool_call_before",
    "tool_call_after",
    "turn_end",
    "on_error",
    "mode_change",
    "subagent_spawn",
    "subagent_complete",
];
const CW_BEGIN: &str = "# >>> octopus:codewhale-hooks:v2 >>>";
const CW_END: &str = "# <<< octopus:codewhale-hooks:v2 <<<";
const AIDER_BEGIN: &str = "# >>> octopus:aider-notification:v2 >>>";
const AIDER_END: &str = "# <<< octopus:aider-notification:v2 <<<";
const OPENCODE_MARKER: &str = "octopus-opencode-plugin-v2";

#[derive(Debug, Default)]
pub struct InstallResult {
    pub added: usize,
    pub path: PathBuf,
    pub message: String,
}

pub fn sync_enabled(
    runtime: &Runtime,
    port: u16,
    token: &str,
    permission_enabled: bool,
    enabled: &[String],
) -> Vec<ProviderStatus> {
    let selected: HashSet<&str> = enabled.iter().map(String::as_str).collect();
    let mut statuses = Vec::new();
    for id in ["claude", "codewhale", "codex", "opencode", "aider"] {
        let result = if selected.contains(id) {
            install_provider(runtime, id, port, token, permission_enabled)
        } else {
            uninstall_provider(id).map(|path| InstallResult {
                path,
                message: "未启用；已清理 Octopus 自有 Hook，保留用户其他配置".into(),
                ..InstallResult::default()
            })
        };
        let status = status_from_result(id, selected.contains(id), result);
        runtime.set_provider_status(status.clone());
        statuses.push(status);
    }
    statuses
}

pub fn resync_current(runtime: &Runtime) -> Result<Vec<ProviderStatus>, String> {
    let raw = fs::read(&runtime.runtime_path)
        .map_err(|e| format!("runtime metadata unavailable: {e}"))?;
    let value: Value = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    let port = value
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|p| u16::try_from(p).ok())
        .ok_or("runtime port unavailable")?;
    let token = value
        .get("token")
        .and_then(Value::as_str)
        .ok_or("runtime token unavailable")?;
    let config = runtime.config();
    Ok(sync_enabled(
        runtime,
        port,
        token,
        config.perm_hook,
        &config.providers,
    ))
}

/// R36 (2026-07-31): verify-only startup check. The 0.5.12 carpet audit
/// P1-3 flagged that the old startup path called `sync_enabled` which
/// INSTALLS/UNINSTALLS hooks into external provider configs (e.g. Claude's
/// settings.json, CodeWhale's config.toml) without explicit user consent
/// at startup. This is a trust boundary issue — the user may not want
/// Octopus to modify external configs on every launch.
///
/// `verify_enabled` reads the same provider status (installed / missing /
/// error) WITHOUT writing anything. It reports drift so the UI can show
/// "hook missing — click to install" instead of silently installing.
/// The user must explicitly call `set_providers` (which triggers
/// `resync_current`) to actually install/uninstall.
///
/// The verify check uses the same `is_hook_installed` predicates that
/// `install_provider` would use, so the reported state matches what a
/// subsequent `resync_current` would produce.
pub fn verify_enabled(runtime: &Runtime, enabled: &[String]) -> Vec<ProviderStatus> {
    let selected: HashSet<&str> = enabled.iter().map(String::as_str).collect();
    let mut statuses = Vec::new();
    for id in ["claude", "codewhale", "codex", "opencode", "aider"] {
        let is_selected = selected.contains(id);
        let installed = is_hook_installed(id);
        let (permission_mode, capabilities) = provider_capabilities(id);
        let state = if !is_selected {
            "disabled"
        } else if installed {
            "installed"
        } else {
            // R36: report "missing" state so the UI can prompt the user
            // to install via set_providers. This is NOT an error — the
            // user simply hasn't installed the hook yet.
            "missing"
        };
        let message = if !is_selected {
            "未启用".to_string()
        } else if installed {
            "Hook 已安装".to_string()
        } else {
            "已启用但 Hook 未安装；保存 Provider 选择或点击重试以安装".to_string()
        };
        let status = ProviderStatus {
            id: id.into(),
            installed,
            state: state.into(),
            message,
            path: None,
            permission_mode: permission_mode.into(),
            capabilities,
        };
        runtime.set_provider_status(status.clone());
        statuses.push(status);
    }
    statuses
}

fn install_provider(
    runtime: &Runtime,
    id: &str,
    port: u16,
    token: &str,
    permission: bool,
) -> Result<InstallResult, String> {
    match id {
        "claude" => install_claude(runtime, port, token, permission),
        "codewhale" => install_codewhale(runtime),
        "codex" => install_codex(runtime),
        "opencode" => install_opencode(runtime),
        "aider" => install_aider(runtime),
        _ => Err(format!("unknown provider: {id}")),
    }
}

/// R36 (2026-07-31): check whether a provider's hook is currently installed,
/// WITHOUT modifying anything. Used by `verify_enabled` at startup so we
/// don't auto-modify external provider configs (the 0.5.12 carpet audit
/// P1-3 trust concern). Each provider has a different detection method:
///   - claude: settings.json contains the Octopus hook block marker
///   - codewhale: config.toml contains the CW_BEGIN marker
///   - codex: config.toml contains the Octopus hook block marker
///   - opencode: config file contains the OPENCODE_MARKER string
///   - aider: .aider.conf.yml contains the AIDER_BEGIN marker
fn is_hook_installed(id: &str) -> bool {
    match id {
        "claude" => {
            // Claude hooks live in ~/.claude/settings.json under the
            // hooks key. Check for the Octopus-owned marker.
            let path = home_dir().join(".claude").join("settings.json");
            file_contains(path, "octopus")
        }
        "codewhale" => {
            let path = codewhale_config_path();
            file_contains(path, CW_BEGIN)
        }
        "codex" => {
            // Codex hooks live in ~/.codex/config.toml.
            let path = home_dir().join(".codex").join("config.toml");
            file_contains(path, "octopus")
        }
        "opencode" => {
            // OpenCode plugin config — check for the marker string.
            let path = home_dir().join(".opencode").join("config.json");
            file_contains(path, OPENCODE_MARKER)
        }
        "aider" => {
            let path = home_dir().join(".aider.conf.yml");
            file_contains(path, AIDER_BEGIN)
        }
        _ => false,
    }
}

/// Helper: read a file and check if it contains a marker string.
/// Returns false if the file doesn't exist or can't be read (not an error —
/// the hook simply isn't installed).
fn file_contains(path: PathBuf, marker: &str) -> bool {
    fs::read_to_string(&path)
        .map(|content| content.contains(marker))
        .unwrap_or(false)
}

fn uninstall_provider(id: &str) -> Result<PathBuf, String> {
    match id {
        "claude" => uninstall_claude(),
        "codewhale" => uninstall_marker_file(&codewhale_config_path(), CW_BEGIN, CW_END),
        "codex" => uninstall_codex(),
        "opencode" => uninstall_opencode(),
        "aider" => {
            uninstall_marker_file(&home_dir().join(".aider.conf.yml"), AIDER_BEGIN, AIDER_END)
        }
        _ => Err(format!("unknown provider: {id}")),
    }
}

/// R13 (2026-07-30): public wrapper so the tray's "Uninstall Claude hooks"
/// menu item can remove a single provider's Octopus-owned hook block without
/// touching the user's other config. Mirrors the upstream Electron tray's
/// `tray.uninstallHook` action.
pub fn uninstall_provider_hooks(id: &str) -> Result<PathBuf, String> {
    uninstall_provider(id)
}

fn status_from_result(
    id: &str,
    enabled: bool,
    result: Result<InstallResult, String>,
) -> ProviderStatus {
    let (permission_mode, capabilities) = provider_capabilities(id);
    match result {
        Ok(result) => ProviderStatus {
            id: id.into(),
            installed: enabled,
            state: if enabled { "installed" } else { "disabled" }.into(),
            message: if result.message.is_empty() {
                if enabled {
                    "Hook 已同步".into()
                } else {
                    "未启用".into()
                }
            } else {
                result.message
            },
            path: if result.path.as_os_str().is_empty() {
                None
            } else {
                Some(result.path.to_string_lossy().into_owned())
            },
            permission_mode: permission_mode.into(),
            capabilities,
        },
        Err(error) => ProviderStatus {
            id: id.into(),
            installed: false,
            state: "error".into(),
            message: error,
            path: None,
            permission_mode: permission_mode.into(),
            capabilities,
        },
    }
}

fn provider_capabilities(id: &str) -> (&'static str, Value) {
    match id {
        "claude" => (
            "external",
            json!({"lifecycle":true,"permissionBubble":true,"metering":"transcript-ledger","trustReview":false,"bypassWarning":"bypassPermissions/--dangerously-skip-permissions can bypass approval prompts"}),
        ),
        "codewhale" => (
            "external",
            json!({"lifecycle":true,"permissionBubble":true,"metering":"rust-ledger","trustReview":false,"bypassWarning":"Full Access does not open approval prompts; hook ask cannot downgrade it"}),
        ),
        "codex" => (
            "external-after-trust",
            json!({"lifecycle":true,"permissionBubble":true,"metering":"pending","trustReview":true,"bypassWarning":"Hook changes require /hooks trust review before decisions take effect"}),
        ),
        "opencode" => (
            "observe-native",
            json!({"lifecycle":true,"permissionBubble":false,"metering":"pending","trustReview":false,"bypassWarning":"Permission decisions stay in OpenCode native UI"}),
        ),
        "aider" => (
            "terminal-native",
            json!({"lifecycle":"turn-end-only","permissionBubble":false,"metering":false,"trustReview":false,"bypassWarning":"Aider exposes completion notifications, not an external permission contract"}),
        ),
        _ => ("none", json!({})),
    }
}

/// Merge-safe Claude hook installation. Unrelated user hooks are retained.
pub fn install_claude(
    runtime: &Runtime,
    _port: u16,
    _token: &str,
    permission_enabled: bool,
) -> Result<InstallResult, String> {
    let settings_path = home_dir().join(".claude").join("settings.json");
    let mut settings = read_json_object(&settings_path, "Claude settings")?;
    let hooks = ensure_object(&mut settings, "hooks")?;
    let executable = current_exe_clean().map_err(|e| e.to_string())?;
    let command = hook_command(&executable, "claude", None, false);
    let mut result = InstallResult {
        path: settings_path.clone(),
        message: "Claude 生命周期与权限 Hook 已同步".into(),
        ..InstallResult::default()
    };
    remove_all_ours(hooks);
    for event in CLAUDE_EVENTS {
        add_group(hooks, event, command_hook(format!("{command} {event}"), 5));
        result.added += 1;
    }
    let pretool = hook_command_with_flags(&executable, "claude", Some("PreToolUse"), false, true);
    add_group(hooks, "PreToolUse", command_hook(pretool, 600));
    if permission_enabled {
        // Keep the runtime token out of hook configuration and process listings.
        // The native hook reads the 0600 runtime file and sends the token only
        // in an HTTP header to the loopback server.
        let permission = hook_command(&executable, "claude", Some("PermissionRequest"), true);
        add_group(hooks, "PermissionRequest", command_hook(permission, 600));
    }
    write_json_atomic(&settings_path, &Value::Object(settings))?;
    runtime.write_log("hooks", "Claude hooks synced");
    Ok(result)
}

fn uninstall_claude() -> Result<PathBuf, String> {
    let path = home_dir().join(".claude").join("settings.json");
    if !path.exists() {
        return Ok(path);
    }
    let mut settings = read_json_object(&path, "Claude settings")?;
    if let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) {
        remove_all_ours(hooks);
    }
    write_json_atomic(&path, &Value::Object(settings))?;
    Ok(path)
}

fn install_codewhale(runtime: &Runtime) -> Result<InstallResult, String> {
    let path = codewhale_config_path();
    let executable = current_exe_clean().map_err(|e| e.to_string())?;
    let mut block = String::from(CW_BEGIN);
    block.push('\n');
    for event in CODEWHALE_EVENTS {
        let permission = event == "tool_call_before";
        let command = hook_command(&executable, "codewhale", Some(event), permission);
        block.push_str("\n[[hooks.hooks]]\n");
        block.push_str(&format!(
            "name = \"octopus-{event}\"\nevent = \"{event}\"\n"
        ));
        block.push_str(&format!("command = {}\n", toml_string(&command)));
        block.push_str(&format!(
            "timeout_secs = {}\n",
            if permission { 600 } else { 5 }
        ));
        // A stale/missing binary must not turn a permission hook into an allow.
        // Observer hooks remain best-effort; the permission hook fails closed.
        block.push_str(&format!(
            "continue_on_error = {}\n",
            if permission { "false" } else { "true" }
        ));
        if !permission {
            block.push_str("background = true\n");
        }
    }
    block.push_str(CW_END);
    replace_marker_block(&path, CW_BEGIN, CW_END, &block)?;
    runtime.write_log("hooks", "CodeWhale hooks synced");
    Ok(InstallResult {
        added: CODEWHALE_EVENTS.len(),
        path,
        message: "CodeWhale 原生 TOML Hook 已同步；权限失败时回退到 ask".into(),
        ..InstallResult::default()
    })
}

fn install_codex(runtime: &Runtime) -> Result<InstallResult, String> {
    let path = home_dir().join(".codex").join("hooks.json");
    let mut root = read_json_object(&path, "Codex hooks")?;
    root.entry("description")
        .or_insert(json!("Octopus multi-agent desktop integration"));
    let hooks = ensure_object(&mut root, "hooks")?;
    remove_all_ours(hooks);
    let executable = current_exe_clean().map_err(|e| e.to_string())?;
    for event in CODEX_EVENTS {
        let permission = event == "PermissionRequest";
        let command = hook_command(&executable, "codex", Some(event), permission);
        let timeout = if event == "SessionEnd" {
            3
        } else if permission {
            600
        } else {
            5
        };
        add_group(hooks, event, command_hook(command, timeout));
    }
    write_json_atomic(&path, &Value::Object(root))?;
    runtime.write_log("hooks", "Codex hooks synced; /hooks trust review required");
    Ok(InstallResult {
        added: CODEX_EVENTS.len(),
        path,
        message: "Codex Hook 已写入；首次或变更后必须在 Codex 中运行 /hooks 审查并信任".into(),
        ..InstallResult::default()
    })
}

fn uninstall_codex() -> Result<PathBuf, String> {
    let path = home_dir().join(".codex").join("hooks.json");
    if !path.exists() {
        return Ok(path);
    }
    let mut root = read_json_object(&path, "Codex hooks")?;
    if let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) {
        remove_all_ours(hooks);
    }
    write_json_atomic(&path, &Value::Object(root))?;
    Ok(path)
}

fn install_opencode(runtime: &Runtime) -> Result<InstallResult, String> {
    let base = std::env::var_os("OPENCODE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".config").join("opencode"));
    let path = base.join("plugins").join("llmpet-octopus.js");
    let source = opencode_plugin_source();
    if let Ok(existing) = fs::read_to_string(&path) {
        if !existing.contains(OPENCODE_MARKER) {
            return Err(format!(
                "OpenCode plugin path already belongs to another plugin: {}",
                path.display()
            ));
        }
    }
    write_text_atomic(&path, source.as_bytes())?;
    runtime.write_log("hooks", "OpenCode ESM plugin synced");
    Ok(InstallResult {
        added: 1,
        path,
        message: "OpenCode ESM 插件已安装；权限事件仅观察，决策仍由 OpenCode 原生界面完成".into(),
        ..InstallResult::default()
    })
}

fn uninstall_opencode() -> Result<PathBuf, String> {
    let base = std::env::var_os("OPENCODE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".config").join("opencode"));
    let path = base.join("plugins").join("llmpet-octopus.js");
    if let Ok(raw) = fs::read_to_string(&path) {
        if raw.contains(OPENCODE_MARKER) {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(path)
}

fn install_aider(runtime: &Runtime) -> Result<InstallResult, String> {
    let path = home_dir().join(".aider.conf.yml");
    let current = fs::read_to_string(&path).unwrap_or_default();
    let stripped = strip_marker_block(&current, AIDER_BEGIN, AIDER_END)?;
    // Aider YAML config uses underscores (notifications_command); the CLI flag
    // uses hyphens (--notifications-command). Detect either form to avoid
    // clobbering a pre-existing foreign notification command.
    let foreign = stripped.lines().find(|line| {
        let t = line.trim();
        (t.starts_with("notifications_command:") || t.starts_with("notifications-command:"))
            && !t.contains(MARKER)
    });
    if let Some(line) = foreign {
        return Err(format!(
            "Aider 已配置其他 notifications_command，未覆盖：{}",
            line.trim()
        ));
    }
    let executable = current_exe_clean().map_err(|e| e.to_string())?;
    let command = hook_command(&executable, "aider", Some("turn_end"), false);
    // YAML key: notifications_command (underscore). The CLI flag is
    // --notifications-command (hyphen), but the config file uses underscore.
    let block = format!(
        "{AIDER_BEGIN}\nnotifications: true\nnotifications_command: {}\n{AIDER_END}",
        yaml_string(&command)
    );
    replace_marker_block(&path, AIDER_BEGIN, AIDER_END, &block)?;
    runtime.write_log("hooks", "Aider notification bridge synced");
    Ok(InstallResult {
        added: 1,
        path,
        message: "Aider 通知桥已安装；仅可靠提供回复完成事件，不接管终端内权限".into(),
        ..InstallResult::default()
    })
}

fn codewhale_config_path() -> PathBuf {
    if let Some(path) = std::env::var_os("CODEWHALE_CONFIG_PATH")
        .or_else(|| std::env::var_os("DEEPSEEK_CONFIG_PATH"))
    {
        return PathBuf::from(path);
    }
    if let Some(base) = std::env::var_os("CODEWHALE_HOME") {
        return PathBuf::from(base).join("config.toml");
    }
    let current = home_dir().join(".codewhale").join("config.toml");
    if current.exists() {
        return current;
    }
    let legacy = home_dir().join(".deepseek").join("config.toml");
    if legacy.exists() {
        return legacy;
    }
    current
}

fn hook_command(
    executable: &Path,
    provider: &str,
    event: Option<&str>,
    permission: bool,
) -> String {
    hook_command_with_flags(executable, provider, event, permission, false)
}

fn hook_command_with_flags(
    executable: &Path,
    provider: &str,
    event: Option<&str>,
    permission: bool,
    pretool: bool,
) -> String {
    let mut args = MARKER.to_string();
    if pretool {
        args.push_str(" --pretool");
    }
    args.push_str(&format!(" --provider {provider}"));
    if permission {
        args.push_str(" --permission");
    }
    if let Some(event) = event {
        args.push(' ');
        args.push_str(event);
    }

    #[cfg(target_os = "windows")]
    {
        let path = executable.to_string_lossy();
        // R22 (2026-07-30): CodeWhale's docs say hook commands are run via
        // "sh -c on Unix, cmd /C on Windows" — CodeWhale ALREADY wraps the
        // command. Adding another cmd.exe /D /S /C layer caused double-
        // wrapping that broke quoting and made message_submit hooks fail.
        // Claude and Codex use JSON config and execute the command string
        // directly, so they still need the cmd.exe wrapper.
        if provider == "codewhale" {
            return format!("\"{}\" {}", path, args);
        }
        return format!("cmd.exe /D /S /C \"\"{}\" {}\"", path, args);
    }
    #[cfg(not(target_os = "windows"))]
    {
        format!("{} {}", quote_command_path(executable), args)
    }
}

fn command_hook(command: String, timeout: u64) -> Value {
    #[cfg(target_os = "windows")]
    let windows_command = command.clone();
    // `mut` is only used on Windows (to insert commandWindows); on other
    // platforms the value is never mutated, hence the allow.
    #[allow(unused_mut)]
    let mut value = json!({"type":"command","command":command,"timeout":timeout,"statusMessage":"Updating Octopus"});
    #[cfg(target_os = "windows")]
    if let Some(object) = value.as_object_mut() {
        object.insert("commandWindows".into(), json!(windows_command));
    }
    value
}

#[cfg_attr(target_os = "windows", allow(dead_code))]
fn quote_command_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    #[cfg(target_os = "windows")]
    {
        return format!("\"{}\"", text.replace('\"', "\\\""));
    }
    #[cfg(not(target_os = "windows"))]
    {
        format!("'{}'", text.replace('\'', "'\"'\"'"))
    }
}

fn add_group(hooks: &mut Map<String, Value>, event: &str, desired: Value) {
    let groups = hooks.entry(event.to_string()).or_insert_with(|| json!([]));
    if let Some(groups) = groups.as_array_mut() {
        groups.push(json!({"matcher":"","hooks":[desired]}));
    }
}

fn remove_all_ours(hooks: &mut Map<String, Value>) {
    let events: Vec<String> = hooks.keys().cloned().collect();
    for event in events {
        let Some(groups) = hooks.get_mut(&event).and_then(Value::as_array_mut) else {
            continue;
        };
        groups.retain_mut(|group| {
            let Some(entries) = group
                .as_object_mut()
                .and_then(|o| o.get_mut("hooks"))
                .and_then(Value::as_array_mut)
            else {
                return true;
            };
            entries.retain(|entry| {
                let command = entry.get("command").and_then(Value::as_str).unwrap_or("");
                let url = entry.get("url").and_then(Value::as_str).unwrap_or("");
                !command.contains(MARKER)
                    && !["octopus-hook.js", "pretool-hook.js", "llmpet-hook.js"]
                        .iter()
                        .any(|m| command.contains(m))
                    && !(url.starts_with("http://127.0.0.1:413") && url.contains("/permission"))
            });
            !entries.is_empty()
        });
        if groups.is_empty() {
            hooks.remove(&event);
        }
    }
}

fn read_json_object(path: &Path, label: &str) -> Result<Map<String, Value>, String> {
    match fs::metadata(path) {
        Ok(meta) if meta.len() > MAX_CONFIG_BYTES => return Err(format!("{label} is too large")),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(error) => return Err(error.to_string()),
    }
    let value: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("invalid {label}: {e}"))?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{label} root must be an object"))
}

fn ensure_object<'a>(
    root: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    if !root.contains_key(key) {
        root.insert(key.into(), Value::Object(Map::new()));
    }
    root.get_mut(key)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("{key} must be an object"))
}

fn replace_marker_block(path: &Path, begin: &str, end: &str, block: &str) -> Result<(), String> {
    let existing = fs::read_to_string(path).unwrap_or_default();
    let mut clean = strip_marker_block(&existing, begin, end)?
        .trim_end()
        .to_string();
    if !clean.is_empty() {
        clean.push_str("\n\n");
    }
    clean.push_str(block);
    clean.push('\n');
    write_text_atomic(path, clean.as_bytes())
}

fn uninstall_marker_file(path: &Path, begin: &str, end: &str) -> Result<PathBuf, String> {
    if !path.exists() {
        return Ok(path.to_path_buf());
    }
    let existing = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let clean = strip_marker_block(&existing, begin, end)?;
    write_text_atomic(path, clean.as_bytes())?;
    Ok(path.to_path_buf())
}

fn strip_marker_block(input: &str, begin: &str, end: &str) -> Result<String, String> {
    let mut output = String::new();
    let mut inside = false;
    for (index, line) in input.lines().enumerate() {
        if line.trim() == begin {
            if inside {
                return Err(format!("nested Octopus marker at line {}", index + 1));
            }
            inside = true;
            continue;
        }
        if line.trim() == end {
            if !inside {
                return Err(format!(
                    "unmatched Octopus marker end at line {}",
                    index + 1
                ));
            }
            inside = false;
            continue;
        }
        if !inside {
            output.push_str(line);
            output.push('\n');
        }
    }
    if inside {
        return Err("unterminated Octopus marker block; configuration was not modified".into());
    }
    Ok(output)
}

fn toml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}
fn yaml_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    write_text_atomic(
        path,
        &serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?,
    )
}

fn write_text_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("config path has no parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    // Do NOT chmod the parent directory — for files like ~/.aider.conf.yml the
    // parent is $HOME, and changing its permissions to 0700 is an unacceptable
    // side effect. Only secure the temp file and the final file themselves.
    let temp = parent.join(format!(
        ".octopus.{}.{}.tmp",
        std::process::id(),
        crate::model::now_ms()
    ));
    fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
        // Windows rename cannot replace an existing file. Preserve the old
        // configuration until the new file is known to be in place; deleting
        // first can lose the user's entire config when antivirus/indexing holds
        // the destination between remove and rename.
        let backup = parent.join(format!(
            ".octopus.{}.{}.bak",
            std::process::id(),
            crate::model::now_ms()
        ));
        let had_original = path.exists();
        if had_original {
            fs::rename(path, &backup).map_err(|e| {
                let _ = fs::remove_file(&temp);
                format!("failed to preserve existing config: {e}")
            })?;
        }
        match fs::rename(&temp, path) {
            Ok(()) => {
                if had_original {
                    let _ = fs::remove_file(&backup);
                }
                Ok(())
            }
            Err(error) => {
                let _ = fs::remove_file(&temp);
                if had_original {
                    let _ = fs::rename(&backup, path);
                }
                Err(format!(
                    "failed to replace config; original restored: {error}"
                ))
            }
        }
    }
    #[cfg(not(windows))]
    {
        fs::rename(&temp, path).map_err(|e| e.to_string())
    }
}

fn opencode_plugin_source() -> &'static str {
    r#"// octopus-opencode-plugin-v2
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

async function send(payload) {
  try {
    const runtime = JSON.parse(await readFile(join(homedir(), ".octopus", "runtime.json"), "utf8"));
    if (runtime.app !== "octopus" || runtime.port < 41330 || runtime.port > 41334) return;
    await fetch(`http://127.0.0.1:${runtime.port}/state`, {
      method: "POST", headers: { "content-type": "application/json", "x-octopus-token": runtime.token, "x-octopus-server": "octopus" },
      body: JSON.stringify({ provider: "opencode", ...payload }), signal: AbortSignal.timeout(500)
    });
  } catch {}
}
function sid(event, directory) {
  return event?.properties?.sessionID || event?.properties?.sessionId || event?.sessionID || `opencode:${directory}`;
}
export const LLMPETPlugin = async ({ directory }) => ({
  event: async ({ event }) => {
    const map = {
      "session.created": ["SessionStart", "idle"], "session.compacted": ["PreCompact", "sweeping"],
      "session.deleted": ["SessionEnd", "sleeping"], "session.error": ["StopFailure", "error"],
      "session.idle": ["Stop", "attention"], "session.status": ["UserPromptSubmit", "thinking"],
      "permission.asked": ["Notification", "needsinput"], "permission.replied": ["PreToolUse", "working"]
    };
    const value = map[event.type]; if (!value) return;
    await send({ hook_event_name: value[0], state: value[1], session_id: sid(event, directory), cwd: directory });
  },
  "tool.execute.before": async (input) => send({ hook_event_name: "PreToolUse", state: "working", session_id: input.sessionID || `opencode:${directory}`, cwd: directory, tool_name: input.tool }),
  "tool.execute.after": async (input) => send({ hook_event_name: "PostToolUse", state: "working", session_id: input.sessionID || `opencode:${directory}`, cwd: directory, tool_name: input.tool })
});
"#
}
