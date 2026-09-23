// R54 (2026-09-22): focused owner for session resume. Extracted from
// commands.rs when the per-provider resume flags (this round's work) pushed
// that file past its audited growth budget (maintainability-boundary-smoke:
// 3791 > 3600). Everything here answers ONE question: "which argv reopens a
// tracked conversation in its provider's terminal?".

use crate::commands::{agent_spec, agent_working_directory, launch_terminal, resolve_agent};
use crate::model::AppState;
use serde_json::json;
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager, State};

/// R54 (2026-09-22): per-provider session resume arguments. Every entry was
/// verified against the REAL CLI binaries on 2026-09-22 (isolated prefix
/// installs, evidence in reports/provider-smoke/0.6.4/):
///   claude    2.1.278   `claude --resume <id>`  — E2E: `claude -p --resume
///                         <id>` against the mock Anthropic API resumed the
///                         session and replied (claude-resume-proof.txt).
///   codex     0.155.1   `codex resume <id>`    — E2E: `codex exec resume
///                         <id>` fired SessionStart/UserPromptSubmit/Stop
///                         hooks and replied (codex-resume-proof.txt).
///   opencode  1.18.32   `opencode -s <id>`     — E2E: `opencode run
///                         --session <id>` replied (opencode-resume-proof.
///                         txt); the TUI `-s/--session` flag is documented as
///                         "session id to continue" and user-confirmed.
///   codewhale 0.9.13    `codewhale --continue` — `--resume <ID|PREFIX>`
///                         exists, but hook-reported sess_ ids are minted per
///                         launch (a separate namespace from the persisted
///                         resumable ids — upstream executor.rs; sessions/
///                         <uuid>/runtime observed live). `--continue` picks
///                         the most recent interactive session FOR THIS
///                         WORKSPACE, which is the honest approximation when
///                         launching from the session's cwd.
///   aider     0.86.2    `aider --restore-chat-history` (+ --chat-history-file
///                         when the transcript exists). Aider has NO
///                         --resume/--continue — verified across 21 upstream
///                         tags and the full git history (R54-e): resuming is
///                         a file-based mechanism, not an id-based one.
pub(crate) fn provider_resume_args(provider: &str, session_id: &str, cwd: &Path) -> Vec<String> {
    match provider {
        "claude" => vec!["--resume".into(), session_id.into()],
        "codex" => vec!["resume".into(), session_id.into()],
        "opencode" => vec!["-s".into(), session_id.into()],
        "codewhale" => vec!["--continue".into()],
        "aider" => {
            // The chat history lives at the git root (or the cwd when not a
            // repo): .aider.chat.history.md. Check the session cwd first,
            // then a bounded upward git-root walk. No transcript on disk
            // means nothing to restore — launch a fresh session instead of
            // erroring.
            let direct = cwd.join(".aider.chat.history.md");
            let history = if direct.is_file() {
                Some(direct)
            } else {
                let mut ancestor = cwd.to_path_buf();
                let mut found = None;
                for _ in 0..8 {
                    if ancestor.join(".git").exists() {
                        let candidate = ancestor.join(".aider.chat.history.md");
                        if candidate.is_file() {
                            found = Some(candidate);
                        }
                        break;
                    }
                    if !ancestor.pop() {
                        break;
                    }
                }
                found
            };
            match history {
                Some(path) => vec![
                    "--restore-chat-history".into(),
                    "--chat-history-file".into(),
                    path.to_string_lossy().into_owned(),
                ],
                None => Vec::new(),
            }
        }
        _ => Vec::new(),
    }
}

/// Reopen a tracked session through its provider CLI resume surface, in the
/// session's own working directory. Called directly from the IPC surface
/// (`resume_session`) and as the focus-fallback path inside `focus_session`.
pub(crate) fn resume_session_inner(
    app: &AppHandle,
    state: &AppState,
    session_id: &str,
) -> Result<(), String> {
    let session = state
        .runtime
        .session(session_id)
        .ok_or("session no longer exists")?
        .clone();
    if session.headless {
        return Err("headless sessions have no terminal window".into());
    }
    let provider = session.provider.clone();
    let working_directory = if session.cwd.is_empty() {
        agent_working_directory(None)?
    } else {
        agent_working_directory(Some(&session.cwd))?
    };
    let spec = agent_spec(&provider)?;
    let executable = resolve_agent(spec)?;
    let resume_args = provider_resume_args(&provider, session_id, &working_directory);
    launch_terminal(spec, &executable, &working_directory, &resume_args)?;
    state.runtime.write_log(
        "resume",
        &format!(
            "resumed session {} via {} (cwd {}, {} resume args)",
            session_id.chars().take(64).collect::<String>(),
            provider,
            working_directory.display(),
            resume_args.len()
        ),
    );
    // R54 interaction feedback: the pet tells the user the conversation is
    // back instead of silently opening a terminal.
    let _ = app.emit(
        "pet:event",
        json!({"kind":"say","text":"已为你重新打开这个会话。"}),
    );
    for label in ["pet", "pet-codex"] {
        if let Some(pet) = app.get_webview_window(label) {
            let _ = pet.set_always_on_top(true);
        }
    }
    Ok(())
}

/// R54 (2026-09-22): explicit "reopen this conversation" IPC surface. The
/// frontend session rows call `focus_session` (which auto-falls back to
/// this when the owning terminal is gone); this command exists for UIs that
/// want to resume directly.
#[tauri::command]
pub fn resume_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    resume_session_inner(&app, &state, &session_id)
}

#[cfg(test)]
mod tests {
    use super::provider_resume_args;

    // ── R54 (2026-09-22): per-provider session resume arguments ──────────
    // Every flag was verified against the REAL CLI binaries (evidence in
    // reports/provider-smoke/0.6.4/): claude 2.1.278 --resume E2E, codex
    // 0.155.1 resume subcommand E2E, opencode 1.18.32 -s E2E (run mode),
    // codewhale 0.9.13 --continue (hook ids live in a per-launch namespace),
    // aider 0.86.2 --restore-chat-history (no --resume/--continue exists).

    #[test]
    fn resume_args_match_verified_provider_flags() {
        let cwd = std::path::Path::new("/tmp/work");
        let claude = provider_resume_args("claude", "6b8a38b3", cwd);
        assert_eq!(claude, vec!["--resume".to_string(), "6b8a38b3".to_string()]);
        let codex = provider_resume_args("codex", "01a0c946", cwd);
        assert_eq!(codex, vec!["resume".to_string(), "01a0c946".to_string()]);
        let opencode = provider_resume_args("opencode", "ses_x", cwd);
        assert_eq!(opencode, vec!["-s".to_string(), "ses_x".to_string()]);
        // codewhale hook ids (sess_…) are minted per launch — a separate
        // namespace from persisted resumable ids; --continue is the honest
        // workspace-scoped resume.
        let codewhale = provider_resume_args("codewhale", "sess_ab12cd34", cwd);
        assert_eq!(codewhale, vec!["--continue".to_string()]);
        // Unknown providers must not invent flags.
        assert!(provider_resume_args("dsh", "x", cwd).is_empty());
    }

    #[test]
    fn aider_resume_restores_history_only_when_a_transcript_exists() {
        let root = std::env::temp_dir().join("r54-aider-resume-test");
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        let nested = repo.join("a").join("b");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::write(repo.join(".aider.chat.history.md"), b"# history").unwrap();

        // Session cwd is nested deeper than the git root: the transcript is
        // discovered by the bounded upward walk.
        let args = provider_resume_args("aider", "aider:deadbeef", &nested);
        assert_eq!(
            args,
            vec![
                "--restore-chat-history".to_string(),
                "--chat-history-file".to_string(),
                repo.join(".aider.chat.history.md")
                    .to_string_lossy()
                    .into_owned()
            ]
        );

        // No transcript anywhere: launch fresh (no restore flags).
        let bare = root.join("bare");
        std::fs::create_dir_all(&bare).unwrap();
        assert!(provider_resume_args("aider", "aider:cafe", &bare).is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }
}
