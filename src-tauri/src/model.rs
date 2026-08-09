use crate::metering::{UsageIngest, UsageLedger};
use crate::transcript::TranscriptScanner;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File};
use std::io::Read;
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
    /// R44 0.5.41: schema version for forward compatibility. Old configs
    /// without this field deserialize as 0 (via serde default). Future
    /// versions that add breaking changes bump this number and implement
    /// migration. `load_config` checks if the parsed version is newer
    /// than `CURRENT_SCHEMA_VERSION` and returns `SchemaTooNew` to
    /// quarantine writes (preventing downgrade data loss).
    #[serde(default)]
    pub schema_version: u32,
    pub lang: String,
    pub mode: String,
    pub skin: String,
    /// single = one aggregated pet; duo = independent Claude + Codex pets.
    pub pet_mode: String,
    pub skin_codex: String,
    pub pet_position: Option<Point>,
    pub pet_position_codex: Option<Point>,
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
    /// R44 0.5.41: unknown-field preservation. Any JSON key not covered by
    /// the fields above is captured here and round-tripped on save. This
    /// prevents data loss when:
    ///   - a future version adds fields this build doesn't know about
    ///   - the user manually adds custom keys to config.json
    ///   - a downgrade happens (newer fields are preserved, not dropped)
    ///
    /// Without this, serde silently drops unknown fields on the next save,
    /// which is irreversible. The flatten attribute captures them into a
    /// Map which is serialized back as top-level JSON keys.
    #[serde(flatten)]
    pub extras: serde_json::Map<String, Value>,
}

/// R44 0.5.41: current schema version this build understands. If a config
/// file has a higher version, `load_config` returns `SchemaTooNew` and
/// writes are quarantined (the user must upgrade or manually migrate).
pub const CURRENT_SCHEMA_VERSION: u32 = 2;

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            lang: "zh".into(),
            mode: "pet".into(),
            skin: "mascot".into(),
            pet_mode: "single".into(),
            skin_codex: "pixel".into(),
            pet_position: None,
            pet_position_codex: None,
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
            extras: serde_json::Map::new(),
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
        if !matches!(self.pet_mode.as_str(), "single" | "duo") {
            self.pet_mode = "single".into();
        }
        if !matches!(self.skin_codex.as_str(), "mascot" | "pixel" | "cat") {
            self.skin_codex = "pixel".into();
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
        let mut rival_keys = HashSet::new();
        self.territory_rivals = self
            .territory_rivals
            .into_iter()
            .map(|value| clean_config_text(&value, 64))
            .filter(|value| !value.is_empty())
            .filter(|value| rival_keys.insert(value.to_lowercase()))
            .take(30)
            .collect();
        self.pinned_sessions = sanitize_session_ids(self.pinned_sessions, &HashSet::new());
        let pinned = self.pinned_sessions.iter().cloned().collect::<HashSet<_>>();
        self.archived_sessions = sanitize_session_ids(self.archived_sessions, &pinned);
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
        // R44 0.5.41: upgrade old configs (schemaVersion 0 or missing) to
        // current. This is a one-way migration — once saved, the config
        // is tagged with CURRENT_SCHEMA_VERSION. Future versions that add breaking
        // changes bump CURRENT_SCHEMA_VERSION and add migration logic here.
        if self.schema_version < CURRENT_SCHEMA_VERSION {
            self.schema_version = CURRENT_SCHEMA_VERSION;
        }
        self
    }
}

fn clean_config_text(value: &str, max_chars: usize) -> String {
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
        .take(max_chars)
        .collect()
}

fn sanitize_session_ids(values: Vec<String>, excluded: &HashSet<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .map(|value| clean_config_text(&value, 256))
        .filter(|value| !value.is_empty() && !excluded.contains(value))
        .filter(|value| seen.insert(value.clone()))
        .take(300)
        .collect()
}

/// R11 backport: whole-machine rank ladder shared by Claude + Codex lifetime
/// tokens. Mirrors upstream `backend/growth.js#rankFor` with the
/// `MACHINE_RANK_UNIT_TOKENS` (10M) unit. QQ-style 4-to-1 promotion:
/// leaf → star → moon → sun → crown. The persisted field name `leaf` matches
/// the upstream API contract; the UI may render it as a paw icon.
fn machine_rank(total_tokens: u64) -> Value {
    const UNIT: u64 = 10_000_000;
    let units = total_tokens / UNIT;
    json!({
        "unitTokens": UNIT,
        "units": units,
        "crown": units / 256,
        "sun": (units % 256) / 64,
        "moon": (units % 64) / 16,
        "star": (units % 16) / 4,
        "leaf": units % 4,
        "progressTokens": total_tokens % UNIT,
        "nextTokens": UNIT,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub content: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_form: Option<String>,
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
    #[serde(default)]
    pub todos: Vec<TodoItem>,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentOperation {
    tool: String,
    icon: String,
    detail: String,
    project: String,
    provider: String,
    ts: u64,
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
#[derive(Default)]
pub struct StatsCoalescerState {
    /// When the last emit happened (for throttle window check).
    pub last_emit: Option<Instant>,
    /// True if an event was dropped during the throttle window.
    pub dirty: bool,
    /// True if a trailing flush timer is currently pending.
    pub scheduled: bool,
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
    recent_ops: Mutex<VecDeque<RecentOperation>>,
    pub pending: Mutex<HashMap<String, PendingPermission>>,
    pub batch_rules: Mutex<Vec<BatchRule>>,
    pub provider_status: Mutex<HashMap<String, ProviderStatus>>,
    pub usage: Mutex<UsageLedger>,
    pub transcripts: Mutex<TranscriptScanner>,
    pub price_sync_status: Mutex<Value>,
    pub price_refresh_tx: Mutex<Option<SyncSender<()>>>,
    /// Single-owner diagnostic lifecycle state. Provider ownership, active PID
    /// and cancellation are intentionally consolidated so cancellation cannot
    /// race a later child registration or leave a stale busy flag.
    pub diagnostic_control: crate::diagnostic_control::DiagnosticControl,
    pub travel: Arc<crate::travel::TravelManager>,
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
    // R40.1 (audit P0-4): the split-mutex throttle was removed. Revision
    // and throttle state now each have one explicit owner.
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
    pub migration_report: Value,
    /// R44 0.5.39 (roadmap v5 §2): replaces the global `CONFIG_WRITE_DISABLED`
    /// AtomicBool with an instance-scoped state machine. The old design
    /// had two problems:
    ///   1. The global static was never actually SET by `load_config`
    ///      (the comment said it was, but the code path didn't do it) —
    ///      so the quarantine was non-functional.
    ///   2. A bool can't distinguish "NotFound" (clean, no quarantine)
    ///      from "ParseError" (corrupt, quarantine) from "TooLarge"
    ///      (quarantine) from "Unreadable" (quarantine).
    ///
    /// The new `ConfigState` enum is set by `load_config` and checked by
    /// `save_config`. Non-`Healthy`/`NotFound` states block writes and
    /// the UI can read this field to show a recovery page.
    pub config_state: Mutex<ConfigState>,
}

/// R44 0.5.39 (roadmap v5 §2): configuration file state machine.
/// Replaces the binary `config_write_disabled: AtomicBool` with a typed
/// enum that distinguishes the reason for quarantine.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ConfigState {
    /// File was read successfully and parsed as valid AppConfig.
    Healthy,
    /// File doesn't exist — new install. Safe to write defaults.
    #[default]
    NotFound,
    /// File exists but couldn't be parsed as AppConfig. The file is
    /// still on disk; writes are blocked to prevent overwriting the
    /// user's (corrupt but present) config with defaults.
    ParseError { message: String },
    /// File exists but couldn't be read (permissions, I/O error).
    /// Writes blocked.
    Unreadable { message: String },
    /// File is larger than MAX_CONFIG_BYTES. Writes blocked.
    TooLarge { size: u64 },
    /// File parsed but its schema version is newer than this build
    /// understands. Writes blocked (would lose unknown fields).
    /// Constructed when a config declares a schema newer than this build.
    /// The recovery UI can then preserve the original file before reset.
    SchemaTooNew { version: u32 },
}

impl ConfigState {
    /// True if `save_config` is allowed. Only `Healthy` and `NotFound`
    /// permit writes; all other states quarantine the config.
    pub fn writes_allowed(&self) -> bool {
        matches!(self, ConfigState::Healthy | ConfigState::NotFound)
    }

    /// True if the config is in a quarantined state (writes blocked,
    /// UI should show a recovery page).
    pub fn is_quarantined(&self) -> bool {
        !self.writes_allowed()
    }

    /// Human-readable label for the UI.
    pub fn label(&self) -> &'static str {
        match self {
            ConfigState::Healthy => "healthy",
            ConfigState::NotFound => "notFound",
            ConfigState::ParseError { .. } => "parseError",
            ConfigState::Unreadable { .. } => "unreadable",
            ConfigState::TooLarge { .. } => "tooLarge",
            ConfigState::SchemaTooNew { .. } => "schemaTooNew",
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    pub runtime: Arc<Runtime>,
}

impl AppState {
    pub fn new() -> Self {
        let home = home_dir();
        let app_dir = home.join(APP_DIR_NAME);
        let migration_report = crate::migration::import_official_data(&home, &app_dir);
        let _ = secure_create_dir(&app_dir);
        let config_path = app_dir.join(CONFIG_FILE_NAME);
        let runtime_path = app_dir.join(RUNTIME_FILE_NAME);
        let log_path = app_dir.join(LOG_FILE_NAME);
        let pending_path = app_dir.join(PENDING_FILE_NAME);
        recover_stale_pending_metadata(&pending_path, &log_path);
        let (config, config_state) = load_config(&config_path);
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
                recent_ops: Mutex::new(VecDeque::with_capacity(50)),
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
                diagnostic_control: crate::diagnostic_control::DiagnosticControl::default(),
                travel: crate::travel::TravelManager::open(&app_dir),
                stats_revision: Mutex::new(0),
                stats_coalescer: Mutex::new(StatsCoalescerState::default()),
                app_dir,
                config_path,
                runtime_path,
                log_path,
                pending_path,
                started_at: now_ms(),
                migration_report: migration_report.as_json(),
                config_state: Mutex::new(config_state),
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
                "territorySupported".into(),
                json!(cfg!(target_os = "macos")),
            );
            object.insert("officialMigration".into(), self.migration_report.clone());
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
        //
        // R44 0.5.39 (roadmap v5 §2): use Runtime::save_config (instance
        // method) instead of the free function, so the config_state
        // quarantine is enforced. If the config was loaded in a quarantined
        // state (ParseError/Unreadable/TooLarge/SchemaTooNew), this returns
        // Err and the caller surfaces it to the UI.
        self.save_config(&candidate)?;
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
        let provider = clean_text(body.get("provider"), 32)
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_else(|| "claude".into());
        let id = clean_text(
            body.get("session_id")
                .or_else(|| body.get("sessionId"))
                .or_else(|| body.get("conversation_id")),
            256,
        )
        // Providers that omit a session id must not collapse into the same
        // global `default` row in duo mode.
        .unwrap_or_else(|| format!("{provider}:default"));
        let cwd = clean_text(
            body.get("cwd")
                .or_else(|| body.get("workspace"))
                .or_else(|| body.get("project")),
            4096,
        )
        .unwrap_or_default();
        let tool_name = clean_text(body.get("tool_name").or_else(|| body.get("toolName")), 256);
        let incoming_todos = extract_todo_snapshot(body, tool_name.as_deref(), &event);
        let incoming_todo_patch = extract_todo_patch(body, tool_name.as_deref(), &event);
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
            let mut usage = self.usage.lock().unwrap_or_else(|error| {
                eprintln!("[octopus] usage mutex poisoned, recovering: {error}");
                error.into_inner()
            });
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
                    .unwrap_or_else(|error| {
                        eprintln!("[octopus] transcripts mutex poisoned, recovering: {error}");
                        error.into_inner()
                    })
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
        let (snapshot, accepted) = {
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
                todos: Vec::new(),
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
                if let Some(todos) = incoming_todos.clone() {
                    entry.todos = todos;
                } else if let Some(todo) = incoming_todo_patch.clone() {
                    apply_todo_patch(&mut entry.todos, todo);
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
            (entry.clone(), accepted)
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
        if accepted {
            if let Some(operation) = recent_operation_for_event(
                &event,
                snapshot.tool_name.as_deref(),
                &snapshot.provider,
                &snapshot.cwd,
                &snapshot.id,
                event_at,
            ) {
                let mut recent = self
                    .recent_ops
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                recent.push_front(operation);
                recent.truncate(50);
            }
        }
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
                behavior: if behavior == "allow" { "allow" } else { "deny" }.into(),
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
                todos: Vec::new(),
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
                "todos":session.todos
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

        // `rows` already contains the effective state after pending-permission
        // reconciliation and is sorted by the same priority the UI consumes.
        // Derive active/context from that final ordering so every surface
        // selects the same session.
        let active_row = rows.first();
        let active_session = active_row
            .and_then(|row| row.get("sessionId"))
            .and_then(Value::as_str)
            .and_then(|id| sessions.iter().find(|session| session.id == id));
        let active = active_row.map(|row| {
            json!({
                "sessionId":row.get("sessionId").cloned().unwrap_or(Value::Null),
                "project":row.get("project").cloned().unwrap_or(Value::Null),
                "state":row.get("state").cloned().unwrap_or(Value::Null),
                "model":row.get("model").cloned().unwrap_or(Value::Null),
                "provider":row.get("provider").cloned().unwrap_or(Value::Null),
                "providerId":row.get("providerId").cloned().unwrap_or(Value::Null),
                "todos":row.get("todos").cloned().unwrap_or_else(|| json!([]))
            })
        });
        let context = active_session.and_then(|session| {
            if session.context_used.is_none()
                && session.context_limit.is_none()
                && session.context_percent.is_none()
            {
                None
            } else {
                Some(json!({
                    "percent":session.context_percent,
                    "used":session.context_used.unwrap_or(0),
                    "limit":session.context_limit
                }))
            }
        });
        // Select Todo data from the same effective/sorted session rows as
        // active/context. Raw session state can lag a pending permission and
        // previously made the HUD highlight one session while showing another
        // session's task list.
        let todo_row = rows.iter().find(|row| {
            row.get("todos")
                .and_then(Value::as_array)
                .map(|items| !items.is_empty())
                .unwrap_or(false)
        });
        let top_todos = todo_row
            .and_then(|row| row.get("todos"))
            .cloned()
            .unwrap_or_else(|| json!([]));
        let todos_project = todo_row
            .and_then(|row| row.get("project"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        let usage = self
            .usage
            .lock()
            .unwrap_or_else(|error| {
                eprintln!("[octopus] usage mutex poisoned in stats(), recovering: {error}");
                error.into_inner()
            })
            .snapshot(now);
        let last_ops = self
            .recent_ops
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .take(30)
            .cloned()
            .collect::<Vec<_>>();
        let mut stats = json!({
            "lastOps":last_ops,
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
            "todos":top_todos,
            "todosProject":todos_project,
            "lastActivityTs":sessions.iter().map(|s| s.updated_at).max().unwrap_or(self.started_at),
            "idleMs":now.saturating_sub(sessions.iter().map(|s| s.updated_at).max().unwrap_or(self.started_at)),
            // Current upstream still exposes background reconciliation as a
            // fixed empty contract. Keep the shape without inventing process data.
            "bg":{"running":0,"zombie":0,"total":0,"items":[]},
            "context":context,
            "travel":self.travel.snapshot(),
            "ts":now
        });
        // Inject cached/incremental Codex rollout data (token usage + rate limits).
        // Returns None when neither rollout nor imported aggregate data exists.
        let (codex_limits, codex_usage) = crate::codex_rollout::snapshot(&self.app_dir);
        if let Some(target) = stats.as_object_mut() {
            if let Some(cl) = codex_limits {
                target.insert("codexLimits".into(), cl);
            }
            // R10 backport: combineUsage — merge Claude + Codex cost into a
            // headline so the panel can show "Claude $X · Codex $Y · 合计 $Z".
            let claude_today_cost = target
                .get("today")
                .and_then(|t| t.get("cost"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let claude_today_unknown = target
                .get("today")
                .and_then(|t| t.get("unknownPrice"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let (codex_today_cost, codex_today_exact) = codex_usage
                .as_ref()
                .and_then(|cu| cu.get("todayCost"))
                .and_then(Value::as_f64)
                .map(|c| {
                    let exact = codex_usage
                        .as_ref()
                        .and_then(|o| o.get("todayCostExact"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    (c, exact)
                })
                .unwrap_or((0.0, false));
            let combined = json!({
                "todayCost": claude_today_cost + codex_today_cost,
                "claudeTodayCost": claude_today_cost,
                "codexTodayCost": codex_today_cost,
                "codexTodayExact": codex_today_exact,
                "claudeUnknownPrice": claude_today_unknown,
            });
            target.insert("combinedUsage".into(), combined);
            if let Some(cu) = codex_usage {
                target.insert("codexUsage".into(), cu);
            }
            // R11 backport: machineGrowth — whole-machine rank combining
            // Claude + Codex lifetime tokens. Mirrors upstream
            // `backend/growth.js#machineGrowth` (10M tokens per rank unit,
            // QQ-style 4-to-1 leaf→star→moon→sun→crown). Claude lifetime is
            // derived from the metering ledger's `daily` map (the Rust ledger
            // keeps raw events within the 95-day retention window; summing
            // daily token counts gives lifetime within that window). Codex
            // lifetime comes directly from codex_rollout's snapshot.
            let claude_lifetime_tokens = usage
                .get("daily")
                .and_then(Value::as_object)
                .map(|daily| {
                    daily
                        .values()
                        .filter_map(|v| v.get("tokens").and_then(Value::as_u64))
                        .sum::<u64>()
                })
                .unwrap_or(0);
            let codex_lifetime_tokens = codex_usage
                .as_ref()
                .and_then(|cu| cu.get("lifetime"))
                .and_then(|l| l.get("tokens"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let machine_total_tokens = claude_lifetime_tokens.saturating_add(codex_lifetime_tokens);
            target.insert(
                "machineGrowth".into(),
                json!({
                    "totalTokens": machine_total_tokens,
                    "claudeTokens": claude_lifetime_tokens,
                    "codexTokens": codex_lifetime_tokens,
                    "rank": machine_rank(machine_total_tokens),
                }),
            );
        }
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
        // 2 MiB, we rotate: re-llmpet.log → octopus.1.log → ... → octopus.4.log
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
        // R1-B#1 fix: enforce 0600 perms on the log file. Every other persisted
        // state file in the app (write_private_json_atomic, write_text_atomic,
        // write_private_atomic, metering secure_file, travel, pricing, runtime)
        // explicitly sets 0600; the log file was the lone outlier, defaulting
        // to the process umask (often 0644 = world-readable on Linux). We set
        // it on every write so the perms are correct even after rotation
        // (fs::rename preserves the source inode's mode, so rotated files
        // inherit 0600 once the current file has it). Best-effort: a chmod
        // failure does not block logging.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.log_path, fs::Permissions::from_mode(0o600));
        }
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

fn todo_input(body: &Value) -> &Value {
    body.get("tool_input")
        .or_else(|| body.get("toolInput"))
        .unwrap_or(body)
}

static EMPTY_TODO_RESPONSE: Value = Value::Null;

fn todo_response(body: &Value) -> &Value {
    body.get("tool_response")
        .or_else(|| body.get("toolResponse"))
        .unwrap_or(&EMPTY_TODO_RESPONSE)
}

fn normalize_todo_status(value: Option<&str>) -> String {
    match value
        .unwrap_or("pending")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "completed" | "complete" | "done" | "closed" => "completed".into(),
        "in_progress" | "in-progress" | "progress" | "working" | "active" => "in_progress".into(),
        _ => "pending".into(),
    }
}

fn todo_text(object: &serde_json::Map<String, Value>) -> Option<String> {
    object
        .get("content")
        .or_else(|| object.get("subject"))
        .or_else(|| object.get("task"))
        .or_else(|| object.get("title"))
        .or_else(|| object.get("text"))
        .or_else(|| object.get("description"))
        .and_then(Value::as_str)
        .map(|text| clean_control_text(text, 500))
        .filter(|text| !text.is_empty())
}

fn todo_id(object: &serde_json::Map<String, Value>) -> Option<String> {
    object
        .get("id")
        .or_else(|| object.get("taskId"))
        .or_else(|| object.get("task_id"))
        .and_then(Value::as_str)
        .map(|value| clean_control_text(value, 256))
        .filter(|value| !value.is_empty())
}

fn todo_active_form(object: &serde_json::Map<String, Value>) -> Option<String> {
    object
        .get("activeForm")
        .or_else(|| object.get("active_form"))
        .and_then(Value::as_str)
        .map(|text| clean_control_text(text, 500))
        .filter(|text| !text.is_empty())
}

fn todo_from_value(value: &Value) -> Option<TodoItem> {
    let object = value.as_object()?;
    Some(TodoItem {
        id: todo_id(object),
        content: todo_text(object)?,
        status: normalize_todo_status(object.get("status").and_then(Value::as_str)),
        active_form: todo_active_form(object),
    })
}

#[derive(Debug, Clone, Default)]
struct TodoPatch {
    id: Option<String>,
    content: Option<String>,
    status: Option<String>,
    active_form: Option<String>,
    deleted: bool,
}

fn todo_patch_from_value(value: &Value) -> Option<TodoPatch> {
    let object = value.as_object()?;
    let raw_status = object.get("status").and_then(Value::as_str);
    let patch = TodoPatch {
        id: todo_id(object),
        content: todo_text(object),
        status: raw_status.map(|status| normalize_todo_status(Some(status))),
        active_form: todo_active_form(object),
        deleted: raw_status
            .map(|status| status.trim().eq_ignore_ascii_case("deleted"))
            .unwrap_or(false),
    };
    if patch.id.is_none()
        && patch.content.is_none()
        && patch.status.is_none()
        && patch.active_form.is_none()
        && !patch.deleted
    {
        None
    } else {
        Some(patch)
    }
}

/// Claude Code v2.1.142+ uses TaskList/TaskGet/TaskCreate/TaskUpdate by
/// default. TaskList data is in the successful PostToolUse `tool_response`,
/// while legacy TodoWrite keeps its complete snapshot in `tool_input.todos`.
fn extract_todo_snapshot(
    body: &Value,
    tool_name: Option<&str>,
    event: &str,
) -> Option<Vec<TodoItem>> {
    let input = todo_input(body);
    let response = todo_response(body);
    let direct = body.get("todos").or_else(|| body.get("tasks"));
    let values = match tool_name.unwrap_or("") {
        "TodoWrite" if event == "PostToolUse" => input.get("todos"),
        "TaskList" if event == "PostToolUse" => response.get("tasks"),
        _ => direct,
    }
    .and_then(Value::as_array)?;
    Some(
        values
            .iter()
            .filter_map(todo_from_value)
            .take(100)
            .collect(),
    )
}

fn merge_todo_patch(target: &mut TodoPatch, source: TodoPatch) {
    if source.id.is_some() {
        target.id = source.id;
    }
    if source.content.is_some() {
        target.content = source.content;
    }
    if source.status.is_some() {
        target.status = source.status;
    }
    if source.active_form.is_some() {
        target.active_form = source.active_form;
    }
    target.deleted |= source.deleted;
}

fn extract_todo_patch(body: &Value, tool_name: Option<&str>, event: &str) -> Option<TodoPatch> {
    if event != "PostToolUse" {
        return None;
    }
    let input = todo_input(body);
    let response = todo_response(body);
    match tool_name.unwrap_or("") {
        "TaskCreate" => {
            let mut patch = todo_patch_from_value(input).unwrap_or_default();
            if let Some(response_patch) = response.get("task").and_then(todo_patch_from_value) {
                merge_todo_patch(&mut patch, response_patch);
            }
            patch.content.as_ref()?;
            patch.status.get_or_insert_with(|| "pending".into());
            Some(patch)
        }
        "TaskUpdate" => {
            if response.get("success").and_then(Value::as_bool) == Some(false) {
                return None;
            }
            let mut patch = todo_patch_from_value(input)?;
            if patch.id.is_none() {
                patch.id = response
                    .get("taskId")
                    .or_else(|| response.get("task_id"))
                    .and_then(Value::as_str)
                    .map(|value| clean_control_text(value, 256))
                    .filter(|value| !value.is_empty());
            }
            Some(patch)
        }
        "TaskGet" => response.get("task").and_then(todo_patch_from_value),
        _ => None,
    }
}

fn apply_todo_patch(todos: &mut Vec<TodoItem>, patch: TodoPatch) {
    let index = patch
        .id
        .as_deref()
        .and_then(|id| todos.iter().position(|item| item.id.as_deref() == Some(id)))
        .or_else(|| {
            patch
                .content
                .as_deref()
                .and_then(|content| todos.iter().position(|item| item.content == content))
        });
    if patch.deleted {
        if let Some(index) = index {
            todos.remove(index);
        }
        return;
    }
    if let Some(index) = index {
        let existing = &mut todos[index];
        if patch.id.is_some() {
            existing.id = patch.id;
        }
        if let Some(content) = patch.content {
            existing.content = content;
        }
        if let Some(status) = patch.status {
            existing.status = status;
        }
        if patch.active_form.is_some() {
            existing.active_form = patch.active_form;
        }
        return;
    }
    let Some(content) = patch.content else {
        return;
    };
    if todos.len() < 100 {
        todos.push(TodoItem {
            id: patch.id,
            content,
            status: patch.status.unwrap_or_else(|| "pending".into()),
            active_form: patch.active_form,
        });
    }
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
/// Example with max_files=5 and path="re-llmpet.log":
///   octopus.4.log → deleted
///   octopus.3.log → octopus.4.log
///   octopus.2.log → octopus.3.log
///   octopus.1.log → octopus.2.log
///   re-llmpet.log   → octopus.1.log
/// Then re-llmpet.log is recreated by the caller's OpenOptions::create(true).
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

/// Config loading distinguishes absence from corruption or unreadability.
/// Unknown fields are preserved by `AppConfig::extras`; schema versions newer
/// than this build are quarantined to avoid destructive downgrade writes.
/// R44 0.5.39 (roadmap v5 §2): load_config now returns `(AppConfig, ConfigState)`
/// instead of just `AppConfig`. The ConfigState is stored on Runtime and
/// checked by save_config to enforce quarantine. The old design returned
/// `AppConfig::default()` on every error path AND never set the global
/// `CONFIG_WRITE_DISABLED` flag — so the next save_config would happily
/// overwrite the user's corrupt config with defaults. Irreversible data loss.
///
/// The new design:
///   - `NotFound` → return defaults + NotFound state (writes allowed)
///   - `TooLarge` → return defaults + TooLarge state (writes blocked)
///   - `Unreadable` → return defaults + Unreadable state (writes blocked)
///   - `ParseError` → return defaults + ParseError state (writes blocked)
///   - `Healthy` → return parsed config + Healthy state (writes allowed)
///
/// In all quarantined states, the in-memory config is defaults (so the
/// app remains usable for diagnostics) but `save_config` refuses to
/// write, preventing the defaults from overwriting the user's real
/// (but unreadable) config file.
pub fn load_config(path: &Path) -> (AppConfig, ConfigState) {
    // Only a genuine absence allows writes. Symlinks, non-regular files,
    // permission failures and open/stat races are quarantined so a default
    // config can never overwrite an unreadable user document.
    let meta = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (AppConfig::default(), ConfigState::NotFound);
        }
        Err(error) => {
            eprintln!(
                "[octopus] ERROR: config.json metadata failed: {error}. Writes are quarantined."
            );
            return (
                AppConfig::default(),
                ConfigState::Unreadable {
                    message: format!("metadata: {error}"),
                },
            );
        }
    };
    if meta.file_type().is_symlink() || !meta.file_type().is_file() {
        return (
            AppConfig::default(),
            ConfigState::Unreadable {
                message: "config path is not a regular file".into(),
            },
        );
    }
    const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
    if meta.len() > MAX_CONFIG_BYTES {
        eprintln!(
            "[octopus] WARNING: config.json is {} bytes (>1MB), using defaults. Writes are quarantined.",
            meta.len()
        );
        return (
            AppConfig::default(),
            ConfigState::TooLarge { size: meta.len() },
        );
    }
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) => {
            return (
                AppConfig::default(),
                ConfigState::Unreadable {
                    message: format!("open: {error}"),
                },
            );
        }
    };
    let opened = match file.metadata() {
        Ok(metadata) => metadata,
        Err(error) => {
            return (
                AppConfig::default(),
                ConfigState::Unreadable {
                    message: format!("opened metadata: {error}"),
                },
            );
        }
    };
    if !opened.is_file() || opened.len() != meta.len() || !same_opened_config_file(&meta, &opened) {
        return (
            AppConfig::default(),
            ConfigState::Unreadable {
                message: "config changed while opening".into(),
            },
        );
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    if let Err(error) = file
        .take(MAX_CONFIG_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
    {
        return (
            AppConfig::default(),
            ConfigState::Unreadable {
                message: format!("read: {error}"),
            },
        );
    }
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return (
            AppConfig::default(),
            ConfigState::TooLarge {
                size: bytes.len() as u64,
            },
        );
    }
    match serde_json::from_slice::<AppConfig>(&bytes) {
        Ok(config) => {
            if config.schema_version > CURRENT_SCHEMA_VERSION {
                eprintln!(
                    "[octopus] WARNING: config schemaVersion {} is newer than this build supports ({}). Writes are quarantined.",
                    config.schema_version, CURRENT_SCHEMA_VERSION
                );
                return (
                    AppConfig::default(),
                    ConfigState::SchemaTooNew {
                        version: config.schema_version,
                    },
                );
            }
            (config.sanitize(), ConfigState::Healthy)
        }
        Err(error) => {
            eprintln!(
                "[octopus] ERROR: config.json parse failed: {error}. Using defaults. Writes are quarantined until the file is fixed."
            );
            (
                AppConfig::default(),
                ConfigState::ParseError {
                    message: error.to_string(),
                },
            )
        }
    }
}

#[cfg(unix)]
fn same_opened_config_file(before: &fs::Metadata, after: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    before.dev() == after.dev() && before.ino() == after.ino()
}

#[cfg(not(unix))]
fn same_opened_config_file(before: &fs::Metadata, after: &fs::Metadata) -> bool {
    before.len() == after.len()
}

/// R44 0.5.39 (roadmap v5 §2): save_config is now a method on Runtime
/// instead of a free function, so it can check the instance-scoped
/// `config_state` Mutex. The old free-function design relied on a global
/// `CONFIG_WRITE_DISABLED` AtomicBool that was NEVER SET by load_config
/// (the comment lied) — so the quarantine was non-functional.
///
/// The `save_config` free function is kept for backward compat with
/// `update_config`'s internal call site, but it now delegates to
/// `Runtime::save_config` via the state parameter. Callers that don't
/// have a Runtime handle (e.g. tests) can use `save_config_unchecked`
/// to bypass the quarantine check.
impl Runtime {
    pub fn save_config(&self, config: &AppConfig) -> Result<(), String> {
        let state = self.config_state.lock().unwrap_or_else(|e| e.into_inner());
        // P3-5 fix (R3): SchemaTooNew no longer hard-blocks ALL writes.
        // Previously, a config file carrying a newer schema version than
        // this build understands quarantined every save — including safe,
        // non-schema-affecting operations like `commit_win_pos` (pet drag)
        // and `set_language`. The result: after a downgrade the app was
        // unusable (every window move failed) and the user had to manually
        // edit/reset config.json. Now we ALLOW writes under SchemaTooNew,
        // but first preserve the original newer-schema file as a one-time
        // backup (`config.json.schema-backup`) so the user can recover the
        // unknown fields after upgrading back. ParseError / Unreadable /
        // TooLarge still hard-quarantine (those mean the file is broken,
        // not merely newer). The in-memory config loaded under
        // SchemaTooNew is already `AppConfig::default()` (see load_config),
        // so the written file will carry schema_version = CURRENT, which
        // means after a restart the state becomes Healthy — the quarantine
        // is self-healing rather than permanent.
        let is_schema_too_new = matches!(*state, ConfigState::SchemaTooNew { .. });
        if !state.writes_allowed() && !is_schema_too_new {
            return Err(format!(
                "Config saves are quarantined because the config file is in state `{}`. Fix the config file and restart. (message: {:?})",
                state.label(),
                match &*state {
                    ConfigState::ParseError { message }
                    | ConfigState::Unreadable { message } => message.clone(),
                    ConfigState::TooLarge { size } => format!("file is {} bytes", size),
                    _ => "n/a".into(),
                }
            ));
        }
        if is_schema_too_new {
            // One-time backup of the newer-schema file before we overwrite
            // it with our (older-schema) serialization. Idempotent: if the
            // backup already exists we leave it untouched so subsequent
            // writes don't clobber the original snapshot.
            let backup = self.config_path.with_extension("json.schema-backup");
            if !backup.exists() && self.config_path.exists() {
                match fs::read(&self.config_path).and_then(|bytes| fs::write(&backup, &bytes)) {
                    Ok(()) => {
                        let label = backup
                            .file_name()
                            .map(|s| s.to_string_lossy().into_owned())
                            .unwrap_or_default();
                        eprintln!(
                            "[octopus] backed up newer-schema config to {label} before allowing downgraded write"
                        );
                    }
                    Err(error) => {
                        eprintln!(
                            "[octopus] WARNING: could not back up newer-schema config before write: {error}. Proceeding anyway."
                        );
                    }
                }
            }
        }
        save_config_unchecked(&self.config_path, config)
    }

    /// Read-only access to the current config state. Used by the UI to
    /// decide whether to show the recovery page.
    pub fn config_state(&self) -> ConfigState {
        self.config_state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// R44 0.5.39 §2: "backup-then-reset" recovery. The user explicitly
    /// requests a reset; we back up the corrupt config, clear the state
    /// to NotFound (allowing writes), and save defaults. The backup lets
    /// the user recover fields manually if needed.
    /// R44 0.5.40 (Roadmap v6 P0-04): backup-and-reset is now a proper
    /// transaction. The 0.5.39 version had two bugs:
    ///   1. It set state to NotFound BEFORE attempting the default write.
    ///      If the write failed, state stayed NotFound, re-allowing writes
    ///      and losing the quarantine reason.
    ///   2. When the original file didn't exist, it returned config_path
    ///      as the "backupPath" — but config_path is NOT a backup file.
    ///      The UI would tell the user "backup saved to <config path>"
    ///      which is misleading.
    ///
    /// The new flow:
    ///   1. Snapshot old ConfigState (for rollback).
    ///   2. Create + verify backup (if source exists).
    ///   3. Write defaults to temp file.
    ///   4. Atomic rename.
    ///   5. Only then commit state to Healthy.
    ///   6. On any failure, restore old state.
    ///
    /// Returns a structured result so the UI can distinguish "backup
    /// created" from "no backup needed (file didn't exist)".
    pub fn backup_and_reset_config(&self) -> Result<ResetResult, String> {
        // P3-2 fix (R1): acquire config_write_lock for the entire backup +
        // default-write + state-commit sequence, mirroring `update_config`.
        // Without this, a concurrent `update_config` (e.g. `commit_win_pos`
        // fired by a pet drag) could land its rename AFTER the reset rename,
        // leaving disk = mutated old config while config_state = Healthy and
        // the user is told "reset succeeded".
        let _write_guard = self
            .config_write_lock
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // Step 1: snapshot old state for rollback.
        let old_state = self.config_state();
        // Step 2: create backup if source exists.
        let backup_path = if self.config_path.exists() {
            let ts = now_ms();
            let bp = self
                .config_path
                .parent()
                .ok_or("config path has no parent")?
                .join(format!(".config.re-llmpet-bak-{ts}.json"));
            fs::copy(&self.config_path, &bp).map_err(|e| {
                // Rollback: restore old state (don't leave it in a half-reset limbo).
                // P3-10 fix (R1): also remove the partial backup file so it
                // doesn't accumulate when fs::copy fails mid-write.
                let _ = fs::remove_file(&bp);
                *self.config_state.lock().unwrap_or_else(|e| e.into_inner()) = old_state.clone();
                format!(
                    "backup failed: {e}; state restored to {}",
                    old_state.label()
                )
            })?;
            Some(bp)
        } else {
            None
        };
        // Step 3: write defaults. If this fails, restore old state.
        if let Err(e) = save_config_unchecked(&self.config_path, &AppConfig::default()) {
            *self.config_state.lock().unwrap_or_else(|e| e.into_inner()) = old_state.clone();
            return Err(format!(
                "default write failed: {e}; state restored to {}",
                old_state.label()
            ));
        }
        // Step 4: commit Healthy state AND update the in-memory config Mutex.
        // P3-1 fix (R1): previously the in-memory `config` Mutex still held
        // the OLD AppConfig after reset. Any subsequent `update_config` (e.g.
        // `commit_win_pos` from a pet drag, `set_language`, etc.) would
        // snapshot the stale memory, mutate it, and `save_config` would
        // succeed (state is now Healthy) — overwriting the just-written
        // defaults with `old_config + mutation`. Setting the in-memory
        // config to the fresh defaults closes that split-brain window.
        *self.config_state.lock().unwrap_or_else(|e| e.into_inner()) = ConfigState::Healthy;
        *self.config.lock().unwrap_or_else(|e| e.into_inner()) = AppConfig::default();
        Ok(ResetResult {
            reset: true,
            backup_created: backup_path.is_some(),
            backup_path,
        })
    }
}

/// R44 0.5.40 (Roadmap v6 P0-04): structured reset result replacing
/// `Result<PathBuf, String>`. The old return type forced callers to
/// interpret a PathBuf as "backup path" even when no backup was created
/// (file didn't exist). The new struct explicitly distinguishes the
/// three cases: reset succeeded with backup / reset succeeded without
/// backup / reset failed (Err).
#[derive(Debug, Clone)]
pub struct ResetResult {
    pub reset: bool,
    pub backup_created: bool,
    pub backup_path: Option<PathBuf>,
}

/// Write config to disk WITHOUT checking the quarantine state. Used by
/// `Runtime::save_config` (which does the check) and by tests.
pub fn save_config_unchecked(path: &Path, config: &AppConfig) -> Result<(), String> {
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

fn recent_operation_for_event(
    event: &str,
    tool_name: Option<&str>,
    provider: &str,
    cwd: &str,
    session_id: &str,
    ts: u64,
) -> Option<RecentOperation> {
    let tool = match event {
        "PreToolUse" => tool_name?.trim(),
        "SubagentStart" => "Task",
        _ => return None,
    };
    if tool.is_empty() {
        return None;
    }
    Some(RecentOperation {
        tool: tool.chars().take(128).collect(),
        icon: tool_icon(tool).into(),
        detail: tool.chars().take(128).collect(),
        project: project_name(cwd, session_id),
        provider: provider.chars().take(32).collect(),
        ts,
    })
}

fn tool_icon(tool: &str) -> &'static str {
    match tool {
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => "📝",
        "Read" => "📖",
        "Bash" | "Exec" | "exec_command" => "⚙️",
        "Grep" | "Glob" => "🔍",
        "WebSearch" | "WebFetch" => "🌐",
        "Task" | "Agent" => "🤖",
        "TodoWrite" | "TaskCreate" | "TaskUpdate" | "TaskList" | "TaskGet" => "✅",
        _ => "🔧",
    }
}

pub(crate) fn project_name(cwd: &str, id: &str) -> String {
    Path::new(cwd)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| id.get(..id.len().min(8)).unwrap_or(id))
        .to_string()
}

#[cfg(test)]
mod recent_operation_tests {
    use super::*;

    #[test]
    fn records_only_real_operation_events() {
        let op = recent_operation_for_event(
            "PreToolUse",
            Some("Read"),
            "claude",
            "/tmp/demo",
            "session",
            42,
        )
        .expect("operation");
        assert_eq!(op.icon, "📖");
        assert_eq!(op.project, "demo");
        assert!(recent_operation_for_event(
            "PostToolUse",
            Some("Read"),
            "claude",
            "/tmp/demo",
            "session",
            43,
        )
        .is_none());
    }
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
            todos: Vec::new(),
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

    #[test]
    fn task_list_reads_successful_post_tool_response() {
        let body = json!({
            "tool_input": {},
            "tool_response": {
                "tasks": [
                    {"id":"1","subject":"Audit parser","status":"in_progress"},
                    {"id":"2","subject":"Ship tests","status":"completed"}
                ]
            }
        });
        let items = extract_todo_snapshot(&body, Some("TaskList"), "PostToolUse").unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id.as_deref(), Some("1"));
        assert_eq!(items[0].content, "Audit parser");
        assert_eq!(items[0].status, "in_progress");
        assert!(extract_todo_snapshot(&body, Some("TaskList"), "PreToolUse").is_none());
    }

    #[test]
    fn task_lifecycle_is_id_aware_and_supports_delete() {
        let create = json!({
            "tool_input": {"subject":"Implement HUD","description":"full body"},
            "tool_response": {"task":{"id":"task-7","subject":"Implement HUD"}}
        });
        let mut todos = Vec::new();
        apply_todo_patch(
            &mut todos,
            extract_todo_patch(&create, Some("TaskCreate"), "PostToolUse").unwrap(),
        );
        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].id.as_deref(), Some("task-7"));

        let update = json!({
            "tool_input": {"taskId":"task-7","status":"completed"},
            "tool_response": {"success":true,"taskId":"task-7"}
        });
        apply_todo_patch(
            &mut todos,
            extract_todo_patch(&update, Some("TaskUpdate"), "PostToolUse").unwrap(),
        );
        assert_eq!(todos[0].status, "completed");

        let delete = json!({
            "tool_input": {"taskId":"task-7","status":"deleted"},
            "tool_response": {"success":true,"taskId":"task-7"}
        });
        apply_todo_patch(
            &mut todos,
            extract_todo_patch(&delete, Some("TaskUpdate"), "PostToolUse").unwrap(),
        );
        assert!(todos.is_empty());
    }
}
