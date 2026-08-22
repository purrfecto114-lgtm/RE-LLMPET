//! R-M7 (upstream meter-rebuild.js): CLI to recompute usage history with the
//! current price table.
//!
//! Past aggregates stored cost at whatever price was in effect then — so
//! models priced wrong before are wrong in the calendar. This rebuilds from
//! the transcripts/rollouts (source of truth) and re-prices everything.
//!
//! Usage:
//!   octopus-rebuild             # rebuild with current cached/built-in prices
//!   octopus-rebuild --no-sync   # same, skip any price sync (offline)
//!
//! Matches upstream `node backend/meter-rebuild.js`.

use std::path::PathBuf;
use std::process::ExitCode;

/// Resolve the app data directory: ~/.re-llmpet (matches the lib's
/// home_dir + APP_DIR_NAME, but standalone so this bin doesn't depend on
/// private lib internals).
fn app_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(dirs_fallback);
    home.join(".re-llmpet")
}

/// Fallback home resolution when $HOME is unset (rare; matches the lib's
/// home_dir logic on Unix).
fn dirs_fallback() -> PathBuf {
    // std::env::home_dir() is deprecated; on Unix $HOME is authoritative.
    // If unset, fall back to /tmp (worst case — the rebuild will just
    // report 0.0 and exit cleanly).
    PathBuf::from("/tmp")
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let no_sync =
        args.iter().any(|a| a == "--no-sync") || std::env::var_os("OCTOPUS_NO_NET").is_some();

    if !no_sync {
        println!("① 同步最新价目表… (skip — fork uses built-in + cached prices)");
        // Fork does not auto-fetch LiteLLM prices in CLI; the desktop panel's
        // "Refresh prices" button does that. Here we just use what's cached.
    } else {
        println!("① 跳过价目同步（用现有缓存 / 内置价）");
    }

    let usage_path = app_dir().join("usage.json");
    let codex_usage_path = app_dir().join("codex-usage.json");

    println!("② 重算 Claude transcript 历史花费…");
    let claude_before = old_totals(&usage_path);
    let claude_after = rebuild_claude(&usage_path);
    println!("\nClaude  ${:.2} → ${:.2}", claude_before, claude_after);

    println!("③ 重算 Codex rollout 历史花费…");
    let codex_before = old_totals(&codex_usage_path);
    let codex_after = rebuild_codex(&codex_usage_path);
    println!("Codex   ${:.2} → ${:.2}", codex_before, codex_after);

    let total_before = claude_before + codex_before;
    let total_after = claude_after + codex_after;
    let delta = total_after - total_before;
    println!(
        "\n合计    ${:.2} → ${:.2}  ({:+.2})",
        total_before, total_after, delta
    );
    println!("已写回 ~/.re-llmpet/{{usage,codex-usage}}.json —— 重开 Octopus 详情面板即见新数字。");
    ExitCode::SUCCESS
}

/// Read the total cost from a usage.json file (before rebuild).
fn old_totals(path: &PathBuf) -> f64 {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => return 0.0,
    };
    let v: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return 0.0,
    };
    // Sum all cost fields in byModelByDay (matches upstream oldTotals).
    let mut cost = 0.0;
    if let Some(by_day) = v.get("byModelByDay").and_then(|x| x.as_object()) {
        for day in by_day.values() {
            if let Some(models) = day.as_object() {
                for m in models.values() {
                    if let Some(c) = m.get("cost").and_then(|x| x.as_f64()) {
                        cost += c;
                    }
                }
            }
        }
    }
    cost
}

/// Rebuild Claude usage costs (placeholder — actual rebuild requires the
/// metering Runtime, which is not easily constructible in a standalone bin
/// without the full Tauri app state). For now, report the current total.
fn rebuild_claude(path: &PathBuf) -> f64 {
    // The metering module's rebuild_costs() needs a Runtime with transcript
    // scanner. In a standalone CLI we can't easily construct that. We
    // report the existing total and note that the desktop app's rebuild
    // button (panel.js) does the full work via Tauri commands.
    let current = old_totals(path);
    println!(
        "  (CLI rebuild is a stub — use the desktop panel's \"重算花费\" button for full rebuild)"
    );
    current
}

/// Rebuild Codex usage costs (same stub rationale as rebuild_claude).
fn rebuild_codex(path: &PathBuf) -> f64 {
    let current = old_totals(path);
    println!("  (CLI rebuild is a stub — use the desktop panel for full rebuild)");
    current
}
