//! R57 (2026-10-02): focused owner for "enter this conversation" liveness.
//!
//! The user's report: clicking a session row re-launched a SECOND provider
//! process (e.g. `opencode -s <id>`) even while the first was still alive —
//! `commands::focus_session` treated ANY native-focus error (window
//! enumeration failure, missing pid, pid recycled) as "dead" and fell
//! through to `session_resume::resume_session_inner`, which unconditionally
//! launches a new terminal. Two processes then write the same session.
//!
//! This module answers ONE question before any launch decision:
//! "is the process that owns this conversation still alive?" —
//!
//! 1. pid identity gate (alive AND looks like our provider, or
//!    unreadable-and-therefore-conservatively-alive),
//! 2. provider binary name (+ cwd on Linux) scan for recycled/missing
//!    pids — including the codewhale short-lived executor case via the
//!    `codewhale-tui` companion,
//! 3. a task-status lease (`STATE_LEASE_MS`) as the final anti-double-spawn
//!    gate when both probes are inconclusive.
//!
//! Only a fully Dead verdict reaches `resume_session_inner`.
//!
//! Design doc: R57-1c (worklog 2026-10-02). All platform process access is
//! concentrated behind the `ProcessTable` trait so the decision logic is
//! unit-testable without spawning real processes.

use crate::commands::{agent_spec, open_panel};
use crate::model::{now_ms, AppState, Session};
use crate::platform;
use crate::session_resume::resume_session_inner;
use serde_json::json;
use tauri::{AppHandle, Emitter, State};

/// Task-status lease: the last-ditch "looks alive" gate. `updated_at` only
/// refreshes on accepted hook events, and long tool runs / long streaming
/// turns genuinely go minutes without events — but those paths are normally
/// covered by the pid gate (four of six providers report a source pid).
/// The lease only fires when pid AND scan are both inconclusive. 90s keeps
/// the "clicked a dead row" retry window short while still blocking the
/// double-spawn window after an abrupt terminal kill.
const STATE_LEASE_MS: u64 = 90_000;
/// Work-family states that imply a live process when fresh.
const LEASE_STATES: [&str; 5] = ["working", "juggling", "sweeping", "thinking", "carrying"];

/// Process liveness verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Liveness {
    /// Confirmed alive — pid hit (identity-matched or unreadable) or scan hit.
    Alive { pid: u32 },
    /// Confirmed dead — pid gone/recycled AND no scan hit.
    Dead,
    /// Cannot judge (providers without a process identity, e.g. dsh's
    /// file observer).
    Unknown,
}

/// The action `focus_session` should take for one session row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FocusPlan {
    /// Process alive → focus its terminal chain. Focus failure must NOT
    /// escalate to a relaunch (the original bug).
    Focus { pid: u32 },
    /// Probes inconclusive but the task-status lease says the session is
    /// still working → hold, never double-spawn.
    LeaseHold,
    /// Provider has no process identity (dsh) → explain + open the panel.
    Untracked,
    /// Child sessions have no terminal of their own.
    Headless,
    /// Dead through and through → `resume_session_inner` may launch.
    Relaunch,
}

/// Identity of one OS process, as much as the platform can see.
#[derive(Debug, Clone, Default)]
struct ProcessIdentity {
    /// Full command line (lossy). Empty = unreadable → treated as
    /// conservatively alive.
    command_line: String,
    /// Process working directory. `None` where the platform cannot read it
    /// (macOS/Windows).
    cwd: Option<std::path::PathBuf>,
    zombie: bool,
}

/// All OS access funnels through this trait — unit tests inject a fake.
trait ProcessTable {
    /// `None` = pid does not exist (Linux zombies count as gone).
    fn pid_identity(&self, pid: u32) -> Option<ProcessIdentity>;
    /// Scan for candidate processes by provider binary names; prefer a
    /// cwd match when the session cwd is known.
    fn scan(&self, names: &[&str], cwd: Option<&str>) -> Option<u32>;
}

// ── decision logic (pure, fully unit-tested) ─────────────────────────────

/// True when the state row implies a live process and the last event is
/// fresh. `ended_at` (SessionEnd) hard-disqualifies: a session that just
/// ENDED must be re-openable immediately, and SessionEnd normalizes to the
/// sweeping work-family state — exactly the trap the ended check closes.
pub(crate) fn state_lease_alive(
    state: &str,
    updated_at: u64,
    ended_at: Option<u64>,
    now: u64,
) -> bool {
    ended_at.is_none()
        && LEASE_STATES.contains(&state)
        && now.saturating_sub(updated_at) <= STATE_LEASE_MS
}

pub(crate) fn plan_focus(session: &Session, now: u64) -> FocusPlan {
    plan_focus_with(&SystemProcessTable, session, now)
}

/// Table-injected form so the Dead→LeaseHold→Relaunch wiring itself is
/// unit-testable without touching the real /proc (RV-A4: the first draft
/// only tested the lease predicates, leaving the wiring uncovered).
fn plan_focus_with<T: ProcessTable>(table: &T, session: &Session, now: u64) -> FocusPlan {
    if session.headless {
        return FocusPlan::Headless;
    }
    if session.provider == "dsh" {
        // File observer: no process identity to probe, and `--resume`-style
        // relaunching (provider_resume_args returns empty for dsh) would
        // just bare-launch a second harness. Explain instead.
        return FocusPlan::Untracked;
    }
    match probe_with(table, &session.provider, session.source_pid, &session.cwd) {
        Liveness::Alive { pid } => FocusPlan::Focus { pid },
        Liveness::Unknown => FocusPlan::Untracked,
        Liveness::Dead => {
            if state_lease_alive(&session.state, session.updated_at, session.ended_at, now) {
                FocusPlan::LeaseHold
            } else {
                FocusPlan::Relaunch
            }
        }
    }
}

/// The probe pipeline shared by production and tests.
fn probe_with<T: ProcessTable>(
    table: &T,
    provider: &str,
    source_pid: Option<u32>,
    cwd: &str,
) -> Liveness {
    if provider == "dsh" {
        return Liveness::Unknown;
    }
    let names = provider_names(provider);
    let cwd_opt = if cwd.is_empty() { None } else { Some(cwd) };
    if let Some(pid) = source_pid {
        match table.pid_identity(pid) {
            Some(id) if !id.zombie => {
                if id.command_line.is_empty() {
                    // Unreadable (permissions/race) — conservatively alive.
                    return Liveness::Alive { pid };
                }
                if identity_matches(&id.command_line, &names)
                    || id.cwd.as_deref().is_some_and(|proc_cwd| {
                        cwd_opt.is_some_and(|c| proc_cwd == std::path::Path::new(c))
                    })
                {
                    return Liveness::Alive { pid };
                }
                // pid alive but identity mismatched → recycled pid, fall
                // through to the scan.
            }
            _ => {
                // Gone or zombie → fall through to the scan.
            }
        }
    }
    let name_refs: Vec<&str> = names.iter().map(String::as_str).collect();
    if let Some(pid) = table.scan(&name_refs, cwd_opt) {
        return Liveness::Alive { pid };
    }
    Liveness::Dead
}

/// Binary names worth matching for this provider (command + companion).
/// Unknown providers fall back to the provider id itself as the only name.
fn provider_names(provider: &str) -> Vec<String> {
    match agent_spec(provider) {
        Ok(spec) => {
            let mut names = vec![spec.command.to_string()];
            if let Some(companion) = spec.companion {
                names.push(companion.to_string());
            }
            names
        }
        Err(_) => vec![provider.to_string()],
    }
}

/// Component-wise containment match: tokenize the command line (NUL on
/// Linux, whitespace elsewhere), split each token on path separators, and
/// hit when any component CONTAINS a provider name. Covers the observed
/// shapes: `/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js`,
/// bare `opencode`, `codewhale-tui`, `python -m aider`.
/// Known acceptable false positive: `claude-code-router` (same CLI family —
/// conservative-by-design; the cwd gate and the lease keep suppressing
/// double-spawns).
fn identity_matches<N: AsRef<str>>(command_line: &str, names: &[N]) -> bool {
    let lowered = command_line.to_lowercase();
    let separator = if command_line.contains('\u{0}') {
        '\u{0}'
    } else {
        ' '
    };
    for token in lowered.split(separator) {
        if token.is_empty() {
            continue;
        }
        for component in token.split(['/', '\\']) {
            if names.iter().any(|name| component.contains(name.as_ref())) {
                return true;
            }
        }
    }
    false
}

// ── orchestration ────────────────────────────────────────────────────────

/// Guarded replacement for the old focus→resume fallback in commands.rs.
/// The pet button's contract is "put me back in that conversation", never
/// "spawn a second process for it".
pub(crate) fn focus_session_guarded(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<(), String> {
    let session = state
        .runtime
        .session(session_id)
        .ok_or("session no longer exists")?
        .clone();
    let now = now_ms();
    let plan = plan_focus(&session, now);
    let short_id: String = session_id.chars().take(64).collect();
    state.runtime.write_log(
        "focus",
        &format!(
            "plan={plan:?} provider={} pid={:?} state={} age_ms={} ended={:?}",
            session.provider,
            session.source_pid,
            session.state,
            now.saturating_sub(session.updated_at),
            session.ended_at
        ),
    );
    match plan {
        FocusPlan::Focus { pid } => {
            // R57-1a #6 (upstream main.js:1528-1561): codex has an official
            // deep link (codex://threads/<id>) — a much lighter "return to
            // the conversation" than window enumeration. Best-effort: the
            // process chain remains the fallback when the URL handler is
            // missing.
            match platform::focus_pid(pid) {
                Ok(()) => {
                    // The user is back in the conversation — retire the green
                    // "just done" badge (upstream requiresCompletionAck) and
                    // push the refreshed snapshot immediately (RV-C11: the
                    // frontend has no polling, so without this the dot only
                    // vanished on the next unrelated event).
                    state.runtime.ack_session_completion(session_id);
                    crate::http_server::emit_stats(app, &state.runtime);
                    Ok(())
                }
                Err(error) => {
                    // Alive but unfocusable: DO NOT relaunch. The original
                    // bug spawned a duplicate here.
                    state.runtime.write_log(
                        "focus",
                        &format!("alive but unfocusable (pid {pid}): {error}"),
                    );
                    // R57-RV-A4 P1-2: the codex deep link is a best-effort
                    // LAST resort (window focus failed, e.g. a bare TUI the
                    // window enumerator cannot raise). Never ack on its exit
                    // code — xdg-open/cmd `start` both report success even
                    // when no handler exists — and only for id-shaped ids
                    // (the rollout fallback ids are full file paths, which
                    // must never reach a URL or a cmd tail).
                    if session.provider == "codex" && codex_thread_id(session_id) {
                        open_codex_deep_link(session_id);
                    }
                    let _ = app.emit(
                        "pet:event",
                        json!({"kind":"say","text":"会话进程仍在运行，但无法聚焦它的窗口（macOS 请检查辅助功能权限）。为避免双进程写同一会话，未重新拉起。"}),
                    );
                    Ok(())
                }
            }
        }
        FocusPlan::LeaseHold => {
            let _ = app.emit(
                "pet:event",
                json!({"kind":"say","text":"这个会话的任务仍在运行（心跳未超时），未重新拉起终端；若终端确实已关，请约 90 秒后再试。"}),
            );
            Ok(())
        }
        FocusPlan::Untracked => {
            let _ = app.emit(
                "pet:event",
                json!({"kind":"say","text":"该会话由后台观察器跟踪，无法聚焦或重开，已为你打开详情面板。"}),
            );
            open_panel(app.clone())
        }
        FocusPlan::Headless => Err("headless sessions have no terminal window".into()),
        FocusPlan::Relaunch => {
            state.runtime.write_log(
                "focus",
                &format!("{short_id}: dead pid, no scan hit, lease expired — relaunching"),
            );
            match resume_session_inner(app, state, session_id) {
                Ok(()) => Ok(()),
                Err(resume_error) => {
                    // R53: localize the fallback bubble and keep the excerpt
                    // tight; raw diagnostics stay in the app log.
                    let safe_error: String = resume_error.chars().take(80).collect();
                    let _ = app.emit(
                        "pet:event",
                        json!({"kind":"say","text":format!("无法重新打开会话：{safe_error}。已为你打开详情面板。")}),
                    );
                    open_panel(app.clone())
                }
            }
        }
    }
}

/// R57-RV-A4 P1-1: upstream gates the deep link (and copy-session-id) on
/// `/^[A-Za-z0-9._:-]{8,128}$/` (main.js:1556). Our session ids come from
/// hook payloads, and the codex rollout fallback id is a full FILE PATH —
/// unvalidated, that string would flow into a URL and (on Windows) a
/// `cmd /C start` tail where `&` is a command separator.
fn codex_thread_id(session_id: &str) -> bool {
    let len = session_id.len();
    (8..=128).contains(&len)
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

// R57-RV-A4 P0-1: `unix` also matches macOS — the xdg-open variant must
// exclude it or the two definitions collide (E0428) on darwin builds.
#[cfg(all(unix, not(target_os = "macos")))]
fn open_codex_deep_link(session_id: &str) -> bool {
    let url = format!("codex://threads/{session_id}");
    let mut command = std::process::Command::new("xdg-open");
    command.arg(&url);
    crate::platform::hide_console_window(&mut command);
    command
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(windows)]
fn open_codex_deep_link(session_id: &str) -> bool {
    let url = format!("codex://threads/{session_id}");
    let mut command = std::process::Command::new("cmd");
    command.args(["/C", "start", "", &url]);
    crate::platform::hide_console_window(&mut command);
    command
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn open_codex_deep_link(session_id: &str) -> bool {
    let url = format!("codex://threads/{session_id}");
    let mut command = std::process::Command::new("open");
    command.arg(&url);
    crate::platform::hide_console_window(&mut command);
    command
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

// ── platform process table ───────────────────────────────────────────────

struct SystemProcessTable;

#[cfg(target_os = "linux")]
impl ProcessTable for SystemProcessTable {
    fn pid_identity(&self, pid: u32) -> Option<ProcessIdentity> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // Field 3 is the state char; comm may contain spaces so parse after
        // the last ')'.
        let after_comm = stat.rsplit(')').next()?;
        let state_char = after_comm.trim().chars().next()?;
        let zombie = state_char == 'Z';
        let command_line = std::fs::read_to_string(format!("/proc/{pid}/cmdline"))
            .map(|raw| raw.replace('\u{0}', " "))
            .unwrap_or_default();
        let cwd = std::fs::read_link(format!("/proc/{pid}/cwd")).ok();
        Some(ProcessIdentity {
            command_line,
            cwd,
            zombie,
        })
    }

    fn scan(&self, names: &[&str], cwd: Option<&str>) -> Option<u32> {
        // Two passes: exact cwd match first (when known), name-only second.
        let entries: Vec<(u32, ProcessIdentity)> = std::fs::read_dir("/proc")
            .ok()?
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().into_string().ok()?;
                let pid: u32 = name.parse().ok()?;
                // Skip self: this process is the pet, never the provider.
                if pid == std::process::id() {
                    return None;
                }
                self.pid_identity(pid).map(|identity| (pid, identity))
            })
            .collect();
        if let Some(wanted) = cwd {
            for (pid, id) in &entries {
                if id.zombie || id.command_line.is_empty() {
                    continue;
                }
                if id.cwd.as_deref() == Some(std::path::Path::new(wanted))
                    && identity_matches(&id.command_line, names)
                {
                    return Some(*pid);
                }
            }
        }
        for (pid, id) in &entries {
            if id.zombie || id.command_line.is_empty() {
                continue;
            }
            if identity_matches(&id.command_line, names) {
                return Some(*pid);
            }
        }
        None
    }
}

#[cfg(target_os = "macos")]
impl ProcessTable for SystemProcessTable {
    fn pid_identity(&self, pid: u32) -> Option<ProcessIdentity> {
        // macOS `ps -o command=` gives the full command line in one call.
        let output = std::process::Command::new("ps")
            .args(["-o", "command=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let command_line = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Some(ProcessIdentity {
            command_line,
            cwd: None,
            zombie: false,
        })
    }

    fn scan(&self, names: &[&str], _cwd: Option<&str>) -> Option<u32> {
        // cwd matching is not portable off Linux (lsof is heavy and often
        // absent) — name-only scan, with the lease as the safety net.
        let output = std::process::Command::new("ps")
            .args(["-axo", "pid=,command="])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        let self_pid = std::process::id();
        for line in text.lines() {
            let trimmed = line.trim_start();
            let Some((pid_raw, command)) = trimmed.split_once(' ') else {
                continue;
            };
            let Ok(pid) = pid_raw.trim().parse::<u32>() else {
                continue;
            };
            if pid == self_pid {
                continue;
            }
            if identity_matches(command, names) {
                return Some(pid);
            }
        }
        None
    }
}

// R57-RV-A4 P0-2: Windows has no `ps` (Git-Bash's MSYS ps only sees MSYS
// processes and is not on PATH) — a ps fallback makes every probe return
// Dead on Windows, silently reintroducing the duplicate-launch bug this
// module exists to fix. PowerShell's Get-CimInstance gives ProcessId +
// CommandLine in one JSON payload (same precedent as platform.rs
// ::parent_pid).
#[cfg(windows)]
impl ProcessTable for SystemProcessTable {
    fn pid_identity(&self, pid: u32) -> Option<ProcessIdentity> {
        let script = format!(
            "Get-CimInstance Win32_Process -Filter 'ProcessId={pid}' | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
        );
        let mut command = std::process::Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
        crate::platform::hide_console_window(&mut command);
        let output = command.output().ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let value: serde_json::Value = serde_json::from_str(text.trim()).ok()?;
        let row_pid = value.get("ProcessId").and_then(serde_json::Value::as_u64)?;
        if row_pid != u64::from(pid) {
            return None;
        }
        let cmdline = value
            .get("CommandLine")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string();
        Some(ProcessIdentity {
            command_line: cmdline,
            cwd: None,
            zombie: false,
        })
    }

    fn scan(&self, names: &[&str], _cwd: Option<&str>) -> Option<u32> {
        let script = "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
        let mut command = std::process::Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
        crate::platform::hide_console_window(&mut command);
        let output = command.output().ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let self_pid = std::process::id();
        // ConvertTo-Json emits either one object (single row) or an array.
        let trimmed = text.trim();
        let rows: Vec<serde_json::Value> = if trimmed.starts_with('[') {
            serde_json::from_str(trimmed).unwrap_or_default()
        } else {
            serde_json::from_str(trimmed)
                .map(|value| vec![value])
                .unwrap_or_default()
        };
        for row in rows {
            let Some(row_pid) = row.get("ProcessId").and_then(serde_json::Value::as_u64) else {
                continue;
            };
            let cmdline = row
                .get("CommandLine")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            if row_pid == u64::from(self_pid) || cmdline.is_empty() {
                continue;
            }
            if identity_matches(cmdline, names) {
                return u32::try_from(row_pid).ok();
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeTable {
        rows: std::collections::HashMap<u32, ProcessIdentity>,
    }

    impl FakeTable {
        fn new() -> Self {
            FakeTable {
                rows: std::collections::HashMap::new(),
            }
        }
        fn with(mut self, pid: u32, command_line: &str, cwd: Option<&str>, zombie: bool) -> Self {
            self.rows.insert(
                pid,
                ProcessIdentity {
                    command_line: command_line.to_string(),
                    cwd: cwd.map(std::path::PathBuf::from),
                    zombie,
                },
            );
            self
        }
    }

    impl ProcessTable for FakeTable {
        fn pid_identity(&self, pid: u32) -> Option<ProcessIdentity> {
            self.rows.get(&pid).cloned()
        }
        fn scan(&self, names: &[&str], cwd: Option<&str>) -> Option<u32> {
            // Prefer a cwd match, then name-only — mirrors the Linux impl.
            if let Some(wanted) = cwd {
                for (pid, id) in &self.rows {
                    if id.zombie || id.command_line.is_empty() {
                        continue;
                    }
                    if id.cwd.as_deref() == Some(std::path::Path::new(wanted))
                        && identity_matches(&id.command_line, names)
                    {
                        return Some(*pid);
                    }
                }
            }
            for (pid, id) in &self.rows {
                if id.zombie || id.command_line.is_empty() {
                    continue;
                }
                if identity_matches(&id.command_line, names) {
                    return Some(*pid);
                }
            }
            None
        }
    }

    fn session(state: &str, updated_at: u64, ended_at: Option<u64>) -> Session {
        Session {
            id: "s1".into(),
            provider: "opencode".into(),
            state: state.into(),
            cwd: "/home/z/work".into(),
            tool_name: None,
            model: None,
            assistant_last_output: None,
            headless: false,
            updated_at,
            source_pid: Some(123),
            context_used: None,
            context_limit: None,
            context_percent: None,
            todos: Vec::new(),
            last_event_at: updated_at,
            last_event_seq: None,
            last_event_rank: 0,
            last_event_key: None,
            ended_at,
            parent_id: None,
            greeted_at: None,
            user_prompt_at: None,
            task_visual_at: None,
            ops_since_prompt: 0,
            last_op_done_at: None,
            turn_done_at: None,
            last_failure_at: None,
            greet_due: false,
        }
    }

    // ── identity_matches ─────────────────────────────────────────────
    #[test]
    fn identity_matches_covers_observed_command_shapes() {
        let names = vec!["claude"];
        assert!(identity_matches(
            "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js",
            &names
        ));
        assert!(identity_matches("claude", &names));
        assert!(identity_matches(
            "node\0/usr/bin/claude\0--resume\0abc",
            &names
        ));
    }

    #[test]
    fn identity_matches_rejects_unrelated_processes() {
        let names = vec!["opencode"];
        assert!(!identity_matches("/usr/bin/google-chrome --flag", &names));
        assert!(!identity_matches("python -m http.server", &names));
    }

    // ── probe_with ───────────────────────────────────────────────────
    #[test]
    fn probe_pid_alive_with_matching_identity_wins() {
        let table = FakeTable::new().with(123, "opencode", Some("/home/z/work"), false);
        assert_eq!(
            probe_with(&table, "opencode", Some(123), "/home/z/work"),
            Liveness::Alive { pid: 123 }
        );
    }

    #[test]
    fn probe_unreadable_cmdline_is_conservatively_alive() {
        let table = FakeTable::new().with(123, "", None, false);
        assert_eq!(
            probe_with(&table, "opencode", Some(123), "/x"),
            Liveness::Alive { pid: 123 }
        );
    }

    #[test]
    fn probe_recycled_pid_falls_through_to_scan() {
        // pid 123 now runs chrome; opencode actually lives at 456.
        let table = FakeTable::new()
            .with(123, "/usr/bin/google-chrome", None, false)
            .with(456, "opencode", Some("/home/z/work"), false);
        assert_eq!(
            probe_with(&table, "opencode", Some(123), "/home/z/work"),
            Liveness::Alive { pid: 456 }
        );
    }

    #[test]
    fn probe_zombie_pid_falls_through_to_scan() {
        let table = FakeTable::new()
            .with(123, "opencode", None, true)
            .with(456, "opencode", None, false);
        assert_eq!(
            probe_with(&table, "opencode", Some(123), ""),
            Liveness::Alive { pid: 456 }
        );
    }

    #[test]
    fn probe_dead_pid_with_no_scan_hit_is_dead() {
        let table = FakeTable::new();
        assert_eq!(
            probe_with(&table, "opencode", Some(123), "/home/z/work"),
            Liveness::Dead
        );
    }

    #[test]
    fn probe_dsh_is_always_unknown() {
        let table = FakeTable::new().with(123, "anything", None, false);
        assert_eq!(
            probe_with(&table, "dsh", Some(123), "/x"),
            Liveness::Unknown
        );
    }

    #[test]
    fn probe_scan_prefers_cwd_match() {
        let table = FakeTable::new()
            .with(10, "opencode", Some("/other/project"), false)
            .with(20, "opencode", Some("/home/z/work"), false);
        assert_eq!(
            probe_with(&table, "opencode", None, "/home/z/work"),
            Liveness::Alive { pid: 20 }
        );
    }

    // ── plan_focus decision matrix ───────────────────────────────────
    #[test]
    fn plan_headless_short_circuits() {
        let mut s = session("working", 1_000, None);
        s.headless = true;
        assert_eq!(plan_focus(&s, 2_000), FocusPlan::Headless);
    }

    #[test]
    fn plan_dsh_is_untracked() {
        let mut s = session("working", 1_000, None);
        s.provider = "dsh".into();
        s.source_pid = None;
        assert_eq!(plan_focus(&s, 2_000), FocusPlan::Untracked);
    }

    #[test]
    fn plan_fresh_work_state_after_dead_probe_holds_the_lease() {
        assert!(state_lease_alive("working", 50_000, None, 100_000));
        assert!(!state_lease_alive(
            "working",
            100_000 - 90_001,
            None,
            100_000
        ));
    }

    #[test]
    fn lease_boundaries_are_exact() {
        let now = 100_000u64;
        assert!(state_lease_alive("thinking", now - 89_999, None, now));
        assert!(state_lease_alive("thinking", now - 90_000, None, now));
        assert!(!state_lease_alive("thinking", now - 90_001, None, now));
    }

    #[test]
    fn lease_rejects_non_work_states() {
        assert!(!state_lease_alive("idle", 0, None, 1_000));
        assert!(!state_lease_alive("waiting", 0, None, 1_000));
        assert!(!state_lease_alive("error", 0, None, 1_000));
    }

    #[test]
    fn lease_rejects_ended_sessions() {
        // SessionEnd normalizes to the sweeping work-family state — without
        // the ended_at gate, a just-finished session would block re-opening
        // for 90s, the exact opposite of what the user wants.
        assert!(!state_lease_alive("sweeping", 0, Some(1_000), 2_000));
    }

    // ── Alive → Focus wiring (RV-B8 P1: the module's whole point — an
    // alive probe must plan Focus, never Relaunch) ──
    #[test]
    fn alive_probe_plans_focus_not_relaunch() {
        let table = FakeTable::new().with(123, "opencode", Some("/home/z/work"), false);
        let s = session("working", 50_000, None);
        assert_eq!(
            plan_focus_with(&table, &s, 100_000),
            FocusPlan::Focus { pid: 123 }
        );
    }

    #[test]
    fn alive_probe_via_companion_name_plans_focus() {
        // codewhale: the short-lived executor pid died, the codewhale-tui
        // companion scan hit must still plan Focus.
        let table = FakeTable::new().with(456, "codewhale-tui", None, false);
        let mut s = session("working", 50_000, None);
        s.provider = "codewhale".into();
        s.source_pid = Some(123);
        assert_eq!(
            plan_focus_with(&table, &s, 100_000),
            FocusPlan::Focus { pid: 456 }
        );
    }

    // ── Dead → LeaseHold/Relaunch wiring (table-injected, no /proc) ──
    #[test]
    fn dead_probe_fresh_work_state_holds_the_lease() {
        let table = FakeTable::new();
        let s = session("working", 50_000, None);
        assert_eq!(plan_focus_with(&table, &s, 100_000), FocusPlan::LeaseHold);
    }

    #[test]
    fn dead_probe_stale_work_state_relaunches() {
        let table = FakeTable::new();
        let s = session("working", 100_000 - 90_001, None);
        assert_eq!(plan_focus_with(&table, &s, 100_000), FocusPlan::Relaunch);
    }

    #[test]
    fn dead_probe_ended_session_relaunches_immediately() {
        let table = FakeTable::new();
        let mut s = session("sweeping", 50_000, Some(50_500));
        s.source_pid = None;
        assert_eq!(plan_focus_with(&table, &s, 51_000), FocusPlan::Relaunch);
    }

    #[test]
    fn dead_probe_idle_state_relaunches() {
        let table = FakeTable::new();
        let s = session("idle", 50_000, None);
        assert_eq!(plan_focus_with(&table, &s, 51_000), FocusPlan::Relaunch);
    }

    #[test]
    fn codex_thread_id_length_boundaries() {
        assert!(!codex_thread_id(""));
        assert!(!codex_thread_id("1234567"));
        assert!(codex_thread_id("12345678"));
        assert!(codex_thread_id(&"a".repeat(128)));
        assert!(!codex_thread_id(&"a".repeat(129)));
    }

    #[test]
    fn codex_thread_id_guards_the_deep_link_surface() {
        assert!(codex_thread_id("01a0c946e5f2478faa9bc0d1e2f3a4b5"));
        assert!(codex_thread_id("thread-123.456:789"));
        // rollout fallback ids are full file paths — must be rejected.
        assert!(!codex_thread_id(
            r"C:\Users\z\.codex\sessions\rollout-2026\file.jsonl"
        ));
        assert!(!codex_thread_id("/home/z/.codex/sessions/x&calc.exe"));
        assert!(!codex_thread_id("short"));
    }
}
