use crate::metering::PRICE_CACHE_FILE_NAME;
use crate::model::{now_ms, Runtime};
use chrono::{TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const MODELS_DEV_URL: &str = "https://models.dev/api.json";
const PRICE_SOURCE_ENV: &str = "RE_LLMPET_MODELS_DEV_URL";
pub const PRICE_SYNC_STATE_FILE_NAME: &str = "pricing-sync-state.json";
const STARTUP_DELAY: Duration = Duration::from_secs(5);
const MAX_IDLE_WAIT: Duration = Duration::from_secs(6 * 60 * 60);
const MIN_FAILURE_BACKOFF_SECS: u64 = 15 * 60;
const MAX_FAILURE_BACKOFF_SECS: u64 = 12 * 60 * 60;
const MAX_DOWNLOAD_BYTES: u64 = 16 * 1024 * 1024;
const MAX_STATE_BYTES: u64 = 64 * 1024;
const MAX_MODELS: usize = 20_000;
const MAX_PRICE_USD_PER_MILLION: f64 = 1_000.0;
const MAX_HEADER_VALUE: usize = 1_024;
const CURL_CONNECT_TIMEOUT_SECS: u64 = 15;
const CURL_TOTAL_TIMEOUT_SECS: u64 = 60;
const CURL_ATTEMPTS_PER_SOURCE: usize = 3;
const CURL_RETRY_BACKOFF_MS: [u64; 2] = [750, 2_000];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct PersistedSyncState {
    schema_version: u8,
    source_url: String,
    etag: Option<String>,
    last_modified: Option<String>,
    last_checked_ms: Option<u64>,
    last_updated_ms: Option<u64>,
    next_check_ms: Option<u64>,
    consecutive_failures: u32,
    last_error: Option<String>,
    last_result: String,
    last_http_status: Option<u16>,
    entry_count: usize,
}

impl Default for PersistedSyncState {
    fn default() -> Self {
        Self {
            schema_version: 1,
            source_url: MODELS_DEV_URL.into(),
            etag: None,
            last_modified: None,
            last_checked_ms: None,
            last_updated_ms: None,
            next_check_ms: None,
            consecutive_failures: 0,
            last_error: None,
            last_result: "never".into(),
            last_http_status: None,
            entry_count: 0,
        }
    }
}

#[derive(Debug)]
struct DownloadResult {
    status_code: u16,
    etag: Option<String>,
    last_modified: Option<String>,
}

#[derive(Debug)]
enum RefreshOutcome {
    Updated {
        count: usize,
        etag: Option<String>,
        last_modified: Option<String>,
    },
    NotModified {
        count: usize,
        etag: Option<String>,
        last_modified: Option<String>,
    },
}

pub fn start(runtime: Arc<Runtime>, app: AppHandle) {
    let (wake_tx, wake_rx) = mpsc::sync_channel::<()>(1);
    runtime.install_price_refresh_sender(wake_tx);

    let mut initial = load_sync_state(&runtime.app_dir).unwrap_or_default();
    if initial.entry_count == 0 {
        initial.entry_count =
            cache_entry_count(&runtime.app_dir.join(PRICE_CACHE_FILE_NAME)).unwrap_or(0);
    }
    publish_status(&runtime, &app, &initial, false, "idle");

    let worker_runtime = runtime.clone();
    let worker_app = app.clone();
    let spawn_result =
        thread::Builder::new()
            .name("octopus-pricing-sync".into())
            .spawn(move || {
                let runtime = worker_runtime;
                let app = worker_app;
                let mut state = initial;
                let mut forced = matches!(wake_rx.recv_timeout(STARTUP_DELAY), Ok(()));

                loop {
                    let config = runtime.config();
                    let disabled_by_env = fetch_disabled_by_env();
                    let now = now_ms();
                    let due = cache_due(
                        &runtime.app_dir.join(PRICE_CACHE_FILE_NAME),
                        &state,
                        config.price_refresh_hours,
                        now,
                    );

                    if disabled_by_env {
                        forced = false;
                        publish_status(&runtime, &app, &state, false, "network-disabled");
                    } else if forced || (config.price_auto_update && due) {
                        forced = false;
                        publish_status(&runtime, &app, &state, true, "refreshing");
                        let checked_at = now_ms();
                        match refresh_once(&runtime.app_dir, &state) {
                            Ok(RefreshOutcome::Updated {
                                count,
                                etag,
                                last_modified,
                            }) => {
                                state.etag = etag.or_else(|| state.etag.clone());
                                state.last_modified =
                                    last_modified.or_else(|| state.last_modified.clone());
                                state.last_checked_ms = Some(checked_at);
                                state.last_updated_ms = Some(checked_at);
                                state.next_check_ms = Some(checked_at.saturating_add(
                                    refresh_interval_ms(config.price_refresh_hours),
                                ));
                                state.consecutive_failures = 0;
                                state.last_error = None;
                                state.last_result = "updated".into();
                                state.last_http_status = Some(200);
                                state.entry_count = count;
                                runtime.reload_price_catalog();
                                runtime.write_log(
                                    "pricing",
                                    &format!("models.dev cache updated ({count} entries)"),
                                );
                                publish_after_catalog_change(&runtime, &app, &state, "updated");
                            }
                            Ok(RefreshOutcome::NotModified {
                                count,
                                etag,
                                last_modified,
                            }) => {
                                state.etag = etag.or_else(|| state.etag.clone());
                                state.last_modified =
                                    last_modified.or_else(|| state.last_modified.clone());
                                state.last_checked_ms = Some(checked_at);
                                state.next_check_ms = Some(checked_at.saturating_add(
                                    refresh_interval_ms(config.price_refresh_hours),
                                ));
                                state.consecutive_failures = 0;
                                state.last_error = None;
                                state.last_result = "not-modified".into();
                                state.last_http_status = Some(304);
                                state.entry_count = count;
                                runtime.write_log(
                                    "pricing",
                                    &format!("models.dev catalog unchanged ({count} entries)"),
                                );
                                publish_status(&runtime, &app, &state, false, "not-modified");
                            }
                            Err(error) => {
                                state.last_checked_ms = Some(checked_at);
                                state.consecutive_failures =
                                    state.consecutive_failures.saturating_add(1);
                                state.last_error = Some(error.chars().take(500).collect());
                                state.last_result = "error".into();
                                state.last_http_status = None;
                                state.next_check_ms = Some(checked_at.saturating_add(
                                    failure_backoff_ms(state.consecutive_failures),
                                ));
                                runtime.write_log(
                                    "pricing",
                                    &format!(
                                        "automatic refresh failed (attempt {}): {}",
                                        state.consecutive_failures,
                                        state.last_error.as_deref().unwrap_or("unknown error")
                                    ),
                                );
                                publish_status(&runtime, &app, &state, false, "error");
                            }
                        }
                        if let Err(error) = persist_sync_state(&runtime.app_dir, &state) {
                            runtime.write_log(
                                "pricing",
                                &format!("sync state persistence failed: {error}"),
                            );
                        }
                    } else if !config.price_auto_update {
                        publish_status(&runtime, &app, &state, false, "auto-disabled");
                    }

                    let wait = next_wait(&state, &runtime, disabled_by_env);
                    match wake_rx.recv_timeout(wait) {
                        Ok(()) => forced = true,
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
            });
    if let Err(error) = spawn_result {
        let message = format!("price synchronization worker failed to start: {error}");
        runtime.write_log("pricing", &message);
        runtime.set_price_sync_status(json!({
            "state":"worker-error",
            "inProgress":false,
            "autoUpdate":runtime.config().price_auto_update,
            "refreshHours":runtime.config().price_refresh_hours,
            "sourceUrl":MODELS_DEV_URL,
            "lastError":message,
            "networkDisabled":fetch_disabled_by_env()
        }));
        let _ = app.emit("panel:price", runtime.price_info());
    }
}

fn publish_after_catalog_change(
    runtime: &Runtime,
    app: &AppHandle,
    state: &PersistedSyncState,
    phase: &str,
) {
    publish_status(runtime, app, state, false, phase);
    let stats = runtime.stats();
    let _ = app.emit("pet:stats", stats.clone());
    let _ = app.emit("panel:stats", stats);
}

fn publish_status(
    runtime: &Runtime,
    app: &AppHandle,
    state: &PersistedSyncState,
    in_progress: bool,
    phase: &str,
) {
    let config = runtime.config();
    runtime.set_price_sync_status(json!({
        "state": phase,
        "inProgress": in_progress,
        "autoUpdate": config.price_auto_update,
        "refreshHours": config.price_refresh_hours,
        "sourceUrl": MODELS_DEV_URL,
        "lastCheckedAt": iso_time(state.last_checked_ms),
        "lastUpdatedAt": iso_time(state.last_updated_ms),
        "nextCheckAt": iso_time(state.next_check_ms),
        "consecutiveFailures": state.consecutive_failures,
        "lastError": state.last_error,
        "lastResult": state.last_result,
        "lastHttpStatus": state.last_http_status,
        "etag": state.etag,
        "lastModified": state.last_modified,
        "entryCount": state.entry_count,
        "conditionalRequests": true,
        "failureBackoff": true,
        "networkDisabled": fetch_disabled_by_env()
    }));
    let _ = app.emit("panel:price", runtime.price_info());
}

fn next_wait(state: &PersistedSyncState, runtime: &Runtime, disabled_by_env: bool) -> Duration {
    let config = runtime.config();
    if disabled_by_env || !config.price_auto_update {
        return MAX_IDLE_WAIT;
    }
    let now = now_ms();
    let due = state.next_check_ms.unwrap_or(now);
    let millis = due
        .saturating_sub(now)
        .min(MAX_IDLE_WAIT.as_millis() as u64);
    Duration::from_millis(millis.max(250))
}

fn cache_due(path: &Path, state: &PersistedSyncState, refresh_hours: u64, now: u64) -> bool {
    if !path.is_file() {
        return true;
    }
    if let Some(next) = state.next_check_ms {
        return now >= next;
    }
    let modified_ms = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64);
    modified_ms
        .map(|modified| now.saturating_sub(modified) >= refresh_interval_ms(refresh_hours))
        .unwrap_or(true)
}

fn refresh_interval_ms(hours: u64) -> u64 {
    hours.clamp(1, 168).saturating_mul(60 * 60 * 1_000)
}

fn failure_backoff_ms(failures: u32) -> u64 {
    let exponent = failures.saturating_sub(1).min(10);
    let seconds = MIN_FAILURE_BACKOFF_SECS
        .saturating_mul(1u64 << exponent)
        .min(MAX_FAILURE_BACKOFF_SECS);
    seconds.saturating_mul(1_000)
}

fn refresh_once(app_dir: &Path, previous: &PersistedSyncState) -> Result<RefreshOutcome, String> {
    if fetch_disabled_by_env() {
        return Err("models.dev network refresh is disabled by environment".into());
    }
    fs::create_dir_all(app_dir).map_err(|error| error.to_string())?;
    secure_dir(app_dir)?;
    let nonce = format!("{}.{}", std::process::id(), now_ms());
    let raw_path = app_dir.join(format!(".models-dev.{nonce}.json"));
    let header_path = app_dir.join(format!(".models-dev.{nonce}.headers"));
    let normalized_path = app_dir.join(format!(".pricing-cache.{nonce}.tmp"));
    let final_path = app_dir.join(PRICE_CACHE_FILE_NAME);
    let result = (|| {
        let response = download_with_curl(
            &raw_path,
            &header_path,
            previous.etag.as_deref(),
            previous.last_modified.as_deref(),
        )?;
        if response.status_code == 304 {
            if !final_path.is_file() {
                return Err("server returned 304 but no local price cache exists".into());
            }
            return Ok(RefreshOutcome::NotModified {
                count: cache_entry_count(&final_path).unwrap_or(previous.entry_count),
                etag: response.etag,
                last_modified: response.last_modified,
            });
        }
        if response.status_code != 200 {
            return Err(format!("models.dev returned HTTP {}", response.status_code));
        }
        let metadata = fs::metadata(&raw_path).map_err(|error| error.to_string())?;
        if metadata.len() == 0 || metadata.len() > MAX_DOWNLOAD_BYTES {
            return Err(format!(
                "models.dev payload size {} is outside bounds",
                metadata.len()
            ));
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        File::open(&raw_path)
            .map_err(|error| error.to_string())?
            .take(MAX_DOWNLOAD_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_DOWNLOAD_BYTES {
            return Err("models.dev payload exceeded bounded reader".into());
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        let mut document = normalize_models_dev(&value)?;
        let count = document
            .get("entries")
            .and_then(Value::as_object)
            .map(Map::len)
            .unwrap_or(0);
        if count < 10 {
            return Err(format!(
                "models.dev extraction produced only {count} entries"
            ));
        }
        if let Some(object) = document.as_object_mut() {
            object.insert("ttl_secs".into(), json!(24 * 60 * 60));
            object.insert("upstream_etag".into(), json!(response.etag.clone()));
            object.insert(
                "upstream_last_modified".into(),
                json!(response.last_modified.clone()),
            );
        }
        {
            let mut file = File::create(&normalized_path).map_err(|error| error.to_string())?;
            secure_file(&normalized_path)?;
            serde_json::to_writer(&mut file, &document).map_err(|error| error.to_string())?;
            file.flush().map_err(|error| error.to_string())?;
            let _ = file.sync_all();
        }
        atomic_replace(&normalized_path, &final_path)?;
        secure_file(&final_path)?;
        Ok(RefreshOutcome::Updated {
            count,
            etag: response.etag,
            last_modified: response.last_modified,
        })
    })();
    let _ = fs::remove_file(&raw_path);
    let _ = fs::remove_file(&header_path);
    let _ = fs::remove_file(&normalized_path);
    result
}

fn price_source_urls() -> Vec<String> {
    let mut urls = Vec::new();
    if let Ok(value) = std::env::var(PRICE_SOURCE_ENV) {
        let value = value.trim();
        // Custom mirrors are useful on corporate/offline networks, but never
        // permit plaintext, embedded credentials, control characters or an
        // unbounded command-line argument.
        if value.starts_with("https://")
            && value.len() <= 2_048
            && !value.chars().any(char::is_control)
            && !value[8..].contains('@')
        {
            urls.push(value.to_string());
        }
    }
    if !urls.iter().any(|existing| existing == MODELS_DEV_URL) {
        urls.push(MODELS_DEV_URL.to_string());
    }
    urls
}

#[derive(Debug)]
struct CurlAttemptError {
    message: String,
    retryable: bool,
}

fn download_with_curl(
    output: &Path,
    headers: &Path,
    etag: Option<&str>,
    last_modified: Option<&str>,
) -> Result<DownloadResult, String> {
    let mut errors = Vec::new();
    for url in price_source_urls() {
        // Validators belong to the primary models.dev representation. Sending
        // them to a mirror can produce a false 304 for a different resource.
        let validators = if url == MODELS_DEV_URL {
            (etag, last_modified)
        } else {
            (None, None)
        };

        for attempt in 0..CURL_ATTEMPTS_PER_SOURCE {
            let _ = fs::remove_file(output);
            let _ = fs::remove_file(headers);
            // A surprising number of desktop networks advertise an unusable
            // IPv6 route. Retry #2 explicitly uses IPv4 instead of waiting for
            // the same resolver/route failure three times.
            let force_ipv4 = attempt == 1;
            match download_single_with_curl(
                output,
                headers,
                validators.0,
                validators.1,
                &url,
                force_ipv4,
            ) {
                Ok(result) => return Ok(result),
                Err(error) => {
                    let route = if force_ipv4 { "ipv4" } else { "dual-stack" };
                    errors.push(format!(
                        "{url} attempt {}/{} ({route}): {}",
                        attempt + 1,
                        CURL_ATTEMPTS_PER_SOURCE,
                        error.message
                    ));
                    if !error.retryable {
                        break;
                    }
                    if attempt + 1 < CURL_ATTEMPTS_PER_SOURCE {
                        let delay = CURL_RETRY_BACKOFF_MS.get(attempt).copied().unwrap_or(2_000);
                        thread::sleep(Duration::from_millis(delay));
                    }
                }
            }
        }
    }
    Err(format!(
        "all pricing sources failed: {}",
        errors.join(" | ")
    ))
}

fn download_single_with_curl(
    output: &Path,
    headers: &Path,
    etag: Option<&str>,
    last_modified: Option<&str>,
    url: &str,
    force_ipv4: bool,
) -> Result<DownloadResult, CurlAttemptError> {
    let binary = trusted_curl_path().ok_or_else(|| CurlAttemptError {
        message: "trusted system curl is unavailable".into(),
        retryable: false,
    })?;
    let mut command = Command::new(&binary);
    command.args([
        "--silent",
        "--show-error",
        "--location",
        "--max-redirs",
        "3",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--tlsv1.2",
        "--compressed",
        "--connect-timeout",
    ]);
    command.arg(CURL_CONNECT_TIMEOUT_SECS.to_string());
    command.arg("--max-time");
    command.arg(CURL_TOTAL_TIMEOUT_SECS.to_string());
    if force_ipv4 {
        command.arg("--ipv4");
    }
    command.arg("--user-agent");
    command.arg(format!(
        "Octopus/{} pricing-sync",
        env!("CARGO_PKG_VERSION")
    ));
    command.arg("--dump-header");
    command.arg(headers);
    command.arg("--output").arg(output);
    command.arg("--write-out").arg("%{http_code}");
    if let Some(value) = safe_header_value(etag) {
        command
            .arg("--header")
            .arg(format!("If-None-Match: {value}"));
    }
    if let Some(value) = safe_header_value(last_modified) {
        command
            .arg("--header")
            .arg(format!("If-Modified-Since: {value}"));
    }
    command.arg(url);
    let result = command
        .stdin(Stdio::null())
        .output()
        .map_err(|error| CurlAttemptError {
            message: format!("curl could not start: {error}"),
            retryable: false,
        })?;
    if !result.status.success() {
        let exit_code = result.status.code();
        let stderr = String::from_utf8_lossy(&result.stderr)
            .trim()
            .chars()
            .take(400)
            .collect::<String>();
        let summary = if stderr.is_empty() {
            format!("curl exited with {}", result.status)
        } else {
            format!(
                "curl exit {}: {stderr}",
                exit_code.map_or_else(|| "signal".into(), |code| code.to_string())
            )
        };
        return Err(CurlAttemptError {
            message: summary,
            retryable: retryable_curl_exit(exit_code),
        });
    }
    let status_text = String::from_utf8_lossy(&result.stdout).trim().to_string();
    let status_code = status_text
        .rsplit(|character: char| !character.is_ascii_digit())
        .find(|part| part.len() == 3)
        .and_then(|part| part.parse::<u16>().ok())
        .ok_or_else(|| CurlAttemptError {
            message: format!("curl returned invalid HTTP status: {status_text:?}"),
            retryable: false,
        })?;
    let (response_etag, response_last_modified) =
        parse_response_headers(headers).map_err(|message| CurlAttemptError {
            message,
            retryable: false,
        })?;
    Ok(DownloadResult {
        status_code,
        etag: response_etag,
        last_modified: response_last_modified,
    })
}

fn retryable_curl_exit(code: Option<i32>) -> bool {
    matches!(code, Some(5 | 6 | 7 | 18 | 28 | 35 | 52 | 55 | 56 | 92))
}

fn parse_response_headers(path: &Path) -> Result<(Option<String>, Option<String>), String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_STATE_BYTES {
        return Err("HTTP response headers exceeded size limit".into());
    }
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let mut etag = None;
    let mut last_modified = None;
    for raw_line in text.lines() {
        let line = raw_line.trim_end_matches('\r');
        if line.starts_with("HTTP/") {
            etag = None;
            last_modified = None;
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = safe_header_value(Some(value.trim()));
        if name.eq_ignore_ascii_case("etag") {
            etag = value;
        } else if name.eq_ignore_ascii_case("last-modified") {
            last_modified = value;
        }
    }
    Ok((etag, last_modified))
}

fn safe_header_value(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty()
        || value.len() > MAX_HEADER_VALUE
        || value.chars().any(|character| character.is_control())
    {
        return None;
    }
    Some(value.to_string())
}

fn trusted_curl_path() -> Option<PathBuf> {
    // R6-K1 fix (R7): cache resolved curl path to eliminate TOCTOU between
    // is_file check and Command::new execution. OnceLock resolves once per process.
    static CACHED: OnceLock<Option<PathBuf>> = OnceLock::new();
    CACHED.get_or_init(resolve_curl_path).clone()
}

/// Actual curl path resolution — called at most once thanks to OnceLock.
fn resolve_curl_path() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let root = std::env::var_os("SystemRoot").or_else(|| std::env::var_os("WINDIR"))?;
        let candidate = PathBuf::from(root).join("System32").join("curl.exe");
        candidate.is_file().then_some(candidate)
    }
    #[cfg(not(windows))]
    {
        [
            "/usr/bin/curl",
            "/bin/curl",
            "/usr/local/bin/curl",
            "/opt/homebrew/bin/curl",
        ]
        .into_iter()
        .map(PathBuf::from)
        .find(|candidate| candidate.is_file())
    }
}

fn normalize_models_dev(value: &Value) -> Result<Value, String> {
    let root = value
        .as_object()
        .ok_or("models.dev root is not an object")?;
    let providers = root
        .get("providers")
        .and_then(Value::as_object)
        .unwrap_or(root);
    let mut entries = Map::new();
    let mut bare_rank: HashMap<String, u8> = HashMap::new();

    for (provider_id, provider) in providers.iter().take(2_000) {
        if provider_id.is_empty() || provider_id.len() > 128 {
            continue;
        }
        let Some(models) = provider.get("models").and_then(Value::as_object) else {
            continue;
        };
        for (model_id, model) in models {
            if entries.len() >= MAX_MODELS || model_id.is_empty() || model_id.len() > 384 {
                continue;
            }
            let Some(entry) = normalize_model_entry(provider_id, model_id, model) else {
                continue;
            };
            let provider_key = format!(
                "{}/{}",
                provider_id.to_ascii_lowercase(),
                model_id.to_ascii_lowercase()
            );
            entries.insert(provider_key, entry.clone());

            let bare = model_id.to_ascii_lowercase();
            let rank = candidate_rank(provider_id, &entry);
            let should_replace = bare_rank
                .get(&bare)
                .map(|current| rank < *current)
                .unwrap_or(true);
            if should_replace {
                bare_rank.insert(bare.clone(), rank);
                entries.insert(bare, entry);
            }
        }
    }

    Ok(json!({
        "schema_version": 2,
        "source": "models.dev",
        "source_url": MODELS_DEV_URL,
        "fetched_at": Utc::now().to_rfc3339(),
        "entries": entries
    }))
}

fn normalize_model_entry(provider_id: &str, model_id: &str, model: &Value) -> Option<Value> {
    let cost = model.get("cost").and_then(Value::as_object);
    let limit = model.get("limit").and_then(Value::as_object);
    let input = finite_rate(cost.and_then(|cost| cost.get("input")));
    let output = finite_rate(cost.and_then(|cost| cost.get("output")));
    let cache_read = finite_rate(cost.and_then(|cost| cost.get("cache_read")));
    let cache_write = finite_rate(cost.and_then(|cost| cost.get("cache_write")));
    let context = finite_u64(limit.and_then(|limit| limit.get("context")));
    let max_output = finite_u64(limit.and_then(|limit| limit.get("output")));
    // Reject the whole entry if a present price field is absurd (out of the
    // finite_rate bounds). A missing field is fine; a present-but-garbage field
    // means the catalog row is unreliable and must not be kept with a null price.
    if present_but_absurd(cost, "input") || present_but_absurd(cost, "output") {
        return None;
    }
    if input.is_none() && output.is_none() && context.is_none() {
        return None;
    }
    Some(json!({
        "id": model_id,
        "provider_id": provider_id,
        "provider_model_id": model.get("id").and_then(Value::as_str).unwrap_or(model_id),
        "input_usd_per_million": input,
        "output_usd_per_million": output,
        "cache_read_usd_per_million": cache_read,
        "cache_write_usd_per_million": cache_write,
        "context_window": context,
        "max_output": max_output,
        "supports_reasoning": model.get("reasoning").and_then(Value::as_bool),
        "model_last_updated": model.get("last_updated").and_then(Value::as_str),
        "provenance": "models.dev"
    }))
}

fn candidate_rank(provider: &str, entry: &Value) -> u8 {
    let object = entry.as_object();
    let has_any_price = object
        .map(|object| {
            [
                "input_usd_per_million",
                "output_usd_per_million",
                "cache_read_usd_per_million",
                "cache_write_usd_per_million",
            ]
            .iter()
            .any(|key| object.get(*key).and_then(Value::as_f64).is_some())
        })
        .unwrap_or(false);
    let has_nonzero_price = object
        .map(|object| {
            ["input_usd_per_million", "output_usd_per_million"]
                .iter()
                .any(|key| object.get(*key).and_then(Value::as_f64).unwrap_or(0.0) > 0.0)
        })
        .unwrap_or(false);
    let official = is_official_provider(provider);
    match (official, has_nonzero_price, has_any_price) {
        (true, true, _) => 0,
        (true, false, true) => 1,
        (true, false, false) => 2,
        (false, true, _) => 3,
        (false, false, true) => 4,
        _ => 5,
    }
}

fn is_official_provider(provider: &str) -> bool {
    matches!(
        provider.to_ascii_lowercase().as_str(),
        "anthropic"
            | "openai"
            | "openai-codex"
            | "google"
            | "deepseek"
            | "xai"
            | "mistral"
            | "cohere"
            | "zai"
            | "z-ai"
            | "moonshot"
            | "moonshotai"
            | "xiaomi"
            | "xiaomi-mimo"
            | "minimax"
            | "stepfun"
            | "sakana"
            | "meta"
            | "alibaba"
            | "alibaba-cn"
            | "nvidia-nim"
            | "qianfan"
            | "volcengine"
    )
}

fn finite_rate(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0 && *value <= MAX_PRICE_USD_PER_MILLION)
}

/// True when the named cost field is present as a number but falls outside the
/// finite_rate bounds (absurd/garbage). Used to reject the whole catalog row
/// rather than keep it with a null price.
fn present_but_absurd(cost: Option<&Map<String, Value>>, field: &str) -> bool {
    let Some(cost) = cost else { return false };
    match cost.get(field).and_then(Value::as_f64) {
        Some(value) => finite_rate(Some(&json!(value))).is_none(),
        None => false,
    }
}

fn finite_u64(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value > 0 && *value <= 100_000_000)
}

fn cache_entry_count(path: &Path) -> Result<usize, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_DOWNLOAD_BYTES {
        return Err("price cache exceeds size limit".into());
    }
    let value: Value =
        serde_json::from_reader(File::open(path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    Ok(value
        .get("entries")
        .and_then(Value::as_object)
        .map(Map::len)
        .unwrap_or(0))
}

fn load_sync_state(app_dir: &Path) -> Result<PersistedSyncState, String> {
    let path = app_dir.join(PRICE_SYNC_STATE_FILE_NAME);
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PersistedSyncState::default())
        }
        Err(error) => return Err(error.to_string()),
    };
    if metadata.len() > MAX_STATE_BYTES {
        return Err("pricing sync state exceeds size limit".into());
    }
    let mut state: PersistedSyncState =
        serde_json::from_reader(File::open(path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    if state.schema_version != 1 || state.source_url != MODELS_DEV_URL {
        state = PersistedSyncState::default();
    }
    state.etag = state
        .etag
        .as_deref()
        .and_then(|value| safe_header_value(Some(value)));
    state.last_modified = state
        .last_modified
        .as_deref()
        .and_then(|value| safe_header_value(Some(value)));
    state.last_error = state
        .last_error
        .map(|value| value.chars().take(500).collect());
    state.entry_count = state.entry_count.min(MAX_MODELS);
    Ok(state)
}

fn persist_sync_state(app_dir: &Path, state: &PersistedSyncState) -> Result<(), String> {
    fs::create_dir_all(app_dir).map_err(|error| error.to_string())?;
    secure_dir(app_dir)?;
    let final_path = app_dir.join(PRICE_SYNC_STATE_FILE_NAME);
    let temp_path = app_dir.join(format!(
        ".pricing-sync-state.{}.{}.tmp",
        std::process::id(),
        now_ms()
    ));
    {
        let mut file = File::create(&temp_path).map_err(|error| error.to_string())?;
        secure_file(&temp_path)?;
        serde_json::to_writer_pretty(&mut file, state).map_err(|error| error.to_string())?;
        file.flush().map_err(|error| error.to_string())?;
        let _ = file.sync_all();
    }
    atomic_replace(&temp_path, &final_path)?;
    secure_file(&final_path)
}

fn atomic_replace(temp: &Path, final_path: &Path) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        fs::rename(temp, final_path).map_err(|error| error.to_string())
    }
    #[cfg(windows)]
    {
        let backup = final_path.with_extension(format!("bak.{}", std::process::id()));
        let had_final = final_path.exists();
        if had_final {
            let _ = fs::remove_file(&backup);
            fs::rename(final_path, &backup).map_err(|error| error.to_string())?;
        }
        match fs::rename(temp, final_path) {
            Ok(()) => {
                let _ = fs::remove_file(&backup);
                Ok(())
            }
            Err(error) => {
                if had_final {
                    let _ = fs::rename(&backup, final_path);
                }
                Err(error.to_string())
            }
        }
    }
}

fn fetch_disabled_by_env() -> bool {
    env_flag("OCTOPUS_DISABLE_MODELS_DEV_FETCH") || env_flag("OCTOPUS_NO_NET")
}

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn iso_time(value: Option<u64>) -> Option<String> {
    let millis = i64::try_from(value?).ok()?;
    Utc.timestamp_millis_opt(millis)
        .single()
        .map(|time| time.to_rfc3339())
}

#[cfg_attr(not(unix), allow(unused_variables))]
fn secure_dir(path: &Path) -> Result<(), String> {
    // R6-K2 fix (R7): reject symlinks on app_dir — prevent chmod from
    // following a symlink to an unintended target outside ~/.re-llmpet.
    #[cfg(unix)]
    {
        if path.symlink_metadata().map_err(|e| e.to_string())?.file_type().is_symlink() {
            return Err(format!("refusing to secure_dir on symlink: {}", path.display()));
        }
    }
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

    #[test]
    fn pinned_models_dev_api_fixture_matches_expected_shape() {
        let raw: Value = serde_json::from_str(include_str!(
            "../../test/fixtures/models-dev-api-sample.json"
        ))
        .unwrap();
        let normalized = normalize_models_dev(&raw).unwrap();
        let entries = normalized["entries"].as_object().unwrap();
        assert_eq!(entries["claude-sample"]["provider_id"], json!("anthropic"));
        assert_eq!(
            entries["claude-sample"]["input_usd_per_million"],
            json!(3.0)
        );
        assert_eq!(
            entries["claude-sample"]["cache_read_usd_per_million"],
            json!(0.3)
        );
        assert_eq!(
            entries["anthropic/claude-sample"]["context_window"],
            json!(200000)
        );
        assert!(entries.contains_key("openrouter/anthropic/claude-sample"));
    }

    #[test]
    fn models_dev_normalization_prefers_official_nonzero_price() {
        let raw = json!({
            "frogbot": {"models": {"same-model": {"cost":{"input":9.0,"output":19.0},"limit":{"context":100}}}},
            "anthropic": {"models": {"same-model": {"cost":{"input":3.0,"output":15.0,"cache_read":0.3},"limit":{"context":200000}}}}
        });
        let normalized = normalize_models_dev(&raw).unwrap();
        let entries = normalized["entries"].as_object().unwrap();
        assert_eq!(entries["same-model"]["input_usd_per_million"], json!(3.0));
        assert_eq!(
            entries["anthropic/same-model"]["provider_id"],
            json!("anthropic")
        );
    }

    #[test]
    fn models_dev_normalization_accepts_catalog_wrapper_and_rejects_absurd_prices() {
        let raw = json!({"providers": {
            "openai": {"models": {
                "good": {"cost":{"input":1.0,"output":2.0},"limit":{"context":128000,"output":32000}},
                "bad": {"cost":{"input":1001.0,"output":2.0}}
            }}
        }});
        let normalized = normalize_models_dev(&raw).unwrap();
        let entries = normalized["entries"].as_object().unwrap();
        assert!(entries.contains_key("good"));
        assert!(!entries.contains_key("bad"));
        assert_eq!(entries["good"]["max_output"], json!(32000));
    }

    #[test]
    fn conditional_header_parser_uses_final_redirect_block_and_rejects_controls() {
        let dir = std::env::temp_dir().join(format!("re-llmpet-pricing-headers-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("headers.txt");
        fs::write(
            &path,
            "HTTP/1.1 302 Found\r\nETag: old\r\n\r\nHTTP/2 200\r\nETag: \"new\"\r\nLast-Modified: Wed, 01 Jul 2026 00:00:00 GMT\r\n\r\n",
        )
        .unwrap();
        let parsed = parse_response_headers(&path).unwrap();
        assert_eq!(parsed.0.as_deref(), Some("\"new\""));
        assert_eq!(parsed.1.as_deref(), Some("Wed, 01 Jul 2026 00:00:00 GMT"));
        assert!(safe_header_value(Some("ok\r\nInjected: yes")).is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn refresh_interval_and_failure_backoff_are_bounded() {
        assert_eq!(refresh_interval_ms(0), 60 * 60 * 1_000);
        assert_eq!(refresh_interval_ms(999), 168 * 60 * 60 * 1_000);
        assert_eq!(failure_backoff_ms(1), 15 * 60 * 1_000);
        assert_eq!(failure_backoff_ms(2), 30 * 60 * 1_000);
        assert_eq!(failure_backoff_ms(99), 12 * 60 * 60 * 1_000);
    }

    #[test]
    fn sync_state_round_trip_keeps_conditional_request_metadata() {
        let dir = std::env::temp_dir().join(format!("re-llmpet-pricing-state-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let state = PersistedSyncState {
            etag: Some("\"abc\"".into()),
            last_modified: Some("Wed, 01 Jul 2026 00:00:00 GMT".into()),
            last_checked_ms: Some(now_ms()),
            next_check_ms: Some(now_ms() + 3_600_000),
            entry_count: 123,
            ..PersistedSyncState::default()
        };
        persist_sync_state(&dir, &state).unwrap();
        let loaded = load_sync_state(&dir).unwrap();
        assert_eq!(loaded.etag, state.etag);
        assert_eq!(loaded.entry_count, 123);
        let _ = fs::remove_dir_all(dir);
    }
}
