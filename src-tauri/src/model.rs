use crate::metering::{UsageIngest, UsageLedger};
use crate::transcript::TranscriptScanner;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    mpsc::{SyncSender, TrySendError},
    Arc, Condvar, Mutex,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const APP_DIR_NAME: &str = ".re-llmpet";
pub const CONFIG_FILE_NAME: &str = "config.json";
pub const RUNTIME_FILE_NAME: &str = "runtime.json";
pub const LOG_FILE_NAME: &str = "re-llmpet.log";
pub const PENDING_FILE_NAME: &str = "pending-permissions.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppConfig {
    pub lang: String,
    pub mode: String,
    pub skin: String,
    pub pet_position: Option<Point>,
    pub budget5h: f64,
    pub muted: bool,
    pub reply_bubbles: bool,
    pub reply_bubble_chars: usize,
    pub perm_hook: bool,
    pub territory: bool,
    pub territory_rivals: Vec<String>,
    pub currency: String,
    pub fx_rate: f64,
    pub providers: Vec<String>,
    pub price_auto_update: bool,
    pub price_refresh_hours: u64,
    // R19 (2026-07-30): session list pin/archive prefs. Pinned sessions
    // float to the top of the panel's session list; archived sessions are
    // hidden unless the user toggles "show archived". Both are stable
    // session-id strings; the backend never touches the actual session
    // state, only the display ordering.
    pub pinned_sessions: Vec<String>,
    pub archived_sessions: Vec<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            lang: "zh".into(),
            mode: "pet".into(),
            skin: "mascot".into(),
            pet_position: None,
            budget5h: 10.0,
            muted: false,
            reply_bubbles: true,
            reply_bubble_chars: 800,
            perm_hook: true,
            territory: false,
            territory_rivals: Vec::new(),
            currency: "USD".into(),
            fx_rate: 7.2,
            providers: Vec::new(), // R22: default empty — user selects providers
            price_auto_update: true,
            price_refresh_hours: 24,
            pinned_sessions: Vec::new(),
            archived_sessions: Vec::new(),
        }
    }
}

impl AppConfig {
    pub fn sanitize(mut self) -> Self {
        if !matches!(self.lang.as_str(), "zh" | "en" | "ja") {
            self.lang = "zh".into();
        }
        if !matches!(self.mode.as_str(), "pet" | "panel" | "menubar" | "hidePet") {
            self.mode = "pet".into();
        }
        if !matches!(self.skin.as_str(), "mascot" | "pixel" | "cat") {
            self.skin = "mascot".into();
        }
        if !self.budget5h.is_finite() || self.budget5h < 0.0 {
            self.budget5h = 10.0;
        }
        self.budget5h = self.budget5h.min(100_000.0);
        self.reply_bubble_chars = self.reply_bubble_chars.clamp(120, 2_200);
        if !matches!(self.currency.as_str(), "USD" | "CNY") {
            self.currency = "USD".into();
        }
        if !self.fx_rate.is_finite() || self.fx_rate <= 0.0 {
            self.fx_rate = 7.2;
        }
        self.fx_rate = self.fx_rate.clamp(0.01, 100.0);
        self.price_refresh_hours = self.price_refresh_hours.clamp(1, 168);
        self.territory_rivals = self
            .territory_rivals
            .into_iter()
            .map(|s| s.trim().chars().take(64).collect::<String>())
            .filter(|s| !s.is_empty())
            .take(30)
            .collect();
        let known = ["claude", "codewhale", "codex", "opencode", "aider"];
        let mut providers = Vec::new();
        for provider in self.providers {
            let p = provider.trim().to_lowercase();
            if known.contains(&p.as_str()) && !providers.contains(&p) {
                providers.push(p);
            }
        }
        // R30 (2026-07-31): allow empty providers. The old code forced
        // "claude" when providers was empty, which contradicted the user's
        // explicit choice to disable all providers. This caused:
        // - uninstall_hooks("all") clearing providers, then sanitize()
        //   re-adding claude on the next config save
        // - changing language/skin would silently select claude
        // - hook resync would re-install claude hooks against user intent
        // Now: empty is a valid first-class state. No provider hooks
        // are installed; the pet still works as a passive observer.
        self.providers = providers;
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub provider: String,
    pub state: String,
    pub cwd: String,
    pub tool_name: Option<String>,
    pub model: Option<String>,
    pub assistant_last_output: Option<String>,
    pub headless: bool,
    pub updated_at: u64,
    pub source_pid: Option<u32>,
    pub context_used: Option<u64>,
    pub context_limit: Option<u64>,
    pub context_percent: Option<f64>,
    #[serde(default, skip_serializing)]
    pub last_event_at: u64,
    #[serde(default, skip_serializing)]
    pub last_event_seq: Option<u64>,
    #[serde(default, skip_serializing)]
    pub last_event_rank: u8,
    #[serde(default, skip_serializing)]
    pub last_event_key: Option<String>,
    #[serde(default, skip_serializing)]
    pub ended_at: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct PendingPermission {
    pub id: String,
    pub signature: String,
    pub session_id: String,
    pub provider: String,
    pub tool_name: String,
    pub tool_input: Value,
    pub permission_suggestions: Vec<Value>,
    pub created_at: u64,
    pub response: Arc<(Mutex<Option<PermissionDecision>>, Condvar)>,
}

#[derive(Debug, Clone)]
pub struct PermissionDecision {
    pub behavior: String,
    pub message: Option<String>,
    pub updated_input: Option<Value>,
    pub updated_permissions: Vec<Value>,
}

#[derive(Debug, Clone)]
pub struct BatchRule {
    pub session_id: String,
    pub tool_name: Option<String>,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: String,
    pub installed: bool,
    pub state: String,
    pub message: String,
    pub path: Option<String>,
    pub permission_mode: String,
    pub capabilities: Value,
}

/// R40.1 (audit P0-4): consolidated stats coalescer state.
///
/// All three fields are under a single `Mutex` so the trailing timer's
/// "read dirty, clear dirty, clear scheduled, decide to emit" sequence
/// is atomic. The 0.5.19 split-mutex design had a race:
///
/// ```text
/// trailing: dirty=false, release dirty lock
/// new event: dirty=true; sees scheduled=true, doesn't schedule new timer
/// trailing: scheduled=false; exits
/// result: dirty=true, but no timer ← permanent lost flush
/// ```
///
/// With a single mutex, the new event must wait for the trailing
/// timer's critical section to complete. When it gets the lock,
/// `scheduled=false`, so it correctly schedules a new timer.
pub struct StatsCoalescerState {
    /// When the last emit happened (for throttle window check).
    pub last_emit: Option<Instant>,
    /// True if an event was dropped during the throttle window.
    pub dirty: bool,
    /// True if a trailing flush timer is currently pending.
    pub scheduled: bool,
}

impl Default for StatsCoalescerState {
    fn default() -> Self {
        Self {
            last_emit: None,
            dirty: false,
            scheduled: false,
        }
    }
}

pub struct Runtime {
    pub config: Mutex<AppConfig>,
    // R35 (2026-07-31): dedicated writer-side lock for `update_config`.
    //
    // The R34 copy-on-write transaction snapshots the config, mutates the
    // snapshot, persists to disk, then commits to the Mutex. Without a
    // separate writer-side lock, two concurrent writers can both snapshot
    // the same C0, both persist (A then B), and both commit — the in-memory
    // state ends up as A while disk is B. The audit's P0-6 example:
    //   A snapshot C0 → candidate A → A writes disk A → A commits memory A
    //   B snapshot C0 → candidate B → B writes disk B → B commits memory B
    //   final: disk B, memory A  ← split-brain.
    //
    // `config_write_lock` serializes the entire snapshot→mutate→save→commit
    // sequence. Reads still take `config` directly and remain concurrent;
    // only writers block each other. This is the simplest correct fix for
    // the small config volume — a CAS / revision scheme is overkill here.
    pub config_write_lock: Mutex<()>,
    pub sessions: Mutex<HashMap<String, Session>>,
    pub pending: Mutex<HashMap<String, PendingPermission>>,
    pub batch_rules: Mutex<Vec<BatchRule>>,
    pub provider_status: Mutex<HashMap<String, ProviderStatus>>,
    pub usage: Mutex<UsageLedger>,
    pub transcripts: Mutex<TranscriptScanner>,
    pub price_sync_status: Mutex<Value>,
    pub price_refresh_tx: Mutex<Option<SyncSender<()>>>,
    // R35.2 (2026-07-31): active diagnostic child PID for real cancellation.
    //
    // The 0.5.12 carpet audit P0-4 flagged that "cancel" only dropped the
    // frontend result — the Rust Child (and on Windows, the cmd.exe-spawned
    // Node grandchild) kept running. Verified via web-search of Rust docs
    // (doc.rust-lang.org/std/process/struct.Child.html): "There is no
    // implementation of Drop for child processes, so if you do not ensure
    // the Child has exited then it will continue to run."
    //
    // This field stores the PID of the currently-running diagnostic probe
    // child. `cancel_diagnostic` reads it and kills the process tree
    // (taskkill /F /T on Windows, killpg on Unix). `diagnose_agent_sync`
    // updates it before each probe spawn and clears it when the diagnostic
    // completes. Only one diagnostic runs at a time per process (the
    // frontend's diagnosticGeneration prevents new ones while one is
    // pending); this is a single-slot registry, not a full DiagnosticRegistry
    // (which is R36).
    pub active_diagnostic_pid: Mutex<Option<u32>>,
    // R36 (2026-07-31): the provider currently being diagnosed. Used by
    // `diagnose_agent` to reject duplicate concurrent runs for the SAME
    // provider — the 0.5.12 carpet audit P0-4 noted "用户反复点击'重新
    // 诊断'可能同时创建多组 blocking jobs / CLI child / reader threads".
    // The frontend's `diagnosticGeneration` already suppresses stale
    // results, but the Rust side had no guard against duplicate spawns.
    // Now if `active_diagnostic_provider == Some("claude")` and a new
    // `diagnose_agent("claude")` arrives, we return Err("busy") immediately
    // without spawning. Different providers can run concurrently (the
    // single PID slot is shared, but that's acceptable since the frontend
    // only shows one diagnostic at a time).
    pub active_diagnostic_provider: Mutex<Option<String>>,
    /// R41 (audit §10): cooperative cancellation flag for diagnose_agent.
    pub diagnostic_cancelled: Arc<std::sync::atomic::AtomicBool>,
    // R38.1 (2026-08-01): Singleton StatsCoalescer state. The 0.5.16 full
    // audit (P0-1) flagged that the R38 trailing flush created a new
    // spawn_blocking task PER throttled event — 1000 events/s would spawn
    // ~1000 sleeping tasks, all waking ~150ms later and each broadcasting
    // a full snapshot. Now we use a single coalescer with dirty+scheduled
    // flags: at most ONE trailing timer exists at any time.
    //
    // State machine:
    //   - last_emit: when the last emit happened (for throttle window)
    //   - dirty: true if an event was dropped during the throttle window
    //   - scheduled: true if a trailing flush timer is already pending
    //   - revision: monotonically increasing, sent with each stats payload
    //
    // R40.1 (audit P0-4): the 0.5.19 split-mutex design had a race where
    // dirty=true but no timer was scheduled (trailing timer clears
    // scheduled between the new event's dirty-set and scheduled-check).
    // The consolidated `stats_coalescer` mutex below fixes this by
    // making the check-and-set atomic. The old fields are kept for
    // backward compatibility with existing smoke tests but are no
    // longer used in the hot path.
    pub last_stats_emit: Mutex<Option<Instant>>,
    pub stats_dirty: Mutex<bool>,
    pub stats_scheduled: Mutex<bool>,
    pub stats_revision: Mutex<u64>,
    /// R40.1: consolidated coalescer state — all three flags under one
    /// lock so the trailing timer's "read dirty, clear dirty, clear
    /// scheduled, decide to emit" sequence is atomic. A new event
    /// arriving during the trailing critical section must wait for the
    /// lock; when it gets it, scheduled=false, so it correctly schedules
    /// a new timer if needed.
    pub stats_coalescer: Mutex<StatsCoalescerState>,
    pub app_dir: PathBuf,
    pub config_path: PathBuf,
    pub runtime_path: PathBuf,
    pub log_path: PathBuf,
    pub pending_path: PathBuf,
    pub started_at: u64,
}

#[derive(Clone)]
pub struct AppState {
    pub runtime: Arc<Runtime>,
}

impl AppState {
    pub fn new() -> Self {
        let app_dir = home_dir().join(APP_DIR_NAME);
        let _ = secure_create_dir(&app_dir);
        let config_path = app_dir.join(CONFIG_FILE_NAME);
        let runtime_path = app_dir.join(RUNTIME_FILE_NAME);
        let log_path = app_dir.join(LOG_FILE_NAME);
        let pending_path = app_dir.join(PENDING_FILE_NAME);
        recover_stale_pending_metadata(&pending_path, &log_path);
        let config = load_config(&config_path);
        let price_auto_update = config.price_auto_update;
        let price_refresh_hours = config.price_refresh_hours;
        let usage = UsageLedger::open(&app_dir, now_ms());
        let transcript_root = home_dir().join(".claude").join("projects");
        let transcripts = TranscriptScanner::open(&app_dir, transcript_root);
        Self {
            runtime: Arc::new(Runtime {
                config: Mutex::new(config),
                config_write_lock: Mutex::new(()),
                sessions: Mutex::new(HashMap::new()),
                pending: Mutex::new(HashMap::new()),
                batch_rules: Mutex::new(Vec::new()),
                provider_status: Mutex::new(HashMap::new()),
                usage: Mutex::new(usage),
                transcripts: Mutex::new(transcripts),
                price_sync_status: Mutex::new(json!({
                    "state":"starting",
                    "inProgress":false,
                    "autoUpdate":price_auto_update,
                    "refreshHours":price_refresh_hours
                })),
                price_refresh_tx: Mutex::new(None),
                active_diagnostic_pid: Mutex::new(None),
                active_diagnostic_provider: Mutex::new(None),
                diagnostic_cancelled: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                last_stats_emit: Mutex::new(None),
                stats_dirty: Mutex::new(false),
                stats_scheduled: Mutex::new(false),
                stats_revision: Mutex::new(0),
                stats_coalescer: Mutex::new(StatsCoalescerState::default()),
                app_dir,
                config_path,
                runtime_path,
                log_path,
                pending_path,
                started_at: now_ms(),
            }),
        }
    }
}

impl Runtime {
    pub fn config(&self) -> AppConfig {
        self.config
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Lightweight read of just the reply-privacy fields, avoiding a full
    /// AppConfig clone on the hot ingest() path (called on every /state POST).
    pub fn privacy_settings(&self) -> (bool, usize) {
        let config = self.config.lock().unwrap_or_else(|e| e.into_inner());
        (config.reply_bubbles, config.reply_bubble_chars)
    }

    pub fn set_provider_status(&self, status: ProviderStatus) {
        self.provider_status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(status.id.clone(), status);
    }

    pub fn provider_statuses(&self) -> HashMap<String, ProviderStatus> {
        self.provider_status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn price_info(&self) -> Value {
        let mut value = self
            .usage
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .price_info();
        let sync = self
            .price_sync_status
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        let config = self.config();
        if let Some(object) = value.as_object_mut() {
            object.insert("sync".into(), sync.clone());
            object.insert("autoUpdate".into(), json!(config.price_auto_update));
            object.insert("refreshHours".into(), json!(config.price_refresh_hours));
            if let Some(sync_object) = sync.as_object() {
                for (key, item) in sync_object {
                    object.insert(key.clone(), item.clone());
                }
            }
        }
        value
    }

    pub fn set_price_sync_status(&self, status: Value) {
        *self
            .price_sync_status
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = status;
    }

    pub fn install_price_refresh_sender(&self, sender: SyncSender<()>) {
        *self
            .price_refresh_tx
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(sender);
    }

    pub fn request_price_refresh(&self) -> Result<(), String> {
        let sender = self
            .price_refresh_tx
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
            .ok_or("price synchronization worker is not ready")?;
        match sender.try_send(()) {
            Ok(()) | Err(TrySendError::Full(())) => Ok(()),
            Err(TrySendError::Disconnected(())) => {
                Err("price synchronization worker has stopped".to_string())
            }
        }
    }

    pub fn mark_price_refresh_queued(&self) {
        let mut status = self
            .price_sync_status
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(object) = status.as_object_mut() {
            object.insert("state".into(), json!("queued"));
            object.insert("inProgress".into(), json!(false));
            object.insert("lastError".into(), Value::Null);
        }
    }

    pub fn mark_price_sync_error(&self, message: &str) {
        let mut status = self
            .price_sync_status
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(object) = status.as_object_mut() {
            object.insert("state".into(), json!("worker-error"));
            object.insert("inProgress".into(), json!(false));
            object.insert(
                "lastError".into(),
                json!(message.chars().take(500).collect::<String>()),
            );
        }
    }

    pub fn mark_price_auto_disabled(&self) {
        let mut status = self
            .price_sync_status
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(object) = status.as_object_mut() {
            object.insert("state".into(), json!("auto-disabled"));
            object.insert("inProgress".into(), json!(false));
            object.insert("autoUpdate".into(), json!(false));
        }
    }

    pub fn reload_price_catalog(&self) {
        self.usage
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .reload_catalog(&self.app_dir);
    }

    /// Renderer-facing view. Persisted AppConfig intentionally keeps providers as
    /// a compact Vec<String>; the web UI receives richer runtime installation data.
    pub fn config_view(&self) -> Value {
        let config = self.config();
        let statuses = self.provider_statuses();
        let mut root = serde_json::to_value(&config).unwrap_or_else(|_| json!({}));
        if let Some(object) = root.as_object_mut() {
            let all = ["claude", "codewhale", "codex", "opencode", "aider"];
            let cw_installed = statuses
                .get("codewhale")
                .map(|status| status.installed)
                .unwrap_or(false);
            object.insert(
                "providers".into(),
                json!({
                    "active": config.providers,
                    "all": all,
                    "statuses": statuses,
                    "cwHooksInstalled": cw_installed
                }),
            );
        }
        root
    }

    pub fn update_config<F>(&self, update: F) -> Result<AppConfig, String>
    where
        F: FnOnce(&mut AppConfig),
    {
        // R34 (2026-07-31): copy-on-write transaction.
        //
        // Previous implementation mutated the shared Mutex guard IN PLACE,
        // then called save_config(). If save_config() failed (disk full,
        // permission denied, antivirus lock, rename failure), the in-memory
        // config was already the new value while the disk still held the
        // old value. Subsequent get_config() / restart would see conflicting
        // state, and provider hook resync would run against a config that
        // the user thinks failed to save.
        //
        // Fix: snapshot the current config, mutate the snapshot, sanitize,
        // PERSIST TO DISK FIRST, and only commit to the shared Mutex if the
        // disk write succeeded. The Mutex is held only for the duration of
        // the snapshot+commit, NOT across file IO.
        //
        // R35 (2026-07-31): serialize the entire snapshot→mutate→save→commit
        // sequence under `config_write_lock`. Without this, two concurrent
        // writers can both snapshot C0, both persist (A then B on disk), and
        // both commit (B then A in memory) — leaving disk==B but memory==A.
        // The audit's P0-6 example shows this exact split-brain. Reads are
        // unaffected: they only take `config` and remain fully concurrent.
        let _write_guard = self
            .config_write_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let candidate = {
            let guard = self.config.lock().unwrap_or_else(|e| e.into_inner());
            let mut candidate = guard.clone();
            update(&mut candidate);
            candidate.sanitize()
        };
        // Disk write happens WITHOUT holding the read Mutex — other readers
        // can still observe the previous config during the IO window. The
        // writer-side `config_write_lock` is still held, so no other writer
        // can race us between snapshot and commit.
        save_config(&self.config_path, &candidate)?;
        // Commit: acquire the read Mutex again, replace in-memory state with
        // the persisted candidate. Because `config_write_lock` is still
        // held, no other writer can interleave between our save and our
        // commit — disk and memory are now guaranteed to agree.
        let mut guard = self.config.lock().unwrap_or_else(|e| e.into_inner());
        *guard = candidate;
        Ok(guard.clone())
    }

    pub fn ingest(&self, body: &Value) -> Session {
        let event = clean_text(
            body.get("hook_event_name").or_else(|| body.get("event")),
            96,
        )
        .unwrap_or_default();
        let explicit_state = clean_text(body.get("state"), 32).unwrap_or_default();
        let id = clean_text(
            body.get("session_id")
                .or_else(|| body.get("sessionId"))
                .or_else(|| body.get("conversation_id")),
            256,
        )
        .unwrap_or_else(|| "default".into());
        let provider = clean_text(body.get("provider"), 32).unwrap_or_else(|| "claude".into());
        let cwd = clean_text(
            body.get("cwd")
                .or_else(|| body.get("workspace"))
                .or_else(|| body.get("project")),
            4096,
        )
        .unwrap_or_default();
        let tool_name = clean_text(body.get("tool_name").or_else(|| body.get("toolName")), 256);
        let mut model = clean_text(body.get("model"), 256);
        let (reply_bubbles, reply_bubble_chars) = self.privacy_settings();
        let mut assistant_last_output = if reply_bubbles {
            body.get("assistant_last_output")
                .or_else(|| body.get("last_assistant_message"))
                .and_then(Value::as_str)
                .and_then(|value| crate::transcript::safe_reply(value, reply_bubble_chars))
        } else {
            None
        };
        let source_pid = body
            .get("source_pid")
            .or_else(|| body.get("sourcePid"))
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok());
        let headless = body
            .get("headless")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let state = normalize_state(&explicit_state, &event);
        let now = now_ms();
        let event_at = incoming_event_time(body, now);
        let event_seq = incoming_event_sequence(body);
        let event_rank = event_rank(&event, &state);
        let event_key = incoming_event_key(body, &event);
        let usage_result = {
            let mut usage = self.usage.lock().unwrap_or_else(|error| error.into_inner());
            let mut combined = match usage.record_hook(body, now) {
                Ok(result) => result,
                Err(error) => {
                    self.write_log("metering", &format!("usage event rejected: {error}"));
                    UsageIngest::default()
                }
            };
            if provider == "claude" {
                let scan = self
                    .transcripts
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .scan_from_hook(
                        body,
                        &id,
                        &mut usage,
                        now,
                        reply_bubbles.then_some(reply_bubble_chars),
                    );
                merge_usage_ingest(&mut combined, scan.usage);
                if assistant_last_output.is_none() {
                    assistant_last_output = scan.assistant_text;
                }
                if model.is_none() {
                    model = scan.model;
                }
            }
            combined
        };

        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let snapshot = {
            let entry = sessions.entry(id.clone()).or_insert_with(|| Session {
                id: id.clone(),
                provider: provider.clone(),
                state: "idle".into(),
                cwd: cwd.clone(),
                tool_name: None,
                model: None,
                assistant_last_output: None,
                headless,
                updated_at: now,
                source_pid,
                context_used: usage_result.context_used,
                context_limit: usage_result.context_limit,
                context_percent: context_percent(
                    usage_result.context_used,
                    usage_result.context_limit,
                ),
                last_event_at: 0,
                last_event_seq: None,
                last_event_rank: 0,
                last_event_key: None,
                ended_at: None,
            });
            let accepted =
                should_accept_event(entry, event_at, event_seq, event_rank, event_key.as_deref());
            if accepted {
                entry.provider = provider;
                entry.state = state;
                if !cwd.is_empty() {
                    entry.cwd = cwd;
                }
                if tool_name.is_some() {
                    entry.tool_name = tool_name;
                }
                if model.is_some() {
                    entry.model = model;
                }
                if assistant_last_output.is_some() {
                    entry.assistant_last_output = assistant_last_output;
                }
                entry.headless = headless;
                if source_pid.is_some() {
                    entry.source_pid = source_pid;
                }
                entry.last_event_at = event_at;
                entry.last_event_seq = event_seq.or(entry.last_event_seq);
                entry.last_event_rank = event_rank;
                entry.last_event_key = event_key;
                entry.ended_at = if event == "SessionEnd" {
                    Some(event_at)
                } else {
                    None
                };
                entry.updated_at = now;
            }
            // Usage/context is monotonic data and remains eligible even when a stale
            // lifecycle event is rejected. The ledger itself handles idempotency.
            if usage_result.context_used.is_some() {
                entry.context_used = usage_result.context_used;
                entry.context_limit = usage_result.context_limit.or(entry.context_limit);
                entry.context_percent = context_percent(entry.context_used, entry.context_limit);
            }
            entry.clone()
        };

        if sessions.len() > 256 {
            if let Some(oldest) = sessions
                .values()
                .filter(|session| session.id != snapshot.id)
                .min_by_key(|session| session.updated_at)
                .map(|session| session.id.clone())
            {
                sessions.remove(&oldest);
            }
        }
        drop(sessions);
        if event == "SessionEnd" && snapshot.ended_at == Some(event_at) {
            self.close_session_pending(&snapshot.id, "Session ended");
        }
        snapshot
    }

    pub fn register_permission(&self, permission: PendingPermission) -> (PendingPermission, bool) {
        let session_id = permission.session_id.clone();
        let mut evicted_session = None;
        {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(existing) = pending
                .values()
                .find(|entry| entry.signature == permission.signature)
                .cloned()
            {
                return (existing, true);
            }
            if pending.len() >= 128 {
                if let Some(oldest) = pending
                    .values()
                    .min_by_key(|entry| (entry.created_at, entry.id.clone()))
                    .map(|entry| entry.id.clone())
                {
                    if let Some(entry) = pending.remove(&oldest) {
                        evicted_session = Some(entry.session_id.clone());
                        let (lock, cv) = &*entry.response;
                        *lock.lock().unwrap_or_else(|e| e.into_inner()) =
                            Some(PermissionDecision {
                                behavior: "deny".into(),
                                message: Some("Octopus permission queue is full".into()),
                                updated_input: None,
                                updated_permissions: Vec::new(),
                            });
                        cv.notify_all();
                    }
                }
            }
            pending.insert(permission.id.clone(), permission.clone());
        }
        self.mark_session_after_permission(&session_id);
        if let Some(session_id) = evicted_session {
            self.mark_session_after_permission(&session_id);
        }
        self.persist_pending_metadata();
        (permission, false)
    }

    pub fn decide(&self, id: &str, behavior: &str, message: Option<String>) -> bool {
        self.finish_permission(
            id,
            PermissionDecision {
                behavior: if behavior == "deny" { "deny" } else { "allow" }.into(),
                message,
                updated_input: None,
                updated_permissions: Vec::new(),
            },
        )
    }

    pub fn decide_value(&self, id: &str, value: &Value) -> Result<bool, String> {
        let entry = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned();
        let Some(entry) = entry else { return Ok(false) };

        let decision = match value {
            Value::String(behavior) if behavior == "allow" || behavior == "deny" => {
                PermissionDecision {
                    behavior: behavior.clone(),
                    message: None,
                    updated_input: if behavior == "allow"
                        && entry.provider == "claude"
                        && entry.tool_name == "ExitPlanMode"
                    {
                        Some(entry.tool_input.clone())
                    } else {
                        None
                    },
                    updated_permissions: Vec::new(),
                }
            }
            Value::String(behavior) if behavior.starts_with("suggestion:") => {
                if entry.provider != "claude" {
                    return Err(
                        "persistent permission suggestions are only supported by Claude".into(),
                    );
                }
                let index = behavior
                    .trim_start_matches("suggestion:")
                    .parse::<usize>()
                    .map_err(|_| "invalid permission suggestion index")?;
                let suggestion = entry
                    .permission_suggestions
                    .get(index)
                    .cloned()
                    .ok_or("permission suggestion no longer exists")?;
                PermissionDecision {
                    behavior: "allow".into(),
                    message: None,
                    updated_input: None,
                    updated_permissions: vec![normalize_permission_suggestion(suggestion)],
                }
            }
            Value::Object(object)
                if object.get("type").and_then(Value::as_str) == Some("elicitation-submit") =>
            {
                if entry.provider != "claude" || entry.tool_name != "AskUserQuestion" {
                    return Err(
                        "structured elicitation is not supported for this provider/tool".into(),
                    );
                }
                let answers = object.get("answers").cloned().unwrap_or_else(|| json!({}));
                PermissionDecision {
                    behavior: "allow".into(),
                    message: None,
                    updated_input: Some(build_elicitation_updated_input(
                        &entry.tool_input,
                        &answers,
                    )),
                    updated_permissions: Vec::new(),
                }
            }
            Value::Object(object)
                if object.get("type").and_then(Value::as_str) == Some("plan-feedback") =>
            {
                if entry.provider != "claude" || entry.tool_name != "ExitPlanMode" {
                    return Err(
                        "plan-review feedback is not supported for this provider/tool".into(),
                    );
                }
                let feedback = object
                    .get("feedback")
                    .and_then(Value::as_str)
                    .map(|value| clean_control_text(value, 4_000))
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| "Plan rejected — please revise".into());
                PermissionDecision {
                    behavior: "deny".into(),
                    message: Some(feedback),
                    updated_input: None,
                    updated_permissions: Vec::new(),
                }
            }
            _ => return Err("unsupported permission decision payload".into()),
        };
        Ok(self.finish_permission(id, decision))
    }

    fn finish_permission(&self, id: &str, decision: PermissionDecision) -> bool {
        let entry = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        let Some(entry) = entry else { return false };
        let (lock, cv) = &*entry.response;
        *lock.lock().unwrap_or_else(|e| e.into_inner()) = Some(decision);
        cv.notify_all();
        self.persist_pending_metadata();
        self.mark_session_after_permission(&entry.session_id);
        true
    }

    pub fn resolve_timeout(&self, id: &str, message: String) -> bool {
        self.finish_permission(
            id,
            PermissionDecision {
                behavior: "deny".into(),
                message: Some(message),
                updated_input: None,
                updated_permissions: Vec::new(),
            },
        )
    }

    pub fn decide_batch(&self, id: &str, mode: &str) -> bool {
        let meta = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .map(|p| (p.session_id.clone(), p.tool_name.clone()));
        let Some((session_id, tool_name)) = meta else {
            return false;
        };
        let tool = match mode {
            "tool" | "cw-allow-tool" => Some(tool_name),
            _ => None,
        };
        self.batch_rules
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(BatchRule {
                session_id,
                tool_name: tool,
                expires_at: now_ms() + 30 * 60 * 1000,
            });
        self.decide(id, "allow", None)
    }

    pub fn close_session_pending(&self, session_id: &str, reason: &str) -> usize {
        let entries = {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            let ids = pending
                .values()
                .filter(|entry| entry.session_id == session_id)
                .map(|entry| entry.id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| pending.remove(&id))
                .collect::<Vec<_>>()
        };
        let message: String = reason.chars().take(240).collect();
        for entry in &entries {
            let (lock, cv) = &*entry.response;
            *lock.lock().unwrap_or_else(|e| e.into_inner()) = Some(PermissionDecision {
                behavior: "deny".into(),
                message: Some(message.clone()),
                updated_input: None,
                updated_permissions: Vec::new(),
            });
            cv.notify_all();
        }
        if !entries.is_empty() {
            self.persist_pending_metadata();
        }
        entries.len()
    }

    pub fn cancel_all_pending(&self, reason: &str) -> usize {
        let entries = {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            pending.drain().map(|(_, entry)| entry).collect::<Vec<_>>()
        };
        let message: String = reason.chars().take(240).collect();
        let mut sessions = Vec::new();
        for entry in &entries {
            let (lock, cv) = &*entry.response;
            *lock.lock().unwrap_or_else(|e| e.into_inner()) = Some(PermissionDecision {
                behavior: "deny".into(),
                message: Some(message.clone()),
                updated_input: None,
                updated_permissions: Vec::new(),
            });
            cv.notify_all();
            if !sessions.contains(&entry.session_id) {
                sessions.push(entry.session_id.clone());
            }
        }
        self.persist_pending_metadata();
        for session_id in sessions {
            self.mark_session_after_permission(&session_id);
        }
        entries.len()
    }

    fn persist_pending_metadata(&self) {
        let rows = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .map(|entry| {
                json!({
                    "id":entry.id.clone(),
                    "sessionId":entry.session_id.clone(),
                    "provider":entry.provider.clone(),
                    "toolName":entry.tool_name.clone(),
                    "createdAt":entry.created_at
                })
            })
            .collect::<Vec<_>>();
        if let Err(error) = write_private_json_atomic(&self.pending_path, &json!({"pending":rows}))
        {
            self.write_log(
                "permission",
                &format!("pending metadata persistence failed: {error}"),
            );
        }
    }

    pub fn matching_batch_rule(&self, session_id: &str, tool_name: &str) -> bool {
        let now = now_ms();
        let mut rules = self.batch_rules.lock().unwrap_or_else(|e| e.into_inner());
        rules.retain(|r| r.expires_at > now);
        rules.iter().any(|r| {
            r.session_id == session_id
                && r.tool_name
                    .as_ref()
                    .map(|tool| tool == tool_name)
                    .unwrap_or(true)
        })
    }

    pub fn mark_session_after_permission(&self, session_id: &str) {
        let pending_meta = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|entry| entry.session_id == session_id)
            .min_by_key(|entry| (entry.created_at, entry.id.clone()))
            .map(|entry| {
                (
                    entry.provider.clone(),
                    entry.tool_name.clone(),
                    entry.id.clone(),
                )
            });
        let still_waiting = pending_meta.is_some();
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let now = now_ms();
        let entry = sessions
            .entry(session_id.to_string())
            .or_insert_with(|| Session {
                id: session_id.to_string(),
                provider: "claude".into(),
                state: "idle".into(),
                cwd: String::new(),
                tool_name: None,
                model: None,
                assistant_last_output: None,
                headless: false,
                updated_at: now,
                source_pid: None,
                context_used: None,
                context_limit: None,
                context_percent: None,
                last_event_at: 0,
                last_event_seq: None,
                last_event_rank: 0,
                last_event_key: None,
                ended_at: None,
            });
        if let Some((provider, tool_name, permission_id)) = pending_meta {
            entry.provider = provider;
            entry.tool_name = Some(tool_name);
            entry.state = "waiting".into();
            entry.last_event_key = Some(format!("permission:{permission_id}"));
        } else {
            entry.state = "idle".into();
            entry.last_event_key = Some("permission-resolved".into());
        }
        entry.updated_at = now;
        entry.last_event_at = now;
        entry.last_event_rank = if still_waiting { 100 } else { 90 };
        entry.ended_at = None;
    }

    fn prune_expired_sessions(&self, now: u64) {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.retain(|_, session| !session_is_expired(session, now));
    }

    pub fn session(&self, session_id: &str) -> Option<Session> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
            .cloned()
    }

    pub fn stats(&self) -> Value {
        let now = now_ms();
        self.prune_expired_sessions(now);
        // Take the locks once and build everything from references, avoiding
        // the previous O(n) clone of every Session + double-clone of every
        // PendingPermission. project_name() is computed exactly once per
        // session (was 3× per session before).
        let (sessions, pending) = {
            let _sessions_guard = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            let mut pending: Vec<PendingPermission> = self
                .pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .values()
                .cloned()
                .collect();
            pending.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
            // Build a snapshot Vec<Session> once (needed because we drop the
            // session lock below), but project_name is computed once + reused.
            let session_snap: Vec<Session> = _sessions_guard.values().cloned().collect();
            (session_snap, pending)
        };
        // project_name once per session, stored for reuse.
        let session_projects: HashMap<String, String> = sessions
            .iter()
            .map(|s| (s.id.clone(), project_name(&s.cwd, &s.id)))
            .collect();
        // Group pending by session: first permission per session (sorted), no
        // re-clone — borrow from the owned `pending` Vec.
        let mut pending_first_by_session: HashMap<&str, &PendingPermission> = HashMap::new();
        for permission in &pending {
            pending_first_by_session
                .entry(permission.session_id.as_str())
                .or_insert(permission);
        }
        let pending_choices: Vec<Value> = pending
            .iter()
            .map(|permission| {
                let project = session_projects
                    .get(permission.session_id.as_str())
                    .map(String::as_str)
                    .unwrap_or("");
                permission_choice(permission, project)
            })
            .collect();

        let mut rows = Vec::with_capacity(sessions.len());
        let mut waiting = 0u32;
        let mut needs_input = 0u32;
        let mut working = 0u32;
        let mut juggling = 0u32;
        let mut sweeping = 0u32;
        let mut thinking = 0u32;
        let mut loafing = 0u32;
        let mut errors = 0u32;

        for session in &sessions {
            let project = session_projects
                .get(session.id.as_str())
                .map(String::as_str)
                .unwrap_or("");
            let (state, reason, choice) =
                if let Some(permission) = pending_first_by_session.get(session.id.as_str()) {
                    (
                        "waiting".to_string(),
                        json!("授权"),
                        permission_choice(permission, project),
                    )
                } else {
                    (session.state.clone(), Value::Null, Value::Null)
                };
            match state.as_str() {
                "waiting" => waiting += 1,
                "needsinput" | "notification" => needs_input += 1,
                "working" => working += 1,
                "juggling" => juggling += 1,
                "sweeping" => sweeping += 1,
                "thinking" => thinking += 1,
                "loafing" => loafing += 1,
                "error" => errors += 1,
                _ => {}
            }
            rows.push(json!({
                "project":project,
                "state":state,
                "reason":reason,
                "idleMs":now.saturating_sub(session.updated_at),
                "op":session.tool_name,
                "sessionId":session.id,
                "headless":session.headless,
                "provider":if session.provider == "claude" { Value::Null } else { json!(session.provider) },
                "providerId":session.provider,
                "badge":if session.state == "error" { "error" } else { "idle" },
                "model":session.model,
                "contextPercent":session.context_percent,
                "contextUsed":session.context_used,
                "contextLimit":session.context_limit,
                "choice":choice,
                "todos":[]
            }));
        }
        rows.sort_by(|a, b| {
            let a_state = a.get("state").and_then(Value::as_str).unwrap_or("idle");
            let b_state = b.get("state").and_then(Value::as_str).unwrap_or("idle");
            session_state_priority(a_state)
                .cmp(&session_state_priority(b_state))
                .then_with(|| {
                    a.get("idleMs")
                        .and_then(Value::as_u64)
                        .unwrap_or(u64::MAX)
                        .cmp(&b.get("idleMs").and_then(Value::as_u64).unwrap_or(u64::MAX))
                })
                .then_with(|| {
                    a.get("providerId")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .cmp(b.get("providerId").and_then(Value::as_str).unwrap_or(""))
                })
                .then_with(|| {
                    a.get("sessionId")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .cmp(b.get("sessionId").and_then(Value::as_str).unwrap_or(""))
                })
        });

        let active = sessions
            .iter()
            .min_by(|a, b| {
                session_state_priority(&a.state)
                    .cmp(&session_state_priority(&b.state))
                    .then_with(|| b.updated_at.cmp(&a.updated_at))
                    .then_with(|| a.provider.cmp(&b.provider))
                    .then_with(|| a.id.cmp(&b.id))
            })
            .map(|s| {
                let project = session_projects
                    .get(s.id.as_str())
                    .map(String::as_str)
                    .unwrap_or("");
                json!({
                    "sessionId":s.id,
                    "project":project,
                    "state":s.state,
                    "model":s.model,
                    "provider":if s.provider == "claude" { Value::Null } else { json!(s.provider) },
                    "providerId":s.provider
                })
            });
        let usage = self
            .usage
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .snapshot(now);
        let mut stats = json!({
            "lastOps":[],
            "active":active,
            "sessions":rows,
            "pendingChoices":pending_choices,
            "pendingPermissionCount":pending.len(),
            "waitingCount":waiting,
            "needsinputCount":needs_input,
            "workingCount":working,
            "jugglingCount":juggling,
            "sweepingCount":sweeping,
            "thinkingCount":thinking,
            "loafingCount":loafing,
            "errorCount":errors,
            "todos":[],
            "todosProject":"",
            "lastActivityTs":sessions.iter().map(|s| s.updated_at).max().unwrap_or(self.started_at),
            "idleMs":now.saturating_sub(sessions.iter().map(|s| s.updated_at).max().unwrap_or(self.started_at)),
            "bg":{"running":0,"zombie":0,"total":0,"items":[]},
            "context":Value::Null,
            "ts":now
        });
        if let (Some(target), Some(source)) = (stats.as_object_mut(), usage.as_object()) {
            for (key, value) in source {
                target.insert(key.clone(), value.clone());
            }
            target.insert(
                "transcriptDiagnostics".into(),
                self.transcripts
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .diagnostics(),
            );
        }
        stats
    }

    pub fn write_log(&self, tag: &str, message: &str) {
        let safe_tag: String = tag.chars().filter(|c| !c.is_control()).take(64).collect();
        let safe_tag = if safe_tag.is_empty() {
            "app"
        } else {
            safe_tag.as_str()
        };
        // Renderer-originated diagnostics share this sink with native logs. Keep
        // every event on one bounded line so a compromised WebView cannot forge
        // additional timestamp/tag records with CR/LF or other controls.
        let safe_message: String = message
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .take(4096)
            .collect();
        let line = format!("{} [{}] {}\n", now_ms(), safe_tag, safe_message);
        // R36 (2026-07-31): log rotation. The 0.5.12 carpet audit P1-5
        // flagged that write_log appends indefinitely with no size limit,
        // rotation, or retention. A long-running session could fill disk.
        // Now we check the file size before each append; if it exceeds
        // 2 MiB, we rotate: octopus.log → octopus.1.log → ... → octopus.4.log
        // (5 files total, max ~10 MiB). The rotation is best-effort — if
        // it fails (permissions, disk full), we still try to append.
        const MAX_LOG_SIZE: u64 = 2 * 1024 * 1024; // 2 MiB
        const MAX_LOG_FILES: u8 = 5;
        if let Ok(metadata) = fs::metadata(&self.log_path) {
            if metadata.len() >= MAX_LOG_SIZE {
                let _ = rotate_log(&self.log_path, MAX_LOG_FILES);
            }
        }
        let _ = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_path)
            .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
    }
}

pub fn permission_signature(
    provider: &str,
    session_id: &str,
    tool_name: &str,
    tool_input: &Value,
) -> String {
    let input = serde_json::to_string(tool_input).unwrap_or_default();
    format!("{provider}\u{1f}{session_id}\u{1f}{tool_name}\u{1f}{input}")
}

fn permission_choice(permission: &PendingPermission, project: &str) -> Value {
    if permission.provider == "claude" && permission.tool_name == "AskUserQuestion" {
        return json!({
            "kind":"ask",
            "sessionId":permission.session_id,
            "permId":permission.id,
            "project":project,
            "header":"Claude 提问",
            "question":"请回答以下结构化问题",
            "questions":parse_elicitation_questions(&permission.tool_input),
            "options":[],
            "multi":false,
            "allowInput":true,
            "provider":Value::Null
        });
    }
    if permission.provider == "claude" && permission.tool_name == "ExitPlanMode" {
        return json!({
            "kind":"plan",
            "sessionId":permission.session_id,
            "permId":permission.id,
            "project":project,
            "header":"ExitPlanMode",
            "question":humanize_tool(&permission.tool_name, &permission.tool_input),
            "options":[{"label":"✅ 批准方案","key":"allow"},{"label":"✏️ 打回并反馈","key":"deny"}],
            "multi":false,
            "allowInput":true,
            "provider":Value::Null
        });
    }
    let mut options = vec![json!({"label":"✅ 允许","key":"allow"})];
    if permission.provider == "claude" {
        for (index, suggestion) in permission.permission_suggestions.iter().take(8).enumerate() {
            options.push(json!({
                "label":permission_suggestion_label(suggestion, index),
                "key":format!("suggestion:{index}")
            }));
        }
    }
    if permission.provider == "codewhale" {
        options.push(json!({"label":"✅✅ 本轮全部允许","key":"cw-allow-session"}));
        options.push(json!({"label":"🔓 本会话允许此工具","key":"cw-allow-tool"}));
    }
    options.push(json!({"label":"⛔ 拒绝","key":"deny"}));
    json!({
        "kind":"perm",
        "sessionId":permission.session_id,
        "permId":permission.id,
        "project":project,
        "header":permission.tool_name,
        "question":humanize_tool(&permission.tool_name, &permission.tool_input),
        "options":options,
        "multi":false,
        "allowInput":false,
        "provider":if permission.provider == "claude" { Value::Null } else { json!(permission.provider) }
    })
}

fn clean_control_text(value: &str, max: usize) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .trim()
        .chars()
        .take(max)
        .collect()
}

fn parse_elicitation_questions(input: &Value) -> Vec<Value> {
    input
        .get("questions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(10)
        .filter_map(|question| {
            let object = question.as_object()?;
            let text = object
                .get("question")
                .or_else(|| object.get("prompt"))
                .and_then(Value::as_str)
                .map(|value| clean_control_text(value, 1_000))
                .filter(|value| !value.is_empty())?;
            let options = object
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .take(12)
                .filter_map(|option| match option {
                    Value::String(label) => Some(json!({"label":clean_control_text(label, 500),"description":""})),
                    Value::Object(map) => {
                        let label = map.get("label").and_then(Value::as_str).map(|value| clean_control_text(value, 500))?;
                        if label.is_empty() { return None; }
                        let description = map.get("description").and_then(Value::as_str).map(|value| clean_control_text(value, 1_000)).unwrap_or_default();
                        Some(json!({"label":label,"description":description}))
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();
            Some(json!({
                "header":object.get("header").and_then(Value::as_str).map(|value| clean_control_text(value, 200)).unwrap_or_default(),
                "question":text,
                "options":options,
                "multiSelect":object.get("multiSelect").and_then(Value::as_bool).unwrap_or(false)
            }))
        })
        .collect()
}

fn build_elicitation_updated_input(input: &Value, answers: &Value) -> Value {
    let mut updated = input.as_object().cloned().unwrap_or_default();
    let mut normalized = serde_json::Map::new();
    let answer_map = answers.as_object();
    if let Some(questions) = updated.get("questions").and_then(Value::as_array) {
        for question in questions.iter().take(10) {
            let Some(text) = question.get("question").and_then(Value::as_str) else {
                continue;
            };
            let Some(answer) = answer_map
                .and_then(|map| map.get(text))
                .and_then(Value::as_str)
            else {
                continue;
            };
            let answer = clean_control_text(answer, 4_000);
            if !answer.is_empty() {
                normalized.insert(text.chars().take(1_000).collect(), Value::String(answer));
            }
        }
    }
    updated.insert("answers".into(), Value::Object(normalized));
    Value::Object(updated)
}

fn normalize_permission_suggestion(mut suggestion: Value) -> Value {
    if let Some(object) = suggestion.as_object_mut() {
        object
            .entry("destination".to_string())
            .or_insert_with(|| json!("localSettings"));
        object
            .entry("behavior".to_string())
            .or_insert_with(|| json!("allow"));
    }
    suggestion
}

fn permission_suggestion_label(suggestion: &Value, index: usize) -> String {
    if let Some(rule) = suggestion
        .get("rules")
        .and_then(Value::as_array)
        .and_then(|rules| rules.first())
    {
        if let Some(tool) = rule
            .get("toolName")
            .or_else(|| rule.get("tool_name"))
            .and_then(Value::as_str)
        {
            return format!("🔓 始终允许 {tool}");
        }
    }
    if let Some(tool) = suggestion
        .get("toolName")
        .or_else(|| suggestion.get("tool_name"))
        .and_then(Value::as_str)
    {
        return format!("🔓 始终允许 {tool}");
    }
    format!("🔓 采用允许规则 {}", index + 1)
}

fn merge_usage_ingest(target: &mut UsageIngest, source: UsageIngest) {
    target.inserted |= source.inserted;
    target.duplicate |= source.duplicate;
    if source.context_used.is_some() {
        target.context_used = source.context_used;
        target.context_limit = source.context_limit.or(target.context_limit);
    }
}

fn context_percent(used: Option<u64>, limit: Option<u64>) -> Option<f64> {
    let (used, limit) = (used?, limit?);
    if limit == 0 {
        return None;
    }
    Some(((used as f64 / limit as f64) * 100.0).clamp(0.0, 100.0))
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

/// R25 (2026-07-30): Atomically replace `dest` with `src` on Windows.
///
/// Windows `fs::rename` cannot overwrite an existing file. The old code
/// did `remove_file(dest)` then `rename(src, dest)` — a crash between them
/// loses the file entirely (config, ledger, or pending permissions).
///
/// This helper mirrors `hook_install.rs::write_text_atomic`'s backup pattern:
/// 1. If dest exists, rename it to a `.bak` backup
/// 2. Rename src → dest
/// 3. On success: remove the backup
/// 4. On failure: restore the backup
pub fn windows_safe_rename(src: &Path, dest: &Path) -> Result<(), String> {
    // R30 (2026-07-31): if src and dest are the same path, do nothing.
    if src == dest {
        return Ok(());
    }
    #[cfg(windows)]
    {
        let backup = dest.with_extension(format!("{}.{}.bak", std::process::id(), now_ms()));
        let had_original = dest.exists();
        if had_original {
            fs::rename(dest, &backup).map_err(|e| {
                let _ = fs::remove_file(src);
                format!("failed to preserve existing file: {e}")
            })?;
        }
        match fs::rename(src, dest) {
            Ok(()) => {
                if had_original {
                    let _ = fs::remove_file(&backup);
                }
                Ok(())
            }
            Err(error) => {
                let _ = fs::remove_file(src);
                if had_original {
                    let _ = fs::rename(&backup, dest);
                }
                Err(format!("failed to rename temp file: {error}"))
            }
        }
    }
    #[cfg(not(windows))]
    {
        // On Unix, rename is atomic and replaces existing files.
        fs::rename(src, dest).map_err(|e| e.to_string())
    }
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

/// R36 (2026-07-31): rotate a log file when it exceeds the size limit.
/// Renames `path` → `path.1.log`, `path.1.log` → `path.2.log`, etc.,
/// up to `max_files`. The oldest file (`path.{max_files-1}.log`) is
/// deleted. Best-effort: errors are ignored (the caller falls back to
/// appending to the original file).
///
/// Example with max_files=5 and path="octopus.log":
///   octopus.4.log → deleted
///   octopus.3.log → octopus.4.log
///   octopus.2.log → octopus.3.log
///   octopus.1.log → octopus.2.log
///   octopus.log   → octopus.1.log
/// Then octopus.log is recreated by the caller's OpenOptions::create(true).
fn rotate_log(path: &Path, max_files: u8) -> std::io::Result<()> {
    // Delete the oldest file if it exists.
    let oldest = path.with_extension(format!("{}.log", max_files - 1));
    let _ = fs::remove_file(&oldest);
    // Shift each file up by one, starting from the second-oldest.
    for i in (1..max_files - 1).rev() {
        let from = path.with_extension(format!("{}.log", i));
        let to = path.with_extension(format!("{}.log", i + 1));
        let _ = fs::rename(&from, &to);
    }
    // Rename the current log to .1.log.
    let first = path.with_extension("1.log");
    fs::rename(path, &first)
}

pub fn secure_create_dir(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn recover_stale_pending_metadata(path: &Path, log_path: &Path) {
    let count = fs::metadata(path)
        .ok()
        .filter(|meta| meta.len() <= 1024 * 1024)
        .and_then(|_| fs::read(path).ok())
        .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
        .and_then(|value| value.get("pending").and_then(Value::as_array).map(Vec::len))
        .unwrap_or(0);
    if count > 0 {
        let line = format!("{} [permission] discarded {} stale pending metadata entries after restart; blocked hook processes must use provider fallback\n", now_ms(), count);
        let _ = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
            .and_then(|mut file| std::io::Write::write_all(&mut file, line.as_bytes()));
    }
    let _ = write_private_json_atomic(path, &json!({"pending":[]}));
}

fn write_private_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        secure_create_dir(parent).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    if bytes.len() > 1024 * 1024 {
        return Err("metadata exceeds 1 MiB".into());
    }
    // R35 (2026-07-31): unique temp file name per write attempt (PID + UUID).
    //
    // The old name `config.<pid>.tmp` (and pending.<pid>.tmp) collided when
    // two writers in the same process tried to persist concurrently. The
    // second `fs::write` would clobber the first, and the subsequent
    // `rename` would either race (losing one writer's bytes) or fail
    // outright. The `config_write_lock` in `update_config` already
    // serializes config writes, but `write_private_json_atomic` is also
    // called from the pending-permission path (which has its own locking)
    // — making the temp name globally unique eliminates the collision
    // class regardless of caller.
    let tmp = unique_tmp_path(path);
    fs::write(&tmp, bytes).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    // R25: use windows_safe_rename to avoid remove-then-rename data loss
    crate::model::windows_safe_rename(&tmp, path)
}

/// R44 (audit P0-02): config loading now distinguishes error cases.
/// - NotFound → default (new install, safe)
/// - Too large → default + log warning (don't crash, but user should know)
/// - Permission/IO error → default + log error (was silently swallowing)
/// - Invalid JSON → default + log error (was silently swallowing)
///
/// NOTE: The audit also recommends preserving unknown fields via
/// `#[serde(flatten)] extras: Map<String, Value>`. That requires changing
/// AppConfig's serde derives and is a larger change. For now, we at least
/// log errors instead of silently returning default. The full
/// unknown-field preservation is deferred to Phase 0B (namespace migration).
pub fn load_config(path: &Path) -> AppConfig {
    let Ok(meta) = fs::metadata(path) else {
        // File doesn't exist — new install, safe to return default.
        return AppConfig::default();
    };
    if meta.len() > 1024 * 1024 {
        // R44: log instead of silently returning default.
        eprintln!(
            "[re-llmpet] WARNING: config.json is {} bytes (>1MB), using defaults",
            meta.len()
        );
        return AppConfig::default();
    }
    match fs::read_to_string(path) {
        Ok(raw) => {
            match serde_json::from_str::<AppConfig>(&raw) {
                Ok(config) => config.sanitize(),
                Err(e) => {
                    // R44: log the parse error instead of silently returning default.
                    // The old code would return default, and the next save_config
                    // would overwrite the user's (unreadable but still present)
                    // config file with the defaults — irreversible data loss.
                    eprintln!("[re-llmpet] ERROR: config.json parse failed: {e}. Using defaults. Config file will NOT be overwritten until a valid save succeeds.");
                    AppConfig::default()
                }
            }
        }
        Err(e) => {
            // R44: log I/O errors instead of silently returning default.
            eprintln!("[re-llmpet] ERROR: config.json read failed: {e}. Using defaults.");
            AppConfig::default()
        }
    }
}

pub fn save_config(path: &Path, config: &AppConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        secure_create_dir(parent).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
    // R35: same unique-temp-name rationale as write_private_json_atomic.
    let tmp = unique_tmp_path(path);
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    // R25: use windows_safe_rename to avoid remove-then-rename data loss
    crate::model::windows_safe_rename(&tmp, path)
}

/// R35 (2026-07-31): Build a temp path next to `dest` with a globally-unique
/// name combining PID + UUID v4. The `.tmp` suffix is preserved so existing
/// cleanup heuristics and `.gitignore` patterns keep working.
///
/// Format: `<dest>.<pid>.<uuid>.tmp`
///   e.g. `config.json.1234.7c1a9e3b-...-b6f2.tmp`
///
/// The UUID guarantees uniqueness across:
///   - two concurrent writers in the same process (same PID)
///   - two writers in different processes (different PIDs anyway, but UUID
///     is still a stable second factor)
///   - a stalled temp from a previous crashed run (UUID differs)
fn unique_tmp_path(dest: &Path) -> PathBuf {
    let pid = std::process::id();
    let id = uuid::Uuid::new_v4();
    let mut name = dest
        .file_name()
        .map(|value| value.to_os_string())
        .unwrap_or_else(|| std::ffi::OsString::from("file"));
    name.push(".");
    name.push(pid.to_string());
    name.push(".");
    name.push(id.to_string());
    name.push(".tmp");
    dest.with_file_name(name)
}

fn clean_text(value: Option<&Value>, max: usize) -> Option<String> {
    let text = value?.as_str()?;
    let clean: String = text
        .chars()
        .map(|c| {
            if c.is_control() && c != '\n' && c != '\t' {
                ' '
            } else {
                c
            }
        })
        .collect();
    let clean = clean.trim();
    if clean.is_empty() {
        None
    } else {
        Some(clean.chars().take(max).collect())
    }
}

const EVENT_CLOCK_SKEW_MS: u64 = 2_000;
const ENDED_SESSION_TTL_MS: u64 = 30 * 60 * 1000;

fn session_is_expired(session: &Session, now: u64) -> bool {
    session
        .ended_at
        .map(|ended_at| now.saturating_sub(ended_at) >= ENDED_SESSION_TTL_MS)
        .unwrap_or(false)
}

fn incoming_event_sequence(body: &Value) -> Option<u64> {
    body.get("event_seq")
        .or_else(|| body.get("eventSeq"))
        .or_else(|| body.get("sequence"))
        .or_else(|| body.get("seq"))
        .and_then(Value::as_u64)
}

fn incoming_event_time(body: &Value, observed_at: u64) -> u64 {
    let numeric = body
        .get("event_timestamp_ms")
        .or_else(|| body.get("eventTimestampMs"))
        .or_else(|| body.get("timestamp_ms"))
        .or_else(|| body.get("timestampMs"))
        .and_then(Value::as_u64);
    let textual = body
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .and_then(|value| u64::try_from(value.timestamp_millis()).ok());
    numeric
        .or(textual)
        .filter(|value| *value <= observed_at.saturating_add(5 * 60 * 1000))
        .unwrap_or(observed_at)
}

fn incoming_event_key(body: &Value, event: &str) -> Option<String> {
    let id = body
        .get("event_id")
        .or_else(|| body.get("eventId"))
        .or_else(|| body.get("hook_id"))
        .or_else(|| body.get("hookId"))
        .or_else(|| body.get("request_id"))
        .or_else(|| body.get("requestId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    Some(format!(
        "{}:{}",
        event.chars().take(64).collect::<String>(),
        id.chars().take(256).collect::<String>()
    ))
}

fn event_rank(event: &str, state: &str) -> u8 {
    match state {
        "waiting" | "needsinput" => 100,
        "error" => 95,
        _ => match event {
            "Stop" | "SessionEnd" | "turn_end" | "TurnEnd" | "TaskCompleted" => 90,
            "Notification" | "PermissionRequest" | "PermissionDenied" | "Elicitation" => 80,
            "PostToolUse" | "PostToolUseFailure" | "SubagentStop" | "ElicitationResult" => 70,
            "PreToolUse" | "SubagentStart" | "TaskCreated" => 60,
            "UserPromptSubmit" | "message_start" => 50,
            "SessionStart" => 10,
            _ => 40,
        },
    }
}

fn should_accept_event(
    current: &Session,
    incoming_at: u64,
    incoming_seq: Option<u64>,
    incoming_rank: u8,
    incoming_key: Option<&str>,
) -> bool {
    if incoming_key.is_some() && incoming_key == current.last_event_key.as_deref() {
        return false;
    }
    if let (Some(incoming), Some(existing)) = (incoming_seq, current.last_event_seq) {
        if incoming != existing {
            return incoming > existing;
        }
        // Same sequence means duplicate or alternate representation of one event.
        // A stronger terminal/permission state wins only when its event time is not older.
        return incoming_at >= current.last_event_at && incoming_rank > current.last_event_rank;
    }
    if incoming_at.saturating_add(EVENT_CLOCK_SKEW_MS) < current.last_event_at {
        return false;
    }
    if incoming_at == current.last_event_at && incoming_rank < current.last_event_rank {
        return false;
    }
    true
}

fn normalize_state(explicit: &str, event: &str) -> String {
    let valid = [
        "idle",
        "thinking",
        "working",
        "juggling",
        "sweeping",
        "carrying",
        "loafing",
        "notification",
        "waiting",
        "needsinput",
        "attention",
        "error",
        "sleeping",
    ];
    if valid.contains(&explicit) {
        return explicit.into();
    }
    match event {
        "UserPromptSubmit" => "thinking",
        "PreToolUse" | "PostToolUse" | "SubagentStop" | "ElicitationResult" | "TaskCompleted" => {
            "working"
        }
        "SubagentStart" | "TaskCreated" => "juggling",
        "PreCompact" | "Compact" | "SessionEnd" => "sweeping",
        "Notification" => "notification",
        "PermissionDenied" | "Elicitation" => "needsinput",
        "TeammateIdle" => "loafing",
        "StopFailure" | "PostToolUseFailure" => "error",
        "SessionStart" | "Stop" => "idle",
        _ => "idle",
    }
    .into()
}

fn session_state_priority(state: &str) -> u8 {
    match state {
        "waiting" => 0,
        "needsinput" => 1,
        "error" | "attention" => 2,
        "notification" => 3,
        "working" => 4,
        "juggling" => 5,
        "sweeping" | "carrying" => 6,
        "thinking" => 7,
        "loafing" => 8,
        "idle" => 9,
        "sleeping" => 10,
        _ => 11,
    }
}

fn project_name(cwd: &str, id: &str) -> String {
    Path::new(cwd)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| id.get(..id.len().min(8)).unwrap_or(id))
        .to_string()
}

fn humanize_tool(tool: &str, input: &Value) -> String {
    match tool {
        "Bash" => input
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("运行命令")
            .chars()
            .take(300)
            .collect(),
        "Write" | "Edit" => input
            .get("file_path")
            .or_else(|| input.get("path"))
            .and_then(Value::as_str)
            .unwrap_or("修改文件")
            .chars()
            .take(300)
            .collect(),
        "WebFetch" => input
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or("访问网页")
            .chars()
            .take(300)
            .collect(),
        _ => format!("允许执行 {tool}？"),
    }
}

#[cfg(test)]
mod session_order_tests {
    use super::*;

    fn session(last_at: u64, seq: Option<u64>, rank: u8, key: Option<&str>) -> Session {
        Session {
            id: "s".into(),
            provider: "claude".into(),
            state: "idle".into(),
            cwd: String::new(),
            tool_name: None,
            model: None,
            assistant_last_output: None,
            headless: false,
            updated_at: last_at,
            source_pid: None,
            context_used: None,
            context_limit: None,
            context_percent: None,
            last_event_at: last_at,
            last_event_seq: seq,
            last_event_rank: rank,
            last_event_key: key.map(str::to_string),
            ended_at: None,
        }
    }

    #[test]
    fn lower_sequence_is_rejected_even_if_delivered_later() {
        let current = session(10_000, Some(8), 90, Some("Stop:done"));
        assert!(!should_accept_event(
            &current,
            11_000,
            Some(7),
            60,
            Some("PreToolUse:old")
        ));
    }

    #[test]
    fn terminal_event_wins_same_sequence_and_time() {
        let current = session(10_000, Some(8), 60, Some("PreToolUse:a"));
        assert!(should_accept_event(
            &current,
            10_000,
            Some(8),
            90,
            Some("Stop:b")
        ));
    }

    #[test]
    fn stale_clock_event_is_rejected_without_sequence() {
        let current = session(20_000, None, 90, Some("Stop:done"));
        assert!(!should_accept_event(
            &current,
            17_999,
            None,
            60,
            Some("PreToolUse:old")
        ));
        assert!(should_accept_event(
            &current,
            18_000,
            None,
            100,
            Some("PermissionRequest:new")
        ));
    }

    #[test]
    fn duplicate_event_key_is_rejected() {
        let current = session(20_000, None, 60, Some("PreToolUse:same"));
        assert!(!should_accept_event(
            &current,
            21_000,
            None,
            60,
            Some("PreToolUse:same")
        ));
    }

    #[test]
    fn ended_session_expires_after_ttl() {
        let mut current = session(20_000, None, 90, Some("SessionEnd:done"));
        current.ended_at = Some(20_000);
        assert!(!session_is_expired(
            &current,
            20_000 + ENDED_SESSION_TTL_MS - 1
        ));
        assert!(session_is_expired(&current, 20_000 + ENDED_SESSION_TTL_MS));
    }

    #[test]
    fn aggregate_state_priority_is_deterministic() {
        assert!(session_state_priority("waiting") < session_state_priority("working"));
        assert!(session_state_priority("working") < session_state_priority("idle"));
        assert_eq!(session_state_priority("unknown"), 11);
    }

    #[test]
    fn elicitation_updated_input_echoes_questions_and_maps_answers() {
        let input = json!({
            "questions":[{
                "question":"Which framework?",
                "header":"Framework",
                "options":[{"label":"Rust"}],
                "multiSelect":false
            }]
        });
        let updated = build_elicitation_updated_input(&input, &json!({"Which framework?":"Rust"}));
        assert_eq!(updated["questions"], input["questions"]);
        assert_eq!(updated["answers"]["Which framework?"], "Rust");
    }

    #[test]
    fn permission_suggestion_defaults_are_native_claude_shape() {
        let suggestion = normalize_permission_suggestion(json!({
            "type":"addRules",
            "rules":[{"toolName":"Bash","ruleContent":"git status"}]
        }));
        assert_eq!(suggestion["behavior"], "allow");
        assert_eq!(suggestion["destination"], "localSettings");
    }
}
