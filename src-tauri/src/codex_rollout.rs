//! Incremental Codex rollout watcher.
//!
//! Codex emits `token_count` events containing a cumulative
//! `total_token_usage` snapshot and, on current versions, a per-turn
//! `last_token_usage` delta. Summing the cumulative snapshot on every event
//! over-counts long sessions, so this watcher always prefers the per-turn
//! delta and falls back to a monotonic cumulative difference for older rows.
//! Parsed files are cached by size + modification time because `stats()` is
//! polled frequently by both pet windows and the panel.

use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_ROLLOUT_FILES: usize = 4_000;
const MAX_ROLLOUT_BYTES: u64 = 32 * 1024 * 1024;
const SNAPSHOT_CACHE_MS: u64 = 3_000;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct UsageTotals {
    tokens: u64,
    input: u64,
    output: u64,
    cached: u64,
    reasoning: u64,
}

impl UsageTotals {
    fn add(&mut self, other: Self) {
        self.tokens = self.tokens.saturating_add(other.tokens);
        self.input = self.input.saturating_add(other.input);
        self.output = self.output.saturating_add(other.output);
        self.cached = self.cached.saturating_add(other.cached);
        self.reasoning = self.reasoning.saturating_add(other.reasoning);
    }

    fn delta_from(self, previous: Self) -> Self {
        if self.tokens < previous.tokens {
            return self;
        }
        Self {
            tokens: self.tokens.saturating_sub(previous.tokens),
            input: self.input.saturating_sub(previous.input),
            output: self.output.saturating_sub(previous.output),
            cached: self.cached.saturating_sub(previous.cached),
            reasoning: self.reasoning.saturating_sub(previous.reasoning),
        }
    }

    fn is_empty(self) -> bool {
        self.tokens == 0
            && self.input == 0
            && self.output == 0
            && self.cached == 0
            && self.reasoning == 0
    }

    fn as_json(self) -> Value {
        json!({
            "tokens": self.tokens,
            "input": self.input,
            "output": self.output,
            "cached": self.cached,
            "reasoning": self.reasoning,
        })
    }
}

#[derive(Debug, Clone, Default)]
struct FileSummary {
    session_id: String,
    usage: UsageTotals,
    daily: BTreeMap<String, UsageTotals>,
    latest_limits: Option<(u64, Value)>,
    token_events: u64,
    malformed_lines: u64,
}

#[derive(Debug, Clone)]
struct CachedFile {
    len: u64,
    modified_ms: u64,
    identity: (u64, u64),
    summary: FileSummary,
}

#[derive(Debug, Default)]
struct RolloutCache {
    root: PathBuf,
    app_dir: PathBuf,
    files: HashMap<PathBuf, CachedFile>,
    last_snapshot_ms: u64,
    last_result: Option<(Option<Value>, Option<Value>)>,
}

static CACHE: OnceLock<Mutex<RolloutCache>> = OnceLock::new();

fn codex_home() -> PathBuf {
    if let Some(path) = std::env::var_os("CODEX_HOME") {
        return PathBuf::from(path);
    }
    crate::model::home_dir().join(".codex")
}

/// Return current Codex rate limits and usage. Official Electron aggregate data
/// imported into `app_dir/codex-usage.json` is used only when rollout files are
/// unavailable, avoiding double-counting the same source transcripts.
pub fn snapshot(app_dir: &Path) -> (Option<Value>, Option<Value>) {
    let root = codex_home().join("sessions");
    let now_ms = crate::model::now_ms();
    let cache = CACHE.get_or_init(|| Mutex::new(RolloutCache::default()));
    let mut cache = cache.lock().unwrap_or_else(|error| error.into_inner());

    if cache.root == root
        && cache.app_dir.as_path() == app_dir
        && now_ms.saturating_sub(cache.last_snapshot_ms) < SNAPSHOT_CACHE_MS
        && cache.last_result.is_some()
    {
        return cache.last_result.clone().unwrap_or((None, None));
    }
    if cache.root != root || cache.app_dir != app_dir {
        cache.root = root.clone();
        cache.app_dir = app_dir.to_path_buf();
        cache.files.clear();
        cache.last_result = None;
    }

    let paths = collect_rollout_files(&root);
    if paths.is_empty() {
        let result = (None, load_official_fallback(app_dir));
        cache.last_snapshot_ms = now_ms;
        cache.last_result = Some(result.clone());
        return result;
    }

    let current_paths = paths.iter().cloned().collect::<HashSet<_>>();
    cache.files.retain(|path, _| current_paths.contains(path));
    let mut skipped_large = 0u64;
    let mut unreadable = 0u64;
    for path in paths {
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata)
                if metadata.file_type().is_file() && !metadata.file_type().is_symlink() =>
            {
                metadata
            }
            _ => {
                cache.files.remove(&path);
                unreadable = unreadable.saturating_add(1);
                continue;
            }
        };
        if metadata.len() > MAX_ROLLOUT_BYTES {
            cache.files.remove(&path);
            skipped_large = skipped_large.saturating_add(1);
            continue;
        }
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(system_time_ms)
            .unwrap_or(0);
        let identity = metadata_identity(&metadata);
        let unchanged = cache
            .files
            .get(&path)
            .map(|cached| {
                cached.len == metadata.len()
                    && cached.modified_ms == modified_ms
                    && cached.identity == identity
            })
            .unwrap_or(false);
        if unchanged {
            continue;
        }
        match parse_rollout_file(&path) {
            Ok(summary) => {
                cache.files.insert(
                    path,
                    CachedFile {
                        len: metadata.len(),
                        modified_ms,
                        identity,
                        summary,
                    },
                );
            }
            Err(_) => {
                cache.files.remove(&path);
                unreadable = unreadable.saturating_add(1);
            }
        }
    }

    if cache.files.is_empty() {
        let result = (None, load_official_fallback(app_dir));
        cache.last_snapshot_ms = now_ms;
        cache.last_result = Some(result.clone());
        return result;
    }

    let today_key = crate::metering::local_day_key(now_ms);
    let mut lifetime = UsageTotals::default();
    let mut today = UsageTotals::default();
    let mut latest_limits: Option<(u64, Value)> = None;
    let mut sessions = HashSet::new();
    let mut token_events = 0u64;
    let mut malformed_lines = 0u64;
    for cached in cache.files.values() {
        let summary = &cached.summary;
        lifetime.add(summary.usage);
        if let Some(day) = summary.daily.get(today_key.as_str()) {
            today.add(*day);
        }
        if !summary.session_id.is_empty() {
            sessions.insert(summary.session_id.clone());
        }
        token_events = token_events.saturating_add(summary.token_events);
        malformed_lines = malformed_lines.saturating_add(summary.malformed_lines);
        if let Some((timestamp, limits)) = &summary.latest_limits {
            let replace = latest_limits
                .as_ref()
                .map(|(current, _)| timestamp >= current)
                .unwrap_or(true);
            if replace {
                latest_limits = Some((*timestamp, limits.clone()));
            }
        }
    }

    let limits = latest_limits.map(|(_, limits)| normalize_limits(&limits));
    let usage = Some(json!({
        "today": today.as_json(),
        "lifetime": {
            "tokens": lifetime.tokens,
            "input": lifetime.input,
            "output": lifetime.output,
            "cached": lifetime.cached,
            "reasoning": lifetime.reasoning,
            "sessions": sessions.len(),
            "events": token_events,
        },
        "diagnostics": {
            "source": "rollout-incremental",
            "cachedFiles": cache.files.len(),
            "malformedLines": malformed_lines,
            "skippedLargeFiles": skipped_large,
            "unreadableFiles": unreadable,
            "maxFiles": MAX_ROLLOUT_FILES,
        }
    }));
    let result = (limits, usage);
    cache.last_snapshot_ms = now_ms;
    cache.last_result = Some(result.clone());
    result
}

fn collect_rollout_files(root: &Path) -> Vec<PathBuf> {
    let mut output = Vec::new();
    collect_jsonl(root, 0, &mut output);
    output.sort();
    if output.len() > MAX_ROLLOUT_FILES {
        output.drain(0..output.len() - MAX_ROLLOUT_FILES);
    }
    output
}

fn collect_jsonl(dir: &Path, depth: usize, output: &mut Vec<PathBuf>) {
    if depth > 4 || output.len() >= MAX_ROLLOUT_FILES.saturating_mul(2) {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    let mut entries = entries.flatten().collect::<Vec<_>>();
    // Codex stores sessions under YYYY/MM/DD and timestamped rollout names.
    // Descending traversal means the hard cap retains recent sessions instead
    // of an arbitrary filesystem-order subset.
    entries.sort_by_key(|right| std::cmp::Reverse(right.file_name()));
    for entry in entries {
        if output.len() >= MAX_ROLLOUT_FILES.saturating_mul(2) {
            break;
        }
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_jsonl(&path, depth + 1, output);
        } else if file_type.is_file()
            && path.extension().and_then(|value| value.to_str()) == Some("jsonl")
        {
            output.push(path);
        }
    }
}

fn parse_rollout_file(path: &Path) -> Result<FileSummary, String> {
    let bytes = read_regular_file_bounded(path, MAX_ROLLOUT_BYTES)?;
    let raw = String::from_utf8(bytes).map_err(|error| error.to_string())?;
    let mut summary = FileSummary::default();
    let mut previous_cumulative = UsageTotals::default();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parsed: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => {
                summary.malformed_lines = summary.malformed_lines.saturating_add(1);
                continue;
            }
        };
        let line_type = parsed
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let payload = parsed.get("payload").unwrap_or(&Value::Null);
        if line_type == "session_meta" {
            summary.session_id = json_text(payload, &["id", "session_id", "sessionId"])
                .unwrap_or_else(|| path.to_string_lossy().into_owned());
            continue;
        }
        if line_type != "event_msg"
            || payload.get("type").and_then(Value::as_str) != Some("token_count")
        {
            continue;
        }
        summary.token_events = summary.token_events.saturating_add(1);
        let timestamp_ms = parsed
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_iso_to_unix_ms)
            .unwrap_or(0);
        if let Some(limits) = payload.get("rate_limits").filter(|value| value.is_object()) {
            let replace = summary
                .latest_limits
                .as_ref()
                .map(|(current, _)| timestamp_ms >= *current)
                .unwrap_or(true);
            if replace {
                summary.latest_limits = Some((timestamp_ms, limits.clone()));
            }
        }
        let info = payload.get("info").unwrap_or(&Value::Null);
        let cumulative = parse_usage(
            info.get("total_token_usage")
                .or_else(|| info.get("totalTokenUsage"))
                .unwrap_or(&Value::Null),
        );
        let current = parse_usage(
            info.get("last_token_usage")
                .or_else(|| info.get("lastTokenUsage"))
                .unwrap_or(&Value::Null),
        );
        let delta = if current.is_empty() {
            cumulative.delta_from(previous_cumulative)
        } else {
            current
        };
        previous_cumulative = cumulative;
        if delta.is_empty() {
            continue;
        }
        summary.usage.add(delta);
        let day = crate::metering::local_day_key(timestamp_ms);
        summary.daily.entry(day).or_default().add(delta);
    }
    if summary.session_id.is_empty() {
        summary.session_id = path.to_string_lossy().into_owned();
    }
    Ok(summary)
}

fn parse_usage(value: &Value) -> UsageTotals {
    let input = json_u64(value, &["input_tokens", "inputTokens"]);
    let output = json_u64(value, &["output_tokens", "outputTokens"]);
    let cached = json_u64(
        value,
        &[
            "cached_input_tokens",
            "cachedInputTokens",
            "cached",
            "cacheRead",
        ],
    );
    let reasoning = json_u64(
        value,
        &[
            "reasoning_output_tokens",
            "reasoningOutputTokens",
            "reasoningOutput",
        ],
    );
    let tokens =
        json_u64(value, &["total_tokens", "totalTokens"]).max(input.saturating_add(output));
    UsageTotals {
        tokens,
        input,
        output,
        cached,
        reasoning,
    }
}

fn normalize_limits(limits: &Value) -> Value {
    let primary = limits.get("primary");
    let secondary = limits.get("secondary");
    json!({
        "usedPercent": primary.and_then(|value| value.get("used_percent").or_else(|| value.get("usedPercent"))).and_then(Value::as_f64),
        "resetsAt": primary.and_then(|value| value.get("resets_at").or_else(|| value.get("resetsAt"))).and_then(Value::as_i64),
        "secondaryUsedPercent": secondary.and_then(|value| value.get("used_percent").or_else(|| value.get("usedPercent"))).and_then(Value::as_f64),
        "secondaryResetsAt": secondary.and_then(|value| value.get("resets_at").or_else(|| value.get("resetsAt"))).and_then(Value::as_i64),
        "planType": limits.get("plan_type").or_else(|| limits.get("planType")).and_then(Value::as_str),
    })
}

fn read_regular_file_bounded(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("not a regular file".into());
    }
    if metadata.len() > max_bytes {
        return Err("file exceeds size limit".into());
    }
    let file = File::open(path).map_err(|error| error.to_string())?;
    let opened = file.metadata().map_err(|error| error.to_string())?;
    if !opened.is_file() || opened.len() != metadata.len() || !same_opened_file(&metadata, &opened)
    {
        return Err("file changed while opening".into());
    }
    let mut bytes = Vec::with_capacity(opened.len().min(max_bytes) as usize);
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err("file exceeds size limit".into());
    }
    Ok(bytes)
}

#[cfg(unix)]
fn same_opened_file(before: &fs::Metadata, after: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    before.dev() == after.dev() && before.ino() == after.ino()
}

#[cfg(not(unix))]
fn same_opened_file(before: &fs::Metadata, after: &fs::Metadata) -> bool {
    before.len() == after.len()
}

fn load_official_fallback(app_dir: &Path) -> Option<Value> {
    let path = app_dir.join("codex-usage.json");
    let bytes = read_regular_file_bounded(&path, MAX_ROLLOUT_BYTES).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    let lifetime = official_usage(value.get("lifetime")?);
    let today_key = crate::metering::local_day_key(crate::model::now_ms());
    let today = value
        .get("daily")
        .and_then(|daily| daily.get(today_key.as_str()))
        .map(official_usage)
        .unwrap_or_default();
    Some(json!({
        "today": today.as_json(),
        "lifetime": {
            "tokens": lifetime.tokens,
            "input": lifetime.input,
            "output": lifetime.output,
            "cached": lifetime.cached,
            "reasoning": lifetime.reasoning,
            "sessions": value.get("sessions").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
            "events": value.pointer("/diagnostics/events").and_then(Value::as_u64).unwrap_or(0),
        },
        "diagnostics": { "source": "official-import-fallback" }
    }))
}

fn official_usage(value: &Value) -> UsageTotals {
    let input = json_u64(value, &["input"]);
    let output = json_u64(value, &["output"]);
    let cached = json_u64(value, &["cached", "cacheRead", "cachedInput"]);
    let reasoning = json_u64(value, &["reasoningOutput", "reasoning_output", "reasoning"]);
    let tokens = json_u64(value, &["tokens"]).max(input.saturating_add(output));
    UsageTotals {
        tokens,
        input,
        output,
        cached,
        reasoning,
    }
}

fn json_u64(value: &Value, keys: &[&str]) -> u64 {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .filter_map(|value| {
            value
                .as_u64()
                .or_else(|| value.as_i64().map(|number| number.max(0) as u64))
                .or_else(|| value.as_f64().map(|number| number.max(0.0) as u64))
        })
        .max()
        .unwrap_or(0)
}

fn json_text(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(256).collect())
}

#[cfg(unix)]
fn metadata_identity(metadata: &fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (metadata.dev(), metadata.ino())
}

#[cfg(not(unix))]
fn metadata_identity(metadata: &fs::Metadata) -> (u64, u64) {
    (metadata.len(), 0)
}

fn system_time_ms(value: SystemTime) -> Option<u64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| duration.as_millis().try_into().ok())
}

fn parse_iso_to_unix_ms(value: &str) -> Option<u64> {
    let seconds = parse_iso_to_unix(value)?;
    let millis = value
        .get(19..)
        .and_then(|rest| rest.strip_prefix('.'))
        .map(|fraction| {
            let digits = fraction
                .chars()
                .take_while(|character| character.is_ascii_digit())
                .take(3)
                .collect::<String>();
            if digits.is_empty() {
                0
            } else {
                digits.parse::<u64>().unwrap_or(0) * 10_u64.pow(3 - digits.len() as u32)
            }
        })
        .unwrap_or(0);
    Some(seconds.saturating_mul(1_000).saturating_add(millis))
}

fn parse_iso_to_unix(value: &str) -> Option<u64> {
    if value.len() < 19
        || value.as_bytes().get(4) != Some(&b'-')
        || value.as_bytes().get(7) != Some(&b'-')
        || value.as_bytes().get(10) != Some(&b'T')
        || value.as_bytes().get(13) != Some(&b':')
        || value.as_bytes().get(16) != Some(&b':')
    {
        return None;
    }
    let year = value.get(0..4)?.parse::<u64>().ok()?;
    let month = value.get(5..7)?.parse::<u64>().ok()?;
    let day = value.get(8..10)?.parse::<u64>().ok()?;
    let hour = value.get(11..13)?.parse::<u64>().ok()?;
    let minute = value.get(14..16)?.parse::<u64>().ok()?;
    let second = value.get(17..19)?.parse::<u64>().ok()?;
    if !(1970..=9999).contains(&year)
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let mut days = 0u64;
    for current_year in 1970..year {
        days = days.saturating_add(if is_leap_year(current_year) { 366 } else { 365 });
    }
    let month_days = [0u64, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for current_month in 1..month {
        days = days.saturating_add(month_days[current_month as usize]);
        if current_month == 2 && is_leap_year(year) {
            days = days.saturating_add(1);
        }
    }
    let max_day = month_days[month as usize] + u64::from(month == 2 && is_leap_year(year));
    if day > max_day {
        return None;
    }
    days = days.saturating_add(day - 1);
    Some(
        days.saturating_mul(86_400)
            .saturating_add(hour.saturating_mul(3_600))
            .saturating_add(minute.saturating_mul(60))
            .saturating_add(second.min(59)),
    )
}

fn is_leap_year(year: u64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cumulative_snapshots_are_not_repeatedly_summed() {
        let first = UsageTotals {
            tokens: 100,
            input: 80,
            output: 20,
            ..UsageTotals::default()
        };
        let second = UsageTotals {
            tokens: 160,
            input: 120,
            output: 40,
            ..UsageTotals::default()
        };
        assert_eq!(second.delta_from(first).tokens, 60);
    }

    #[test]
    fn reset_cumulative_counter_starts_a_new_segment() {
        let previous = UsageTotals {
            tokens: 100,
            ..UsageTotals::default()
        };
        let reset = UsageTotals {
            tokens: 20,
            ..UsageTotals::default()
        };
        assert_eq!(reset.delta_from(previous).tokens, 20);
    }

    #[test]
    fn parser_prefers_last_usage_and_does_not_sum_cumulative_snapshots() {
        let path = std::env::temp_dir().join(format!(
            "octopus-codex-rollout-{}-{}.jsonl",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let rows = [
            json!({"type":"session_meta","payload":{"id":"session-a"}}),
            json!({
                "timestamp":"2026-08-04T10:00:00Z",
                "type":"event_msg",
                "payload":{"type":"token_count","info":{
                    "total_token_usage":{"total_tokens":100,"input_tokens":80,"output_tokens":20},
                    "last_token_usage":{"total_tokens":100,"input_tokens":80,"output_tokens":20}
                }}
            }),
            json!({
                "timestamp":"2026-08-04T10:01:00Z",
                "type":"event_msg",
                "payload":{"type":"token_count","info":{
                    "total_token_usage":{"total_tokens":160,"input_tokens":120,"output_tokens":40},
                    "last_token_usage":{"total_tokens":60,"input_tokens":40,"output_tokens":20}
                }}
            }),
        ];
        fs::write(
            &path,
            rows.iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let parsed = parse_rollout_file(&path).unwrap();
        assert_eq!(parsed.session_id, "session-a");
        assert_eq!(parsed.usage.tokens, 160);
        assert_eq!(parsed.usage.input, 120);
        assert_eq!(parsed.usage.output, 40);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn iso_parser_rejects_impossible_dates() {
        assert!(parse_iso_to_unix("2026-02-29T00:00:00Z").is_none());
        assert!(parse_iso_to_unix("2024-02-29T00:00:00Z").is_some());
    }
}
