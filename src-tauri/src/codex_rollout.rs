//! R44 0.5.43: Codex rollout watcher.
//!
//! Tails `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` to extract:
//! - `token_count` events → token usage (input/output/cached/reasoning)
//! - `rate_limits` inside `token_count` → 5h + weekly usage percent + plan type
//!
//! The watcher does a one-shot scan of today's rollout files on each
//! `snapshot()` call (called from `Runtime::stats()`). This avoids the
//! complexity of a background thread + file watcher while still providing
//! near-real-time data (the panel polls stats every few seconds).
//!
//! ## Format (verified against codex-rs source)
//!
//! Each JSONL line is: `{"timestamp":"...","ordinal":N,"type":"event_msg","payload":{"type":"token_count","info":{...},"rate_limits":{...}}}`
//!
//! Key fields:
//! - `payload.info.total_token_usage` → cumulative session usage
//! - `payload.info.last_token_usage` → last turn delta
//! - `payload.rate_limits.primary.used_percent` → 5h window
//! - `payload.rate_limits.secondary.used_percent` → weekly window
//! - `payload.rate_limits.plan_type` → "free"|"go"|"plus"|"pro"|...
//!
//! Reference: codex-rs/protocol/src/protocol.rs (TokenCountEvent, RateLimitSnapshot)

use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

/// Default Codex home directory.
fn codex_home() -> PathBuf {
    if let Some(p) = std::env::var_os("CODEX_HOME") {
        return PathBuf::from(p);
    }
    crate::model::home_dir().join(".codex")
}

/// One-shot snapshot of Codex rollout data. Called from `Runtime::stats()`.
/// Returns `(codex_limits, codex_usage)` as JSON values, or `(None, None)`
/// if no rollout files are found.
pub fn snapshot() -> (Option<Value>, Option<Value>) {
    let sessions_dir = codex_home().join("sessions");
    if !sessions_dir.exists() {
        return (None, None);
    }

    // Scan today's directory (and yesterday's for edge cases around midnight).
    // Format: sessions/YYYY/MM/DD/rollout-*.jsonl
    let mut rollout_files: Vec<PathBuf> = Vec::new();
    if let Ok(years) = fs::read_dir(&sessions_dir) {
        for year_entry in years.flatten() {
            let year_name = match year_entry.file_name().to_str() {
                Some(s) => s.to_string(),
                None => continue,
            };
            if !year_name.chars().all(|c| c.is_ascii_digit()) || year_name.len() != 4 {
                continue;
            }
            // Only scan the most recent year
            if let Ok(months) = fs::read_dir(year_entry.path()) {
                for month_entry in months.flatten() {
                    let month_name = match month_entry.file_name().to_str() {
                        Some(s) => s.to_string(),
                        None => continue,
                    };
                    if !month_name.chars().all(|c| c.is_ascii_digit()) || month_name.len() != 2 {
                        continue;
                    }
                    if let Ok(days) = fs::read_dir(month_entry.path()) {
                        for day_entry in days.flatten() {
                            let day_path = day_entry.path();
                            if let Ok(files) = fs::read_dir(&day_path) {
                                for file_entry in files.flatten() {
                                    let file_path = file_entry.path();
                                    if let Some(ext) = file_path.extension() {
                                        if ext == "jsonl" {
                                            rollout_files.push(file_path);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if rollout_files.is_empty() {
        return (None, None);
    }

    // Parse each file, collecting the latest token_count from each session.
    // Also accumulate lifetime totals across all sessions.
    let mut latest_limits: Option<Value> = None;
    let mut latest_limits_ts: u64 = 0;
    let mut lifetime_input: i64 = 0;
    let mut lifetime_output: i64 = 0;
    let mut lifetime_cached: i64 = 0;
    let mut lifetime_reasoning: i64 = 0;
    let mut lifetime_total: i64 = 0;
    let mut session_count: u64 = 0;
    let mut event_count: u64 = 0;

    // Today's totals (approximate: sessions started in the last 24h)
    let now_secs = crate::model::now_ms() / 1000;
    let day_ago = now_secs.saturating_sub(86400);
    let mut today_input: i64 = 0;
    let mut today_output: i64 = 0;
    let mut today_cached: i64 = 0;
    let mut today_reasoning: i64 = 0;
    let mut today_total: i64 = 0;

    for file_path in &rollout_files {
        let raw = match fs::read_to_string(file_path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let mut has_session_meta = false;
        let mut session_started_ts: u64 = 0;

        for line in raw.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let parsed: Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            event_count += 1;

            let line_type = parsed.get("type").and_then(Value::as_str).unwrap_or("");
            if line_type == "session_meta" {
                has_session_meta = true;
                // Extract session start timestamp
                if let Some(payload) = parsed.get("payload") {
                    if let Some(ts_str) = payload.get("timestamp").and_then(Value::as_str) {
                        // Parse ISO 8601 like "2026-06-01T09:15:22Z"
                        if let Ok(ts) = parse_iso_to_unix(ts_str) {
                            session_started_ts = ts;
                        }
                    }
                }
                continue;
            }

            if line_type != "event_msg" {
                continue;
            }
            let payload = match parsed.get("payload") {
                Some(p) => p,
                None => continue,
            };
            let inner_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
            if inner_type != "token_count" {
                continue;
            }

            // Extract rate_limits
            if let Some(rl) = payload.get("rate_limits") {
                let ts = parsed
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .and_then(|s| parse_iso_to_unix(s).ok())
                    .unwrap_or(0);
                if ts >= latest_limits_ts {
                    latest_limits_ts = ts;
                    latest_limits = Some(rl.clone());
                }
            }

            // Extract token usage from info.total_token_usage
            if let Some(info) = payload.get("info") {
                if let Some(total) = info.get("total_token_usage") {
                    let input = total
                        .get("input_tokens")
                        .and_then(Value::as_i64)
                        .unwrap_or(0);
                    let output = total
                        .get("output_tokens")
                        .and_then(Value::as_i64)
                        .unwrap_or(0);
                    let cached = total
                        .get("cached_input_tokens")
                        .and_then(Value::as_i64)
                        .unwrap_or(0);
                    let reasoning = total
                        .get("reasoning_output_tokens")
                        .and_then(Value::as_i64)
                        .unwrap_or(0);
                    let total_tokens = total
                        .get("total_tokens")
                        .and_then(Value::as_i64)
                        .unwrap_or(0);

                    // Accumulate lifetime (all sessions)
                    lifetime_input += input;
                    lifetime_output += output;
                    lifetime_cached += cached;
                    lifetime_reasoning += reasoning;
                    lifetime_total += total_tokens;

                    // Accumulate today (sessions started in last 24h)
                    if session_started_ts >= day_ago {
                        today_input += input;
                        today_output += output;
                        today_cached += cached;
                        today_reasoning += reasoning;
                        today_total += total_tokens;
                    }
                }
            }
        }
        if has_session_meta {
            session_count += 1;
        }
    }

    // Build codexLimits from the latest rate_limits snapshot
    let codex_limits = latest_limits.map(|rl| {
        let primary = rl.get("primary");
        let secondary = rl.get("secondary");
        json!({
            "usedPercent": primary.and_then(|p| p.get("used_percent")).and_then(Value::as_f64),
            "resetsAt": primary.and_then(|p| p.get("resets_at")).and_then(Value::as_i64),
            "secondaryUsedPercent": secondary.and_then(|p| p.get("used_percent")).and_then(Value::as_f64),
            "secondaryResetsAt": secondary.and_then(|p| p.get("resets_at")).and_then(Value::as_i64),
            "planType": rl.get("plan_type").and_then(Value::as_str),
        })
    });

    // Build codexUsage
    let codex_usage = if session_count > 0 {
        Some(json!({
            "today": {
                "tokens": today_total,
                "input": today_input,
                "output": today_output,
                "cached": today_cached,
                "reasoning": today_reasoning,
            },
            "lifetime": {
                "tokens": lifetime_total,
                "input": lifetime_input,
                "output": lifetime_output,
                "cached": lifetime_cached,
                "reasoning": lifetime_reasoning,
                "sessions": session_count,
                "events": event_count,
            }
        }))
    } else {
        None
    };

    (codex_limits, codex_usage)
}

/// Parse an ISO 8601 timestamp like "2026-06-01T09:15:22.431Z" to Unix seconds.
fn parse_iso_to_unix(s: &str) -> Result<u64, ()> {
    // Simple parser: extract YYYY-MM-DDTHH:MM:SS
    if s.len() < 19 {
        return Err(());
    }
    let year: u64 = s[0..4].parse().map_err(|_| ())?;
    let month: u64 = s[5..7].parse().map_err(|_| ())?;
    let day: u64 = s[8..10].parse().map_err(|_| ())?;
    let hour: u64 = s[11..13].parse().map_err(|_| ())?;
    let minute: u64 = s[14..16].parse().map_err(|_| ())?;
    let second: u64 = s[17..19].parse().map_err(|_| ())?;

    // Days from epoch to start of year
    let mut days: u64 = 0;
    for y in 1970..year {
        days += if is_leap_year(y) { 366 } else { 365 };
    }
    let month_days = [0u64, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for m in 1..month {
        days += month_days[m as usize];
        if m == 2 && is_leap_year(year) {
            days += 1;
        }
    }
    days += day - 1;
    Ok(days * 86400 + hour * 3600 + minute * 60 + second)
}

fn is_leap_year(y: u64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}
