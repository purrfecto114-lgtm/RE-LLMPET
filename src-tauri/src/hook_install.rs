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

pub(crate) const MAX_CONFIG_BYTES: u64 = 16 * 1024 * 1024;
const MARKER: &str = "--octopus-hook";
/// R41 (audit §10): stable ownership tag embedded in every hook command.
/// `remove_all_ours` checks for this to avoid matching user hooks that
/// happen to contain "octopus" in their command string. Before this,
/// ownership was inferred from `MARKER` ("--octopus-hook") + filename
/// patterns ("octopus-hook.js"), which could false-positive on user
/// hooks that mentioned octopus.
const HOOK_OWNER: &str = "--owner re-llmpet";
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
//
// R40.5 (audit P1-3): message_submit RESTORED as a background observer.
// The R22 removal was based on an outdated assumption that message_submit
// is always foreground-blocking. Current CodeWhale documentation
// (config.example.toml) confirms `background = true` makes the hook
// observer-only: "submitted and never awaited. The hook still gets
// [the payload]." It does NOT block, transform, or wait.
//
// The install function writes message_submit with:
//   background = true
//   continue_on_error = true
//   timeout_secs = 5 (short — observer doesn't need long)
// This gives us the most direct user-message observation without
// blocking CodeWhale's message submission.
const CODEWHALE_EVENTS: [&str; 10] = [
    "session_start",
    "session_end",
    "tool_call_before",
    "tool_call_after",
    "turn_end",
    "on_error",
    "mode_change",
    "subagent_spawn",
    "subagent_complete",
    "message_submit",
];
const CW_BEGIN: &str = "# >>> octopus:codewhale-hooks:v2 >>>";
const CW_END: &str = "# <<< octopus:codewhale-hooks:v2 <<<";
const AIDER_BEGIN: &str = "# >>> octopus:aider-notification:v2 >>>";
const AIDER_END: &str = "# <<< octopus:aider-notification:v2 <<<";
// R40 (2026-08-01): bumped marker to v3 because the plugin source
// changed in a backward-incompatible way (session.status mapping).
// Existing v2 files are detected by `is_octopus_marker` and replaced
// on the next sync_enabled() call — see `install_opencode()`.
const OPENCODE_MARKER: &str = "octopus-opencode-plugin-v3";
const OPENCODE_MARKER_LEGACY: &[&str] = &["octopus-opencode-plugin-v2"];

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
            // R40: the install_opencode() function writes the plugin to
            // `$OPENCODE_CONFIG_DIR/plugins/llmpet-octopus.js` (defaults to
            // `~/.config/opencode/plugins/llmpet-octopus.js`). The previous
            // check looked at `~/.opencode/config.json` — a path the
            // installer NEVER writes — so the "installed?" probe always
            // returned false, and the diagnostic silently misreported
            // OpenCode as "not installed" even when the plugin was present.
            // Fix: probe the actual plugin file path, and accept either the
            // current v3 marker or any legacy v2 marker.
            let base = std::env::var_os("OPENCODE_CONFIG_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| home_dir().join(".config").join("opencode"));
            let path = base.join("plugins").join("llmpet-octopus.js");
            match fs::read_to_string(&path) {
                Ok(raw) => {
                    raw.contains(OPENCODE_MARKER)
                        || OPENCODE_MARKER_LEGACY.iter().any(|m| raw.contains(m))
                }
                Err(_) => false,
            }
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

    // R40.1 (2026-08-01): the 0.5.19 `strip_legacy_codewhale_hooks` was
    // DISABLED. The 0.5.19 carpet audit (P0-2) proved the line-oriented
    // state machine could absorb user-owned `[provider]` / `[[models]]`
    // / arbitrary TOML tables into a legacy `[[hooks.hooks]]` body and
    // silently delete them when dropping the hook table. That is a data
    // corruption bug — losing a `[provider] api_key = "..."` block is
    // far worse than the original "message_submit blocked" symptom.
    //
    // Emergency closure for 0.5.20:
    //   1. Do NOT auto-run the legacy cleanup.
    //   2. Create a timestamped backup before any write.
    //   3. The diagnostic (in commands.rs) still DETECTS stale
    //      pre-R22 hooks and surfaces them as an issue with
    //      instructions, so the user knows they exist.
    //   4. A future R41 will reintroduce cleanup via a real TOML AST
    //      editor with exact ownership metadata, not a line scanner.
    //
    // The diagnostic-side detection (`stalePreR22Hooks` field in
    // commands.rs) is preserved — it tells the user "you have stale
    // message_submit hooks; here's how to manually remove them or
    // wait for R41". This is the safe trade-off: detect + inform
    // instead of detect + auto-mutate.
    //
    // R40.5 (audit P0-5): backup failure is now fail-closed. The previous
    // code logged and continued writing, which could corrupt user config
    // if the write also failed mid-way (no backup to restore from). Now
    // we abort the install entirely if backup fails — the user's existing
    // config is preserved untouched.
    if path.exists() {
        if let Err(err) = backup_codewhale_config(&path, runtime) {
            return Err(format!(
                "CodeWhale pre-write backup failed — aborting install to protect existing config: {err}. \
                 Check disk space, permissions, and antivirus locking. No changes were made."
            ));
        }
    }

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
    runtime.write_log(
        "hooks",
        "CodeWhale hooks synced (v2); legacy cleanup disabled in R40.1 (see audit P0-2)",
    );
    Ok(InstallResult {
        added: CODEWHALE_EVENTS.len(),
        path,
        message: "CodeWhale 原生 TOML Hook 已同步（含 background message_submit observer）；权限失败时回退到 ask。".into(),
        ..InstallResult::default()
    })
}

/// R40.1: create a timestamped backup of the CodeWhale config before
/// any write. Backups are placed alongside the original file with a
/// `.octopus-backup-<unix_ms>.toml` suffix. Old backups older than
/// 30 days are pruned on each call to prevent unbounded growth.
fn backup_codewhale_config(path: &Path, runtime: &Runtime) -> Result<(), String> {
    let parent = path.parent().ok_or("config path has no parent")?;
    let now_ms = crate::model::now_ms();
    let backup_name = format!(
        ".{}-octopus-backup-{}.toml",
        path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("config"),
        now_ms
    );
    let backup_path = parent.join(backup_name);
    fs::copy(path, &backup_path).map_err(|e| e.to_string())?;
    runtime.write_log(
        "hooks",
        &format!("CodeWhale config backed up to {}", backup_path.display()),
    );
    // Prune backups older than 30 days. Best-effort — failure to prune
    // must not block the install.
    if let Ok(entries) = fs::read_dir(parent) {
        let cutoff = now_ms.saturating_sub(30 * 24 * 60 * 60 * 1000);
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let name = match file_name.to_str() {
                Some(s) => s.to_string(),
                None => continue,
            };
            if !name.contains("-octopus-backup-") {
                continue;
            }
            // Extract the timestamp from the filename.
            if let Some(ts_str) = name
                .rsplit("-octopus-backup-")
                .next()
                .and_then(|s| s.strip_suffix(".toml"))
                .and_then(|s| s.parse::<u64>().ok())
            {
                if ts_str < cutoff {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }
    Ok(())
}

/// R40: scan a CodeWhale config.toml and remove any `[[hooks.hooks]]`
/// table whose `name` starts with `octopus-` BUT which is NOT inside the
/// current v2 marker block. This catches legacy v1 marker blocks and
/// any unmarked pre-R22 install residue (notably `octopus-message_submit`).
///
/// The function is intentionally line-oriented and tolerant of TOML
/// formatting variations (single vs double quotes, leading whitespace)
/// because pre-R22 installs were generated by different code paths and
/// may not match the exact formatting of the current installer.
fn strip_legacy_codewhale_hooks(path: &Path, messages: &mut Vec<String>) -> Result<(), String> {
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return Ok(()), // file doesn't exist yet — nothing to clean
    };

    // Two-pass approach for clarity:
    //   Pass 1: walk lines, group each `[[hooks.hooks]]` table into a
    //           contiguous block, classify it as KEEP / DROP.
    //           - DROP if the table is OUTSIDE the v2 marker block AND
    //             its `name` starts with `octopus-`.
    //           - Otherwise KEEP.
    //   Pass 2: emit the kept blocks (and all non-table lines) in order.
    #[derive(Clone)]
    enum Span {
        Raw(String), // a non-table line, kept verbatim
        Table {
            header: String,
            body: Vec<String>,
            keep: bool,
            name: String,
        },
    }

    let mut spans: Vec<Span> = Vec::new();
    let mut in_v2_block = false;
    let mut current_table: Option<(String, Vec<String>)> = None;

    let flush_table = |spans: &mut Vec<Span>, tbl: Option<(String, Vec<String>)>, in_v2: bool| {
        if let Some((header, body)) = tbl {
            let name = body
                .iter()
                .find_map(|l| parse_toml_string_value(l.trim(), "name"))
                .unwrap_or_default();
            let keep = in_v2 || !name.starts_with("octopus-");
            spans.push(Span::Table {
                header,
                body,
                keep,
                name,
            });
        }
    };

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed == CW_BEGIN {
            in_v2_block = true;
            // close any open table before the marker
            let tbl = current_table.take();
            flush_table(&mut spans, tbl, false); // not yet in v2
            spans.push(Span::Raw(line.to_string()));
            continue;
        }
        if trimmed == CW_END {
            // close any open table before the end marker
            let tbl = current_table.take();
            flush_table(&mut spans, tbl, in_v2_block);
            in_v2_block = false;
            spans.push(Span::Raw(line.to_string()));
            continue;
        }
        if trimmed.starts_with("[[hooks.hooks]]") {
            // start a new table — flush the previous one first
            let tbl = current_table.take();
            flush_table(&mut spans, tbl, in_v2_block);
            current_table = Some((line.to_string(), Vec::new()));
            continue;
        }
        if let Some((_, body)) = current_table.as_mut() {
            body.push(line.to_string());
        } else {
            spans.push(Span::Raw(line.to_string()));
        }
    }
    // flush trailing table
    flush_table(&mut spans, current_table.take(), in_v2_block);

    let mut output = String::with_capacity(raw.len());
    let mut changed = false;
    for span in spans {
        match span {
            Span::Raw(s) => {
                output.push_str(&s);
                output.push('\n');
            }
            Span::Table {
                header,
                body,
                keep,
                name,
            } => {
                if keep {
                    output.push_str(&header);
                    output.push('\n');
                    for b in &body {
                        output.push_str(b);
                        output.push('\n');
                    }
                } else {
                    changed = true;
                    messages.push(format!("removed legacy hook `{name}`"));
                }
            }
        }
    }
    if changed {
        write_text_atomic(path, output.as_bytes())?;
    }
    Ok(())
}

/// Parse `name = "value"` (or `name = 'value'`) from a single TOML line.
/// Returns None if the line doesn't match `key = "..."`.
fn parse_toml_string_value(line: &str, key: &str) -> Option<String> {
    let trimmed = line.trim();
    let prefix = format!("{key} =");
    if !trimmed.starts_with(&prefix) {
        return None;
    }
    let rest = trimmed[prefix.len()..].trim_start();
    if let Some(stripped) = rest.strip_prefix('"') {
        let end = stripped.find('"')?;
        return Some(stripped[..end].to_string());
    }
    if let Some(stripped) = rest.strip_prefix('\'') {
        let end = stripped.find('\'')?;
        return Some(stripped[..end].to_string());
    }
    None
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
        // R40: accept the current marker OR any legacy marker we own.
        // Legacy markers are listed in OPENCODE_MARKER_LEGACY; if the
        // existing file matches one of them, we transparently overwrite
        // with the v3 source. If it matches neither current nor legacy,
        // the path is owned by another plugin — refuse to clobber.
        let owns_current = existing.contains(OPENCODE_MARKER);
        let owns_legacy = OPENCODE_MARKER_LEGACY
            .iter()
            .any(|marker| existing.contains(marker));
        if !owns_current && !owns_legacy {
            return Err(format!(
                "OpenCode plugin path already belongs to another plugin: {}",
                path.display()
            ));
        }
    }
    write_text_atomic(&path, source.as_bytes())?;
    runtime.write_log("hooks", "OpenCode ESM plugin synced (v3)");
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
        // R40: uninstall accepts both current and legacy markers.
        let owns_current = raw.contains(OPENCODE_MARKER);
        let owns_legacy = OPENCODE_MARKER_LEGACY
            .iter()
            .any(|marker| raw.contains(marker));
        if owns_current || owns_legacy {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(path)
}

fn install_aider(runtime: &Runtime) -> Result<InstallResult, String> {
    let path = home_dir().join(".aider.conf.yml");
    // R44 (audit P0-03): do NOT use unwrap_or_default() — if the file
    // exists but is unreadable (permissions, I/O error, non-UTF-8),
    // treating it as empty would cause the subsequent write to overwrite
    // the user's real config with only our marker block. Only
    // ErrorKind::NotFound is safe to treat as "new file".
    let current = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!(
            "Aider config exists but cannot be read ({}). Aborting to protect existing config. No changes were made.",
            e
        )),
    };
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
    // R41: embed ownership tag so remove_all_ours can do exact matching.
    args.push_str(&format!(" {HOOK_OWNER}"));
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
                // R41: primary ownership check — the --owner re-llmpet tag.
                // This is exact and cannot false-positive on user hooks.
                if command.contains("re-llmpet") {
                    return false; // ours — remove
                }
                // Fallback: legacy markers for hooks installed before R41.
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
    // R44 (audit P0-03): only NotFound is safe to treat as empty.
    // Unreadable files must fail closed to prevent data loss.
    let existing = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            return Err(format!(
                "Config file exists but cannot be read ({}). Aborting to protect existing config.",
                e
            ))
        }
    };
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
    r#"// octopus-opencode-plugin-v3
// R40 (2026-08-01): rewrite of the OpenCode plugin event mapping.
//
// Root-cause analysis (systematic-debugging Phase 1):
//   The v2 plugin mapped `session.status` -> `UserPromptSubmit`. OpenCode
//   emits `session.status` for EVERY status transition (thinking → running
//   → tool-use → thinking → idle), so every tool call indirectly fired
//   `UserPromptSubmit`. The Rust http_server maps `UserPromptSubmit` to
//   `{kind:"user-turn"}`, which the pet renders as the "📨 收到新任务！"
//   bubble. Net effect: every tool call → "received new task" spam.
//
//   There is NO dedicated "user submitted prompt" event in OpenCode's
//   plugin API (verified via web-search of opencode.ai/docs and
//   smithery.ai skills). The closest semantic is `session.idle` AFTER
//   user input, but that is itself fired whenever the agent goes idle
//   (including after every assistant turn). So any mapping to
//   `UserPromptSubmit` will over-fire.
//
// Fix:
//   - DROP the `session.status -> UserPromptSubmit` mapping entirely.
//     The pet still gets thinking/working/attention transitions via the
//     dedicated `tool.execute.before/after` and `session.idle` hooks.
//   - Map `session.status` to a generic `state` event with the raw
//     status string, so the Rust server can do state aggregation without
//     raising a fake "user-turn".
//   - `tool.execute.before/after` are kept; they already produce the
//     correct `{kind:"operation"}` payload on the Rust side.
//   - `permission.asked/replied` are kept; they drive the waiting /
//     needsinput UI.
//   - Tighten `sid()` to read `input.metadata.sessionID` (the actual
//     field OpenCode v0.9.x passes to tool hooks) before falling back
//     to `input.sessionID` and the directory key.
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
function sidFromEvent(event, directory) {
  return event?.properties?.sessionID
    || event?.properties?.sessionId
    || event?.sessionID
    || event?.metadata?.sessionID
    || `opencode:${directory}`;
}
function sidFromToolInput(input, directory) {
  // OpenCode v0.9.x: tool hooks receive { tool, metadata: { sessionID, ... } }
  // Older builds used input.sessionID at the top level. Accept both.
  return input?.metadata?.sessionID
    || input?.sessionID
    || input?.sessionId
    || `opencode:${directory}`;
}
export const LLMPETPlugin = async ({ directory }) => ({
  event: async ({ event }) => {
    // R40: `session.status` MUST NOT be mapped to `UserPromptSubmit` —
    // that caused the "every tool call = received new task" regression.
    //
    // R40.1 (audit P1-2): the 0.5.19 plugin hardcoded `state: "thinking"`
    // for every `session.status` event, ignoring the actual status. This
    // made idle/retry/busy transitions all look like "thinking" and could
    // overwrite correct working/attention/error states. Fix: read the
    // actual status from `event.properties.status` (OpenCode v0.9.x
    // payload shape, verified via opencode.school lessons/plugins docs
    // and the smithery.ai opencode-sdk-development skill). Map the raw
    // status string to our internal state vocabulary; unknown values
    // are forwarded as-is so the server can decide.
    const fixedMap = {
      "session.created": ["SessionStart", "idle"],
      "session.compacted": ["PreCompact", "sweeping"],
      "session.deleted": ["SessionEnd", "sleeping"],
      "session.error": ["StopFailure", "error"],
      "session.idle": ["Stop", "attention"],
      "permission.asked": ["Notification", "needsinput"],
      "permission.replied": ["PreToolUse", "working"]
    };
    if (event.type === "session.status") {
      // R40.5 (audit P1-2): OpenCode v0.9.x SDK sends `properties.status`
      // as an OBJECT, not a string. The shape is:
      //   { type: "idle" }
      //   { type: "busy" }
      //   { type: "retry", attempt: number, message: string, next: number }
      // The previous code did `stateMap[raw]` where `raw` was the object,
      // producing `[object Object]` as the key and failing to map. Fix:
      // extract `.type` from the object; fall back to string for older
      // builds that sent a bare string.
      const status = event?.properties?.status ?? event?.status;
      const raw = typeof status === "string"
        ? status
        : (status?.type ?? "unknown");
      const retryMeta = (typeof status === "object" && status?.type === "retry")
        ? { attempt: status.attempt, message: status.message, next: status.next }
        : null;
      // Map known OpenCode statuses to our internal state vocabulary.
      const stateMap = {
        busy: "working",
        working: "working",
        running: "working",
        idle: "attention",
        waiting: "waiting",
        retry: "error",
        error: "error"
      };
      const mapped = stateMap[raw] || raw;
      const payload = {
        hook_event_name: "SessionStatus",
        state: mapped,
        status_raw: raw,
        session_id: sidFromEvent(event, directory),
        cwd: directory
      };
      if (retryMeta) payload.retry = retryMeta;
      await send(payload);
      return;
    }
    const value = fixedMap[event.type]; if (!value) return;
    await send({
      hook_event_name: value[0],
      state: value[1],
      session_id: sidFromEvent(event, directory),
      cwd: directory
    });
  },
  "tool.execute.before": async (input) => send({
    hook_event_name: "PreToolUse",
    state: "working",
    session_id: sidFromToolInput(input, directory),
    cwd: directory,
    tool_name: input?.tool || input?.toolName || "tool"
  }),
  "tool.execute.after": async (input) => send({
    hook_event_name: "PostToolUse",
    state: "working",
    session_id: sidFromToolInput(input, directory),
    cwd: directory,
    tool_name: input?.tool || input?.toolName || "tool"
  })
});
"#
}
