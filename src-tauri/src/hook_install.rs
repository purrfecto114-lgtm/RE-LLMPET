use crate::model::{home_dir, now_ms, ProviderStatus, Runtime, APP_DIR_NAME};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

// R44 Phase 0C (2026-08-03): unified backup + install receipt.
//
// User requirement: "不要破坏原本 hooks（创建备份，注意备份的数量）" —
// "Do not break existing hooks: create backups; mind the backup count."
//
// Before Phase 0C only CodeWhale had a pre-write backup. Claude, Codex,
// and Aider wrote directly to the user's external config file. If the
// write failed mid-way (atomic rename was already in place, but a buggy
// serializer could still emit partial JSON), or if our `remove_all_ours`
// accidentally matched a user hook (we already narrowed ownership, but
// defense in depth), the user's config was gone with no recovery path.
//
// Phase 0C closes that gap:
//   1. `backup_config_file()` — generic, works for any file extension.
//      Fail-closed: returns Err if the file exists and backup fails.
//   2. `write_install_receipt()` — records what we installed (provider,
//      events, path, backup path, version, timestamp, content hash).
//      Stored under `~/.re-llmpet/receipts/<provider>-<ts>.json`.
//      Capped at 20 most-recent per provider.
//   3. `read_install_receipts()` — returns the latest receipt per
//      provider, for diagnostics and Phase 0D uninstall confirmation.
const BACKUP_RETENTION: usize = 5;
const RECEIPT_RETENTION: usize = 20;
const RECEIPTS_DIR_NAME: &str = "receipts";

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
const LEGACY_MARKER: &str = "--re-llmpet-hook";
/// Stable ownership tags embedded in hook commands. New installs use the
/// Octopus name; the legacy tag remains cleanup-only so existing users can
/// migrate without leaving duplicate hooks behind.
const HOOK_OWNER: &str = "--owner octopus";
const LEGACY_HOOK_OWNER: &str = "--owner re-llmpet";
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
const CW_BEGIN: &str = "# >>> octopus:codewhale-hooks:v4 >>>";
const CW_END: &str = "# <<< octopus:codewhale-hooks:v4 <<<";
const CW_LEGACY_BEGIN: &str = "# >>> re-llmpet:codewhale-hooks:v3 >>>";
const CW_LEGACY_END: &str = "# <<< re-llmpet:codewhale-hooks:v3 <<<";
const CW_MARKERS: &[(&str, &str)] = &[(CW_BEGIN, CW_END), (CW_LEGACY_BEGIN, CW_LEGACY_END)];
const AIDER_BEGIN: &str = "# >>> octopus:aider-notification:v4 >>>";
const AIDER_END: &str = "# <<< octopus:aider-notification:v4 <<<";
const AIDER_LEGACY_BEGIN: &str = "# >>> re-llmpet:aider-notification:v3 >>>";
const AIDER_LEGACY_END: &str = "# <<< re-llmpet:aider-notification:v3 <<<";
const AIDER_MARKERS: &[(&str, &str)] = &[
    (AIDER_BEGIN, AIDER_END),
    (AIDER_LEGACY_BEGIN, AIDER_LEGACY_END),
];
const OPENCODE_MARKER: &str = "octopus-opencode-plugin-v3";
const OPENCODE_MARKER_LEGACY: &[&str] =
    &["re-llmpet-opencode-plugin-v1", "octopus-opencode-plugin-v2"];

#[derive(Debug, Default)]
pub struct InstallResult {
    pub added: usize,
    pub path: PathBuf,
    pub message: String,
}

/// R44 0.5.39 (roadmap v5 §3): typed cleanup result replacing
/// `Result<PathBuf, String>`. The old type could only express "ok (here's
/// the path)" or "error (string)" — it could NOT distinguish:
///   - file didn't exist (clean, nothing to remove)
///   - file existed and we removed our block (true success)
///   - file existed but wasn't ours (refused to touch, user must inspect)
///   - file existed, we removed our block, but the file hash changed
///     unexpectedly (possible residue)
///   - file couldn't be read (manual action required)
///
/// The roadmap v5 §3 requires five providers to uniformly return this
/// enum so the IPC layer can report accurate status to the UI instead
/// of collapsing everything to "Ok" or "Err".
#[derive(Debug, Clone)]
pub enum CleanupResult {
    /// Our hook block was found and successfully removed.
    Removed { path: PathBuf },
    /// File didn't exist — nothing to clean. Not an error.
    NotFound { path: PathBuf },
    /// File exists but doesn't contain our marker — not ours, left intact.
    Unowned { path: PathBuf },
    /// File existed and contained our marker, but after removal the file
    /// hash differs from what we expected (possible residue or concurrent
    /// edit). The block was removed but the user should verify.
    /// Not currently constructed by any cleanup path (reserved for Phase 0D
    /// drift verification); kept as a public status contract.
    #[allow(dead_code)]
    Changed { path: PathBuf },
    /// The path itself changed (symlink, env var, moved config dir)
    /// between install and uninstall. Refused to write; user must inspect.
    /// Not currently constructed by any cleanup path (reserved for Phase 0D
    /// uninstall verification); kept as a public status contract.
    #[allow(dead_code)]
    PathDrift { expected: PathBuf, actual: PathBuf },
    /// File exists but can't be read (permissions, I/O error, non-UTF-8).
    /// No changes made. User must fix permissions and retry.
    Unreadable { path: PathBuf, error: String },
    /// Uninstall partially succeeded but residue remains (e.g. marker
    /// block removed but a stale hook entry outside the block survives).
    Residue { path: PathBuf, detail: String },
    /// Uninstall requires manual action that the code can't safely
    /// automate (e.g. TOML parse failed mid-block, or file is locked).
    ManualActionRequired { path: PathBuf, detail: String },
}

impl CleanupResult {
    /// Convert to a JSON value for IPC responses. Includes a `status`
    /// string (matching the enum variant name) and a `path` field.
    pub fn to_json(&self) -> Value {
        match self {
            CleanupResult::Removed { path } => json!({
                "status": "removed",
                "path": path.to_string_lossy(),
            }),
            CleanupResult::NotFound { path } => json!({
                "status": "notFound",
                "path": path.to_string_lossy(),
            }),
            CleanupResult::Unowned { path } => json!({
                "status": "unowned",
                "path": path.to_string_lossy(),
                "message": "File exists but is not owned by Octopus; left intact",
            }),
            CleanupResult::Changed { path } => json!({
                "status": "changed",
                "path": path.to_string_lossy(),
                "message": "Hook block removed but file hash differs from expected; verify residue",
            }),
            CleanupResult::PathDrift { expected, actual } => json!({
                "status": "pathDrift",
                "expected": expected.to_string_lossy(),
                "actual": actual.to_string_lossy(),
                "message": "Config path changed between install and uninstall; refused to write",
            }),
            CleanupResult::Unreadable { path, error } => json!({
                "status": "unreadable",
                "path": path.to_string_lossy(),
                "error": error,
                "message": "File exists but cannot be read; fix permissions and retry",
            }),
            CleanupResult::Residue { path, detail } => json!({
                "status": "residue",
                "path": path.to_string_lossy(),
                "detail": detail,
                "message": "Partial cleanup; residue remains",
            }),
            CleanupResult::ManualActionRequired { path, detail } => json!({
                "status": "manualActionRequired",
                "path": path.to_string_lossy(),
                "detail": detail,
                "message": "Manual cleanup required",
            }),
        }
    }

    /// True if the result represents a successful cleanup (Removed or
    /// NotFound). Used by bulk uninstall to compute `allHooksVerifiedAbsent`.
    pub fn is_clean(&self) -> bool {
        matches!(
            self,
            CleanupResult::Removed { .. } | CleanupResult::NotFound { .. }
        )
    }

    /// True if the result represents a hard failure (Unreadable or
    /// ManualActionRequired). Soft failures (Unowned, Changed, Residue,
    /// PathDrift) leave the file in a known state and don't block other
    /// providers.
    pub fn is_hard_failure(&self) -> bool {
        matches!(
            self,
            CleanupResult::Unreadable { .. } | CleanupResult::ManualActionRequired { .. }
        )
    }
}

/// R44 0.5.41: return the config file path for a provider (for status
/// reporting when idempotent-sync skips the install). This is the same
/// path that `install_*` writes to and the hook-presence checks inspect.
fn provider_config_path(id: &str) -> PathBuf {
    match id {
        "claude" => home_dir().join(".claude").join("settings.json"),
        "codewhale" => codewhale_config_path(),
        "codex" => home_dir().join(".codex").join("hooks.json"),
        "opencode" => opencode_plugin_path(),
        "aider" => home_dir().join(".aider.conf.yml"),
        _ => PathBuf::new(),
    }
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
            // R44 0.5.41: idempotent sync. If the hook is already installed,
            // skip the backup + write + receipt cycle. The hook command
            // (`--provider X EventName`) doesn't contain port/token (those
            // are read from runtime.json at invocation time), so re-writing
            // the same command is a no-op that just creates churn (backup
            // files + receipts). The 5-backup cap prevents unbounded growth,
            // but skipping the write entirely is cleaner.
            //
            // Exact legacy ownership is not treated as current here. An
            // explicit resync rewrites those blocks to Octopus markers while
            // startup verification remains read-only.
            if is_current_hook_installed(id) {
                Ok(InstallResult {
                    path: provider_config_path(id),
                    message: "Hook 已安装（幂等跳过）".into(),
                    ..InstallResult::default()
                })
            } else {
                install_provider(runtime, id, port, token, permission_enabled)
            }
        } else {
            // R44 0.5.39: cleanup_provider returns CleanupResult. Convert
            // to InstallResult for the status_from_result helper. The
            // cleanup's path + a human-readable message are extracted
            // from the CleanupResult variant.
            let cleanup = cleanup_provider(id);
            let path = match &cleanup {
                CleanupResult::Removed { path }
                | CleanupResult::NotFound { path }
                | CleanupResult::Unowned { path }
                | CleanupResult::Changed { path }
                | CleanupResult::Residue { path, .. }
                | CleanupResult::Unreadable { path, .. }
                | CleanupResult::ManualActionRequired { path, .. } => path.clone(),
                CleanupResult::PathDrift { actual, .. } => actual.clone(),
            };
            let message = match &cleanup {
                CleanupResult::Removed { .. } => {
                    "未启用；已清理 Octopus 自有 Hook，保留用户其他配置"
                }
                CleanupResult::NotFound { .. } => "未启用；无 Hook 需要清理",
                CleanupResult::Unowned { .. } => "未启用；配置文件存在但不属于 Octopus，未修改",
                CleanupResult::Changed { .. } => "未启用；Hook 块已移除但检测到残留，请检查",
                CleanupResult::Residue { detail, .. } => detail.as_str(),
                CleanupResult::PathDrift { .. } => "未启用；配置路径发生变化，未执行清理",
                CleanupResult::Unreadable { error, .. } => error.as_str(),
                CleanupResult::ManualActionRequired { detail, .. } => detail.as_str(),
            };
            Ok(InstallResult {
                added: 0,
                path,
                message: message.into(),
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HookPresence {
    Missing,
    Legacy,
    Current,
    Mixed,
}

fn marker_presence(content: &str, current: &[&str], legacy: &[&str]) -> HookPresence {
    let has_current = current.iter().any(|marker| content.contains(marker));
    let has_legacy = legacy.iter().any(|marker| content.contains(marker));
    match (has_current, has_legacy) {
        (true, true) => HookPresence::Mixed,
        (true, false) => HookPresence::Current,
        (false, true) => HookPresence::Legacy,
        (false, false) => HookPresence::Missing,
    }
}

fn file_marker_presence(path: impl AsRef<Path>, current: &[&str], legacy: &[&str]) -> HookPresence {
    fs::read_to_string(path)
        .map(|content| marker_presence(&content, current, legacy))
        .unwrap_or(HookPresence::Missing)
}

fn block_marker_presence(
    content: &str,
    current: (&str, &str),
    legacy: &[(&str, &str)],
) -> HookPresence {
    let current_complete = content.contains(current.0) && content.contains(current.1);
    let legacy_complete = legacy
        .iter()
        .any(|(begin, end)| content.contains(begin) && content.contains(end));
    let any_current = content.contains(current.0) || content.contains(current.1);
    let any_legacy = legacy
        .iter()
        .any(|(begin, end)| content.contains(begin) || content.contains(end));

    match (current_complete, legacy_complete, any_current, any_legacy) {
        (true, true, _, _) => HookPresence::Mixed,
        (true, false, _, true) => HookPresence::Mixed,
        (true, false, _, false) => HookPresence::Current,
        (false, true, _, _) => HookPresence::Legacy,
        (false, false, true, _) | (false, false, false, true) => HookPresence::Legacy,
        (false, false, false, false) => HookPresence::Missing,
    }
}

fn file_block_presence(
    path: impl AsRef<Path>,
    current: (&str, &str),
    legacy: &[(&str, &str)],
) -> HookPresence {
    fs::read_to_string(path)
        .map(|content| block_marker_presence(&content, current, legacy))
        .unwrap_or(HookPresence::Missing)
}

/// Read-only ownership probe. Startup verification accepts both current and
/// exact legacy ownership so existing integrations remain visible, while an
/// explicit resync can distinguish legacy files and migrate them.
fn hook_presence(id: &str) -> HookPresence {
    match id {
        "claude" => file_marker_presence(
            home_dir().join(".claude").join("settings.json"),
            &[MARKER, HOOK_OWNER],
            &[LEGACY_MARKER, LEGACY_HOOK_OWNER],
        ),
        "codewhale" => file_block_presence(
            codewhale_config_path(),
            (CW_BEGIN, CW_END),
            &[(CW_LEGACY_BEGIN, CW_LEGACY_END)],
        ),
        "codex" => file_marker_presence(
            home_dir().join(".codex").join("hooks.json"),
            &[MARKER, HOOK_OWNER],
            &[LEGACY_MARKER, LEGACY_HOOK_OWNER],
        ),
        "opencode" => {
            let base = std::env::var_os("OPENCODE_CONFIG_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| home_dir().join(".config").join("opencode"));
            file_marker_presence(
                base.join("plugins").join("llmpet-hook.js"),
                &[OPENCODE_MARKER],
                OPENCODE_MARKER_LEGACY,
            )
        }
        "aider" => file_block_presence(
            home_dir().join(".aider.conf.yml"),
            (AIDER_BEGIN, AIDER_END),
            &[(AIDER_LEGACY_BEGIN, AIDER_LEGACY_END)],
        ),
        _ => HookPresence::Missing,
    }
}

fn is_hook_installed(id: &str) -> bool {
    hook_presence(id) != HookPresence::Missing
}

fn is_current_hook_installed(id: &str) -> bool {
    hook_presence(id) == HookPresence::Current
}

/// Helper: read a file and check if it contains a marker string.
/// Returns false if the file doesn't exist or can't be read (not an error —
/// the hook simply isn't installed).
#[allow(dead_code)]
fn file_contains(path: impl AsRef<Path>, marker: &str) -> bool {
    fs::read_to_string(path)
        .map(|content| content.contains(marker))
        .unwrap_or(false)
}

fn contains_any_marker(content: &str, markers: &[(&str, &str)]) -> bool {
    markers.iter().any(|(begin, _)| content.contains(begin))
}

#[allow(dead_code)]
fn file_contains_any_marker(path: impl AsRef<Path>, markers: &[(&str, &str)]) -> bool {
    fs::read_to_string(path)
        .map(|content| contains_any_marker(&content, markers))
        .unwrap_or(false)
}

pub(crate) fn codewhale_config_has_owned_block(content: &str) -> bool {
    contains_any_marker(content, CW_MARKERS)
}

pub(crate) fn is_codewhale_marker_begin(line: &str) -> bool {
    let line = line.trim();
    CW_MARKERS.iter().any(|(begin, _)| line == *begin)
}

pub(crate) fn is_codewhale_marker_end(line: &str) -> bool {
    let line = line.trim();
    CW_MARKERS.iter().any(|(_, end)| line == *end)
}

/// R44 0.5.39 (roadmap v5 §3+§4): unified cleanup pipeline returning
/// `CleanupResult` instead of `Result<PathBuf, String>`. The bulk
/// uninstall path calls this same function in a loop — no separate
/// weak-logic bulk path.
fn cleanup_provider(id: &str) -> CleanupResult {
    cleanup_provider_with_path(id, None)
}

/// R44 0.5.41: receipt-driven uninstall. When `receipt_path` is Some,
/// the cleanup uses the path recorded in the install receipt instead of
/// re-deriving from environment variables. This fixes the OpenCode/
/// CodeWhale env-var drift bug: if OPENCODE_CONFIG_DIR was set at install
/// time but unset (or different) at uninstall time, the old code would
/// look in the wrong place and leave the hook behind.
///
/// When `receipt_path` is None (sync_enabled path, no receipt available),
/// falls back to env-var-derived paths (current behavior).
fn cleanup_provider_with_path(id: &str, receipt_path: Option<&Path>) -> CleanupResult {
    match id {
        "claude" => {
            // Claude's path is always ~/.claude/settings.json (no env var
            // override), so receipt path is the same as derived path.
            // Use receipt path if available for consistency.
            let path = receipt_path
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| home_dir().join(".claude").join("settings.json"));
            uninstall_claude_at(&path)
        }
        "codewhale" => {
            let path = receipt_path
                .map(|p| p.to_path_buf())
                .unwrap_or_else(codewhale_config_path);
            uninstall_marker_variants(&path, CW_MARKERS)
        }
        "codex" => {
            let path = receipt_path
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| home_dir().join(".codex").join("hooks.json"));
            uninstall_codex_at(&path)
        }
        "opencode" => {
            let path = receipt_path
                .map(|p| p.to_path_buf())
                .unwrap_or_else(opencode_plugin_path);
            uninstall_opencode_at(&path)
        }
        "aider" => {
            let path = receipt_path
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| home_dir().join(".aider.conf.yml"));
            uninstall_marker_variants(&path, AIDER_MARKERS)
        }
        _ => CleanupResult::ManualActionRequired {
            path: PathBuf::new(),
            detail: format!("unknown provider: {id}"),
        },
    }
}

/// R44 0.5.41: derive the OpenCode plugin path from env vars (used when
/// no receipt is available). Extracted from uninstall_opencode for reuse.
fn opencode_plugin_path() -> PathBuf {
    let base = std::env::var_os("OPENCODE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".config").join("opencode"));
    base.join("plugins").join("llmpet-hook.js")
}

fn finish_json_hook_cleanup(path: &Path) -> CleanupResult {
    let post_raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) => {
            return CleanupResult::Unreadable {
                path: path.to_path_buf(),
                error: format!("post-clean verify read failed: {error}"),
            }
        }
    };
    let post: Value = match serde_json::from_str(&post_raw) {
        Ok(value) => value,
        Err(error) => {
            return CleanupResult::ManualActionRequired {
                path: path.to_path_buf(),
                detail: format!("post-clean JSON verify failed: {error}"),
            }
        }
    };
    if json_config_contains_our_hooks(&post) {
        CleanupResult::Residue {
            path: path.to_path_buf(),
            detail: "Octopus-owned hook remains after cleanup".into(),
        }
    } else {
        CleanupResult::Removed {
            path: path.to_path_buf(),
        }
    }
}

/// R44 0.5.41: Claude uninstall at a specific path (receipt-driven).
fn uninstall_claude_at(path: &Path) -> CleanupResult {
    if !path.exists() {
        return CleanupResult::NotFound {
            path: path.to_path_buf(),
        };
    }
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            return CleanupResult::Unreadable {
                path: path.to_path_buf(),
                error: e.to_string(),
            }
        }
    };
    let mut settings: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            return CleanupResult::ManualActionRequired {
                path: path.to_path_buf(),
                detail: format!("settings.json is not valid JSON: {e}. Refusing to overwrite; manual cleanup required."),
            }
        }
    };
    if !json_config_contains_our_hooks(&settings) {
        return CleanupResult::Unowned {
            path: path.to_path_buf(),
        };
    }
    if let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) {
        remove_all_ours(hooks);
    }
    if let Err(e) = write_json_atomic(path, &settings) {
        return CleanupResult::ManualActionRequired {
            path: path.to_path_buf(),
            detail: format!("write failed: {e}"),
        };
    }
    finish_json_hook_cleanup(path)
}

/// R44 0.5.41: Codex uninstall at a specific path (receipt-driven).
fn uninstall_codex_at(path: &Path) -> CleanupResult {
    if !path.exists() {
        return CleanupResult::NotFound {
            path: path.to_path_buf(),
        };
    }
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            return CleanupResult::Unreadable {
                path: path.to_path_buf(),
                error: e.to_string(),
            }
        }
    };
    let mut root: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            return CleanupResult::ManualActionRequired {
                path: path.to_path_buf(),
                detail: format!("hooks.json is not valid JSON: {e}. Refusing to overwrite."),
            }
        }
    };
    if !json_config_contains_our_hooks(&root) {
        return CleanupResult::Unowned {
            path: path.to_path_buf(),
        };
    }
    if let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) {
        remove_all_ours(hooks);
    }
    if let Err(e) = write_json_atomic(path, &root) {
        return CleanupResult::ManualActionRequired {
            path: path.to_path_buf(),
            detail: format!("write failed: {e}"),
        };
    }
    finish_json_hook_cleanup(path)
}

/// R44 0.5.41: OpenCode uninstall at a specific path (receipt-driven).
fn uninstall_opencode_at(path: &Path) -> CleanupResult {
    match fs::read_to_string(path) {
        Ok(raw) => {
            let owns_current = raw.contains(OPENCODE_MARKER);
            let owns_legacy = OPENCODE_MARKER_LEGACY
                .iter()
                .any(|marker| raw.contains(marker));
            if owns_current || owns_legacy {
                match fs::remove_file(path) {
                    Ok(()) => CleanupResult::Removed {
                        path: path.to_path_buf(),
                    },
                    Err(e) => CleanupResult::ManualActionRequired {
                        path: path.to_path_buf(),
                        detail: format!("remove_file failed: {e}"),
                    },
                }
            } else {
                CleanupResult::Unowned {
                    path: path.to_path_buf(),
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => CleanupResult::NotFound {
            path: path.to_path_buf(),
        },
        Err(e) => CleanupResult::Unreadable {
            path: path.to_path_buf(),
            error: e.to_string(),
        },
    }
}

/// R13 (2026-07-30): public wrapper so the tray's "Uninstall Claude hooks"
/// menu item can remove a single provider's RE-LLMPET-owned hook block
/// without touching the user's other config. Mirrors the upstream
/// Electron tray's `tray.uninstallHook` action.
///
/// R44 0.5.39 (roadmap v5 §3): now returns `CleanupResult` instead of
/// `Result<PathBuf, String>`. Callers can inspect the variant to
/// distinguish "removed" / "notFound" / "unowned" / "unreadable" etc.
pub fn uninstall_provider_hooks(id: &str) -> CleanupResult {
    cleanup_provider(id)
}

/// R44 0.5.41: receipt-driven uninstall. Public wrapper that takes the
/// path recorded in the install receipt, so the cleanup targets the
/// ORIGINAL install location even if environment variables changed
/// between install and uninstall. Used by the `uninstall_hooks` IPC
/// command when a prior receipt is available.
pub fn uninstall_provider_hooks_with_path(id: &str, receipt_path: &Path) -> CleanupResult {
    cleanup_provider_with_path(id, Some(receipt_path))
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
    // R44 Phase 0C: pre-write backup. Fail-closed — abort if backup fails
    // so the user's existing settings.json is never overwritten without
    // a recoverable snapshot. read_json_object below will then re-read
    // the file (unchanged) and proceed.
    let backup_path = backup_config_file(&settings_path, runtime)?;
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
    let mut installed_events: Vec<String> = Vec::new();
    for event in CLAUDE_EVENTS {
        add_group(hooks, event, command_hook(format!("{command} {event}"), 5));
        result.added += 1;
        installed_events.push(event.into());
    }
    let pretool = hook_command_with_flags(&executable, "claude", Some("PreToolUse"), false, true);
    add_group(hooks, "PreToolUse", command_hook(pretool, 600));
    installed_events.push("PreToolUse".into());
    if permission_enabled {
        // Keep the runtime token out of hook configuration and process listings.
        // The native hook reads the 0600 runtime file and sends the token only
        // in an HTTP header to the loopback server.
        let permission = hook_command(&executable, "claude", Some("PermissionRequest"), true);
        add_group(hooks, "PermissionRequest", command_hook(permission, 600));
        installed_events.push("PermissionRequest".into());
    }
    write_json_atomic(&settings_path, &Value::Object(settings))?;
    write_install_receipt(
        runtime,
        "claude",
        &settings_path,
        &installed_events,
        backup_path.as_deref(),
    );
    runtime.write_log("hooks", "Claude hooks synced");
    Ok(result)
}

#[allow(dead_code)]
fn uninstall_claude() -> CleanupResult {
    let path = home_dir().join(".claude").join("settings.json");
    uninstall_claude_at(&path)
}

fn install_codewhale(runtime: &Runtime) -> Result<InstallResult, String> {
    let path = codewhale_config_path();
    let executable = current_exe_clean().map_err(|e| e.to_string())?;

    // Protect user-owned TOML before replacing Octopus-owned marker blocks.
    // Exact current/legacy marker pairs are safe to migrate. Unmarked legacy
    // hook tables are detected by diagnostics but never deleted here because
    // ownership cannot be proven without parsing and preserving the full TOML.
    // Backup failure is fail-closed: no provider config is modified.
    let backup_path: Option<PathBuf> = if path.exists() {
        match backup_codewhale_config(&path, runtime) {
            Ok(p) => p,
            Err(err) => {
                return Err(format!(
                    "CodeWhale pre-write backup failed — aborting install to protect existing config: {err}. \
                     Check disk space, permissions, and antivirus locking. No changes were made."
                ));
            }
        }
    } else {
        None
    };

    let mut block = String::from(CW_BEGIN);
    block.push('\n');
    let installed_events: Vec<String> = CODEWHALE_EVENTS.iter().map(|s| (*s).to_string()).collect();
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
        // Observer hooks remain best-effort; the permission hook is strict and
        // the helper emits an explicit deny when the desktop service is absent.
        block.push_str(&format!(
            "continue_on_error = {}\n",
            if permission { "false" } else { "true" }
        ));
        if !permission {
            block.push_str("background = true\n");
        }
    }
    block.push_str(CW_END);
    replace_codewhale_marker_block(&path, &block)?;
    write_install_receipt(
        runtime,
        "codewhale",
        &path,
        &installed_events,
        backup_path.as_deref(),
    );
    runtime.write_log(
        "hooks",
        "CodeWhale hooks synced (v4, global hooks enabled); exact legacy markers migrated; unmarked legacy cleanup remains disabled",
    );
    Ok(InstallResult {
        added: CODEWHALE_EVENTS.len(),
        path,
        message: "CodeWhale 原生 TOML Hook 已同步并启用 [hooks]；权限链路异常时显式拒绝，避免 Full Access 下静默放行。".into(),
    })
}

/// R44 Phase 0C (2026-08-03): generic pre-write backup for any provider's
/// config file. Used by install_claude / install_codex / install_aider in
/// addition to the existing CodeWhale path. Returns the backup file path
/// on success so callers can record it in the install receipt.
///
/// Behavior:
///   - If `path` does not exist (first install), returns Ok(None). No backup
///     is created — there is nothing to protect.
///   - If `path` exists, copies it to `<parent>/.<stem>.re-llmpet-bak-<unix_ms>.<ext>`
///     alongside the original. The leading dot keeps it out of the way of
///     most tooling that glob-lists the directory.
///   - Prunes backups of the SAME stem + extension to the newest
///     `BACKUP_RETENTION` (5). Older backups are removed.
///   - Fail-closed: any I/O error during copy or prune is returned as Err.
///     The caller MUST abort the install to avoid losing the user's config.
///
/// Why a count-based cap instead of age-based:
///   The old CodeWhale backup pruned by age (30 days). On a CI/dev machine
///   that runs many installs per day, this led to hundreds of backup files
///   accumulating before any aged out. Count-based retention guarantees a
///   bounded disk footprint regardless of install frequency.
fn backup_config_file(path: &Path, runtime: &Runtime) -> Result<Option<PathBuf>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let parent = path.parent().ok_or("config path has no parent")?;
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("config");
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
    let ts = now_ms();
    // Build a backup filename that:
    //   - starts with `.` (hidden on Unix, mostly ignored by Windows tooling)
    //   - embeds the original stem so multiple provider configs in the same
    //     directory (e.g. ~/.codex/hooks.json + ~/.codex/config.toml) do
    //     not collide on the pruner's stem match
    //   - embeds the extension so a TOML backup isn't accidentally picked
    //     up by a JSON tool that globs `*.json`
    let backup_name = if ext.is_empty() {
        format!(".{stem}.re-llmpet-bak-{ts}")
    } else {
        format!(".{stem}.re-llmpet-bak-{ts}.{ext}")
    };
    let backup_path = parent.join(backup_name);
    fs::copy(path, &backup_path).map_err(|e| {
        // Fail-closed: the caller must NOT proceed to overwrite the user's
        // config without a recoverable backup. We return a descriptive
        // error so the install result surfaces the root cause to the UI.
        format!(
            "backup failed for {} → {}: {e}. Install aborted to protect existing config.",
            path.display(),
            backup_path.display()
        )
    })?;
    runtime.write_log(
        "hooks",
        &format!(
            "config backed up: {} → {}",
            path.display(),
            backup_path.display()
        ),
    );
    prune_backups(parent, stem, ext)?;
    Ok(Some(backup_path))
}

/// R44 Phase 0C: prune `.<stem>.re-llmpet-bak-<ts>[.<ext>]` files in
/// `parent` to the newest `BACKUP_RETENTION`. Files matching the stem
/// but a DIFFERENT extension are left alone (they belong to a different
/// provider's config in the same directory).
fn prune_backups(parent: &Path, stem: &str, ext: &str) -> Result<(), String> {
    let prefix = format!(".{stem}.re-llmpet-bak-");
    let suffix = if ext.is_empty() {
        String::new()
    } else {
        format!(".{ext}")
    };
    let entries = fs::read_dir(parent).map_err(|e| e.to_string())?;
    let mut backups: Vec<(u64, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = match entry.file_name().to_str() {
            Some(s) => s.to_string(),
            None => continue,
        };
        if !name.starts_with(&prefix) || !name.ends_with(&suffix) {
            continue;
        }
        // Extract the timestamp between prefix and suffix.
        let mid = &name[prefix.len()..name.len() - suffix.len()];
        if let Ok(ts) = mid.parse::<u64>() {
            backups.push((ts, entry.path()));
        }
    }
    // Sort newest first; drop everything past the retention cap.
    backups.sort_by_key(|b| std::cmp::Reverse(b.0));
    for (_, p) in backups.iter().skip(BACKUP_RETENTION) {
        let _ = fs::remove_file(p);
    }
    Ok(())
}

/// R40.1: create a timestamped backup of the CodeWhale config before
/// any write. Backups are placed alongside the original file with a
/// `.octopus-backup-<unix_ms>.toml` suffix. Old backups older than
/// 30 days are pruned on each call to prevent unbounded growth.
///
/// R44 Phase 0C: now delegates to the generic `backup_config_file`.
/// The legacy CodeWhale-specific naming (`.<stem>-re-llmpet-backup-<ts>.toml`)
/// is preserved for backward compat: the old pruner scanned for
/// `-re-llmpet-backup-` and removed files matching that pattern; the new
/// pruner scans for `.re-llmpet-bak-`. Both patterns coexist so old
/// pre-0.5.38 backups are eventually cleaned up by the new pruner when
/// the user runs another install, while new backups use the shorter name.
///
/// R44 Phase 0D (audit fix Minor #1): now returns `Result<Option<PathBuf>, String>`
/// matching the generic helper's signature, so `install_codewhale` can
/// propagate the actual backup path into the install receipt. Previously
/// the receipt's `backup_path` was always `None` for CodeWhale, which
/// meant the uninstall confirmation dialog couldn't show the user where
/// their CodeWhale backup lived.
fn backup_codewhale_config(path: &Path, runtime: &Runtime) -> Result<Option<PathBuf>, String> {
    let backup_path = backup_config_file(path, runtime)?;
    // R44 Phase 0C: also clean up legacy-named backups (`-re-llmpet-backup-`)
    // left by 0.5.34–0.5.37. The new generic helper handles new-named
    // backups; this block is a one-time sweep that removes legacy-named
    // files beyond the retention cap so they don't accumulate forever.
    if let Some(parent) = path.parent() {
        if let Ok(entries) = fs::read_dir(parent) {
            let mut legacy: Vec<(u64, PathBuf)> = Vec::new();
            for entry in entries.flatten() {
                let name = match entry.file_name().to_str() {
                    Some(s) => s.to_string(),
                    None => continue,
                };
                if !name.contains("-re-llmpet-backup-") {
                    continue;
                }
                if let Some(ts_str) = name
                    .rsplit("-re-llmpet-backup-")
                    .next()
                    .and_then(|s| s.strip_suffix(".toml"))
                    .and_then(|s| s.parse::<u64>().ok())
                {
                    legacy.push((ts_str, entry.path()));
                }
            }
            legacy.sort_by_key(|b| std::cmp::Reverse(b.0));
            for (_, p) in legacy.iter().skip(BACKUP_RETENTION) {
                let _ = fs::remove_file(p);
            }
        }
    }
    Ok(backup_path)
}

// `strip_legacy_codewhale_hooks` and its permissive parser were DELETED:
// they could remove user-owned TOML. Marker-owned blocks use
// `strip_marker_variants`; unmarked legacy tables remain diagnostics-only.

fn install_codex(runtime: &Runtime) -> Result<InstallResult, String> {
    let path = home_dir().join(".codex").join("hooks.json");
    // R44 Phase 0C: pre-write backup (fail-closed).
    let backup_path = backup_config_file(&path, runtime)?;
    let mut root = read_json_object(&path, "Codex hooks")?;
    root.entry("description")
        .or_insert(json!("Octopus multi-agent desktop integration"));
    let hooks = ensure_object(&mut root, "hooks")?;
    remove_all_ours(hooks);
    let executable = current_exe_clean().map_err(|e| e.to_string())?;
    let installed_events: Vec<String> = CODEX_EVENTS.iter().map(|s| (*s).to_string()).collect();
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
    write_install_receipt(
        runtime,
        "codex",
        &path,
        &installed_events,
        backup_path.as_deref(),
    );
    runtime.write_log("hooks", "Codex hooks synced; /hooks trust review required");
    Ok(InstallResult {
        added: CODEX_EVENTS.len(),
        path,
        message: "Codex Hook 已写入；首次或变更后必须在 Codex 中运行 /hooks 审查并信任".into(),
    })
}

#[allow(dead_code)]
fn uninstall_codex() -> CleanupResult {
    let path = home_dir().join(".codex").join("hooks.json");
    uninstall_codex_at(&path)
}

fn install_opencode(runtime: &Runtime) -> Result<InstallResult, String> {
    let base = std::env::var_os("OPENCODE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".config").join("opencode"));
    let path = base.join("plugins").join("llmpet-hook.js");
    // R44 Phase 0C: pre-write backup (fail-closed). Even though this file
    // is nominally owned by RE-LLMPET, a backup lets us recover if the
    // write produces a corrupt plugin (e.g. disk full mid-write) AND
    // preserves the previous known-good version if the user wants to
    // downgrade. The ownership check below STILL refuses to clobber a
    // foreign plugin, so the backup only ever contains our own file.
    let backup_path = backup_config_file(&path, runtime)?;
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
    write_install_receipt(
        runtime,
        "opencode",
        &path,
        &[
            "event".to_string(),
            "tool.execute.before".into(),
            "tool.execute.after".into(),
        ],
        backup_path.as_deref(),
    );
    runtime.write_log("hooks", "OpenCode ESM plugin synced (v3)");
    Ok(InstallResult {
        added: 1,
        path,
        message: "OpenCode ESM 插件已安装；权限事件仅观察，决策仍由 OpenCode 原生界面完成".into(),
    })
}

/// R44 0.5.39 (roadmap v5 §3): OpenCode uninstall now returns accurate
/// `CleanupResult` variants. Previously it returned `Ok(path)` even when
/// the file was NOT deleted (because it wasn't ours) — the roadmap v5 §3
/// explicitly states "OpenCode 未删除文件时不得显示 `removed`".
#[allow(dead_code)]
fn uninstall_opencode() -> CleanupResult {
    let base = std::env::var_os("OPENCODE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".config").join("opencode"));
    let path = base.join("plugins").join("llmpet-hook.js");
    match fs::read_to_string(&path) {
        Ok(raw) => {
            let owns_current = raw.contains(OPENCODE_MARKER);
            let owns_legacy = OPENCODE_MARKER_LEGACY
                .iter()
                .any(|marker| raw.contains(marker));
            if owns_current || owns_legacy {
                // File is ours — delete it.
                match fs::remove_file(&path) {
                    Ok(()) => CleanupResult::Removed { path },
                    Err(e) => CleanupResult::ManualActionRequired {
                        path,
                        detail: format!("remove_file failed: {e}"),
                    },
                }
            } else {
                // File exists but doesn't contain our marker — NOT ours.
                // Return Unowned (NOT Removed) so the UI can tell the user
                // "file exists but isn't ours; left intact".
                CleanupResult::Unowned { path }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // File doesn't exist — clean, nothing to do.
            CleanupResult::NotFound { path }
        }
        Err(e) => {
            // File exists but can't be read — report as Unreadable (was Err).
            CleanupResult::Unreadable {
                path,
                error: e.to_string(),
            }
        }
    }
}

fn install_aider(runtime: &Runtime) -> Result<InstallResult, String> {
    let path = home_dir().join(".aider.conf.yml");
    // R44 Phase 0C: pre-write backup (fail-closed).
    let backup_path = backup_config_file(&path, runtime)?;
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
    let stripped = strip_marker_variants(&current, AIDER_MARKERS)?;
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
    replace_marker_variants(&path, AIDER_MARKERS, &block)?;
    write_install_receipt(
        runtime,
        "aider",
        &path,
        &["turn_end".to_string()],
        backup_path.as_deref(),
    );
    runtime.write_log("hooks", "Aider notification bridge synced");
    Ok(InstallResult {
        added: 1,
        path,
        message: "Aider 通知桥已安装；仅可靠提供回复完成事件，不接管终端内权限".into(),
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
        format!("cmd.exe /D /S /C \"\"{}\" {}\"", path, args)
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
        format!("\"{}\"", text.replace('\"', "\\\""))
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

fn command_is_ours(command: &str) -> bool {
    command.contains(HOOK_OWNER)
        || command.contains(LEGACY_HOOK_OWNER)
        || command.contains(MARKER)
        || command.contains(LEGACY_MARKER)
        || [
            "re-llmpet-hook.js",
            "re-llmpet-pretool-hook.js",
            "re-llmpet-llmpet-hook.js",
            "octopus-hook.js",
            "pretool-hook.js",
            "llmpet-hook.js",
            "llmpet-octopus.js",
        ]
        .iter()
        .any(|marker| command.contains(marker))
}

fn hooks_contain_ours(hooks: &Map<String, Value>) -> bool {
    hooks.values().any(|groups| {
        groups.as_array().is_some_and(|groups| {
            groups.iter().any(|group| {
                group
                    .get("hooks")
                    .and_then(Value::as_array)
                    .is_some_and(|entries| {
                        entries.iter().any(|entry| {
                            entry
                                .get("command")
                                .and_then(Value::as_str)
                                .is_some_and(command_is_ours)
                        })
                    })
            })
        })
    })
}

fn json_config_contains_our_hooks(value: &Value) -> bool {
    value
        .get("hooks")
        .and_then(Value::as_object)
        .is_some_and(hooks_contain_ours)
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
                // Ownership is centralized so install detection, cleanup,
                // and post-clean verification cannot drift apart.
                !command_is_ours(command)
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

fn ensure_codewhale_hooks_enabled(input: &str) -> String {
    // CodeWhale ignores every [[hooks.hooks]] entry unless the global
    // [hooks].enabled switch is true. Touch only the exact top-level table
    // and preserve every unrelated user-owned TOML line.
    let mut lines = input.lines().map(str::to_string).collect::<Vec<_>>();
    let mut hooks_header = None;
    let mut hooks_end = lines.len();
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed == "[hooks]" {
            hooks_header = Some(index);
            continue;
        }
        if let Some(header) = hooks_header {
            if index > header && trimmed.starts_with('[') {
                hooks_end = index;
                break;
            }
        }
    }

    if let Some(header) = hooks_header {
        let enabled_line = (header + 1..hooks_end).find(|index| {
            let trimmed = lines[*index].trim_start();
            trimmed
                .strip_prefix("enabled")
                .map(|rest| rest.trim_start().starts_with('='))
                .unwrap_or(false)
        });
        if let Some(index) = enabled_line {
            let original = &lines[index];
            let indent_len = original.len() - original.trim_start().len();
            let indent = &original[..indent_len];
            let comment = original
                .find('#')
                .map(|position| format!(" {}", original[position..].trim_start()))
                .unwrap_or_default();
            lines[index] = format!("{indent}enabled = true{comment}");
        } else {
            lines.insert(header + 1, "enabled = true".into());
        }
    } else {
        while lines
            .last()
            .map(|line| line.trim().is_empty())
            .unwrap_or(false)
        {
            lines.pop();
        }
        if !lines.is_empty() {
            lines.push(String::new());
        }
        lines.push("[hooks]".into());
        lines.push("enabled = true".into());
    }

    let mut output = lines.join("\n");
    if !output.is_empty() {
        output.push('\n');
    }
    output
}

fn replace_codewhale_marker_block(path: &Path, block: &str) -> Result<(), String> {
    let existing = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(format!(
                "CodeWhale config exists but cannot be read ({error}); aborting to protect it"
            ))
        }
    };
    let stripped = strip_marker_variants(&existing, CW_MARKERS)?;
    let mut clean = ensure_codewhale_hooks_enabled(&stripped)
        .trim_end()
        .to_string();
    if !clean.is_empty() {
        clean.push_str("\n\n");
    }
    clean.push_str(block);
    clean.push('\n');
    write_text_atomic(path, clean.as_bytes())
}

fn replace_marker_variants(
    path: &Path,
    markers: &[(&str, &str)],
    block: &str,
) -> Result<(), String> {
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
    let mut clean = strip_marker_variants(&existing, markers)?
        .trim_end()
        .to_string();
    if !clean.is_empty() {
        clean.push_str(
            "

",
        );
    }
    clean.push_str(block);
    clean.push('\n');
    write_text_atomic(path, clean.as_bytes())
}

fn uninstall_marker_variants(path: &Path, markers: &[(&str, &str)]) -> CleanupResult {
    if !path.exists() {
        return CleanupResult::NotFound {
            path: path.to_path_buf(),
        };
    }
    let existing = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            return CleanupResult::Unreadable {
                path: path.to_path_buf(),
                error: e.to_string(),
            }
        }
    };
    if !contains_any_marker(&existing, markers) {
        return CleanupResult::Unowned {
            path: path.to_path_buf(),
        };
    }
    let clean = match strip_marker_variants(&existing, markers) {
        Ok(c) => c,
        Err(e) => {
            return CleanupResult::ManualActionRequired {
                path: path.to_path_buf(),
                detail: format!("marker block parse failed: {e}"),
            }
        }
    };
    if let Err(e) = write_text_atomic(path, clean.as_bytes()) {
        return CleanupResult::ManualActionRequired {
            path: path.to_path_buf(),
            detail: format!("write failed: {e}"),
        };
    }
    match fs::read_to_string(path) {
        Ok(post) if contains_any_marker(&post, markers) => CleanupResult::Residue {
            path: path.to_path_buf(),
            detail: "owned marker still present after strip".into(),
        },
        Ok(_) => CleanupResult::Removed {
            path: path.to_path_buf(),
        },
        Err(e) => CleanupResult::Unreadable {
            path: path.to_path_buf(),
            error: format!("post-clean verify read failed: {e}"),
        },
    }
}

fn strip_marker_variants(input: &str, markers: &[(&str, &str)]) -> Result<String, String> {
    let mut clean = input.to_string();
    for (begin, end) in markers {
        clean = strip_marker_block(&clean, begin, end)?;
    }
    Ok(clean)
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
        ".re-llmpet.{}.{}.tmp",
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
            ".re-llmpet.{}.{}.bak",
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

// ============================================================================
// R44 Phase 0C: install receipts.
//
// Each successful install writes a JSON receipt to
// `~/.re-llmpet/receipts/<provider>-<unix_ms>.json` containing:
//   {
//     "provider": "claude",
//     "version": "0.5.38",
//     "installed_at": 1722700000000,
//     "path": "/home/user/.claude/settings.json",
//     "backup_path": "/home/user/.claude/.settings.re-llmpet-bak-1722700000000.json",
//     "events": ["SessionStart", "SessionEnd", ...],
//     "drift_signature": "9e8a3f1c2b7d4a55... (64-char SHA-256 hex)"
//   }
//
// Receipts are pruned to the newest `RECEIPT_RETENTION` (20) per provider.
// They are read by `read_install_receipts()` for diagnostics and will be
// used by Phase 0D to confirm "you installed this on <date>, backup at
// <path>" before destructive uninstall.
//
// Why a separate receipts dir instead of embedding in the log:
//   - Structured (machine-readable) — diagnostics can parse them without
//     regex over log lines.
//   - Bounded — count-based retention prevents unbounded growth.
//   - Independent of log rotation — log rotation is for human-readable
//     debug traces; receipts are state.
// ============================================================================

/// App version embedded in receipts. Must match `package.json` /
/// `Cargo.toml`. We use env!("CARGO_PKG_VERSION") so it stays in sync
/// with the build, not a hardcoded string that drifts.
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Receipts directory: `~/.re-llmpet/receipts/`.
fn receipts_dir() -> PathBuf {
    home_dir().join(APP_DIR_NAME).join(RECEIPTS_DIR_NAME)
}

/// R44 0.5.39 (roadmap v5 §5): compute a SHA-256 hash of the file at
/// `path`, returned as a 64-character lowercase hex string. Used by
/// `verify_enabled` and Phase 0D uninstall confirmation to detect "the
/// user (or another tool) modified this file after we installed our hook".
///
/// Previous implementation (0.5.38) used `size=<bytes>;mtime=<unix_secs>`.
/// The roadmap v5 §5 explicitly requires SHA-256 because:
///   - mtime can be preserved by tools that write-then-restore timestamps
///   - size is a weak fingerprint (many edits produce the same size)
///   - SHA-256 detects any byte-level change regardless of filesystem
///     metadata tricks
///
/// Returns None if the file can't be read (drift = "unknown"). The
/// receipt stores `drift_signature` as a string; absence means "unknown".
fn drift_signature(path: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let hash = hasher.finalize();
    Some(hash.iter().map(|b| format!("{:02x}", b)).collect())
}

/// R44 Phase 0D: pub wrapper around `drift_signature` so commands.rs can
/// compute the current signature of a config file and compare it to the
/// value stored in the install receipt. Used by `uninstall_hooks` to
/// surface a drift warning ("config was modified after install — verify
/// backup") in the IPC response.
pub fn current_drift_signature(path: &Path) -> Option<String> {
    drift_signature(path)
}

/// Write an install receipt. Best-effort: failures are logged but do NOT
/// fail the install (the install itself already succeeded; a receipt
/// failure is a diagnostics degradation, not a hook failure).
fn write_install_receipt(
    runtime: &Runtime,
    provider: &str,
    config_path: &Path,
    events: &[String],
    backup_path: Option<&Path>,
) {
    let dir = receipts_dir();
    if let Err(e) = fs::create_dir_all(&dir) {
        runtime.write_log(
            "hooks",
            &format!("receipt dir create failed (non-fatal): {e}"),
        );
        return;
    }
    let ts = now_ms();
    let signature = drift_signature(config_path);
    let receipt = json!({
        "provider": provider,
        "version": app_version(),
        "installed_at": ts,
        "path": config_path.to_string_lossy(),
        "backup_path": backup_path.map(|p| p.to_string_lossy().into_owned()),
        "events": events,
        "drift_signature": signature,
    });
    let receipt_path = dir.join(format!("{provider}-{ts}.json"));
    let bytes = match serde_json::to_vec_pretty(&receipt) {
        Ok(b) => b,
        Err(e) => {
            runtime.write_log(
                "hooks",
                &format!("receipt serialize failed (non-fatal): {e}"),
            );
            return;
        }
    };
    // Use the same atomic-write contract as the config writer so a
    // half-written receipt never appears on disk.
    if let Err(e) = write_text_atomic(&receipt_path, &bytes) {
        runtime.write_log("hooks", &format!("receipt write failed (non-fatal): {e}"));
        return;
    }
    // Prune to newest RECEIPT_RETENTION per provider.
    if let Err(e) = prune_receipts(&dir, provider) {
        runtime.write_log("hooks", &format!("receipt prune failed (non-fatal): {e}"));
    }
}

/// Remove older receipts for `provider` so at most RECEIPT_RETENTION
/// remain. Receipt files are named `<provider>-<unix_ms>.json`.
fn prune_receipts(dir: &Path, provider: &str) -> Result<(), String> {
    let prefix = format!("{provider}-");
    let suffix = ".json";
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    let mut found: Vec<(u64, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = match entry.file_name().to_str() {
            Some(s) => s.to_string(),
            None => continue,
        };
        if !name.starts_with(&prefix) || !name.ends_with(suffix) {
            continue;
        }
        let mid = &name[prefix.len()..name.len() - suffix.len()];
        if let Ok(ts) = mid.parse::<u64>() {
            found.push((ts, entry.path()));
        }
    }
    found.sort_by_key(|b| std::cmp::Reverse(b.0));
    for (_, p) in found.iter().skip(RECEIPT_RETENTION) {
        let _ = fs::remove_file(p);
    }
    Ok(())
}

/// Read the latest receipt for each provider. Returns a map keyed by
/// provider id → receipt JSON. Missing or unreadable receipts are
/// silently omitted (caller treats absent key as "never installed by
/// this version's receipt system").
///
/// Phase 0D will use this to show the user "you installed Claude on
/// 2026-08-03 14:23; backup at /home/.../.settings.re-llmpet-bak-...json"
/// before confirming a destructive uninstall.
pub fn read_install_receipts() -> Map<String, Value> {
    let dir = receipts_dir();
    let mut out: Map<String, Value> = Map::new();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    // Track newest ts per provider.
    let mut newest: std::collections::HashMap<String, (u64, PathBuf)> =
        std::collections::HashMap::new();
    for entry in entries.flatten() {
        let name = match entry.file_name().to_str() {
            Some(s) => s.to_string(),
            None => continue,
        };
        let stem = name.strip_suffix(".json").unwrap_or(&name);
        let Some((provider, ts_str)) = stem.split_once('-') else {
            continue;
        };
        let Ok(ts) = ts_str.parse::<u64>() else {
            continue;
        };
        match newest.get(provider) {
            Some((existing_ts, _)) if *existing_ts >= ts => continue,
            _ => {
                newest.insert(provider.to_string(), (ts, entry.path()));
            }
        }
    }
    for (provider, (_, path)) in newest {
        if let Ok(bytes) = fs::read(&path) {
            if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                out.insert(provider, value);
            }
        }
    }
    out
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
    const runtime = JSON.parse(await readFile(join(homedir(), ".re-llmpet", "runtime.json"), "utf8"));
    if (runtime.app !== "re-llmpet" || runtime.port < 41330 || runtime.port > 41334) return;
    await fetch(`http://127.0.0.1:${runtime.port}/state`, {
      method: "POST", headers: { "content-type": "application/json", "x-re-llmpet-token": runtime.token, "x-re-llmpet-server": "re-llmpet" },
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

#[cfg(test)]
mod codewhale_config_tests {
    use super::ensure_codewhale_hooks_enabled;

    #[test]
    fn adds_the_global_hook_switch_without_losing_other_tables() {
        let edited = ensure_codewhale_hooks_enabled("[provider]\nname = \"deepseek\"\n");
        assert!(edited.contains("[hooks]\nenabled = true"));
        assert!(edited.contains("[provider]\nname = \"deepseek\""));
    }

    #[test]
    fn reenables_an_existing_hook_table_and_preserves_its_comment() {
        let input = "[hooks]\nenabled = false # user disabled it\ndefault_timeout_secs = 30\n\n[provider]\napi_key = \"secret\"\n";
        let edited = ensure_codewhale_hooks_enabled(input);
        assert!(edited.contains("enabled = true # user disabled it"));
        assert!(edited.contains("[provider]\napi_key = \"secret\""));
    }
}
