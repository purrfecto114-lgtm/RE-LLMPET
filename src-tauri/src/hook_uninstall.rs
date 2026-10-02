// R58 (2026-10-02): focused owner for the headless uninstall pipeline.
// Extracted from hook_install.rs when the R58-IMPL-D shell/backup residue
// sweep (R2-R5 of the uninstall audit) pushed that file past its audited
// growth budget (2679 > 2330, r11-settings-watcher-smoke + maintainability
// guards) — the same extraction pattern R54 set with plugin_sources.rs.
// This module owns: receipt reading, the NSIS/CLI headless uninstall run
// (including the R58 `purge` mode), and the post-cleanup shell + backup +
// empty-directory sweeps. Install/sync/marker machinery stays in
// hook_install.rs.

use crate::hook_install::{
    provider_config_path, receipts_dir, uninstall_provider_hooks,
    uninstall_provider_hooks_with_path, write_text_atomic, CleanupResult,
};
use crate::model::{home_dir, APP_DIR_NAME};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

/// Read the latest receipt for each provider. Returns a map keyed by
/// provider id → receipt JSON. Missing or unreadable receipts are
/// silently omitted (caller treats absent key as "never installed by
/// this version's receipt system").
///
/// Phase 0D will use this to show the user "you installed Claude on
/// 2026-08-03 14:23; backup at /home/.../.settings.octopus-bak-...json"
/// before confirming a destructive uninstall.
/// R56: headless hook cleanup for the OS uninstaller (NSIS PREUNINSTALL
/// runs `octopus.exe --uninstall-hooks`; macOS/Linux users must run the
/// flag BEFORE dragging the .app to Trash / `dpkg -r` — the binary is gone
/// afterwards, see README uninstall notes). Removes our hook blocks from
/// every provider config BEFORE the app files are deleted — otherwise every
/// provider CLI is left pointing at a nonexistent binary, and CodeWhale's
/// fail-closed permission hook rejects every tool call ("卸载完 agent 全坏了").
/// Receipt-driven cleanup first (survives env-var drift), env fallback second.
///
/// R58-IMPL-D (A1): `purge` additionally removes the whole `~/.re-llmpet`
/// app data directory (config / runtime / logs / usage ledgers / travel /
/// receipts) after the hook cleanup, and the run now ALWAYS finishes with a
/// shell + backup residue sweep (`sweep_shell_residue`) that deletes the
/// empty config shells and timestamped backups our installer created —
/// the "user folder" residue the uninstall audit (R58-1e) catalogued as
/// R2-R5. Ordering contract: read receipts → clean five providers →
/// sweep shells/backups → (optionally) purge `~/.re-llmpet` — receipts are
/// read into memory FIRST so the purge deleting `~/.re-llmpet/receipts`
/// mid-run cannot blind the sweep.
/// Returns a process exit code: 0 = all clean (removed / not-found / unowned
/// are all acceptable end states), 1 = at least one provider needs attention.
pub fn uninstall_all_hooks_headless(purge: bool) -> i32 {
    let receipts = read_install_receipts();
    let mut failures = 0u32;
    // R58-IMPL-D (A1): keep per-provider outcomes so the post-cleanup sweep
    // knows which providers fully succeeded (backup sweep gate).
    let mut outcomes: Vec<(&'static str, CleanupResult)> = Vec::new();
    for id in ["claude", "codewhale", "codex", "opencode", "aider"] {
        // dsh is observer-only (no installed hooks) — nothing to clean.
        let receipt_path = receipts
            .get(id)
            .and_then(|value| value.get("path"))
            .and_then(Value::as_str)
            .map(PathBuf::from);
        let result = match receipt_path.as_deref() {
            Some(path) => uninstall_provider_hooks_with_path(id, path),
            None => uninstall_provider_hooks(id),
        };
        outcomes.push((id, result.clone()));
        let line = match &result {
            CleanupResult::Removed { path } => {
                format!("{id}: removed ({})", path.display())
            }
            CleanupResult::NotFound { path } => {
                format!("{id}: not-found ({})", path.display())
            }
            CleanupResult::Unowned { path } => {
                format!("{id}: unowned, left intact ({})", path.display())
            }
            CleanupResult::Changed { path } => {
                failures += 1;
                format!("{id}: CHANGED — residue possible ({})", path.display())
            }
            CleanupResult::PathDrift { expected, actual } => {
                failures += 1;
                format!(
                    "{id}: PATH DRIFT expected {} actual {}",
                    expected.display(),
                    actual.display()
                )
            }
            CleanupResult::Unreadable { path, error } => {
                failures += 1;
                format!("{id}: UNREADABLE ({}) — {error}", path.display())
            }
            CleanupResult::Residue { path, detail } => {
                failures += 1;
                format!("{id}: RESIDUE ({}) — {detail}", path.display())
            }
            CleanupResult::ManualActionRequired { path, detail } => {
                failures += 1;
                format!("{id}: MANUAL ACTION ({}) — {detail}", path.display())
            }
        };
        println!("[octopus:uninstall-hooks] {line}");
    }
    // R58-IMPL-D (A1, R2-R5): best-effort shell + backup residue sweep.
    // Never fails the exit code on its own — the provider hooks above are
    // the load-bearing part of the uninstall.
    sweep_shell_residue(&receipts, &outcomes);
    // R58-IMPL-D (A1, R1): `--purge-data` removes the whole app data
    // directory. Runs LAST: receipts were already read into memory and the
    // per-provider cleanups above must complete while receipts still exist
    // on disk for `read_install_receipts`-driven provenance (they were
    // consumed at fn start, this is just the documented ordering contract).
    if purge {
        let dir = home_dir().join(APP_DIR_NAME);
        if !dir.exists() {
            println!(
                "[octopus:uninstall-hooks] purge: {} already absent",
                dir.display()
            );
        } else {
            match fs::remove_dir_all(&dir) {
                Ok(()) => {
                    println!("[octopus:uninstall-hooks] purge: removed {}", dir.display());
                }
                Err(e) => {
                    failures += 1;
                    println!(
                        "[octopus:uninstall-hooks] purge FAILED ({}) — {e}",
                        dir.display()
                    );
                }
            }
        }
    }
    if failures == 0 {
        println!("[octopus:uninstall-hooks] all provider hooks clean");
        0
    } else {
        println!(
            "[octopus:uninstall-hooks] {failures} provider(s) need manual attention (see above)"
        );
        1
    }
}

// ============================================================================
// R58-IMPL-D (A1): post-cleanup shell + backup residue sweep.
//
// The R58-1e uninstall audit catalogued what a "successful"
// --uninstall-hooks run still leaves behind:
//   R2  timestamped config backups (`.octopus-bak-<ts>` and the legacy
//       `re-llmpet-bak-` / `-re-llmpet-backup-` names) in ~/.claude,
//       ~/.codex, ~/.codewhale, ~/.config/opencode/plugins, $HOME
//   R3  config shells WE created: when the install receipt records
//       `backup_path: null` the target file did not exist before our
//       install — every byte in it is ours. After the hook strip the file
//       is either empty or holds only our decoration keys (codex
//       `description`, codewhale `[hooks] enabled = true`), i.e. a shell
//       with zero user data.
//   R4  directories WE created: `write_text_atomic` / `install_opencode`
//       `create_dir_all` the config parents (e.g. ~/.codex,
//       ~/.config/opencode). If, after removing our shell file, the
//       directory is empty, it holds no user data.
//   R5  the codewhale `[hooks]` global-switch table added to a
//       PRE-EXISTING config by `ensure_codewhale_hooks_enabled`.
//
// Guiding principle (audit wording): 只删我们写的段/文件，绝不动用户自有
// 数据；无法判定时保留（宁残留勿误删）。 Provenance always comes from the
// install receipt (`backup_path`) or a byte-compare against the recorded
// backup — never from a guess.
// ============================================================================

/// Run the R2-R5 residue sweep for all five providers. `outcomes` carries
/// the `CleanupResult` of the hook pass that just ran, so backup deletion
/// can be gated on a fully-clean provider (a failed cleanup keeps the
/// backup as the user's only restore path).
fn sweep_shell_residue(receipts: &Map<String, Value>, outcomes: &[(&'static str, CleanupResult)]) {
    for (id, result) in outcomes {
        // id is &&'static str from the tuple borrow; deref to &str once.
        let id: &str = id;
        let receipt = receipts.get(id);
        let config_path: PathBuf = receipt
            .and_then(|value| value.get("path"))
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .unwrap_or_else(|| provider_config_path(id));
        sweep_provider_shell(id, receipt, &config_path);
        // Backups only go away when the live config is verified clean —
        // otherwise they are still the rollback path for this provider.
        if result.is_clean() {
            sweep_our_backups(&config_path);
        }
        sweep_empty_config_dirs(id, &config_path);
    }
}

/// R3+R5: remove shell files / tables that are provably ours.
fn sweep_provider_shell(id: &str, receipt: Option<&Value>, config_path: &Path) {
    // No receipt = no provenance. We cannot prove we created anything here,
    // so leave the file untouched (宁残留勿误删).
    let Some(receipt) = receipt else { return };
    // `backup_path` null/absent = the file did NOT exist before our install
    // (backup_config_file returns Ok(None) exactly in that case) — every
    // byte in it is ours.
    let created_by_us = receipt.get("backup_path").and_then(Value::as_str).is_none();
    match id {
        "claude" if created_by_us => remove_json_shell_file(config_path),
        "codex" if created_by_us => remove_codex_shell_file(config_path),
        "aider" if created_by_us => remove_text_shell_file(config_path),
        "codewhale" if created_by_us => remove_codewhale_shell_file(config_path),
        "codewhale" => remove_codewhale_hooks_table_if_ours(config_path, receipt),
        // opencode's plugin file was already deleted by the cleanup pass;
        // its directories are handled by sweep_empty_config_dirs.
        _ => {}
    }
}

/// Claude shell: `install_claude` writes only the `hooks` object; after
/// `remove_all_ours` a file we created is `{}` or `{"hooks":{}}`.
fn remove_json_shell_file(path: &Path) {
    let Ok(raw) = fs::read_to_string(path) else {
        return; // already gone — nothing to do
    };
    let Ok(root) = serde_json::from_str::<Value>(&raw) else {
        return; // not our known shape — leave it
    };
    let Some(obj) = root.as_object() else { return };
    let hooks_empty = match obj.get("hooks") {
        Some(Value::Object(hooks)) => hooks.is_empty(),
        None => true,
        _ => false,
    };
    let only_hooks_key = obj.keys().all(|key| key == "hooks");
    if only_hooks_key && hooks_empty {
        remove_shell(path);
    }
}

/// Codex shell: `install_codex` sets `description` to the exact string
/// below and fills `hooks`. After cleanup the file is
/// `{"description":"…","hooks":{}}` — delete only that exact shape.
fn remove_codex_shell_file(path: &Path) {
    const CODEX_DESCRIPTION: &str = "Octopus multi-agent desktop integration";
    let Ok(raw) = fs::read_to_string(path) else {
        return;
    };
    let Ok(root) = serde_json::from_str::<Value>(&raw) else {
        return;
    };
    let Some(obj) = root.as_object() else { return };
    let description_is_ours =
        obj.get("description").and_then(Value::as_str) == Some(CODEX_DESCRIPTION);
    let hooks_empty = obj
        .get("hooks")
        .and_then(Value::as_object)
        .map(|hooks| hooks.is_empty())
        .unwrap_or(false);
    let only_known_keys = obj.keys().all(|key| key == "description" || key == "hooks");
    if description_is_ours && hooks_empty && only_known_keys {
        remove_shell(path);
    }
}

/// Aider shell: `install_aider` writes only the marker block; after the
/// strip a file we created is empty (or whitespace only).
fn remove_text_shell_file(path: &Path) {
    let Ok(raw) = fs::read_to_string(path) else {
        return;
    };
    if raw.trim().is_empty() {
        remove_shell(path);
    }
}

/// CodeWhale shell (file created by us): `replace_codewhale_marker_block`
/// runs `ensure_codewhale_hooks_enabled` on the stripped remainder, so a
/// file we created reduces to `[hooks]\nenabled = true` after the marker
/// block is stripped. Delete only that exact shape.
fn remove_codewhale_shell_file(path: &Path) {
    let Ok(raw) = fs::read_to_string(path) else {
        return;
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "[hooks]\nenabled = true" {
        remove_shell(path);
    }
}

fn remove_shell(path: &Path) {
    match fs::remove_file(path) {
        Ok(()) => println!(
            "[octopus:uninstall-hooks] shell removed: {}",
            path.display()
        ),
        Err(e) => println!(
            "[octopus:uninstall-hooks] shell cleanup failed for {} — {e}",
            path.display()
        ),
    }
}

/// R5: the `[hooks]` table added by `ensure_codewhale_hooks_enabled` to a
/// PRE-EXISTING config. Provenance = the pre-install backup recorded in the
/// receipt: if the backup is still readable and contains no `[hooks]` table,
/// the table in the live file was added by us → strip it, but ONLY when the
/// table body holds nothing but our `enabled = true` line (anything else in
/// the body means the user added keys — leave the whole table).
fn remove_codewhale_hooks_table_if_ours(config_path: &Path, receipt: &Value) {
    let Some(backup_path) = receipt
        .get("backup_path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
    else {
        return;
    };
    let Ok(backup_raw) = fs::read_to_string(&backup_path) else {
        return; // backup gone — cannot prove provenance, keep the table
    };
    let backup_had_hooks_table = backup_raw.lines().any(|line| line.trim() == "[hooks]");
    if backup_had_hooks_table {
        return; // the user already had a [hooks] table before us
    }
    let Ok(current) = fs::read_to_string(config_path) else {
        return;
    };
    let Some(cleaned) = strip_hooks_enabled_table(&current) else {
        return; // table body is not exactly ours — leave it
    };
    if let Err(e) = write_text_atomic(config_path, cleaned.as_bytes()) {
        println!(
            "[octopus:uninstall-hooks] codewhale [hooks] table removal failed for {} — {e}",
            config_path.display()
        );
    } else {
        println!(
            "[octopus:uninstall-hooks] codewhale [hooks] table removed (ours, added to pre-existing config): {}",
            config_path.display()
        );
    }
}

/// If `content` contains a top-level `[hooks]` table whose body is ONLY the
/// `enabled = true` line (plus blank lines), return the content without that
/// table. Otherwise return None (the table is not provably ours to remove).
fn strip_hooks_enabled_table(content: &str) -> Option<String> {
    let lines: Vec<&str> = content.lines().collect();
    let header = lines.iter().position(|line| line.trim() == "[hooks]")?;
    let mut end = lines.len();
    for (index, line) in lines.iter().enumerate().skip(header + 1) {
        if line.trim_start().starts_with('[') {
            end = index;
            break;
        }
    }
    let body_is_only_ours = lines[header + 1..end].iter().all(|line| {
        let trimmed = line.trim();
        trimmed.is_empty() || trimmed == "enabled = true" || trimmed == "enabled=true"
    });
    if !body_is_only_ours {
        return None;
    }
    let mut out = String::new();
    for (index, line) in lines.iter().enumerate() {
        if index >= header && index < end {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    Some(out)
}

/// R2: delete our timestamped backups next to `config_path`. The names are
/// unambiguous by construction (`backup_config_file` / legacy codewhale
/// naming): `.<stem>.octopus-bak-<ts>[.<ext>]`, `.<stem>.re-llmpet-bak-<ts>`,
/// `.<stem>-re-llmpet-backup-<ts>.toml`. For aider the parent is $HOME — the
/// scan only ever removes exact-pattern matches, never user files.
fn sweep_our_backups(config_path: &Path) {
    let Some(parent) = config_path.parent() else {
        return;
    };
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        // R58: bind the OsString first — let-else drops the temporary
        // `file_name()` OsString at the statement end, leaving `name`
        // dangling (E0716).
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        if !name.contains(".octopus-bak-")
            && !name.contains(".re-llmpet-bak-")
            && !name.contains("-re-llmpet-backup-")
        {
            continue;
        }
        match fs::remove_file(entry.path()) {
            Ok(()) => println!(
                "[octopus:uninstall-hooks] backup removed: {}",
                entry.path().display()
            ),
            Err(e) => println!(
                "[octopus:uninstall-hooks] backup cleanup failed for {} — {e}",
                entry.path().display()
            ),
        }
    }
}

/// R4: remove config directories that are now empty (and therefore hold no
/// user data). `fs::remove_dir` — NOT `remove_dir_all` — only succeeds on
/// empty directories, so this is structurally incapable of eating data.
/// `~/.claude` normally holds `projects/` etc. and stays; `$HOME` for aider
/// is never empty. For opencode both `plugins/` and the config dir are
/// checked (both were `create_dir_all`-ed by `install_opencode`).
fn sweep_empty_config_dirs(id: &str, config_path: &Path) {
    if id == "opencode" {
        // config_path = <config-dir>/plugins/llmpet-hook.js
        if let Some(plugins_dir) = config_path.parent() {
            remove_dir_if_empty(plugins_dir);
            if let Some(config_dir) = plugins_dir.parent() {
                remove_dir_if_empty(config_dir);
            }
        }
        return;
    }
    if let Some(parent) = config_path.parent() {
        remove_dir_if_empty(parent);
    }
}

fn remove_dir_if_empty(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return; // does not exist — nothing to do
    };
    if entries.flatten().next().is_some() {
        return; // not empty — user data inside, keep it
    }
    // remove_dir only removes EMPTY directories — double safety net.
    match fs::remove_dir(dir) {
        Ok(()) => println!(
            "[octopus:uninstall-hooks] empty dir removed: {}",
            dir.display()
        ),
        Err(e) => println!(
            "[octopus:uninstall-hooks] empty dir cleanup failed for {} — {e}",
            dir.display()
        ),
    }
}

pub fn read_install_receipts() -> Map<String, Value> {
    let dir = receipts_dir();
    let mut out: Map<String, Value> = Map::new();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
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

#[cfg(test)]
mod codewhale_config_tests {
    // R58: these tests moved with the uninstall pipeline but exercise
    // marker/config helpers that stayed in hook_install.rs.
    use crate::hook_install::ensure_codewhale_hooks_enabled;

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

#[cfg(test)]
mod marker_tests {
    // R58: strip_marker_variants lives in hook_install.rs (marker family);
    // only the uninstall pipeline moved here.
    use crate::hook_install::strip_marker_variants;

    const BEGIN: &str = "# >>> octopus:test:v1 >>>";
    const END: &str = "# <<< octopus:test:v1 <<<";

    #[test]
    fn strip_removes_marker_block_and_preserves_surrounding_content() {
        let input = format!("line1\n{BEGIN}\nremoved\n{END}\nline2\n");
        let clean = strip_marker_variants(&input, &[(BEGIN, END)]).unwrap();
        assert!(clean.contains("line1"));
        assert!(clean.contains("line2"));
        assert!(!clean.contains("removed"));
        assert!(!clean.contains(BEGIN));
    }

    #[test]
    fn strip_handles_multiple_marker_variants() {
        let legacy_begin = "# >>> re-llmpet:test:v0 >>>";
        let legacy_end = "# <<< re-llmpet:test:v0 <<<";
        let input = format!(
            "before\n{BEGIN}\ncurrent\n{END}\nmiddle\n{legacy_begin}\nlegacy\n{legacy_end}\nafter\n"
        );
        let clean =
            strip_marker_variants(&input, &[(BEGIN, END), (legacy_begin, legacy_end)]).unwrap();
        assert!(clean.contains("before"));
        assert!(clean.contains("middle"));
        assert!(clean.contains("after"));
        assert!(!clean.contains("current"));
        assert!(!clean.contains("legacy"));
    }

    #[test]
    fn strip_returns_error_on_unterminated_block() {
        let input = format!("line1\n{BEGIN}\ncontent without end\n");
        let result = strip_marker_variants(&input, &[(BEGIN, END)]);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unterminated"));
    }

    #[test]
    fn strip_returns_error_on_nested_begin() {
        let input = format!("{BEGIN}\n{BEGIN}\n{END}\n");
        let result = strip_marker_variants(&input, &[(BEGIN, END)]);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("nested"));
    }

    #[test]
    fn strip_returns_error_on_unmatched_end() {
        let input = format!("line1\n{END}\n");
        let result = strip_marker_variants(&input, &[(BEGIN, END)]);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unmatched"));
    }

    #[test]
    fn strip_preserves_content_with_no_markers() {
        let input = "line1\nline2\nline3\n";
        let clean = strip_marker_variants(input, &[(BEGIN, END)]).unwrap();
        assert_eq!(clean, input);
    }
}
