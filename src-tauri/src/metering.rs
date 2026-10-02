use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const CATALOG_JSON: &str = include_str!("../../resources/model-catalog.bundled.json");
const LEDGER_FILE_NAME: &str = "usage-events.jsonl";
pub const PRICE_CACHE_FILE_NAME: &str = "pricing-cache.models-dev.json";
const PRICE_OVERRIDE_FILE_NAME: &str = "pricing.json";
const MAX_PRICE_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_OFFICIAL_USAGE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_LEDGER_READ_BYTES: u64 = 64 * 1024 * 1024;
const COMPACT_AT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 64 * 1024;
const MAX_EVENTS: usize = 50_000;
const RETENTION_MS: u64 = 95 * 24 * 60 * 60 * 1000;
const WINDOW_MS: u64 = 5 * 60 * 60 * 1000;
const CACHE_READ_FALLBACK_RATIO: f64 = 0.1;
const CACHE_WRITE_FALLBACK_RATIO: f64 = 1.25;

#[derive(Debug, Clone, Default)]
struct PriceEntry {
    input: Option<f64>,
    output: Option<f64>,
    cache_read: Option<f64>,
    cache_write: Option<f64>,
    context_window: Option<u64>,
    source: String,
    updated_at: Option<String>,
}

#[derive(Debug, Clone)]
struct CostQuote {
    cost_usd: f64,
    source: String,
    updated_at: Option<String>,
    /// R58: match tier label persisted as `cost_kind`（token-priced /
    /// token-priced-free / normalized-priced / approx-priced），供面板区分
    /// 精确 / 免费 / 规范化估算 / 前缀近似 / 未知。
    kind: &'static str,
}

/// R58 (2026-10-02): price lookup match tier. The pre-R58 lookup was
/// exact-or-fuzzy with no distinction, so OpenRouter-style ids
/// (`deepseek/deepseek-chat:free`) missed every layer and surfaced
/// 价格未知, while bare `:free` variants silently billed the PAID rate
/// via the prefix-fuzzy layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PriceMatchKind {
    /// provider-qualified / exact / case-folded catalog key hit
    Exact,
    /// `:free` modifier — OpenRouter free rows are billed $0 per token
    FreeVariant,
    /// `:modifier` / vendor prefix / dated suffix had to be stripped
    Normalized,
    /// longest-prefix fallback onto an adjacent catalog model
    PrefixApprox,
}

impl PriceMatchKind {
    fn cost_kind(self) -> &'static str {
        match self {
            PriceMatchKind::Exact => "token-priced",
            PriceMatchKind::FreeVariant => "token-priced-free",
            PriceMatchKind::Normalized => "normalized-priced",
            PriceMatchKind::PrefixApprox => "approx-priced",
        }
    }
}

#[derive(Debug, Clone, Default)]
struct PriceCatalog {
    entries: HashMap<String, PriceEntry>,
    source: String,
    updated_at: Option<String>,
    live: bool,
    load_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageEvent {
    pub event_id: String,
    pub timestamp_ms: u64,
    pub provider: String,
    pub billing_provider: Option<String>,
    pub billing_surface: Option<String>,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub model: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_create: u64,
    // R18 (2026-07-30): Anthropic exposes cache writes split by TTL —
    // 5-minute ephemeral and 1-hour ephemeral. Older transcript rows only
    // have the aggregate cache_creation_input_tokens; we attribute the
    // full amount to 5m in that case (Anthropic's default TTL is 5m).
    // serde(default) keeps older ledger JSON loading without breakage.
    #[serde(default)]
    pub cache_write_5m: u64,
    #[serde(default)]
    pub cache_write_1h: u64,
    #[serde(default = "default_true")]
    pub input_includes_cache: bool,
    pub reasoning: u64,
    pub reasoning_replay: u64,
    pub context_used: Option<u64>,
    pub context_limit: Option<u64>,
    pub cost_usd: Option<f64>,
    #[serde(default)]
    pub cost_kind: Option<String>,
    #[serde(default)]
    pub price_source: Option<String>,
    #[serde(default)]
    pub price_updated_at: Option<String>,
    #[serde(default)]
    pub schema_keys: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct UsageIngest {
    pub inserted: bool,
    pub duplicate: bool,
    pub context_used: Option<u64>,
    pub context_limit: Option<u64>,
}

pub struct UsageLedger {
    path: PathBuf,
    events: Vec<UsageEvent>,
    seen: HashSet<String>,
    catalog: PriceCatalog,
    malformed_lines: u64,
    duplicate_events: u64,
    load_message: Option<String>,
    official_imported_events: u64,
    official_malformed_records: u64,
}

#[derive(Debug, Clone, Default)]
struct Aggregate {
    cost: f64,
    input: u64,
    output: u64,
    cache_create: u64,
    cache_read: u64,
    // R18: split cache writes by TTL for parity with upstream metering.js
    cache_write_5m: u64,
    cache_write_1h: u64,
    tokens: u64,
    messages: u64,
    unknown_price: u64,
    estimated_price: u64,
}

impl Aggregate {
    fn add(&mut self, event: &UsageEvent) {
        self.cost += event.cost_usd.unwrap_or(0.0);
        self.input = self.input.saturating_add(event.input);
        self.output = self.output.saturating_add(event.output);
        self.cache_create = self.cache_create.saturating_add(event.cache_create);
        self.cache_read = self.cache_read.saturating_add(event.cache_read);
        self.cache_write_5m = self.cache_write_5m.saturating_add(event.cache_write_5m);
        self.cache_write_1h = self.cache_write_1h.saturating_add(event.cache_write_1h);
        let mut tokens = event.input.saturating_add(event.output);
        if !event.input_includes_cache {
            tokens = tokens
                .saturating_add(event.cache_read)
                .saturating_add(event.cache_create);
        }
        self.tokens = self.tokens.saturating_add(tokens);
        self.messages = self.messages.saturating_add(1);
        if event.cost_usd.is_none() {
            self.unknown_price = self.unknown_price.saturating_add(1);
        }
        if matches!(
            event.cost_kind.as_deref(),
            Some("api-equivalent-estimate") | Some("normalized-priced") | Some("approx-priced")
        ) {
            // R58: normalized/approx matches count as estimates so the panel's
            // existing ≈ / 含估算 presentation separates them from exact hits.
            self.estimated_price = self.estimated_price.saturating_add(1);
        }
    }

    fn to_json(&self) -> Value {
        json!({
            "cost": self.cost,
            "input": self.input,
            "output": self.output,
            "cacheCreate": self.cache_create,
            "cacheWrite5m": self.cache_write_5m,
            "cacheWrite1h": self.cache_write_1h,
            "cacheRead": self.cache_read,
            "tokens": self.tokens,
            "messages": self.messages,
            "msgs": self.messages,
            "unknownPrice": self.unknown_price,
            "estimatedPrice": self.estimated_price
        })
    }
}

impl UsageLedger {
    pub fn open(app_dir: &Path, now_ms: u64) -> Self {
        let path = app_dir.join(LEDGER_FILE_NAME);
        // R2-D1 fix (R3): recover from a crashed `compact()`. If the
        // process died mid-compact, a `.usage-events.<pid>.tmp` file is
        // left in the app dir. If it is valid (every line parses as a
        // JSON event) AND the main ledger is missing or older, we promote
        // it; otherwise we discard it so the next compact can run cleanly
        // instead of accumulating orphan tmps. See `recover_compact_tmp`.
        recover_compact_tmp(&path);
        let catalog = load_catalog(app_dir);
        let mut ledger = Self {
            path,
            events: Vec::new(),
            seen: HashSet::new(),
            catalog,
            malformed_lines: 0,
            duplicate_events: 0,
            load_message: None,
            official_imported_events: 0,
            official_malformed_records: 0,
        };
        if let Err(error) = ledger.load(now_ms) {
            ledger.append_load_message(error);
        }
        match ledger.import_official_usage(app_dir, now_ms) {
            Ok(imported) if imported > 0 => {
                ledger.official_imported_events = imported as u64;
                ledger.events.sort_by_key(|event| event.timestamp_ms);
                ledger.prune(now_ms);
                if let Err(error) = ledger.compact() {
                    ledger.append_load_message(format!(
                        "official usage import was not persisted: {error}"
                    ));
                }
            }
            Ok(_) => {}
            Err(error) => {
                ledger.append_load_message(format!("official usage import ignored: {error}"))
            }
        }
        ledger
    }

    fn append_load_message(&mut self, message: String) {
        self.load_message = Some(match self.load_message.take() {
            Some(existing) if !existing.is_empty() => format!("{existing}; {message}"),
            _ => message,
        });
    }

    /// Convert the official Electron aggregate record file into the native
    /// append-only ledger. The event id deliberately matches the transcript
    /// scanner (`claude:assistant:<message>|<request>`) so later transcript
    /// discovery deduplicates rather than charging the imported row twice.
    fn import_official_usage(&mut self, app_dir: &Path, now_ms: u64) -> Result<usize, String> {
        let path = app_dir.join("usage.json");
        let Some(document) = read_json_bounded(&path, MAX_OFFICIAL_USAGE_BYTES)? else {
            return Ok(0);
        };
        let Some(records) = document.get("records").and_then(Value::as_object) else {
            return Ok(0);
        };
        let cutoff = now_ms.saturating_sub(RETENTION_MS);
        let mut imported = 0usize;
        for (record_key, record) in records {
            if record_key.is_empty() || record_key.chars().count() > 600 {
                self.official_malformed_records = self.official_malformed_records.saturating_add(1);
                continue;
            }
            let Some(object) = record.as_object() else {
                self.official_malformed_records = self.official_malformed_records.saturating_add(1);
                continue;
            };
            let timestamp_ms = object
                .get("ts")
                .and_then(json_timestamp_ms)
                .filter(|value| *value >= cutoff && *value <= now_ms.saturating_add(5 * 60 * 1000));
            let model = object
                .get("model")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.chars().take(256).collect::<String>());
            let usage = object.get("usage").and_then(Value::as_object);
            let (Some(timestamp_ms), Some(model), Some(usage)) = (timestamp_ms, model, usage)
            else {
                self.official_malformed_records = self.official_malformed_records.saturating_add(1);
                continue;
            };
            let input = number(usage, &["input", "input_tokens"]).unwrap_or(0);
            let output = number(usage, &["output", "output_tokens"]).unwrap_or(0);
            let cache_read = number(usage, &["cacheRead", "cache_read_input_tokens"]).unwrap_or(0);
            let cache_write_5m = number(usage, &["cacheWrite5m", "cache_write_5m"]).unwrap_or(0);
            let cache_write_1h = number(usage, &["cacheWrite1h", "cache_write_1h"]).unwrap_or(0);
            let cache_create = number(usage, &["cacheCreate", "cache_creation_input_tokens"])
                .unwrap_or_else(|| cache_write_5m.saturating_add(cache_write_1h));
            if input == 0 && output == 0 && cache_read == 0 && cache_create == 0 {
                continue;
            }
            let event_id = format!("claude:assistant:{record_key}");
            if self.seen.contains(&event_id) {
                continue;
            }
            let turn_id = record_key
                .split_once('|')
                .map(|(message_id, _)| message_id)
                .filter(|value| !value.is_empty())
                .map(|value| value.chars().take(256).collect::<String>());
            let session_id = object
                .get("sessionId")
                .or_else(|| object.get("session_id"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.chars().take(256).collect::<String>())
                .unwrap_or_else(|| "official-import".into());
            let context_used = input
                .saturating_add(cache_read)
                .saturating_add(cache_create);
            let context_limit = self
                .find_price(&model, Some("anthropic"))
                .and_then(|entry| entry.context_window);
            let quote = self.cost_for(
                &model,
                Some("anthropic"),
                input,
                output,
                cache_read,
                cache_create,
                false,
            );
            let (cost_usd, price_source, price_updated_at, _price_kind) = quote_parts(quote); // R58: import path keeps its api-equivalent-estimate label
            let mut schema_keys = object.keys().cloned().collect::<Vec<_>>();
            schema_keys.sort();
            schema_keys.truncate(64);
            self.seen.insert(event_id.clone());
            self.events.push(UsageEvent {
                event_id,
                timestamp_ms,
                provider: "claude".into(),
                billing_provider: Some("anthropic".into()),
                billing_surface: Some("official-electron-import".into()),
                session_id,
                turn_id,
                model,
                input,
                output,
                cache_read,
                cache_create,
                cache_write_5m,
                cache_write_1h,
                input_includes_cache: false,
                reasoning: 0,
                reasoning_replay: 0,
                context_used: Some(context_used),
                context_limit,
                cost_usd,
                cost_kind: cost_usd.map(|_| "api-equivalent-estimate".to_string()),
                price_source,
                price_updated_at,
                schema_keys,
            });
            imported = imported.saturating_add(1);
        }
        Ok(imported)
    }

    pub fn record_hook(&mut self, body: &Value, observed_at: u64) -> Result<UsageIngest, String> {
        let Some(event) = self.parse_hook(body, observed_at) else {
            return Ok(UsageIngest::default());
        };
        self.store_event(event, observed_at)
    }

    pub fn record_claude_assistant(
        &mut self,
        line: &Value,
        session_hint: &str,
        observed_at: u64,
    ) -> Result<UsageIngest, String> {
        let Some(event) = self.parse_claude_assistant(line, session_hint, observed_at) else {
            return Ok(UsageIngest::default());
        };
        self.store_event(event, observed_at)
    }

    pub fn reload_catalog(&mut self, app_dir: &Path) {
        self.catalog = load_catalog(app_dir);
    }

    /// R11 backport: recompute all event costs with the current price catalog.
    /// Past events stored cost at whatever price was in effect then — so models
    /// priced wrong before (e.g. new model billed at default) are wrong in the
    /// calendar. This re-prices every event and rewrites the ledger atomically.
    /// Returns (before_total, after_total, event_count).
    pub fn rebuild_costs(&mut self) -> (f64, f64, usize) {
        let before_total: f64 = self.events.iter().filter_map(|e| e.cost_usd).sum();
        let count = self.events.len();
        type EventPriceParams = (String, Option<String>, u64, u64, u64, u64, bool);
        let params: Vec<EventPriceParams> = self
            .events
            .iter()
            .map(|e| {
                (
                    e.model.clone(),
                    e.billing_provider.clone(),
                    e.input,
                    e.output,
                    e.cache_read,
                    e.cache_create,
                    e.input_includes_cache,
                )
            })
            .collect();
        // R58-RV-2 P1: pre-compute one quote per UNIQUE (model, billing)
        // pair — the old per-event lookup re-ran the full tiered scan
        // (including the O(catalog) L4 pass) for every "unknown"-model row,
        // which with a large ledger turns rebuild into O(N_events ×
        // N_entries) while holding the usage mutex on a sync command.
        use std::collections::HashMap as StdHashMap;
        let mut quote_cache: StdHashMap<(String, Option<String>), Option<CostQuote>> =
            StdHashMap::new();
        for (i, (model, billing, input, output, cache_read, cache_create, incl)) in
            params.into_iter().enumerate()
        {
            let quote = quote_cache
                .entry((model.clone(), billing.clone()))
                .or_insert_with(|| {
                    self.cost_for(
                        &model,
                        billing.as_deref(),
                        input,
                        output,
                        cache_read,
                        cache_create,
                        incl,
                    )
                })
                .clone();
            if let Some(q) = quote {
                if let Some(event) = self.events.get_mut(i) {
                    event.cost_usd = Some(q.cost_usd);
                    event.price_source = Some(q.source);
                    event.price_updated_at = q.updated_at;
                    // R58: hook-sourced rows adopt the CURRENT match tier so
                    // 重算花费 re-labels old unknown rows after a catalog
                    // refresh; transcript estimate labels are preserved.
                    if event.cost_kind.as_deref() != Some("api-equivalent-estimate") {
                        event.cost_kind = Some(q.kind.to_string());
                    }
                }
            }
        }
        let after_total: f64 = self.events.iter().filter_map(|e| e.cost_usd).sum();
        let _ = self.rewrite_ledger();
        (before_total, after_total, count)
    }

    fn rewrite_ledger(&self) -> Result<(), String> {
        let temp = self
            .path
            .parent()
            .ok_or("ledger path has no parent")?
            .join(format!(".usage-events.{}.tmp", std::process::id()));
        let mut content = String::new();
        for event in &self.events {
            if let Ok(line) = serde_json::to_string(event) {
                content.push_str(&line);
                content.push('\n');
            }
        }
        std::fs::write(&temp, content).map_err(|e| format!("write temp: {e}"))?;
        std::fs::rename(&temp, &self.path).map_err(|e| format!("rename: {e}"))?;
        Ok(())
    }

    fn store_event(&mut self, event: UsageEvent, observed_at: u64) -> Result<UsageIngest, String> {
        let result = UsageIngest {
            context_used: event.context_used,
            context_limit: event.context_limit,
            ..UsageIngest::default()
        };
        // Old replayed events may arrive after a provider restores a session.
        // Keep their context signal but do not let stale records grow the ledger.
        if event.timestamp_ms < observed_at.saturating_sub(RETENTION_MS) {
            return Ok(result);
        }
        if self.seen.contains(&event.event_id) {
            self.duplicate_events = self.duplicate_events.saturating_add(1);
            return Ok(UsageIngest {
                duplicate: true,
                ..result
            });
        }

        self.append(&event)?;
        self.seen.insert(event.event_id.clone());
        self.events.push(event);
        self.prune(observed_at);
        if self.events.len() >= MAX_EVENTS
            || fs::metadata(&self.path)
                .map(|meta| meta.len() >= COMPACT_AT_BYTES)
                .unwrap_or(false)
        {
            self.compact()?;
        }
        Ok(UsageIngest {
            inserted: true,
            ..result
        })
    }

    pub fn snapshot(&self, now_ms: u64) -> Value {
        let today_key = local_day_key(now_ms);
        let mut today = Aggregate::default();
        let mut window = Aggregate::default();
        let mut by_model: BTreeMap<String, Aggregate> = BTreeMap::new();
        let mut provider_cost: BTreeMap<String, Aggregate> = BTreeMap::new();
        let mut daily: BTreeMap<String, Aggregate> = BTreeMap::new();
        let mut hourly = vec![0.0_f64; 24];
        let mut hourly_tok = vec![0_u64; 24];
        let window_start = now_ms.saturating_sub(WINDOW_MS);
        let mut window_oldest = None::<u64>;

        for event in &self.events {
            let day = local_day_key(event.timestamp_ms);
            daily.entry(day.clone()).or_default().add(event);
            if day == today_key {
                today.add(event);
                by_model.entry(event.model.clone()).or_default().add(event);
                provider_cost
                    .entry(event.provider.clone())
                    .or_default()
                    .add(event);
                let hour = local_hour(event.timestamp_ms);
                hourly[hour] += event.cost_usd.unwrap_or(0.0);
                hourly_tok[hour] =
                    hourly_tok[hour].saturating_add(event.input.saturating_add(event.output));
            }
            if event.timestamp_ms >= window_start
                && event.timestamp_ms <= now_ms.saturating_add(5 * 60 * 1000)
            {
                window.add(event);
                window_oldest = Some(
                    window_oldest
                        .map(|oldest| oldest.min(event.timestamp_ms))
                        .unwrap_or(event.timestamp_ms),
                );
            }
        }

        let by_model = by_model
            .into_iter()
            .map(|(key, value)| (key, value.to_json()))
            .collect::<Map<String, Value>>();
        let provider_cost = provider_cost
            .into_iter()
            .map(|(key, value)| (key, value.to_json()))
            .collect::<Map<String, Value>>();
        let daily = daily
            .into_iter()
            .map(|(key, value)| {
                (
                    key,
                    json!({
                        "cost": value.cost,
                        "tokens": value.tokens,
                        "msgs": value.messages,
                        "unknownPrice": value.unknown_price,
                        "estimatedPrice": value.estimated_price
                    }),
                )
            })
            .collect::<Map<String, Value>>();

        json!({
            "today": today.to_json(),
            "window5h": {
                "cost": window.cost,
                "tokens": window.tokens,
                "startTs": window_oldest,
                "resetTs": window_oldest.map(|ts| ts.saturating_add(WINDOW_MS)),
                "unknownPrice": window.unknown_price,
                "estimatedPrice": window.estimated_price
            },
            "byModel": by_model,
            "providerCost": provider_cost,
            "hourly": hourly,
            "hourlyTok": hourly_tok,
            "daily": daily,
            "diagnostics": {
                "ledgerEvents": self.events.len(),
                "duplicateEvents": self.duplicate_events,
                "malformedLines": self.malformed_lines,
                "loadMessage": self.load_message.clone(),
                "officialImportedEvents": self.official_imported_events,
                "officialMalformedRecords": self.official_malformed_records,
            }
        })
    }

    pub fn price_info(&self) -> Value {
        // R2-D18 fix (R3): only expose the ledger file NAME, not its
        // absolute path. The full path leaks the user's home directory
        // layout to the frontend (and any injected script in the
        // webview). The filename is sufficient for debug display.
        let ledger_name = self
            .path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        json!({
            "source": self.catalog.source.clone(),
            "updatedAt": self.catalog.updated_at.clone(),
            "ts": self.catalog.updated_at.clone(),
            "status": if self.catalog.live { "live-cache" } else { "bundled-offline" },
            "live": self.catalog.live,
            "models": self.catalog.entries.len(),
            "count": self.catalog.entries.len(),
            "loadMessage": self.catalog.load_message.clone(),
            "ledger": ledger_name,
            "unknownPricesAreEstimated": false
        })
    }

    fn parse_hook(&self, body: &Value, observed_at: u64) -> Option<UsageEvent> {
        let object = body.as_object()?;
        let provider = text(object, &["provider"], 32).unwrap_or_else(|| "claude".into());
        let native_event = text(object, &["native_event", "event"], 96).unwrap_or_default();
        // R54 (2026-09-22): opencode's message.updated (assistant, completed)
        // carries the per-turn tokens object; normalize_opencode_native
        // reshapes it into the same `turn_usage` fields codewhale turn_end
        // uses, so this gate accepts both producers.
        // R56: dsh turn/end now carries a per-turn turn_usage delta with its
        // native_event name attached (dsh_watch.rs) — same gate shape as the
        // other native producers.
        let is_usage_event = (provider == "codewhale" && native_event == "turn_end")
            || (provider == "opencode" && native_event == "message.updated")
            || (provider == "dsh" && native_event == "turn_end");
        if !is_usage_event {
            return None;
        }

        let usage = object.get("usage").and_then(Value::as_object);
        let normalized = object.get("turn_usage").and_then(Value::as_object);
        let input = number_from(normalized, &["input"])
            .or_else(|| number_from(usage, &["input_tokens"]))
            .unwrap_or(0);
        let output = number_from(normalized, &["output"])
            .or_else(|| number_from(usage, &["output_tokens"]))
            .unwrap_or(0);
        let cache_read = number_from(normalized, &["cache_read"])
            .or_else(|| number_from(usage, &["prompt_cache_hit_tokens"]))
            .unwrap_or(0);
        let cache_miss = number_from(normalized, &["cache_create"])
            .or_else(|| number_from(usage, &["prompt_cache_miss_tokens"]))
            .unwrap_or(0);
        let cache_write = number_from(normalized, &["cache_write"])
            .or_else(|| number_from(usage, &["prompt_cache_write_tokens"]))
            .unwrap_or(0);
        let cache_create = cache_miss.max(cache_write);
        let reasoning = number_from(normalized, &["reasoning"])
            .or_else(|| number_from(usage, &["reasoning_tokens"]))
            .unwrap_or(0);
        let reasoning_replay = number_from(normalized, &["reasoning_replay"])
            .or_else(|| number_from(usage, &["reasoning_replay_tokens"]))
            .unwrap_or(0);
        if input == 0 && output == 0 && cache_read == 0 && cache_create == 0 {
            return None;
        }

        let model = text(object, &["model"], 256).unwrap_or_else(|| "unknown".into());
        let session_id = text(object, &["session_id", "sessionId"], 256)
            .unwrap_or_else(|| "codewhale:unknown".into());
        let turn_id = text(object, &["turn_id", "turnId"], 256);
        let billing_provider = text(object, &["billing_provider"], 64);
        let billing_surface = text(object, &["billing_surface"], 128);
        let duration = number(object, &["turn_duration_ms", "duration_ms"]).unwrap_or(0);
        let timestamp_ms = number(object, &["created_at_ms", "createdAtMs"])
            .or_else(|| {
                text(object, &["created_at", "createdAt"], 128)
                    .and_then(|value| parse_rfc3339_ms(&value))
            })
            .filter(|value| *value <= observed_at.saturating_add(5 * 60 * 1000))
            .unwrap_or_else(|| observed_at.saturating_sub(duration.min(30 * 24 * 60 * 60 * 1000)));
        let totals = object.get("totals").and_then(Value::as_object);
        let context = object.get("context_usage").and_then(Value::as_object);
        let context_used = number_from(context, &["used"])
            .or_else(|| number_from(totals, &["conversation_tokens"]));
        let context_limit = self
            .find_price(&model, billing_provider.as_deref())
            .and_then(|entry| entry.context_window);
        let quote = if token_priced_surface(billing_surface.as_deref()) {
            self.cost_for(
                &model,
                billing_provider.as_deref(),
                input,
                output,
                cache_read,
                cache_create,
                true,
            )
        } else {
            None
        };
        let (cost_usd, price_source, price_updated_at, price_kind) = quote_parts(quote);
        let event_id = turn_id
            .as_ref()
            .filter(|value| !value.is_empty())
            .map(|value| format!("codewhale:turn:{value}"))
            .unwrap_or_else(|| {
                let created = text(object, &["created_at"], 128).unwrap_or_default();
                stable_event_id(&format!(
                    "{session_id}|{model}|{created}|{input}|{output}|{cache_read}|{cache_create}"
                ))
            });

        let mut schema_keys = object.keys().cloned().collect::<Vec<_>>();
        schema_keys.sort();
        schema_keys.truncate(64);

        Some(UsageEvent {
            event_id,
            timestamp_ms,
            provider,
            billing_provider,
            billing_surface,
            session_id,
            turn_id,
            model,
            input,
            output,
            cache_read,
            cache_create,
            // R18: CodeWhale turn_end hooks do not expose the 5m/1h TTL split.
            // The aggregate cache_create is preserved for cost math; the
            // split fields stay 0 so the panel's 5m/1h rows read 0 until
            // CodeWhale starts emitting the split.
            cache_write_5m: 0,
            cache_write_1h: 0,
            input_includes_cache: true,
            reasoning,
            reasoning_replay,
            context_used,
            context_limit,
            cost_usd,
            cost_kind: price_kind, // R58: layered match tier (token-priced/free/normalized/approx)
            price_source,
            price_updated_at,
            schema_keys,
        })
    }

    fn parse_claude_assistant(
        &self,
        line: &Value,
        session_hint: &str,
        observed_at: u64,
    ) -> Option<UsageEvent> {
        let object = line.as_object()?;
        if object.get("type").and_then(Value::as_str) != Some("assistant")
            || object.get("isApiErrorMessage").and_then(Value::as_bool) == Some(true)
            || object.get("isSidechain").and_then(Value::as_bool) == Some(true)
        {
            return None;
        }
        let message = object.get("message").and_then(Value::as_object)?;
        let usage = message.get("usage").and_then(Value::as_object)?;
        let input = number(usage, &["input_tokens"]).unwrap_or(0);
        let output = number(usage, &["output_tokens"]).unwrap_or(0);
        let cache_read = number(usage, &["cache_read_input_tokens"]).unwrap_or(0);
        let cache_create = number(usage, &["cache_creation_input_tokens"]).unwrap_or(0);
        if input == 0 && output == 0 && cache_read == 0 && cache_create == 0 {
            return None;
        }
        // R18 (2026-07-30): Anthropic exposes cache writes split by TTL via
        // usage.cache_creation.ephemeral_5m_input_tokens /
        // ephemeral_1h_input_tokens. Older transcript rows only have the
        // aggregate cache_creation_input_tokens; we attribute the full
        // remainder to 5m (Anthropic's default TTL is 5 minutes), matching
        // upstream metering.js usageSnapshot().
        let cache_creation_obj = usage.get("cache_creation").and_then(Value::as_object);
        let explicit_5m = cache_creation_obj
            .and_then(|o| number(o, &["ephemeral_5m_input_tokens"]))
            .unwrap_or(0);
        let one_hour = cache_creation_obj
            .and_then(|o| number(o, &["ephemeral_1h_input_tokens"]))
            .unwrap_or(0);
        let five_minute = explicit_5m
            .saturating_add(cache_create.saturating_sub(explicit_5m.saturating_add(one_hour)));
        let cache_write_5m = five_minute;
        let cache_write_1h = one_hour;
        let model = text(message, &["model"], 256).unwrap_or_else(|| "unknown".into());
        let session_id = text(object, &["sessionId", "session_id"], 256)
            .or_else(|| {
                (!session_hint.is_empty()).then(|| session_hint.chars().take(256).collect())
            })
            .unwrap_or_else(|| "claude:unknown".into());
        let message_id = text(message, &["id"], 256);
        let request_id = text(object, &["requestId", "request_id"], 256).unwrap_or_default();
        let timestamp_ms = text(object, &["timestamp"], 128)
            .and_then(|value| parse_rfc3339_ms(&value))
            .filter(|value| *value <= observed_at.saturating_add(5 * 60 * 1000))
            .unwrap_or(observed_at);
        let event_id = message_id
            .as_ref()
            .map(|value| format!("claude:assistant:{value}|{request_id}"))
            .unwrap_or_else(|| {
                stable_id_with_prefix(
                    "claude:fallback",
                    &format!("{session_id}|{request_id}|{timestamp_ms}|{model}|{input}|{output}|{cache_read}|{cache_create}"),
                )
            });
        let context_used = input
            .saturating_add(cache_read)
            .saturating_add(cache_create);
        let context_limit = self
            .find_price(&model, Some("anthropic"))
            .and_then(|entry| entry.context_window)
            .or(Some(if context_used > 200_000 {
                1_000_000
            } else {
                200_000
            }));
        let quote = self.cost_for(
            &model,
            Some("anthropic"),
            input,
            output,
            cache_read,
            cache_create,
            false,
        );
        let (cost_usd, price_source, price_updated_at, _price_kind) = quote_parts(quote); // R58: transcript path keeps its api-equivalent-estimate label
        let mut schema_keys = object.keys().cloned().collect::<Vec<_>>();
        schema_keys.sort();
        schema_keys.truncate(64);
        Some(UsageEvent {
            event_id,
            timestamp_ms,
            provider: "claude".into(),
            billing_provider: Some("anthropic".into()),
            billing_surface: Some("transcript-api-equivalent".into()),
            session_id,
            turn_id: message_id,
            model,
            input,
            output,
            cache_read,
            cache_create,
            cache_write_5m,
            cache_write_1h,
            input_includes_cache: false,
            reasoning: number(usage, &["reasoning_tokens"]).unwrap_or(0),
            reasoning_replay: 0,
            context_used: Some(context_used),
            context_limit,
            cost_usd,
            cost_kind: cost_usd.map(|_| "api-equivalent-estimate".to_string()),
            price_source,
            price_updated_at,
            schema_keys,
        })
    }

    // The token-count parameters are intentionally flat: bundling them into
    // a struct would churn every call site and the tests for no gain, so
    // the narrow lint allow is kept instead.
    #[allow(clippy::too_many_arguments)]
    fn cost_for(
        &self,
        model: &str,
        billing_provider: Option<&str>,
        input: u64,
        output: u64,
        cache_read: u64,
        cache_create: u64,
        input_includes_cache: bool,
    ) -> Option<CostQuote> {
        let (kind, price) = self.find_price_tiered(model, billing_provider)?;
        if kind == PriceMatchKind::FreeVariant {
            // OpenRouter `:free` rows are billed $0 per token. Charge exactly
            // zero instead of the base model's paid rate (the pre-R58 fuzzy
            // layer billed `deepseek-chat:free` at paid rates), keeping the
            // base row's provenance in the source tag.
            return Some(CostQuote {
                cost_usd: 0.0,
                source: format!("{}:free-variant", price.source),
                updated_at: price.updated_at.clone(),
                kind: PriceMatchKind::FreeVariant.cost_kind(),
            });
        }
        let input_rate = price.input?;
        let output_rate = price.output.unwrap_or(input_rate);
        let cache_read_rate = price
            .cache_read
            .unwrap_or(input_rate * CACHE_READ_FALLBACK_RATIO);
        let cache_write_rate = price
            .cache_write
            .unwrap_or(input_rate * CACHE_WRITE_FALLBACK_RATIO);

        let micro_dollars = if input_includes_cache {
            // CodeWhale currently reports input_tokens including cache hit/miss.
            // Avoid charging overlapping cache counters twice.
            let uncached_input = input.saturating_sub(cache_read.min(input));
            let extra_cache_write = cache_create.saturating_sub(uncached_input);
            (uncached_input as f64 * input_rate)
                + (cache_read.min(input) as f64 * cache_read_rate)
                + (extra_cache_write as f64 * cache_write_rate)
                + (output as f64 * output_rate)
        } else {
            // Claude transcript usage exposes non-cached input and cache buckets
            // separately, matching Anthropic API accounting.
            (input as f64 * input_rate)
                + (cache_read as f64 * cache_read_rate)
                + (cache_create as f64 * cache_write_rate)
                + (output as f64 * output_rate)
        };
        Some(CostQuote {
            cost_usd: micro_dollars / 1_000_000.0,
            source: price.source.clone(),
            updated_at: price.updated_at.clone(),
            kind: kind.cost_kind(),
        })
    }

    /// Compatibility shim: pre-R58 signature for context-window lookups
    /// (parse_hook / parse_claude_assistant / import_official_usage).
    fn find_price(&self, model: &str, billing_provider: Option<&str>) -> Option<&PriceEntry> {
        self.find_price_tiered(model, billing_provider)
            .map(|(_, entry)| entry)
    }

    /// R58 layered lookup — first hit wins:
    ///   L0 provider-qualified exact      `anthropic/claude-sonnet-5`
    ///   L1 exact raw key                 `deepseek/deepseek-chat:free`
    ///                                    (models.dev openrouter rows are
    ///                                    stored verbatim as bare keys)
    ///   L2 case-folded exact             `GPT-5.3-CODEX`（all keys, with or
    ///                                    without '/' — keys are stored
    ///                                    lowercased by merge_catalog_document）
    ///   L3 normalized exact              strip `:free` modifier, vendor
    ///                                    prefix（last '/' segment）and dated
    ///                                    suffix, then qualified retry + bare
    ///   L4 prefix fuzzy                  longest shared prefix between the
    ///                                    normalized bare id and the bare
    ///                                    segment of every key（min length 4）
    /// No hit -> None: token-only record + `unknown_price`（价格未知）.
    /// Never fabricate a default rate (R10 contract).
    fn find_price_tiered(
        &self,
        model: &str,
        billing_provider: Option<&str>,
    ) -> Option<(PriceMatchKind, &PriceEntry)> {
        let trimmed = model.trim();
        if trimmed.is_empty() {
            return None;
        }
        let lower = trimmed.to_ascii_lowercase();
        let (_, modifier) = split_model_modifier(trimmed);
        let free = modifier == "free";
        let kind = |base: PriceMatchKind| {
            if free {
                PriceMatchKind::FreeVariant
            } else {
                base
            }
        };

        // L0: provider-qualified exact（unchanged from pre-R58 behavior）
        if let Some(provider) = billing_provider
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let qualified = format!("{}/{}", provider.to_ascii_lowercase(), lower);
            if let Some(entry) = self.catalog.entries.get(&qualified) {
                return Some((kind(PriceMatchKind::Exact), entry));
            }
        }
        // L1: exact raw key（keys are lowercase, so this only hits when the
        // reported id is already lowercase — preserved for exact semantics）
        if let Some(entry) = self.catalog.entries.get(trimmed) {
            return Some((kind(PriceMatchKind::Exact), entry));
        }
        // L2: case-folded exact over ALL keys（pre-R58 only folded keys
        // without '/'；the extension only adds hits for previously-missing
        // mixed-case qualified ids）
        if let Some(entry) = self.catalog.entries.get(&lower) {
            return Some((kind(PriceMatchKind::Exact), entry));
        }

        // L3: normalized exact
        let (bare, _) = split_model_modifier(trimmed);
        if !bare.is_empty() {
            if let Some(provider) = billing_provider
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                let qualified = format!("{}/{}", provider.to_ascii_lowercase(), bare);
                if let Some(entry) = self.catalog.entries.get(&qualified) {
                    return Some((kind(PriceMatchKind::Normalized), entry));
                }
            }
            if let Some(entry) = self.catalog.entries.get(&bare) {
                return Some((kind(PriceMatchKind::Normalized), entry));
            }
        }

        // L4: prefix fuzzy over normalized bare forms（pre-R58 compared only
        // slash-free keys；now also the bare segment of qualified keys）
        let bare = bare.as_str();
        if bare.len() >= 4 && bare != "unknown" {
            // R58-RV-5: HashMap iteration order is random per process —
            // max_by_key over it made equal-length ties (e.g. gpt-5 →
            // gpt-5-codex vs gpt-5-terra) bill differently across restarts.
            // Longest bare key wins; ties break on the lexicographically
            // smallest key so rebuild_costs is stable.
            let mut best: Option<(usize, &str, &PriceEntry)> = None;
            for (key, entry) in self.catalog.entries.iter() {
                let key_bare = strip_dated_suffix(key.rsplit('/').next().unwrap_or(key));
                if key_bare.len() < 4 {
                    continue;
                }
                if !(bare.starts_with(key_bare) || key_bare.starts_with(bare)) {
                    continue;
                }
                let better = match best {
                    None => true,
                    Some((best_len, best_key, _)) => {
                        key_bare.len() > best_len
                            || (key_bare.len() == best_len && key_bare < best_key)
                    }
                };
                if better {
                    best = Some((key_bare.len(), key_bare, entry));
                }
            }
            if let Some((_, _, entry)) = best {
                return Some((kind(PriceMatchKind::PrefixApprox), entry));
            }
        }
        None
    }

    fn load(&mut self, now_ms: u64) -> Result<(), String> {
        let metadata = match fs::metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.to_string()),
        };
        let mut file = File::open(&self.path).map_err(|error| error.to_string())?;
        let mut skipped_prefix = false;
        if metadata.len() > MAX_LEDGER_READ_BYTES {
            file.seek(SeekFrom::Start(metadata.len() - MAX_LEDGER_READ_BYTES))
                .map_err(|error| error.to_string())?;
            skipped_prefix = true;
        }
        let mut reader = BufReader::new(file);
        if skipped_prefix {
            let mut partial = Vec::new();
            let _ = reader.read_until(b'\n', &mut partial);
        }

        let cutoff = now_ms.saturating_sub(RETENTION_MS);
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            let read = reader
                .by_ref()
                .take((MAX_LINE_BYTES + 1) as u64)
                .read_until(b'\n', &mut buffer)
                .map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            if buffer.len() > MAX_LINE_BYTES {
                self.malformed_lines = self.malformed_lines.saturating_add(1);
                consume_line_remainder(&mut reader)?;
                continue;
            }
            let line = trim_line(&buffer);
            if line.is_empty() {
                continue;
            }
            match serde_json::from_slice::<UsageEvent>(line) {
                Ok(event) if event.timestamp_ms >= cutoff => {
                    if self.seen.insert(event.event_id.clone()) {
                        self.events.push(event);
                    } else {
                        self.duplicate_events = self.duplicate_events.saturating_add(1);
                    }
                }
                Ok(_) => {}
                Err(_) => self.malformed_lines = self.malformed_lines.saturating_add(1),
            }
        }
        self.events.sort_by_key(|event| event.timestamp_ms);
        if self.events.len() > MAX_EVENTS {
            let excess = self.events.len() - MAX_EVENTS;
            let removed: Vec<String> = self.events[..excess]
                .iter()
                .map(|event| event.event_id.clone())
                .collect();
            self.events.drain(..excess);
            for event_id in removed {
                self.seen.remove(&event_id);
            }
        }
        if metadata.len() >= COMPACT_AT_BYTES || skipped_prefix || self.malformed_lines > 0 {
            self.compact()?;
        }
        Ok(())
    }

    fn append(&self, event: &UsageEvent) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            secure_dir(parent)?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|error| error.to_string())?;
        secure_file(&self.path)?;
        serde_json::to_writer(&mut file, event).map_err(|error| error.to_string())?;
        file.write_all(b"\n").map_err(|error| error.to_string())?;
        file.flush().map_err(|error| error.to_string())?;
        // R4-D14 fix: sync metadata to detect disk-full errors early
        file.sync_all().map_err(|error| error.to_string())
    }

    fn prune(&mut self, now_ms: u64) {
        let cutoff = now_ms.saturating_sub(RETENTION_MS);
        let first_kept = self
            .events
            .iter()
            .position(|event| event.timestamp_ms >= cutoff)
            .unwrap_or(self.events.len());
        if first_kept > 0 {
            let removed: Vec<String> = self.events[..first_kept]
                .iter()
                .map(|event| event.event_id.clone())
                .collect();
            self.events.drain(..first_kept);
            for event_id in removed {
                self.seen.remove(&event_id);
            }
        }
        if self.events.len() > MAX_EVENTS {
            let excess = self.events.len() - MAX_EVENTS;
            let removed: Vec<String> = self.events[..excess]
                .iter()
                .map(|event| event.event_id.clone())
                .collect();
            self.events.drain(..excess);
            for event_id in removed {
                self.seen.remove(&event_id);
            }
        }
    }

    fn compact(&self) -> Result<(), String> {
        let parent = self.path.parent().ok_or("ledger path has no parent")?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        secure_dir(parent)?;
        let temp = parent.join(format!(".usage-events.{}.tmp", std::process::id()));
        {
            let mut file = File::create(&temp).map_err(|error| error.to_string())?;
            secure_file(&temp)?;
            for event in &self.events {
                serde_json::to_writer(&mut file, event).map_err(|error| error.to_string())?;
                file.write_all(b"\n").map_err(|error| error.to_string())?;
            }
            file.flush().map_err(|error| error.to_string())?;
            let _ = file.sync_all();
        }
        // R25: use windows_safe_rename to avoid remove-then-rename data loss
        crate::model::windows_safe_rename(&temp, &self.path)?;
        secure_file(&self.path)
    }
}

/// R2-D1 fix (R3): recover from a crashed `compact()`.
///
/// `compact()` writes the deduplicated/pruned event stream to
/// `.usage-events.<pid>.tmp`, then atomically renames it over the main
/// ledger. If the process dies after creating the tmp but before the
/// rename, the tmp is orphaned. On the next `open()` we:
///
/// 1. Scan the ledger's directory for `.usage-events.*.tmp` files.
/// 2. For each, validate that every line parses as a JSON value (so we
///    don't promote a half-written tmp that would corrupt the ledger).
/// 3. If valid AND the main ledger is missing or older than the tmp,
///    promote the tmp via `windows_safe_rename` (atomic on Unix, safe
///    backup-then-rename on Windows).
/// 4. Otherwise discard the tmp so subsequent compacts aren't blocked by
///    stale orphan files accumulating.
///
/// This recovers the most recent compacted state when the crash happened
/// after `flush`+`sync_all` but before `rename`, which is the common case
/// (rename is the last step). If the crash happened during the write, the
/// validation step catches the partial line and we fall back to the
/// existing main ledger.
fn recover_compact_tmp(path: &Path) {
    use std::io::BufRead;
    let Some(parent) = path.parent() else {
        return;
    };
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    let main_mtime = match path.symlink_metadata() {
        Ok(metadata) => metadata.modified().ok(),
        Err(_) => None,
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        if !name.starts_with(".usage-events.") || !name.ends_with(".tmp") {
            continue;
        }
        let tmp_path = entry.path();
        let valid = {
            let Ok(file) = File::open(&tmp_path) else {
                continue;
            };
            let reader = std::io::BufReader::new(file);
            let mut all_ok = true;
            for line in reader.lines() {
                match line {
                    Ok(line) if line.is_empty() => continue,
                    Ok(line) => {
                        if serde_json::from_str::<Value>(&line).is_err() {
                            all_ok = false;
                            break;
                        }
                    }
                    Err(_) => {
                        all_ok = false;
                        break;
                    }
                }
            }
            all_ok
        };
        let tmp_mtime = tmp_path.symlink_metadata().and_then(|m| m.modified()).ok();
        let tmp_is_newer = matches!((main_mtime, tmp_mtime), (Some(m), Some(t)) if t > m);
        let main_missing = main_mtime.is_none();
        if valid && (main_missing || tmp_is_newer) {
            match crate::model::windows_safe_rename(&tmp_path, path) {
                Ok(()) => {
                    eprintln!("[octopus] recovered usage ledger from compact tmp");
                    let _ = secure_file(path);
                }
                Err(error) => {
                    eprintln!("[octopus] failed to promote compact tmp: {error}");
                }
            }
        } else {
            match fs::remove_file(&tmp_path) {
                Ok(()) => eprintln!(
                    "[octopus] discarded compact tmp (valid={valid}, main_missing={main_missing})"
                ),
                Err(error) => eprintln!("[octopus] failed to clean compact tmp: {error}"),
            }
        }
    }
}

fn json_timestamp_ms(value: &Value) -> Option<u64> {
    if let Some(number) = value.as_u64() {
        return Some(number);
    }
    if let Some(number) = value.as_i64().and_then(|number| u64::try_from(number).ok()) {
        return Some(number);
    }
    let text = value.as_str()?.trim();
    text.parse::<u64>().ok().or_else(|| parse_rfc3339_ms(text))
}

fn load_catalog(app_dir: &Path) -> PriceCatalog {
    let mut catalog = PriceCatalog::default();
    match serde_json::from_str::<Value>(CATALOG_JSON) {
        Ok(value) => merge_catalog_document(&mut catalog, &value, "bundled", false),
        Err(error) => catalog.load_message = Some(format!("bundled catalog invalid: {error}")),
    }

    let cache_path = app_dir.join(PRICE_CACHE_FILE_NAME);
    match read_json_bounded(&cache_path, MAX_PRICE_FILE_BYTES) {
        Ok(Some(value)) => merge_catalog_document(&mut catalog, &value, "models.dev-cache", true),
        Ok(None) => {}
        Err(error) => append_catalog_message(&mut catalog, format!("price cache ignored: {error}")),
    }

    let override_path = app_dir.join(PRICE_OVERRIDE_FILE_NAME);
    match read_json_bounded(&override_path, MAX_PRICE_FILE_BYTES) {
        Ok(Some(value)) => merge_catalog_document(&mut catalog, &value, "user-override", true),
        Ok(None) => {}
        Err(error) => {
            append_catalog_message(&mut catalog, format!("price override ignored: {error}"))
        }
    }
    catalog
}

fn merge_catalog_document(
    catalog: &mut PriceCatalog,
    value: &Value,
    fallback_source: &str,
    live: bool,
) {
    let source = value
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or(fallback_source)
        .chars()
        .take(128)
        .collect::<String>();
    let updated_at = value
        .get("fetched_at")
        .or_else(|| value.get("updated_at"))
        .and_then(Value::as_str)
        .map(|value| value.chars().take(128).collect::<String>());
    let Some(entries) = value.get("entries").and_then(Value::as_object) else {
        append_catalog_message(catalog, format!("{source} has no entries object"));
        return;
    };
    let mut inserted = 0usize;
    for (id, raw) in entries.iter().take(20_000) {
        if id.is_empty() || id.len() > 512 {
            continue;
        }
        let Some(object) = raw.as_object() else {
            continue;
        };
        let entry = PriceEntry {
            input: finite_rate(
                object
                    .get("input_usd_per_million")
                    .or_else(|| object.get("input")),
            ),
            output: finite_rate(
                object
                    .get("output_usd_per_million")
                    .or_else(|| object.get("output")),
            ),
            cache_read: finite_rate(
                object
                    .get("cache_read_usd_per_million")
                    .or_else(|| object.get("cache_read")),
            ),
            cache_write: finite_rate(
                object
                    .get("cache_write_usd_per_million")
                    .or_else(|| object.get("cache_write")),
            ),
            context_window: finite_u64(
                object
                    .get("context_window")
                    .or_else(|| object.get("context")),
            )
            .filter(|value| *value > 0),
            source: source.clone(),
            updated_at: updated_at.clone(),
        };
        if entry.input.is_none() && entry.output.is_none() && entry.context_window.is_none() {
            continue;
        }
        catalog
            .entries
            .insert(id.to_ascii_lowercase(), entry.clone());
        if let Some(alias) = object.get("provider_model_id").and_then(Value::as_str) {
            let alias = alias.trim();
            if !alias.is_empty() && alias.len() <= 512 {
                catalog
                    .entries
                    .insert(alias.to_ascii_lowercase(), entry.clone());
            }
        }
        inserted += 1;
    }
    if inserted > 0 {
        catalog.source = source;
        if updated_at.is_some() {
            catalog.updated_at = updated_at;
        }
        catalog.live |= live;
    }
}

fn read_json_bounded(path: &Path, max_bytes: u64) -> Result<Option<Value>, String> {
    // R2-D20 fix (R3): error messages must not contain the absolute path.
    // These errors flow into `load_message` (via append_load_message) and
    // reach the frontend through `price_info()`, which would leak the
    // user's home directory layout. We surface only the file name.
    let label = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "<unknown>".to_string());
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(format!("{label} is not a regular file"));
    }
    if metadata.len() > max_bytes {
        return Err(format!("{label} exceeds {} bytes", max_bytes));
    }
    let file = File::open(path).map_err(|error| error.to_string())?;
    let opened = file.metadata().map_err(|error| error.to_string())?;
    if !opened.is_file() || opened.len() != metadata.len() || !same_opened_file(&metadata, &opened)
    {
        return Err(format!("{label} changed while opening"));
    }
    serde_json::from_reader(file.take(max_bytes.saturating_add(1)))
        .map(Some)
        .map_err(|error| error.to_string())
}

fn same_opened_file(expected: &fs::Metadata, opened: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        expected.dev() == opened.dev() && expected.ino() == opened.ino()
    }
    #[cfg(not(unix))]
    {
        expected.len() == opened.len() && expected.is_file() == opened.is_file()
    }
}

fn append_catalog_message(catalog: &mut PriceCatalog, message: String) {
    catalog.load_message = Some(match catalog.load_message.take() {
        Some(existing) => format!("{existing}; {message}"),
        None => message,
    });
}

fn number(object: &Map<String, Value>, names: &[&str]) -> Option<u64> {
    names.iter().find_map(|name| finite_u64(object.get(*name)))
}

fn number_from(object: Option<&Map<String, Value>>, names: &[&str]) -> Option<u64> {
    object.and_then(|object| number(object, names))
}

fn finite_u64(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::Number(number) => number.as_u64().or_else(|| {
            number
                .as_f64()
                .filter(|value| value.is_finite() && *value >= 0.0)
                .map(|value| value.min(u64::MAX as f64) as u64)
        }),
        Value::String(text) => text.parse::<u64>().ok(),
        _ => None,
    }
}

fn finite_rate(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0 && *value <= 1_000_000.0)
}

fn text(object: &Map<String, Value>, names: &[&str], limit: usize) -> Option<String> {
    names.iter().find_map(|name| {
        object
            .get(*name)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.chars().take(limit).collect())
    })
}

fn quote_parts(
    quote: Option<CostQuote>,
) -> (Option<f64>, Option<String>, Option<String>, Option<String>) {
    match quote {
        Some(quote) => (
            Some(quote.cost_usd),
            Some(quote.source),
            quote.updated_at,
            Some(quote.kind.to_string()),
        ),
        None => (None, None, None, None),
    }
}

/// R58: split an OpenRouter-style modifier off a raw model id and normalize
/// the remainder. `"deepseek/deepseek-chat:free"` -> `("deepseek-chat",
/// "free")`; `"OpenAI/GPT-5.3-Codex-2026-04-23"` -> `("gpt-5.3-codex", "")`.
/// Mirrors codex_pricing::norm_codex_model_name（duplicated on purpose so
/// test/tauri-codex-pricing-r10-smoke.js's pinned source shape stays valid）。
fn split_model_modifier(model: &str) -> (String, String) {
    let lower = model.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return (String::new(), String::new());
    }
    let (head, modifier) = match lower.split_once(':') {
        Some((head, tail)) => (
            head,
            tail.split('/').next().unwrap_or("").trim().to_string(),
        ),
        None => (lower.as_str(), String::new()),
    };
    // Keep the LAST non-empty '/' segment:
    //   deepseek/deepseek-chat        -> deepseek-chat
    //   openrouter/deepseek/deepseek-chat -> deepseek-chat
    //   us.anthropic/claude-sonnet-5  -> claude-sonnet-5
    let bare = head
        .rsplit('/')
        .find(|segment| !segment.is_empty())
        .unwrap_or(head.trim());
    let bare = strip_dated_suffix(bare.trim());
    (bare.split('@').next().unwrap_or(bare).to_string(), modifier)
}

/// Remove a trailing `-YYYY-MM-DD` or `-YYYYMMDD` version date.
fn strip_dated_suffix(bare: &str) -> &str {
    if let Some(index) = bare.rfind("-20") {
        let suffix = &bare[index + 1..];
        let is_dated = (suffix.len() == 10 && suffix.chars().filter(|c| *c == '-').count() == 2)
            || (suffix.len() == 8 && suffix.chars().all(|c| c.is_ascii_digit()));
        if is_dated {
            return &bare[..index];
        }
    }
    bare
}

fn default_true() -> bool {
    true
}

fn parse_rfc3339_ms(value: &str) -> Option<u64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .and_then(|timestamp| u64::try_from(timestamp.timestamp_millis()).ok())
}

fn token_priced_surface(surface: Option<&str>) -> bool {
    let Some(surface) = surface.map(str::trim).filter(|value| !value.is_empty()) else {
        return true;
    };
    let lower = surface.to_ascii_lowercase();
    matches!(lower.as_str(), "api" | "payg" | "token" | "token-priced") || lower.ends_with("-payg")
}

fn stable_event_id(value: &str) -> String {
    stable_id_with_prefix("codewhale:fallback", value)
}

fn stable_id_with_prefix(prefix: &str, value: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{prefix}:{hash:016x}")
}

pub(crate) fn local_day_key(timestamp_ms: u64) -> String {
    let timestamp = i64::try_from(timestamp_ms).unwrap_or(i64::MAX);
    Local
        .timestamp_millis_opt(timestamp)
        .single()
        .unwrap_or_else(Local::now)
        .format("%Y-%m-%d")
        .to_string()
}

fn local_hour(timestamp_ms: u64) -> usize {
    use chrono::Timelike;
    let timestamp = i64::try_from(timestamp_ms).unwrap_or(i64::MAX);
    Local
        .timestamp_millis_opt(timestamp)
        .single()
        .unwrap_or_else(Local::now)
        .hour() as usize
}

fn trim_line(bytes: &[u8]) -> &[u8] {
    let mut end = bytes.len();
    while end > 0 && matches!(bytes[end - 1], b'\n' | b'\r' | b' ' | b'\t') {
        end -= 1;
    }
    &bytes[..end]
}

fn consume_line_remainder(reader: &mut BufReader<File>) -> Result<(), String> {
    let mut sink = Vec::new();
    loop {
        sink.clear();
        let read = reader
            .by_ref()
            .take((MAX_LINE_BYTES + 1) as u64)
            .read_until(b'\n', &mut sink)
            .map_err(|error| error.to_string())?;
        if read == 0 || sink.last() == Some(&b'\n') {
            return Ok(());
        }
    }
}

#[cfg_attr(not(unix), allow(unused_variables))]
fn secure_dir(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg_attr(not(unix), allow(unused_variables))]
fn secure_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../test/fixtures/codewhale-turn-end.json"))
            .expect("fixture must be valid")
    }

    fn fixture_at(timestamp_ms: u64) -> Value {
        let mut value = fixture();
        let timestamp = chrono::Local
            .timestamp_millis_opt(i64::try_from(timestamp_ms).unwrap())
            .single()
            .unwrap();
        value["created_at"] = Value::String(timestamp.to_rfc3339());
        value
    }

    fn temp_dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "re-llmpet-metering-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn codewhale_turn_is_deduplicated_and_costed() {
        let dir = temp_dir();
        let now = crate::model::now_ms();
        let payload = fixture_at(now);
        let mut ledger = UsageLedger::open(&dir, now);
        let first = ledger.record_hook(&payload, now).unwrap();
        let second = ledger.record_hook(&payload, now + 1).unwrap();
        assert!(first.inserted);
        assert!(second.duplicate);
        let snapshot = ledger.snapshot(now + 1);
        assert_eq!(snapshot["today"]["tokens"], 1380);
        assert_eq!(snapshot["today"]["cacheRead"], 900);
        assert_eq!(snapshot["today"]["cacheCreate"], 300);
        assert_eq!(snapshot["today"]["messages"], 1);
        let cost = snapshot["today"]["cost"].as_f64().unwrap();
        assert!((cost - 0.00009492).abs() < 0.000000001);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn unknown_price_is_explicit_not_fabricated() {
        let dir = temp_dir();
        let now = crate::model::now_ms();
        let mut payload = fixture_at(now);
        payload["model"] = Value::String("brand-new-unpriced-model".into());
        payload["turn_id"] = Value::String("turn_unknown_price".into());
        let mut ledger = UsageLedger::open(&dir, now);
        assert!(ledger.record_hook(&payload, now).unwrap().inserted);
        let snapshot = ledger.snapshot(now);
        assert_eq!(snapshot["today"]["unknownPrice"], 1);
        assert_eq!(snapshot["today"]["cost"], 0.0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn normalized_ledger_reloads_without_duplicate_growth() {
        let dir = temp_dir();
        let now = crate::model::now_ms();
        let payload = fixture_at(now);
        {
            let mut ledger = UsageLedger::open(&dir, now);
            ledger.record_hook(&payload, now).unwrap();
        }
        let mut reloaded = UsageLedger::open(&dir, now + 1000);
        assert_eq!(reloaded.snapshot(now + 1000)["today"]["messages"], 1);
        assert!(
            reloaded
                .record_hook(&payload, now + 1001)
                .unwrap()
                .duplicate
        );
        assert_eq!(reloaded.snapshot(now + 1001)["today"]["messages"], 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rfc3339_time_and_price_provenance_are_persisted() {
        let dir = temp_dir();
        let now = crate::model::now_ms();
        let mut payload = fixture_at(now);
        let created = chrono::Local
            .timestamp_millis_opt(i64::try_from(now).unwrap())
            .single()
            .unwrap();
        payload["created_at"] = Value::String(created.to_rfc3339());
        payload["turn_id"] = Value::String("turn_rfc3339".into());
        let mut ledger = UsageLedger::open(&dir, now);
        assert!(ledger.record_hook(&payload, now).unwrap().inserted);
        let line = fs::read_to_string(dir.join(LEDGER_FILE_NAME)).unwrap();
        let event: UsageEvent = serde_json::from_str(line.trim()).unwrap();
        assert!(event.timestamp_ms.abs_diff(now) < 1000);
        assert_eq!(event.price_source.as_deref(), Some("bundled"));
        assert!(event.price_updated_at.is_some());
        assert!(event.schema_keys.contains(&"turn_id".to_string()));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn quota_or_plan_surface_remains_explicitly_unpriced() {
        let dir = temp_dir();
        let now = crate::model::now_ms();
        let mut payload = fixture_at(now);
        payload["turn_id"] = Value::String("turn_plan_surface".into());
        payload["billing_surface"] = Value::String("stepfun-plan".into());
        let mut ledger = UsageLedger::open(&dir, now);
        assert!(ledger.record_hook(&payload, now).unwrap().inserted);
        let snapshot = ledger.snapshot(now);
        assert_eq!(snapshot["today"]["unknownPrice"], 1);
        assert_eq!(snapshot["today"]["cost"], 0.0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn malformed_ledger_lines_are_compacted_away() {
        let dir = temp_dir();
        let now = crate::model::now_ms();
        let path = dir.join(LEDGER_FILE_NAME);
        fs::write(&path, b"not-json\n").unwrap();
        let ledger = UsageLedger::open(&dir, now);
        assert_eq!(ledger.snapshot(now)["diagnostics"]["malformedLines"], 1);
        assert_eq!(fs::read_to_string(path).unwrap(), "");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn claude_transcript_usage_counts_separate_cache_buckets_and_marks_estimate() {
        let dir = temp_dir();
        let now = crate::model::now_ms();
        let mut line: Value = serde_json::from_str(
            include_str!("../../test/fixtures/claude-transcript-assistant.jsonl").trim(),
        )
        .unwrap();
        line["timestamp"] = Value::String(chrono::Utc::now().to_rfc3339());
        let mut ledger = UsageLedger::open(&dir, now);
        assert!(
            ledger
                .record_claude_assistant(&line, "claude-session", now)
                .unwrap()
                .inserted
        );
        assert!(
            ledger
                .record_claude_assistant(&line, "claude-session", now + 1)
                .unwrap()
                .duplicate
        );
        let snapshot = ledger.snapshot(now + 1);
        assert_eq!(snapshot["today"]["tokens"], 180);
        assert_eq!(snapshot["today"]["estimatedPrice"], 1);
        assert_eq!(snapshot["today"]["messages"], 1);
        let cost = snapshot["today"]["cost"].as_f64().unwrap();
        assert!((cost - 0.0006525).abs() < 0.000000001);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn layered_price_catalog_prefers_user_override_and_qualified_provider() {
        let dir = temp_dir();
        fs::write(
            dir.join(PRICE_CACHE_FILE_NAME),
            serde_json::to_vec(&json!({
                "source":"models.dev",
                "fetched_at":"2026-07-26T00:00:00Z",
                "entries":{
                    "anthropic/test-model":{"input":1.0,"output":2.0,"context":1234},
                    "test-model":{"input":9.0,"output":9.0}
                }
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            dir.join(PRICE_OVERRIDE_FILE_NAME),
            serde_json::to_vec(&json!({
                "source":"user-override",
                "updated_at":"2026-07-26T01:00:00Z",
                "entries":{
                    "anthropic/test-model":{"input":3.0,"output":4.0,"context":4321}
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let now = crate::model::now_ms();
        let ledger = UsageLedger::open(&dir, now);
        let qualified = ledger.find_price("test-model", Some("anthropic")).unwrap();
        assert_eq!(qualified.input, Some(3.0));
        assert_eq!(qualified.context_window, Some(4321));
        assert_eq!(qualified.source, "user-override");
        assert_eq!(
            qualified.updated_at.as_deref(),
            Some("2026-07-26T01:00:00Z")
        );
        let bundled = ledger
            .find_price("claude-sonnet-4-6", Some("anthropic"))
            .unwrap();
        assert_eq!(bundled.source, "bundled");
        let quote = ledger
            .cost_for("test-model", Some("anthropic"), 1_000_000, 0, 0, 0, false)
            .unwrap();
        assert_eq!(quote.source, "user-override");
        assert_eq!(quote.cost_usd, 3.0);
        let info = ledger.price_info();
        assert_eq!(info["source"], "user-override");
        assert_eq!(info["live"], true);
        assert_eq!(info["models"], info["count"]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn official_usage_records_import_once_and_match_transcript_event_ids() {
        let dir = temp_dir();
        let now = crate::model::now_ms();
        fs::write(
            dir.join("usage.json"),
            serde_json::to_vec(&json!({
                "records": {
                    "msg_official|req_official": {
                        "day": local_day_key(now),
                        "ts": now,
                        "model": "claude-sonnet-4-6",
                        "usage": {
                            "input": 10,
                            "output": 5,
                            "cacheRead": 20,
                            "cacheWrite5m": 3,
                            "cacheWrite1h": 2
                        }
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let ledger = UsageLedger::open(&dir, now);
        let snapshot = ledger.snapshot(now);
        assert_eq!(snapshot["today"]["messages"], 1);
        assert_eq!(snapshot["today"]["tokens"], 40);
        assert_eq!(snapshot["diagnostics"]["officialImportedEvents"], 1);
        drop(ledger);

        let mut reloaded = UsageLedger::open(&dir, now + 1);
        assert_eq!(reloaded.snapshot(now + 1)["today"]["messages"], 1);
        let transcript = json!({
            "type": "assistant",
            "requestId": "req_official",
            "sessionId": "session-one",
            "timestamp": chrono::Utc::now().to_rfc3339(),
            "message": {
                "id": "msg_official",
                "model": "claude-sonnet-4-6",
                "usage": {"input_tokens": 10, "output_tokens": 5}
            }
        });
        assert!(
            reloaded
                .record_claude_assistant(&transcript, "session-one", now + 1)
                .unwrap()
                .duplicate
        );
        assert_eq!(reloaded.snapshot(now + 1)["today"]["messages"], 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn old_usage_event_without_cache_semantics_defaults_to_codewhale_compatible_mode() {
        let event: UsageEvent = serde_json::from_value(json!({
            "eventId":"legacy",
            "timestampMs":1,
            "provider":"codewhale",
            "billingProvider":null,
            "billingSurface":null,
            "sessionId":"s",
            "turnId":null,
            "model":"m",
            "input":10,
            "output":2,
            "cacheRead":8,
            "cacheCreate":2,
            "reasoning":0,
            "reasoningReplay":0,
            "contextUsed":null,
            "contextLimit":null,
            "costUsd":null,
            "schemaKeys":[]
        }))
        .unwrap();
        assert!(event.input_includes_cache);
        let mut aggregate = Aggregate::default();
        aggregate.add(&event);
        assert_eq!(aggregate.tokens, 12);
    }

    #[test]
    fn free_variant_models_price_at_zero_not_unknown() {
        // R58-1d 用户报告主案例：`deepseek/deepseek-chat:free` 原先全层
        // miss -> 价格未知。现在 L3 规范化命中 base 行，FreeVariant 零计费。
        let dir = temp_dir();
        let now = crate::model::now_ms();
        let mut payload = fixture_at(now);
        payload["model"] = Value::String("deepseek/deepseek-chat:free".into());
        payload["turn_id"] = Value::String("turn_free_variant".into());
        payload["billing_provider"] = Value::String("openrouter".into());
        let mut ledger = UsageLedger::open(&dir, now);
        assert!(ledger.record_hook(&payload, now).unwrap().inserted);
        let snapshot = ledger.snapshot(now);
        assert_eq!(snapshot["today"]["unknownPrice"], 0);
        assert_eq!(snapshot["today"]["cost"], 0.0);
        assert_eq!(snapshot["today"]["estimatedPrice"], 0);
        let line = fs::read_to_string(dir.join(LEDGER_FILE_NAME)).unwrap();
        let event: UsageEvent = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(event.cost_kind.as_deref(), Some("token-priced-free"));
        assert!(event
            .price_source
            .as_deref()
            .unwrap()
            .ends_with(":free-variant"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn prefixed_and_dated_model_ids_match_with_estimate_flag() {
        // R58-1d：`openai/gpt-5.3-codex`（provider 前缀、无 billing_provider）
        // 与 `gpt-5.3-codex-2026-04-23`（日期后缀）都按 base 行计费，但标为
        // 估算（estimatedPrice=1），不再 价格未知。
        for (turn, model) in [
            ("turn_prefixed", "openai/gpt-5.3-codex"),
            ("turn_dated", "gpt-5.3-codex-2026-04-23"),
        ] {
            let dir = temp_dir();
            let now = crate::model::now_ms();
            let mut payload = fixture_at(now);
            payload["model"] = Value::String(model.into());
            payload["turn_id"] = Value::String(turn.into());
            let mut ledger = UsageLedger::open(&dir, now);
            assert!(ledger.record_hook(&payload, now).unwrap().inserted);
            let snapshot = ledger.snapshot(now);
            assert_eq!(snapshot["today"]["unknownPrice"], 0, "{model}");
            assert_eq!(snapshot["today"]["estimatedPrice"], 1, "{model}");
            // same math as the bare fixture model at gpt-5.3-codex rates:
            // uncached 300*1.75 + cache_read 900*0.175 + output 180*14
            let cost = snapshot["today"]["cost"].as_f64().unwrap();
            assert!((cost - 0.0032025).abs() < 0.000000001, "{model}");
            let _ = fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn split_model_modifier_handles_prefix_case_and_dates() {
        // R58-1d: normalization helper — OpenRouter modifier, vendor prefix,
        // dated suffix, @tail, mixed case, empty input.
        assert_eq!(
            split_model_modifier("deepseek/deepseek-chat:free"),
            ("deepseek-chat".into(), "free".into())
        );
        assert_eq!(
            split_model_modifier("OpenAI/GPT-5.3-Codex-2026-04-23"),
            ("gpt-5.3-codex".into(), String::new())
        );
        assert_eq!(
            split_model_modifier("zai/glm-5.1"),
            ("glm-5.1".into(), String::new())
        );
        assert_eq!(
            split_model_modifier("kimi-k3-20260101"),
            ("kimi-k3".into(), String::new())
        );
        assert_eq!(
            split_model_modifier("model@2026-01-01"),
            ("model".into(), String::new())
        );
        assert_eq!(split_model_modifier(""), (String::new(), String::new()));
    }
}
