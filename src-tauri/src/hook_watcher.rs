//! R11 backport: settings.json watcher.
//!
//! Mirrors upstream `backend/hooks.js startWatcher()`: polls
//! `~/.claude/settings.json` every 2s for mtime changes. If the file was
//! overwritten by another tool (CC-Switch, manual edits) and our hooks are
//! missing, re-registers them via `install_claude`.
//!
//! Design choices:
//!   * **Polling instead of `notify` crate** — the file is small (~tens of
//!     KB at most) and a 2s mtime probe is negligible CPU. Adding `notify`
//!     would pull in `inotify`/`kqueue`/`ReadDirectoryChangesW` platform
//!     deps for a feature that runs once on startup and sleeps forever
//!     after. The 2s cadence also matches upstream.
//!   * **mtime debounce** — only re-checks hook presence when the file's
//!     modified time actually changed, so idle polling costs ~1 `stat()`
//!     per 2s and never re-installs hooks on an unchanged file.
//!   * **Claude-only** — the upstream watcher only re-registers Claude
//!     hooks because `~/.claude/settings.json` is the file CC-Switch
//!     overwrites. Other providers' config files (CodeWhale TOML, Codex
//!     hooks.json, OpenCode plugin JS, Aider YAML) are not touched by
//!     CC-Switch and don't need watching.
//!   * **Graceful failure** — if the file doesn't exist (Claude not yet
//!     initialized), the watcher skips that tick. If `install_claude`
//!     fails (disk full, permission denied), the error is logged and the
//!     watcher continues — it will retry on the next detected change.
//!   * **Fire-and-forget** — the spawned thread owns its `Arc<Runtime>`
//!     clone and runs for the lifetime of the process. There is no
//!     shutdown signal because the watcher never blocks shutdown: the
//!     thread is `thread::sleep`ing and the process exits without
//!     waiting for it.

use crate::hook_install::{claude_hooks_present, install_claude};
use crate::model::{home_dir, Runtime};
use std::fs;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// How often to poll `settings.json` for mtime changes. Matches upstream.
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Spawn the settings.json watcher thread.
///
/// Called once at startup (from `lib.rs`, after `verify_enabled` so the
/// initial drift log is already recorded). The thread is fire-and-forget:
/// failures inside the loop are logged via `runtime.write_log` and never
/// propagate to the caller. Returns immediately after spawning.
pub fn start_settings_watcher(runtime: Arc<Runtime>) {
    thread::Builder::new()
        .name("octopus-hook-watcher".into())
        .spawn(move || watch_loop(&runtime))
        .ok();
}

/// Main watcher loop. Extracted from `start_settings_watcher` so the
/// `?`-free error handling stays in one place and the spawn closure
/// remains a one-liner.
fn watch_loop(runtime: &Runtime) {
    let settings_path = home_dir().join(".claude").join("settings.json");
    // Seed the last-seen mtime with the file's current state so we don't
    // fire a spurious re-sync on the very first tick (which would be
    // redundant with the startup `verify_enabled` check).
    let mut last_mtime = fs::metadata(&settings_path)
        .ok()
        .and_then(|m| m.modified().ok());

    loop {
        thread::sleep(POLL_INTERVAL);

        // Re-stat the file. If it doesn't exist (Claude not yet
        // initialized) or is unreadable, skip this tick — there's
        // nothing to re-register. `last_mtime` is left untouched so
        // when the file reappears we detect the change.
        let current_mtime = match fs::metadata(&settings_path) {
            Ok(m) => m.modified().ok(),
            Err(_) => continue,
        };

        // Debounce: only act when the file actually changed.
        if current_mtime == last_mtime {
            continue;
        }
        last_mtime = current_mtime;

        // Drift check: only re-install if our hooks are missing. This
        // avoids creating churn (backup files + receipts) when the file
        // was edited by something that preserved our hooks (e.g. user
        // added an unrelated setting).
        if claude_hooks_present() {
            continue;
        }

        runtime.write_log(
            "hooks",
            "settings.json changed and our hooks are missing — re-syncing",
        );

        // `install_claude` takes `_port`/`_token` params for historical
        // reasons but does not use them (the hook command reads
        // port/token from runtime.json at invocation time). Pass 0 / ""
        // since they're ignored.
        let config = runtime.config();
        match install_claude(runtime, 0, "", config.perm_hook) {
            Ok(_) => {
                runtime.write_log("hooks", "Claude hooks re-registered by watcher");
            }
            Err(e) => {
                runtime.write_log("hooks", &format!("watcher re-sync failed: {e}"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The watcher loop sleeps for 2s per tick and reads `~/.claude/settings.json`
    // from the real home directory, so it cannot be unit-tested in isolation
    // without filesystem mocking. Behavior is covered by:
    //   - test/tauri-r11-settings-watcher-smoke.js (structural assertions)
    //   - scripts/rust-structure-smoke.py (lexical balance)
    // Real-machine verification is in scripts/phase-0e-destructive-test.sh.
    //
    // This test just asserts the polling constant matches the upstream cadence
    // so a future edit doesn't silently change it.
    #[test]
    fn poll_interval_is_two_seconds() {
        assert_eq!(POLL_INTERVAL, Duration::from_secs(2));
    }
}
