use crate::diagnostic_control::DiagnosticControl;
use crate::diagnostic_io::drain_bounded;
use crate::hook_install;
use crate::model::{home_dir, AppState, Point};
use crate::platform;
use serde_json::{json, Value};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, State};


fn pet_label_for_agent(agent: Option<&str>) -> &'static str {
    if agent == Some("codex") { "pet-codex" } else { "pet" }
}

pub(crate) fn sync_pet_windows(app: &AppHandle, config: &crate::model::AppConfig) {
    let hidden = config.mode == "hidePet";
    if let Some(window) = app.get_webview_window("pet") {
        let _ = if hidden { window.hide() } else { window.show() };
    }
    if let Some(window) = app.get_webview_window("pet-codex") {
        let _ = if !hidden && config.pet_mode == "duo" {
            window.show()
        } else {
            window.hide()
        };
    }
}

fn emit_config(app: &AppHandle, state: &AppState) {
    let config = state.runtime.config_view();
    let _ = app.emit("pet:config", config.clone());
    let _ = app.emit("panel:config", config);
}

/// User-initiated permission decisions need immediate UI feedback. Stats
/// revisioning and coalescer timestamps are owned by http_server so there is
/// only one broadcast implementation to keep correct.
fn emit_stats_now(app: &AppHandle, state: &AppState) {
    crate::http_server::emit_stats_now(app, &state.runtime);
}

fn emit_price(app: &AppHandle, state: &AppState) {
    let _ = app.emit("panel:price", state.runtime.price_info());
}

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> Value {
    state.runtime.config_view()
}

/// R44 0.5.39 (roadmap v5 §2): return the current config quarantine state.
/// The UI uses this to decide whether to show the recovery page:
///   - healthy / notFound → normal UI
///   - parseError / unreadable / tooLarge / schemaTooNew → recovery page
///     with "backup and reset" button calling `backup_and_reset_config`.
#[tauri::command]
pub fn get_config_state(state: State<'_, AppState>) -> Value {
    let cs = state.runtime.config_state();
    let (label, message) = match &cs {
        crate::model::ConfigState::Healthy => ("healthy", None),
        crate::model::ConfigState::NotFound => ("notFound", None),
        crate::model::ConfigState::ParseError { message } => ("parseError", Some(message.clone())),
        crate::model::ConfigState::Unreadable { message } => ("unreadable", Some(message.clone())),
        crate::model::ConfigState::TooLarge { size } => {
            ("tooLarge", Some(format!("file is {} bytes", size)))
        }
        crate::model::ConfigState::SchemaTooNew { version } => (
            "schemaTooNew",
            Some(format!(
                "schema version {} is newer than this build supports",
                version
            )),
        ),
    };
    json!({
        "state": label,
        "quarantined": cs.is_quarantined(),
        "writesAllowed": cs.writes_allowed(),
        "message": message,
    })
}

/// R44 0.5.39 (roadmap v5 §2): "backup-then-reset" recovery. Backs up the
/// corrupt config to `.config.re-llmpet-bak-<ts>.json`, clears the quarantine
/// state, and writes defaults. Returns the backup path so the UI can tell
/// the user where their old config was preserved.
#[tauri::command]
pub fn backup_and_reset_config(state: State<'_, AppState>) -> Result<Value, String> {
    let result = state.runtime.backup_and_reset_config()?;
    state.runtime.write_log(
        "config",
        &format!(
            "backup_and_reset_config: reset={}, backup_created={}, backup_path={:?}",
            result.reset, result.backup_created, result.backup_path
        ),
    );
    Ok(json!({
        "reset": result.reset,
        "backupCreated": result.backup_created,
        "backupPath": result.backup_path.map(|p| p.to_string_lossy().into_owned()),
        "state": "healthy",
        "message": if result.backup_created {
            "Config backed up and reset to defaults; restart the app to reload"
        } else {
            "Config reset to defaults (no backup needed — file did not exist); restart the app"
        }
    }))
}

#[tauri::command]
pub fn get_stats(state: State<'_, AppState>) -> Value {
    state.runtime.stats()
}

#[tauri::command]
pub fn get_travel(state: State<'_, AppState>) -> Value {
    state.runtime.travel.snapshot()
}

#[tauri::command]
pub fn start_travel(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    mission: Option<String>,
) -> Result<Value, String> {
    state.runtime.travel.start_project(
        app,
        state.runtime.clone(),
        session_id,
        mission.unwrap_or_else(|| "浏览项目，找出最有意思的结构、风险与下一步建议".into()),
    )
}

#[tauri::command]
pub fn start_wander(
    app: AppHandle,
    state: State<'_, AppState>,
    mission: Option<String>,
) -> Result<Value, String> {
    state.runtime.travel.start_wander(
        app,
        state.runtime.clone(),
        mission.unwrap_or_else(|| "寻找今天值得开发者关注的一个新工具或工程实践".into()),
    )
}

#[tauri::command]
pub fn cancel_travel(state: State<'_, AppState>) -> Result<Value, String> {
    state.runtime.travel.cancel()
}

#[tauri::command]
pub fn get_price_info(state: State<'_, AppState>) -> Value {
    state.runtime.price_info()
}

#[tauri::command]
pub fn refresh_model_prices(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    state.runtime.mark_price_refresh_queued();
    if let Err(error) = state.runtime.request_price_refresh() {
        state.runtime.mark_price_sync_error(&error);
        emit_price(&app, &state);
        return Err(error);
    }
    emit_price(&app, &state);
    Ok(state.runtime.price_info())
}

#[tauri::command]
pub fn set_price_auto_update(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
    refresh_hours: u64,
) -> Result<(), String> {
    state.runtime.update_config(|config| {
        config.price_auto_update = enabled;
        config.price_refresh_hours = refresh_hours.clamp(1, 168);
    })?;
    if enabled {
        state.runtime.mark_price_refresh_queued();
        if let Err(error) = state.runtime.request_price_refresh() {
            state.runtime.mark_price_sync_error(&error);
            emit_config(&app, &state);
            emit_price(&app, &state);
            return Err(error);
        }
    } else {
        state.runtime.mark_price_auto_disabled();
    }
    emit_config(&app, &state);
    emit_price(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn set_language(
    app: AppHandle,
    state: State<'_, AppState>,
    lang: String,
) -> Result<(), String> {
    state.runtime.update_config(|config| config.lang = lang)?;
    emit_config(&app, &state);
    // R11 (2026-07-30): rebuild the native tray menu so OS-rendered labels
    // track the renderer language switch. The tray is the only native
    // surface that holds hard-coded text; refresh_tray_menu reads the new
    // lang from AppState and calls TrayIcon::set_menu.
    crate::refresh_tray_menu(&app);
    Ok(())
}

#[tauri::command]
pub fn set_mode(app: AppHandle, state: State<'_, AppState>, mode: String) -> Result<(), String> {
    // R14 (2026-07-30): validate mode before persisting so an unknown value
    // cannot sneak into config. sanitize() would also clamp it, but emitting
    // a clear error here helps the tray handler log the failure.
    let mode = match mode.as_str() {
        "pet" | "panel" | "menubar" | "hidePet" => mode,
        other => return Err(format!("unsupported mode: {other}")),
    };
    state
        .runtime
        .update_config(|config| config.mode = mode.clone())?;
    // R14: window side-effect. "hidePet" hides the pet window so the user
    // gets a tray-only experience (the upstream Electron "menubar" mode
    // equivalent — Tauri has no native menubar). "pet" and "panel" both
    // show the pet window again. The panel window is controlled separately
    // by open_panel/close_panel and is not touched here.
    let config = state.runtime.config();
    sync_pet_windows(&app, &config);
    if mode != "hidePet" {
        if let Some(window) = app.get_webview_window("pet") {
            let _ = window.set_focus();
        }
    }
    emit_config(&app, &state);
    Ok(())
}

/// R13 (2026-07-30): tray-driven single-provider hook uninstall. Removes
/// only the Octopus-owned hook block for the given provider, leaving the
/// user's own config and other providers intact. Mirrors the upstream
/// Electron tray's `tray.uninstallHook` action.
/// R22 (2026-07-30): if provider is "all", clean ALL providers and clear
/// config.providers so the user starts fresh.
///
/// R44 0.5.39 (roadmap v5 §3+§4): both single-provider and "all" paths
/// now call the same `uninstall_provider_hooks` pipeline which returns
/// `CleanupResult` (replacing `Result<PathBuf, String>`). The bulk path
/// no longer maintains a separate weak-logic loop — it iterates the same
/// pipeline and aggregates results.
#[tauri::command]
pub fn uninstall_hooks(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: String,
) -> Result<Value, String> {
    let provider = provider.trim().to_lowercase();
    let all_providers = ["claude", "codewhale", "codex", "opencode", "aider"];

    // Helper: run the cleanup pipeline for one provider and return its
    // JSON result object. Used by both single-provider and bulk paths.
    let run_one = |id: &str| -> (Value, bool, Option<String>) {
        // R44 Phase 0D (audit fix C9+C10): snapshot receipt + compute
        // R44 0.5.40 (Roadmap v6 P0-06): drift is now an enum, not a bool.
        // The 0.5.39 version collapsed "no receipt", "receipt missing
        // path/sig", and "file unreadable" all to `false`, hiding the
        // reason from the UI. The new DriftStatus enum distinguishes:
        //   unchanged — file hash matches receipt
        //   changed   — file hash differs from receipt
        //   missing   — file doesn't exist (was it deleted manually?)
        //   unreadable — file exists but can't be read
        //   noReceipt — no install receipt for this provider
        //   invalidReceipt — receipt exists but lacks path/signature
        let prior_receipt = crate::hook_install::read_install_receipts()
            .get(id)
            .cloned();
        let drift_status = match &prior_receipt {
            None => "noReceipt",
            Some(r) => {
                let path_str = r.get("path").and_then(Value::as_str);
                let receipt_sig = r.get("drift_signature").and_then(Value::as_str);
                match (path_str, receipt_sig) {
                    (None, _) | (_, None) => "invalidReceipt",
                    (Some(p), Some(saved)) => {
                        match crate::hook_install::current_drift_signature(Path::new(p)) {
                            None => {
                                // current_drift_signature returns None when the file
                                // can't be read. Distinguish "missing" from "unreadable"
                                // by checking existence.
                                if Path::new(p).exists() {
                                    "unreadable"
                                } else {
                                    "missing"
                                }
                            }
                            Some(current) if current == saved => "unchanged",
                            Some(_) => "changed",
                        }
                    }
                }
            }
        };
        let drift_detected = drift_status == "changed";
        // R44 0.5.41: receipt-driven uninstall. If the prior receipt
        // recorded a path, pass it to the cleanup pipeline so it cleans
        // up the ORIGINAL install location (not the env-var-derived one).
        // This fixes the OpenCode/CodeWhale env-var drift bug where
        // OPENCODE_CONFIG_DIR changed between install and uninstall.
        let receipt_path = prior_receipt
            .as_ref()
            .and_then(|r| r.get("path"))
            .and_then(Value::as_str)
            .map(Path::new);
        let cleanup = match receipt_path {
            Some(p) => crate::hook_install::uninstall_provider_hooks_with_path(id, p),
            None => crate::hook_install::uninstall_provider_hooks(id),
        };
        let mut result_json = cleanup.to_json();
        if let Some(obj) = result_json.as_object_mut() {
            obj.insert("provider".into(), json!(id));
            obj.insert("driftDetected".into(), json!(drift_detected));
            obj.insert("driftStatus".into(), json!(drift_status));
            if let Some(r) = &prior_receipt {
                obj.insert("priorReceipt".into(), r.clone());
                if let Some(ts) = r.get("installed_at").and_then(Value::as_u64) {
                    obj.insert("installedAt".into(), json!(ts));
                }
                if let Some(bp) = r.get("backup_path").and_then(Value::as_str) {
                    obj.insert("backupPath".into(), json!(bp));
                }
            }
        }
        let is_clean = cleanup.is_clean();
        let failure_msg = if cleanup.is_hard_failure() {
            Some(format!("{}: {:?}", id, cleanup))
        } else {
            None
        };
        (result_json, is_clean, failure_msg)
    };

    // Determine which providers to process.
    let targets: Vec<&str> = if provider == "all" {
        all_providers.to_vec()
    } else if all_providers.contains(&provider.as_str()) {
        vec![provider.as_str()]
    } else {
        return Err(format!("unsupported provider: {provider}"));
    };

    // Run the pipeline for each target.
    let mut results = Vec::new();
    let mut failures = Vec::new();
    let mut all_clean = true;
    for id in &targets {
        let (result_json, is_clean, failure_msg) = run_one(id);
        if !is_clean {
            all_clean = false;
        }
        if let Some(msg) = failure_msg {
            failures.push(msg);
        }
        state.runtime.write_log(
            "tray",
            &format!("uninstall_hooks('{}'): {:?}", id, result_json),
        );
        results.push(result_json);
    }

    // R44 (audit Roadmap v2 P0-01): ALWAYS clear config.providers for
    // "all" (the user asked to start fresh). For single-provider, only
    // remove that one provider from the selection.
    if provider == "all" {
        state.runtime.update_config(|config| {
            config.providers.clear();
        })?;
    } else {
        state.runtime.update_config(|config| {
            config.providers.retain(|p| p != &provider);
        })?;
    }
    // CRITICAL: do NOT call resync_current() here. The old code did:
    //   1. Delete hooks for each provider
    //   2. Call resync_current()
    //   3. resync_current() reads config.providers (not yet cleared)
    //   4. Calls sync_enabled() which RE-INSTALLS the hooks we just deleted
    // This created a "delete then reinstall" loop.
    emit_config(&app, &state);

    // Build the response. For "all", include the bulk fields. For
    // single-provider, include the receipt-provenance fields at top level
    // (for backward compat with the 0.5.38 frontend expectation).
    if provider == "all" {
        let message = if all_clean {
            "All Octopus hooks removed; config.providers cleared".to_string()
        } else {
            format!(
                "Provider selection cleared. Some external hooks could not be fully verified: {}",
                failures.join("；")
            )
        };
        Ok(json!({
            "provider": "all",
            "selectionCleared": true,
            "allHooksVerifiedAbsent": all_clean,
            "allHooksRemoved": all_clean, // backward compat alias
            "results": results,
            "failures": failures,
            "message": message,
        }))
    } else {
        // Single-provider: unwrap the single result and surface its fields.
        let single = results.into_iter().next().unwrap_or(json!({}));
        let drift_detected = single
            .get("driftDetected")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let prior_receipt = single.get("priorReceipt").cloned();
        let installed_at = single.get("installedAt").and_then(Value::as_u64);
        let backup_path = single
            .get("backupPath")
            .and_then(Value::as_str)
            .map(|s| s.to_string());
        let path = single
            .get("path")
            .and_then(Value::as_str)
            .map(|s| s.to_string())
            .unwrap_or_default();
        let status = single
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        Ok(json!({
            "provider": provider,
            "path": path,
            "status": status,
            "selectionCleared": true,
            "priorReceipt": prior_receipt,
            "installedAt": installed_at,
            "backupPath": backup_path,
            "driftDetected": drift_detected,
            "cleanupResult": single,
            "message": if drift_detected {
                "Octopus hooks removed; WARNING: config was modified after install — verify backup"
            } else if status == "unowned" {
                "File exists but is not owned by Octopus; left intact"
            } else if status == "notFound" {
                "No Octopus hooks found for this provider; nothing to remove"
            } else if status == "residue" {
                "Partial cleanup; residue remains — see cleanupResult.detail"
            } else {
                "Octopus hooks removed for this provider; user config preserved"
            }
        }))
    }
}

/// R44 Phase 0D: return the latest install receipt per provider. Used by
/// the frontend's "Uninstall" confirmation dialog to show the user:
///   "你于 2026-08-03 14:23 通过 Octopus 0.5.38 安装了 Claude hooks。
///    备份文件：~/.claude/.settings.re-llmpet-bak-1722700000000.json。
///    配置漂移：未检测到 / 已检测到（用户或第三方工具修改过）。"
///
/// Returns a JSON object keyed by provider id. Each value is the receipt
/// JSON written by `write_install_receipt`. Providers without receipts
/// (never installed by 0.5.38+, or receipts pruned) are absent from the
/// map — the frontend treats absent key as "no provenance info".
#[tauri::command]
pub fn get_install_receipts() -> Value {
    let map = crate::hook_install::read_install_receipts();
    // Convert Map<String, Value> to a JSON object Value.
    Value::Object(map.into_iter().collect())
}

#[tauri::command]
pub fn set_skin(
    app: AppHandle,
    state: State<'_, AppState>,
    skin: String,
    agent: Option<String>,
) -> Result<(), String> {
    state.runtime.update_config(|config| {
        if agent.as_deref() == Some("codex") {
            config.skin_codex = skin;
        } else {
            config.skin = skin;
        }
    })?;
    emit_config(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn set_pet_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    pet_mode: String,
) -> Result<(), String> {
    if !matches!(pet_mode.as_str(), "single" | "duo") {
        return Err(format!("unsupported pet mode: {pet_mode}"));
    }
    let config = state
        .runtime
        .update_config(|config| config.pet_mode = pet_mode.clone())?;
    sync_pet_windows(&app, &config);
    emit_config(&app, &state);
    Ok(())
}

/// R19 (2026-07-30): persist session list pin/archive prefs. The renderer
/// sends the full pinned + archived session-id lists; we replace the
/// config fields atomically. Mirrors the upstream Electron
/// `set-session-prefs` IPC. Session ids are bounded to 256 chars and
/// deduplicated; archived ids that are also pinned are dropped from
/// archived (pin wins).
#[tauri::command]
pub fn set_session_prefs(
    app: AppHandle,
    state: State<'_, AppState>,
    pinned: Vec<String>,
    archived: Vec<String>,
) -> Result<(), String> {
    fn sanitize_ids(ids: Vec<String>) -> Vec<String> {
        let mut seen = std::collections::HashSet::new();
        ids.into_iter()
            .map(|s| s.trim().chars().take(256).collect::<String>())
            .filter(|s| !s.is_empty() && seen.insert(s.clone()))
            .collect()
    }
    let pinned_clean = sanitize_ids(pinned);
    let pinned_set: std::collections::HashSet<&str> =
        pinned_clean.iter().map(String::as_str).collect();
    let archived_clean = sanitize_ids(archived)
        .into_iter()
        .filter(|id| !pinned_set.contains(id.as_str()))
        .collect::<Vec<_>>();
    state.runtime.update_config(|config| {
        config.pinned_sessions = pinned_clean;
        config.archived_sessions = archived_clean;
    })?;
    emit_config(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn set_budget(app: AppHandle, state: State<'_, AppState>, value: f64) -> Result<(), String> {
    state
        .runtime
        .update_config(|config| config.budget5h = value)?;
    emit_config(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn set_currency(
    app: AppHandle,
    state: State<'_, AppState>,
    currency: String,
) -> Result<(), String> {
    state
        .runtime
        .update_config(|config| config.currency = currency)?;
    emit_config(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn toggle_mute(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state
        .runtime
        .update_config(|config| config.muted = !config.muted)?;
    emit_config(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn set_providers(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<Value, String> {
    // R34 (2026-07-31): return structured per-provider result instead of Ok(()).
    //
    // R35.2 (2026-07-31): the 0.5.12 carpet audit (P0-2) flagged a
    // transaction-semantic error in the R34 implementation. The old code:
    //   1. update_config() — commits ids to disk + memory (SUCCESS)
    //   2. resync_current() — installs/uninstalls hooks (may partially fail)
    //   3. emit_config() — broadcasts the new config
    //   4. If ANY hook failed → return Err(errors)
    //
    // The frontend's .catch() then reverted the checkbox, but the config
    // was ALREADY committed. Result: disk/memory say "opencode enabled"
    // but the UI shows it disabled, and on next restart the checkbox
    // jumps back to enabled. This is a disk/memory/UI split-brain.
    //
    // R35.2 fix: separate "selected persistence" from "hook installation".
    // The user's selection is always saved successfully (step 1 commits it).
    // Hook installation results are returned as per-provider status, NOT as
    // a top-level Err. The Promise resolves with:
    //   {
    //     "selectedSaved": true,          // selection persisted
    //     "selected": ["opencode"],       // what the user chose
    //     "hookResults": [                // per-provider install outcome
    //       { "id": "opencode", "installed": false, "state": "error",
    //         "retryable": true, "message": "..." }
    //     ],
    //     "allHooksOk": false,            // convenience: did all hooks succeed?
    //     "errors": ["opencode: ..."]     // convenience: human-readable errors
    //   }
    //
    // The frontend keeps the checkbox checked (matching disk) and shows
    // "已启用，但 hook 安装失败" for providers whose hooks failed. This
    // matches the audit's recommended "enabled vs installed" split.
    //
    // We still emit a pet:event for inline error display, but it's now
    // informational (not a rejection). The resync_current() Err path
    // (runtime metadata unavailable) is a genuine setup failure that DOES
    // reject — that's not a hook-install partial failure.
    state
        .runtime
        .update_config(|config| config.providers = ids.clone())?;
    // R38.1 (2026-08-01): the 0.5.16 full audit (P1-1) flagged that
    // resync_current()? could top-level reject AFTER config was committed,
    // causing the frontend to revert the checkbox while disk/memory had
    // the new selection. Now we catch the error and return it as a
    // structured field instead of rejecting the Promise.
    let (statuses, infra_error) = match hook_install::resync_current(&state.runtime) {
        Ok(s) => (s, None),
        Err(e) => (Vec::new(), Some(e)),
    };
    emit_config(&app, &state);

    let providers: Vec<Value> = statuses
        .iter()
        .map(|s| {
            let selected = ids.iter().any(|id| id == &s.id);
            // R35.2: retryable = true for hook-install errors. The user
            // can fix the external config and retry without toggling the
            // checkbox off/on. (A full retry command is R36; for now the
            // user can re-save the same selection to re-trigger resync.)
            let retryable = s.state == "error";
            json!({
                "id": s.id,
                "selected": selected,
                "installed": s.installed,
                "state": s.state,
                "message": s.message,
                "path": s.path,
                "retryable": retryable,
            })
        })
        .collect();
    let errors: Vec<String> = statuses
        .iter()
        .filter(|s| s.state == "error")
        .map(|s| format!("{}: {}", s.id, s.message))
        .collect();
    let all_hooks_ok = errors.is_empty();

    // R35.2: informational pet:event for inline error display. No longer
    // a rejection — the Promise resolves so the frontend keeps the
    // checkbox in sync with the committed config.
    if !all_hooks_ok {
        let _ = app.emit(
            "pet:event",
            json!({"kind":"error","text":errors.join("；")}),
        );
    }

    Ok(json!({
        "selectedSaved": true,
        "allHooksOk": all_hooks_ok && infra_error.is_none(),
        "selected": ids,
        "hookResults": providers,
        "errors": errors,
        "infrastructureError": infra_error,
    }))
}

/// Toggle automatic macOS territory patrol. Enabling performs an immediate
/// real patrol, then the background worker repeats every 15 seconds while the
/// UI is not busy. On other platforms the command remains safe and reports the
/// feature boundary honestly.
#[tauri::command]
pub fn territory_toggle_auto(
    app: AppHandle,
    state: State<'_, AppState>,
    platform_state: State<'_, Arc<platform::PlatformState>>,
) -> Result<Value, String> {
    let config = state
        .runtime
        .update_config(|config| config.territory = !config.territory)?;
    emit_config(&app, &state);
    if !config.territory {
        let result = json!({"enabled":false});
        let _ = app.emit("pet:event", json!({"kind":"say","text":"领地模式已关闭。"}));
        return Ok(result);
    }
    if platform_state.is_ui_busy() {
        return Ok(json!({"enabled":true,"deferred":true}));
    }
    let mut result = crate::territory::run_now(&app, &state.runtime)?;
    if let Some(object) = result.as_object_mut() {
        object.insert("enabled".into(), json!(true));
    }
    Ok(result)
}

#[tauri::command]
pub fn territory_run_now(
    app: AppHandle,
    state: State<'_, AppState>,
    platform_state: State<'_, Arc<platform::PlatformState>>,
) -> Result<Value, String> {
    if platform_state.is_ui_busy() {
        return Ok(json!({"deferred":true,"message":"UI is busy"}));
    }
    crate::territory::run_now(&app, &state.runtime)
}

const PANEL_DEFAULT_WIDTH: f64 = 560.0;
const PANEL_DEFAULT_HEIGHT: f64 = 720.0;
const PANEL_MIN_WIDTH: f64 = 420.0;
const PANEL_MIN_HEIGHT: f64 = 320.0;
const PANEL_WORK_AREA_MARGIN: f64 = 24.0;

#[derive(Clone, Copy)]
enum PanelPlacement {
    CenterOnPet,
    PreserveCurrentCenter,
}

fn fit_panel(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    requested_height: Option<f64>,
    placement: PanelPlacement,
) -> Result<[f64; 2], String> {
    // Opening is anchored to the pet's display. Subsequent content-fit calls
    // use the panel's current display and preserve its center so a user move
    // is not undone by the next stats render.
    let pet_monitor = app
        .get_webview_window("pet")
        .and_then(|pet| pet.current_monitor().ok().flatten());
    let panel_monitor = window.current_monitor().ok().flatten();
    let monitor = match placement {
        PanelPlacement::CenterOnPet => pet_monitor.or(panel_monitor),
        PanelPlacement::PreserveCurrentCenter => panel_monitor.or(pet_monitor),
    }
    .or(window
        .primary_monitor()
        .map_err(|error| error.to_string())?)
    .ok_or("monitor information unavailable")?;

    let scale = monitor.scale_factor().max(0.1);
    let work = monitor.work_area();
    let work_width = f64::from(work.size.width) / scale;
    let work_height = f64::from(work.size.height) / scale;
    let max_width = (work_width - PANEL_WORK_AREA_MARGIN * 2.0).max(1.0);
    let max_height = (work_height - PANEL_WORK_AREA_MARGIN * 2.0).max(1.0);

    let current_height = window
        .outer_size()
        .map(|size| f64::from(size.height) / scale)
        .unwrap_or(PANEL_DEFAULT_HEIGHT);
    let desired_height = requested_height
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(current_height);

    let logical_width = PANEL_DEFAULT_WIDTH
        .min(max_width)
        .max(PANEL_MIN_WIDTH.min(max_width));
    let logical_height = desired_height
        .min(PANEL_DEFAULT_HEIGHT)
        .min(max_height)
        .max(PANEL_MIN_HEIGHT.min(max_height));
    let physical_width = logical_to_physical(logical_width, scale);
    let physical_height = logical_to_physical(logical_height, scale);

    let centered_x =
        i64::from(work.position.x) + (i64::from(work.size.width) - i64::from(physical_width)) / 2;
    let centered_y =
        i64::from(work.position.y) + (i64::from(work.size.height) - i64::from(physical_height)) / 2;
    let (candidate_x, candidate_y) = match placement {
        PanelPlacement::CenterOnPet => (centered_x, centered_y),
        PanelPlacement::PreserveCurrentCenter => {
            match (window.outer_position(), window.outer_size()) {
                (Ok(position), Ok(size)) => (
                    i64::from(position.x) + (i64::from(size.width) - i64::from(physical_width)) / 2,
                    i64::from(position.y)
                        + (i64::from(size.height) - i64::from(physical_height)) / 2,
                ),
                _ => (centered_x, centered_y),
            }
        }
    };

    let margin = i64::from(logical_to_physical(PANEL_WORK_AREA_MARGIN, scale));
    let min_x = i64::from(work.position.x) + margin;
    let min_y = i64::from(work.position.y) + margin;
    let max_x = (i64::from(work.position.x) + i64::from(work.size.width)
        - margin
        - i64::from(physical_width))
    .max(min_x);
    let max_y = (i64::from(work.position.y) + i64::from(work.size.height)
        - margin
        - i64::from(physical_height))
    .max(min_y);
    let x = candidate_x.clamp(min_x, max_x);
    let y = candidate_y.clamp(min_y, max_y);

    window
        .set_size(Size::Physical(PhysicalSize::new(
            physical_width,
            physical_height,
        )))
        .map_err(|error| error.to_string())?;
    window
        .set_position(Position::Physical(PhysicalPosition::new(
            x.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
            y.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        )))
        .map_err(|error| error.to_string())?;
    Ok([logical_width, logical_height])
}

fn fit_and_center_panel(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    requested_height: Option<f64>,
) -> Result<[f64; 2], String> {
    fit_panel(app, window, requested_height, PanelPlacement::CenterOnPet)
}

#[tauri::command]
pub fn open_panel(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("panel")
        .ok_or("panel window missing")?;
    fit_and_center_panel(&app, &window, None)?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    // The panel WebView survives hide/show. Emit an explicit lifecycle event
    // after the native window is visible so the renderer can begin a fresh
    // auto-fit cycle without rebuilding its subscriptions.
    let _ = app.emit("panel:shown", ());
    Ok(())
}

#[tauri::command]
pub fn close_panel(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("panel")
        .ok_or("panel window missing")?;
    window.hide().map_err(|e| e.to_string())?;
    // Every hide path shares this lifecycle signal, allowing the renderer to
    // stop hidden-window rendering regardless of whether the close button,
    // tray or native command initiated the transition.
    let _ = app.emit("panel:hidden", ());
    Ok(())
}

#[tauri::command]
pub fn get_win_pos(app: AppHandle, agent: Option<String>) -> Result<[i32; 2], String> {
    let label = pet_label_for_agent(agent.as_deref());
    let window = app.get_webview_window(label).ok_or("pet window missing")?;
    // R22 (2026-07-30): return LOGICAL position so the renderer's screenX
    // delta (also logical) can be added directly without DPI mismatch.
    // The old code returned outer_position (physical), which caused the pet
    // to move at a different speed than the mouse on scaled displays.
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let logical_x = (position.x as f64 / scale).round() as i32;
    let logical_y = (position.y as f64 / scale).round() as i32;
    Ok([logical_x, logical_y])
}

#[tauri::command]
pub fn set_win_pos(app: AppHandle, x: i32, y: i32, agent: Option<String>) -> Result<(), String> {
    // R22 (2026-07-30): accept LOGICAL position from the renderer (which
    // uses e.screenX — CSS/logical pixels) and convert to physical internally.
    // The old code used PhysicalPosition directly, causing DPI mismatch on
    // scaled displays (pet moved slower/faster than mouse).
    let label = pet_label_for_agent(agent.as_deref());
    let window = app.get_webview_window(label).ok_or("pet window missing")?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let physical_x = (x as f64 * scale).round() as i32;
    let physical_y = (y as f64 * scale).round() as i32;
    window
        .set_position(Position::Physical(PhysicalPosition::new(
            physical_x, physical_y,
        )))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn commit_win_pos(
    app: AppHandle,
    state: State<'_, AppState>,
    agent: Option<String>,
) -> Result<[i32; 2], String> {
    let label = pet_label_for_agent(agent.as_deref());
    let window = app.get_webview_window(label).ok_or("pet window missing")?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);
    // R22: store and return LOGICAL position for consistency with get_win_pos.
    let logical_x = (position.x as f64 / scale).round() as i32;
    let logical_y = (position.y as f64 / scale).round() as i32;
    state.runtime.update_config(|config| {
        let point = Some(Point {
            x: logical_x,
            y: logical_y,
        });
        if agent.as_deref() == Some("codex") {
            config.pet_position_codex = point;
        } else {
            config.pet_position = point;
        }
    })?;
    emit_config(&app, &state);
    Ok([logical_x, logical_y])
}

#[tauri::command]
pub fn set_ignore_mouse(
    platform_state: State<'_, Arc<platform::PlatformState>>,
    ignore: bool,
    agent: Option<String>,
) -> Result<(), String> {
    // Electron supported `forward: true`, allowing ignored windows to keep
    // receiving mousemove events. Tauri intentionally exposes only a strict
    // ignore toggle, so the native cursor hit-test loop owns the applied state.
    platform_state.request_mouse_ignore(pet_label_for_agent(agent.as_deref()), ignore);
    Ok(())
}

#[tauri::command]
pub fn set_pet_tall(app: AppHandle, tall: bool, agent: Option<String>) -> Result<(), String> {
    set_pet_size(app, 320.0, if tall { 620.0 } else { 340.0 }, agent)
}

#[tauri::command]
pub fn set_pet_big(app: AppHandle, on: bool, agent: Option<String>) -> Result<(), String> {
    set_pet_size(
        app,
        if on { 520.0 } else { 320.0 },
        if on { 700.0 } else { 340.0 },
        agent,
    )
}

fn logical_to_physical(value: f64, scale: f64) -> u32 {
    (value * scale).round().clamp(1.0, f64::from(u32::MAX)) as u32
}

fn resize_pet_anchored(
    window: &tauri::WebviewWindow,
    width: f64,
    height: f64,
) -> Result<(), String> {
    // Renderer measurements are CSS/logical pixels. Convert them using the
    // monitor scale factor, then preserve the old bottom-centre anchor exactly
    // like upstream Electron's applyPetSize so opening a HUD does not make the
    // visible pet jump across the desktop.
    let scale = window
        .scale_factor()
        .ok()
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(1.0);
    let old_position = window.outer_position().map_err(|error| error.to_string())?;
    let old_size = window.outer_size().map_err(|error| error.to_string())?;
    let mut target_width = logical_to_physical(width, scale);
    let mut target_height = logical_to_physical(height, scale);
    let center_x = i64::from(old_position.x) + i64::from(old_size.width) / 2;
    let bottom = i64::from(old_position.y) + i64::from(old_size.height);

    let mut x = center_x - i64::from(target_width) / 2;
    let mut y = bottom - i64::from(target_height);
    if let Some(monitor) = window
        .current_monitor()
        .map_err(|error| error.to_string())?
    {
        let work = monitor.work_area();
        target_width = target_width.min(work.size.width.max(1));
        target_height = target_height.min(work.size.height.max(1));
        x = center_x - i64::from(target_width) / 2;
        y = bottom - i64::from(target_height);
        let min_x = i64::from(work.position.x);
        let min_y = i64::from(work.position.y);
        let max_x = min_x + i64::from(work.size.width) - i64::from(target_width);
        let max_y = min_y + i64::from(work.size.height) - i64::from(target_height);
        x = x.clamp(min_x, max_x.max(min_x));
        y = y.clamp(min_y, max_y.max(min_y));
    }

    window
        .set_size(Size::Physical(PhysicalSize::new(
            target_width,
            target_height,
        )))
        .map_err(|error| error.to_string())?;
    window
        .set_position(Position::Physical(PhysicalPosition::new(
            x.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
            y.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        )))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_pet_size(
    app: AppHandle,
    width: f64,
    height: f64,
    agent: Option<String>,
) -> Result<(), String> {
    let (width, height) = if width <= 0.0 || height <= 0.0 {
        (320.0, 340.0)
    } else {
        (width.clamp(240.0, 1200.0), height.clamp(240.0, 1200.0))
    };
    let label = pet_label_for_agent(agent.as_deref());
    let window = app.get_webview_window(label).ok_or("pet window missing")?;
    resize_pet_anchored(&window, width, height)
}

#[tauri::command]
pub fn set_panel_height(app: AppHandle, height: f64) -> Result<[f64; 2], String> {
    let window = app
        .get_webview_window("panel")
        .ok_or("panel window missing")?;
    fit_panel(
        &app,
        &window,
        Some(height),
        PanelPlacement::PreserveCurrentCenter,
    )
}

#[tauri::command]
pub fn focus_pet(app: AppHandle, agent: Option<String>) -> Result<(), String> {
    let label = pet_label_for_agent(agent.as_deref());
    let window = app.get_webview_window(label).ok_or("pet window missing")?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn blur_pet(_app: AppHandle) -> Result<(), String> {
    // Tauri/tao does not expose a portable "focus another app" primitive.
    // Keeping this command as a no-op preserves renderer compatibility without
    // stealing focus or synthesizing unsafe global input.
    Ok(())
}

#[tauri::command]
pub fn decide_permission(
    app: AppHandle,
    state: State<'_, AppState>,
    perm_id: String,
    behavior: Value,
) -> Result<(), String> {
    if !state.runtime.decide_value(&perm_id, &behavior)? {
        return Err("permission request no longer exists".into());
    }
    // User-initiated: bypass hook-ingestion throttling for immediate feedback.
    emit_stats_now(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn decide_permission_batch(
    app: AppHandle,
    state: State<'_, AppState>,
    perm_id: String,
    mode: String,
) -> Result<(), String> {
    if !state.runtime.decide_batch(&perm_id, &mode) {
        return Err("permission request no longer exists".into());
    }
    // User-initiated: bypass hook-ingestion throttling for immediate feedback.
    emit_stats_now(&app, &state);
    Ok(())
}

#[derive(Clone, Copy)]
struct AgentSpec {
    id: &'static str,
    title: &'static str,
    command: &'static str,
    companion: Option<&'static str>,
}

fn agent_spec(provider: &str) -> Result<AgentSpec, String> {
    match provider {
        "claude" => Ok(AgentSpec {
            id: "claude",
            title: "Claude Code",
            command: "claude",
            companion: None,
        }),
        "codewhale" => Ok(AgentSpec {
            id: "codewhale",
            title: "CodeWhale",
            command: "codewhale",
            companion: Some("codewhale-tui"),
        }),
        "codex" => Ok(AgentSpec {
            id: "codex",
            title: "Codex",
            command: "codex",
            companion: None,
        }),
        "opencode" => Ok(AgentSpec {
            id: "opencode",
            title: "OpenCode",
            command: "opencode",
            companion: None,
        }),
        "aider" => Ok(AgentSpec {
            id: "aider",
            title: "Aider",
            command: "aider",
            companion: None,
        }),
        _ => Err(format!("unsupported agent provider: {provider}")),
    }
}

fn agent_working_directory(requested: Option<&str>) -> Result<PathBuf, String> {
    if let Some(raw) = requested.map(str::trim).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(raw);
        if !path.is_dir() {
            return Err(format!(
                "agent working directory does not exist: {}",
                path.display()
            ));
        }
        return Ok(path);
    }
    if let Some(raw) = std::env::var_os("LLMPET_AGENT_CWD") {
        let path = PathBuf::from(raw);
        if path.is_dir() {
            return Ok(path);
        }
    }
    let home = home_dir();
    if home.is_dir() {
        return Ok(home);
    }
    std::env::current_dir().map_err(|e| format!("working directory unavailable: {e}"))
}

fn executable_candidates(command: &str) -> Vec<OsString> {
    #[cfg(windows)]
    {
        let lower = command.to_ascii_lowercase();
        if [".exe", ".com", ".cmd", ".bat"]
            .iter()
            .any(|suffix| lower.ends_with(suffix))
        {
            return vec![OsString::from(command)];
        }
        let extensions = std::env::var_os("PATHEXT")
            .map(|raw| {
                raw.to_string_lossy()
                    .split(';')
                    .filter(|value| !value.trim().is_empty())
                    .map(|value| value.trim().to_ascii_lowercase())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| vec![".com".into(), ".exe".into(), ".bat".into(), ".cmd".into()]);
        // R22 (2026-07-30): try extensions ONLY on Windows.
        // npm creates both "codewhale" (bash script, no extension) and
        // "codewhale.cmd" (Windows batch). The bare-name file cannot be
        // executed by wt.exe or cmd.exe directly — it causes
        // 0x800700c1 (STATUS_INVALID_IMAGE_FORMAT). By trying ONLY
        // extensioned candidates, we guarantee the correct .cmd/.exe is
        // found. On non-Windows, the bare name is still valid (POSIX
        // executables have no extension).
        #[cfg(windows)]
        {
            extensions
                .into_iter()
                .map(|extension| format!("{command}{extension}").into())
                .collect()
        }
        #[cfg(not(windows))]
        {
            let mut values = vec![OsString::from(command)];
            values.extend(
                extensions
                    .into_iter()
                    .map(|extension| format!("{command}{extension}").into()),
            );
            values
        }
    }
    #[cfg(not(windows))]
    {
        vec![OsString::from(command)]
    }
}

fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(windows)]
    {
        true
    }
}

/// R22 (2026-07-30): canonicalize a path and strip the Windows `\\?\` prefix.
/// The prefix is added by `std::fs::canonicalize` when resolving symlinks or
/// long paths. Windows Terminal (`wt.exe`) and `cmd.exe` cannot handle the
/// `\\?\` prefix for `.cmd`/`.bat` script files — they treat it as a native
/// executable and fail with `0x800700c1` (STATUS_INVALID_IMAGE_FORMAT).
/// Stripping the prefix restores compatibility with all Windows shell tools.
fn canonicalize_path(path: &Path) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(path)
        .ok()
        .or_else(|| Some(path.to_path_buf()))?;
    #[cfg(windows)]
    {
        let s = canonical.to_string_lossy();
        // R30 (2026-07-31): handle both \\?\ and \\?\UNC\ prefixes.
        // \\?\C:\path → C:\path
        // \\?\UNC\server\share → \\server\share
        if let Some(stripped) = s.strip_prefix(r"\\?\UNC\") {
            return Some(PathBuf::from(format!(r"\\{stripped}")));
        }
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            return Some(PathBuf::from(stripped));
        }
    }
    Some(canonical)
}

/// Resolve through the application's inherited PATH without invoking a shell.
/// This deliberately returns an absolute path so terminal launch never reparses
/// renderer-controlled text as a command line.
fn which(command: &str) -> Option<PathBuf> {
    let command_path = Path::new(command);
    if command_path.components().count() > 1 && is_executable_file(command_path) {
        return canonicalize_path(command_path);
    }
    let candidates = executable_candidates(command);
    if let Some(path_value) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path_value) {
            for candidate in &candidates {
                let path = directory.join(candidate);
                if is_executable_file(&path) {
                    return canonicalize_path(&path);
                }
            }
        }
    }
    #[cfg(windows)]
    if command.eq_ignore_ascii_case("codewhale") || command.eq_ignore_ascii_case("codewhale-tui") {
        let file = if command.eq_ignore_ascii_case("codewhale") {
            "codewhale.exe"
        } else {
            "codewhale-tui.exe"
        };
        let mut bases = Vec::new();
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            bases.push(
                PathBuf::from(local)
                    .join("Programs")
                    .join("CodeWhale")
                    .join("bin"),
            );
        }
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            bases.push(PathBuf::from(profile).join("bin"));
        }
        for base in bases {
            let path = base.join(file);
            if is_executable_file(&path) {
                return canonicalize_path(&path);
            }
        }
    }
    None
}

fn companion_for(spec: AgentSpec, executable: &Path) -> Option<PathBuf> {
    let name = spec.companion?;
    #[cfg(windows)]
    let sibling_name = format!("{name}.exe");
    #[cfg(not(windows))]
    let sibling_name = name.to_string();
    executable
        .parent()
        .map(|parent| parent.join(&sibling_name))
        .filter(|path| is_executable_file(path))
        .or_else(|| which(name))
}

fn resolve_agent(spec: AgentSpec) -> Result<PathBuf, String> {
    let executable = which(spec.command).ok_or_else(|| {
        format!(
            "{} CLI not found in the desktop application's PATH; restart Octopus after installing it",
            spec.title
        )
    })?;
    if spec.id == "codewhale" && companion_for(spec, &executable).is_none() {
        return Err(
            "CodeWhale installation is incomplete (MISSING_COMPANION_BINARY): codewhale-tui is missing or is a different installation. Reinstall the matched CodeWhale bundle, then restart Octopus."
                .into(),
        );
    }
    Ok(executable)
}

fn redact_sensitive_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    let sensitive_keys = [
        "api_key",
        "api-key",
        "apikey",
        "authorization",
        "access_token",
        "refresh_token",
        "client_secret",
        "password",
    ];
    if sensitive_keys.iter().any(|key| lower.contains(key)) {
        if let Some(index) = line.find(':').or_else(|| line.find('=')) {
            return format!("{}: ***", line[..index].trim_end());
        }
        return "*** redacted sensitive diagnostic line ***".into();
    }

    let mut output = Vec::new();
    for token in line.split_whitespace() {
        let normalized = token.trim_matches(|ch: char| {
            matches!(
                ch,
                '\"' | '\'' | ',' | ';' | '(' | ')' | '[' | ']' | '{' | '}'
            )
        });
        let lower_token = normalized.to_ascii_lowercase();
        let looks_secret = lower_token.starts_with("sk-")
            || lower_token.starts_with("sk_")
            || lower_token.starts_with("ds-")
            || lower_token.starts_with("bearer-")
            || (lower_token.starts_with("bearer") && normalized.len() > 12);
        output.push(if looks_secret { "***" } else { token });
    }
    output.join(" ")
}

fn redact_sensitive_json(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, child) in object.iter_mut() {
                let normalized = key.to_ascii_lowercase().replace('-', "_");
                let sensitive = matches!(
                    normalized.as_str(),
                    "authorization"
                        | "access_token"
                        | "refresh_token"
                        | "client_secret"
                        | "password"
                        | "token"
                        | "secret"
                        | "api_key_value"
                );
                if sensitive {
                    *child = Value::String("***".into());
                    continue;
                }
                // CodeWhale's doctor schema intentionally exposes only the
                // credential source under api_key. Preserve that non-secret
                // field while discarding any future credential material.
                if normalized == "api_key" {
                    let source = child
                        .get("source")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    *child = source
                        .map(|source| json!({"source": source}))
                        .unwrap_or_else(|| Value::String("***".into()));
                    continue;
                }
                redact_sensitive_json(child);
            }
        }
        Value::Array(values) => values.iter_mut().for_each(redact_sensitive_json),
        Value::String(text) => {
            let redacted = redact_sensitive_line(text);
            if redacted != *text {
                *text = redacted;
            }
        }
        _ => {}
    }
}

fn sanitized_probe_json(bytes: &[u8]) -> Option<Value> {
    let text = decode_subprocess_output(bytes);
    let mut value = serde_json::from_str::<Value>(text.trim()).ok()?;
    redact_sensitive_json(&mut value);
    Some(value)
}

fn bounded_probe_text(bytes: &[u8]) -> String {
    let filtered: String = decode_subprocess_output(bytes)
        .chars()
        .filter(|ch| !ch.is_control() || *ch == '\n' || *ch == '\t')
        .take(16_384)
        .collect();
    filtered
        .lines()
        .map(redact_sensitive_line)
        .collect::<Vec<_>>()
        .join("\n")
        .chars()
        .take(8192)
        .collect()
}

/// R35 (2026-07-31): Decode Windows subprocess stdout/stderr with the
/// fallback chain recommended by the deep-audit roadmap:
///
///   1. UTF-16 BOM (FF FE or FE FF) → UTF-16 LE/BE
///   2. Strict UTF-8 (the modern ideal; what `--json` CLIs emit)
///   3. OEM code page (cmd.exe default; CP437 on en-US, CP932 on ja, CP936 on zh)
///   4. ANSI code page (Windows-1252 on en-US, etc.)
///   5. Lossy UTF-8 (last resort, replaces undecodable bytes with U+FFFD)
///
/// Without this chain, Chinese Windows `cmd.exe` output (CP936 / GBK) would
/// hit `String::from_utf8_lossy`, which replaces every non-ASCII byte with
/// U+FFFD. The user-facing symptom in the audit screenshot was a flood of
/// "�" replacement characters in the diagnostic panel.
///
/// On non-Windows platforms this collapses to: strict UTF-8 → lossy. Unix
/// locales are normally UTF-8 already, and we have no portable way to query
/// the locale's encoding from std. The platform-specific work is gated by
/// `#[cfg(windows)]` and uses `windows-sys`'s `Win32_Globalization` API
/// (`GetOEMCP`, `GetACP`, `MultiByteToWideChar`).
fn decode_subprocess_output(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    // (1) UTF-16 BOM — some Windows tools emit UTF-16 LE.
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let utf16: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        if let Ok(text) = String::from_utf16(&utf16) {
            return text;
        }
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let utf16: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect();
        if let Ok(text) = String::from_utf16(&utf16) {
            return text;
        }
    }
    // (2) Strict UTF-8. Modern CLIs (opencode --version, codewhale doctor
    // --json, etc.) emit UTF-8 even on Windows. This fast path avoids any
    // platform-specific work in the common case.
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    // (3) and (4): Windows-only OEM/ACP fallback.
    #[cfg(windows)]
    {
        if let Some(text) = decode_windows_codepage(bytes) {
            return text;
        }
    }
    // (5) Lossy fallback. Anything we couldn't decode above becomes U+FFFD.
    // This preserves the byte length and most of the ASCII content so the
    // user still sees command names, exit codes, etc.
    String::from_utf8_lossy(bytes).into_owned()
}

/// R35 (2026-07-31): Windows-only OEM + ANSI code page decode using
/// `MultiByteToWideChar`. Returns `None` if both code pages fail (the caller
/// will then fall back to lossy UTF-8).
///
/// The function tries the OEM code page first (what `cmd.exe` uses for
/// stdout/stderr by default on Windows), then the ANSI code page (the
/// GUI/system locale). Each call to `MultiByteToWideChar` is given a
/// pre-allocated buffer sized to the worst case; on failure we move on to
/// the next code page.
#[cfg(windows)]
fn decode_windows_codepage(bytes: &[u8]) -> Option<String> {
    use windows_sys::Win32::Globalization::{
        GetACP, GetOEMCP, MultiByteToWideChar, MB_ERR_INVALID_CHARS,
    };

    fn try_codepage(codepage: u32, bytes: &[u8]) -> Option<String> {
        // MB_ERR_INVALID_CHARS makes MultiByteToWideChar fail (return 0)
        // instead of silently substituting U+0000 or skipping bytes. That
        // lets us detect "this code page is wrong" and try the next one.
        let flags = MB_ERR_INVALID_CHARS;
        // Safety: MultiByteToWideChar reads `cbMultiByte` bytes from
        // `lpMultiByteStr`. We pass the slice pointer and exact length, so
        // there is no out-of-bounds read. The function never writes to the
        // input buffer.
        //
        // Note: the 5th parameter (lpWideCharStr) is `*mut u16` per the
        // windows-sys 0.61 signature, so we pass `null_mut()` (not
        // `null()`) when querying the required buffer size.
        let needed = unsafe {
            MultiByteToWideChar(
                codepage,
                flags,
                bytes.as_ptr(),
                bytes.len() as i32,
                core::ptr::null_mut(),
                0,
            )
        };
        if needed <= 0 {
            return None;
        }
        let mut buffer = vec![0u16; needed as usize];
        let written = unsafe {
            MultiByteToWideChar(
                codepage,
                flags,
                bytes.as_ptr(),
                bytes.len() as i32,
                buffer.as_mut_ptr(),
                needed,
            )
        };
        if written <= 0 {
            return None;
        }
        buffer.truncate(written as usize);
        String::from_utf16(&buffer).ok()
    }

    // Try the OEM code page first (cmd.exe default). On en-US Windows this
    // is CP437; on zh-CN it's CP936 (GBK); on ja-JP it's CP932 (Shift-JIS).
    let oem_cp = unsafe { GetOEMCP() };
    if oem_cp != 0 {
        if let Some(text) = try_codepage(oem_cp, bytes) {
            return Some(text);
        }
    }
    // Then the system ANSI code page (Windows-1252 on en-US, CP936 on zh-CN).
    let ansi_cp = unsafe { GetACP() };
    if ansi_cp != 0 && ansi_cp != oem_cp {
        if let Some(text) = try_codepage(ansi_cp, bytes) {
            return Some(text);
        }
    }
    None
}

#[cfg(windows)]
fn cmd_quote_arg(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[cfg(windows)]
fn cmd_probe_call(path: &Path, args: &[&str]) -> String {
    let mut command_line = vec![cmd_call(path)];
    command_line.extend(args.iter().map(|value| cmd_quote_arg(value)));
    command_line.join(" ")
}

/// R35 (2026-07-31): Pass a pre-built `cmd.exe /S /C` tail to the spawned
/// process WITHOUT additional CreateProcessW quoting.
///
/// The previous code did `Command::new("cmd.exe").args(["/D","/S","/C"]).arg(tail)`.
/// `Command::arg(tail)` re-escapes `tail` per CreateProcessW rules: it wraps
/// the whole string in `"..."` and doubles internal quotes. That produced the
/// literal `\"C:\\...\\file.cmd\"` pattern the audit flagged — cmd.exe then
/// failed to invoke the .cmd shim correctly. The downstream symptom was that
/// CodeWhale/OpenCode diagnostics could not parse their own `--version`
/// output, even though the CLI itself was installed.
///
/// `CommandExt::raw_arg(tail)` appends `tail` to the command line as-is.
/// Combined with `/S /C`, cmd.exe then strips the outermost quote pair (if
/// any) from `tail` and executes the result verbatim — exactly what we want.
#[cfg(windows)]
fn append_cmd_tail(command: &mut Command, tail: String) {
    use std::os::windows::process::CommandExt;
    command.args(["/D", "/S", "/C"]).raw_arg(tail);
}

struct ProbeCapture {
    report: Value,
    json: Option<Value>,
}

struct CodeWhaleDoctorProbe {
    report: Value,
    target: Option<String>,
    surface: Option<&'static str>,
    json: Option<Value>,
    attempts: Vec<Value>,
}

fn cancelled_probe_capture() -> ProbeCapture {
    ProbeCapture {
        report: json!({
            "started": false,
            "success": false,
            "cancelled": true,
            "error": "diagnostic cancelled"
        }),
        json: None,
    }
}

/// Runs one bounded diagnostic child process. Cancellation, PID ownership and
/// worker completion all use the same state machine.
fn run_diagnostic_probe_capture(
    executable: &Path,
    args: &[&str],
    cwd: &Path,
    timeout: Duration,
    control: &DiagnosticControl,
) -> ProbeCapture {
    if control.is_cancel_requested() {
        return cancelled_probe_capture();
    }

    #[cfg(windows)]
    let mut command = if is_windows_script(executable) {
        let mut command = Command::new("cmd.exe");
        append_cmd_tail(&mut command, cmd_probe_call(executable, args));
        command
    } else {
        let mut command = Command::new(executable);
        command.args(args);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        use std::os::unix::process::CommandExt;
        let mut command = Command::new(executable);
        command.args(args).process_group(0);
        command
    };
    let mut child = match command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return ProbeCapture {
                report: json!({"started":false,"success":false,"error":error.to_string()}),
                json: None,
            }
        }
    };
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_reader = thread::spawn(move || {
        stdout
            .map(|pipe| drain_bounded(pipe, 64 * 1024).unwrap_or_default())
            .unwrap_or_default()
    });
    let stderr_reader = thread::spawn(move || {
        stderr
            .map(|pipe| drain_bounded(pipe, 64 * 1024).unwrap_or_default())
            .unwrap_or_default()
    });

    if !control.register_pid(pid) {
        let _ = kill_process_tree(pid);
        let _ = child.wait();
        let _ = stdout_reader.join();
        let _ = stderr_reader.join();
        return cancelled_probe_capture();
    }

    let started = Instant::now();
    let mut cancelled = false;
    let mut timed_out = false;
    let mut termination_error: Option<String> = None;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                control.clear_pid(pid);
                break Some(status);
            }
            Ok(None) => {}
            Err(error) => {
                if control.claim_pid_for_termination(pid) {
                    if let Err(kill_error) = kill_process_tree(pid) {
                        termination_error = Some(format!(
                            "failed to poll child process: {error}; termination failed: {kill_error}"
                        ));
                    } else {
                        termination_error = Some(format!("failed to poll child process: {error}"));
                    }
                }
                // A Child handle targets the spawned process object directly,
                // so this is safe even if a concurrent cancel already claimed
                // the numeric PID for tree termination.
                let _ = child.kill();
                break child.wait().ok();
            }
        }

        let cancellation_now = control.is_cancel_requested();
        let timeout_now = !cancellation_now && started.elapsed() >= timeout;
        cancelled |= cancellation_now;
        timed_out |= timeout_now;
        if (cancellation_now || timeout_now) && control.claim_pid_for_termination(pid) {
            if let Err(error) = kill_process_tree(pid) {
                termination_error = Some(error);
                let _ = child.kill();
            }
        }
        thread::sleep(Duration::from_millis(25));
    };
    control.clear_pid(pid);
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    let parsed_json = if cancelled || timed_out {
        None
    } else {
        sanitized_probe_json(&stdout).or_else(|| sanitized_probe_json(&stderr))
    };
    ProbeCapture {
        report: json!({
            "started": true,
            "timedOut": timed_out,
            "cancelled": cancelled,
            "success": !cancelled && status.as_ref().is_some_and(|value| value.success()),
            "exitCode": status.and_then(|value| value.code()),
            "terminationError": termination_error,
            "stdout": bounded_probe_text(&stdout),
            "stderr": bounded_probe_text(&stderr)
        }),
        json: parsed_json,
    }
}

fn run_diagnostic_probe(
    executable: &Path,
    args: &[&str],
    cwd: &Path,
    timeout: Duration,
    control: &DiagnosticControl,
) -> Value {
    run_diagnostic_probe_capture(executable, args, cwd, timeout, control).report
}

fn probe_succeeded(probe: &Value) -> bool {
    probe
        .get("started")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && !probe
            .get("timedOut")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        && probe
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

fn probe_failure_detail(probe: &Value) -> String {
    if probe
        .get("timedOut")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return "probe timed out".into();
    }
    if let Some(error) = probe.get("error").and_then(Value::as_str) {
        return error.lines().next().unwrap_or("probe failed").to_string();
    }
    for key in ["stderr", "stdout"] {
        if let Some(text) = probe.get(key).and_then(Value::as_str) {
            if let Some(line) = text.lines().find(|line| !line.trim().is_empty()) {
                return line.trim().chars().take(240).collect();
            }
        }
    }
    match probe.get("exitCode").and_then(Value::as_i64) {
        Some(code) => format!("exit code {code}"),
        None => "probe failed without an exit code".into(),
    }
}

fn probe_combined_text(probe: &Value) -> String {
    ["stdout", "stderr", "error"]
        .into_iter()
        .filter_map(|key| probe.get(key).and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

fn probe_indicates_unknown_command(probe: &Value) -> bool {
    let text = probe_combined_text(probe).to_ascii_lowercase();
    [
        "unknown command",
        "unknown subcommand",
        "unrecognized subcommand",
        "invalid subcommand",
        "unexpected argument 'doctor'",
        "unexpected argument \"doctor\"",
        "found argument 'doctor' which wasn't expected",
        "found argument \"doctor\" which wasn't expected",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

fn codewhale_doctor_probe(
    dispatcher: Option<&Path>,
    companion: Option<&Path>,
    cwd: &Path,
    control: &DiagnosticControl,
) -> CodeWhaleDoctorProbe {
    // R10 (2026-07-30): probe the matched codewhale-tui companion FIRST.
    //
    // Project docs (`docs/CODEWHALE.md`, R5 autonomous deep-dive, R5 TODO L17)
    // all define `doctor` as a TUI subcommand and forbid depending on the
    // dispatcher compatibility alias. Earlier rounds probed dispatcher first
    // and treated the companion as a fallback for command-surface drift; that
    // produced one meaningless failure per diagnostic on installs where the
    // dispatcher had not yet grown the `doctor` alias, and it contradicted the
    // docs that the same source tree shipped.
    //
    // The dispatcher is now the fallback: it is tried only when the companion
    // is missing or when the companion explicitly rejects `doctor` (unknown
    // subcommand, unexpected argument, or non-zero exit without JSON). Both
    // attempts remain visible in `doctorAttempts` so users can audit which
    // surface actually answered.
    //
    // Cross-source consistency is locked in by
    // `test/tauri-codewhale-doctor-consistency-r10-smoke.js`.
    //
    // Web cross-validation (see `docs/MIGRATION_R10_CODEWHALE_DOCTOR_ORDER_2026-07-30.md`):
    // CodeWhale's own `docs/RUNTIME_API.md` does call `codewhale doctor --json`
    // the canonical Capability endpoint. We deliberately keep companion-first
    // because (a) project-internal docs/tests/impl consistency is the
    // maintenance hazard being fixed, and (b) on any matched bundle the
    // companion is guaranteed to exist (we already enforce
    // `MISSING_COMPANION_BINARY`), so the companion probe cannot regress on
    // healthy installs. If CodeWhale ever drops `codewhale-tui doctor`, the
    // dispatcher fallback keeps diagnostics working and the decision record
    // tells the next maintainer to flip the order.
    let mut attempts = Vec::new();
    let mut companion_capture = companion.map(|path| {
        let capture = run_diagnostic_probe_capture(
            path,
            &["doctor", "--json"],
            cwd,
            Duration::from_secs(15),
            control,
        );
        attempts.push(json!({
            "surface": "companion",
            "target": path.to_string_lossy(),
            "parseableJson": capture.json.is_some(),
            "probe": capture.report.clone()
        }));
        (path, capture)
    });

    let companion_is_definitive = match companion_capture.as_ref() {
        Some((_, capture)) => capture.json.is_some() || probe_succeeded(&capture.report),
        None => false,
    };

    let should_try_dispatcher = !companion_is_definitive
        && match companion_capture.as_ref() {
            None => true,
            Some((_, capture)) => {
                probe_indicates_unknown_command(&capture.report)
                    || !capture
                        .report
                        .get("started")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
            }
        };

    if should_try_dispatcher {
        if let Some(path) = dispatcher {
            let duplicate = companion.is_some_and(|companion| companion == path);
            if !duplicate {
                let capture = run_diagnostic_probe_capture(
                    path,
                    &["doctor", "--json"],
                    cwd,
                    Duration::from_secs(15),
                    control,
                );
                attempts.push(json!({
                    "surface": "dispatcher",
                    "target": path.to_string_lossy(),
                    "parseableJson": capture.json.is_some(),
                    "probe": capture.report.clone()
                }));
                let dispatcher_is_better = capture.json.is_some()
                    || probe_succeeded(&capture.report)
                    || companion_capture.as_ref().is_some_and(|(_, companion)| {
                        probe_indicates_unknown_command(&companion.report)
                    });
                if dispatcher_is_better {
                    return CodeWhaleDoctorProbe {
                        report: capture.report,
                        target: Some(path.to_string_lossy().into_owned()),
                        surface: Some("dispatcher"),
                        json: capture.json,
                        attempts,
                    };
                }
            }
        }
    }

    if let Some((path, capture)) = companion_capture.take() {
        return CodeWhaleDoctorProbe {
            report: capture.report,
            target: Some(path.to_string_lossy().into_owned()),
            surface: Some("companion"),
            json: capture.json,
            attempts,
        };
    }

    CodeWhaleDoctorProbe {
        report: Value::Null,
        target: None,
        surface: None,
        json: None,
        attempts,
    }
}

fn numeric_version_parts(value: &str) -> Vec<u64> {
    value
        .split(['.', '-', '+'])
        .take_while(|part| part.chars().all(|ch| ch.is_ascii_digit()))
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
}

fn version_is_older(actual: &str, required: &str) -> bool {
    let mut left = numeric_version_parts(actual);
    let mut right = numeric_version_parts(required);
    let width = left.len().max(right.len());
    left.resize(width, 0);
    right.resize(width, 0);
    left < right
}

fn opencode_auth_has_entries(probe: &Value) -> bool {
    let text = probe_combined_text(probe).to_ascii_lowercase();
    !text.trim().is_empty()
        && !text.contains("0 credentials")
        && !text.contains("no credentials")
        && !text.contains("no authenticated providers")
}

fn semverish_from_probe(probe: &Value) -> Option<String> {
    ["stdout", "stderr"]
        .into_iter()
        .filter_map(|key| probe.get(key).and_then(Value::as_str))
        .flat_map(str::split_whitespace)
        .map(|value| {
            value
                .trim_matches(|ch: char| {
                    !(ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '+')
                })
                .trim_start_matches('v')
                .to_string()
        })
        .find(|value| {
            value.chars().next().is_some_and(|ch| ch.is_ascii_digit())
                && value.matches('.').count() >= 1
        })
}

fn nested_string<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    path.iter()
        .try_fold(value, |current, key| current.get(*key))
        .and_then(Value::as_str)
}

fn codewhale_doctor_summary(value: Option<&Value>) -> Value {
    let Some(report) = value else {
        return Value::Null;
    };
    let session_recovery = report
        .get("legacy_state")
        .and_then(|legacy| legacy.get("session_recovery"))
        .and_then(|recovery| {
            recovery
                .get("status")
                .and_then(Value::as_str)
                .or_else(|| recovery.as_str())
        });
    json!({
        "status": report.get("status").and_then(Value::as_str),
        "errorKind": nested_string(report, &["error", "kind"]),
        "version": report.get("version").and_then(Value::as_str),
        "configPath": report.get("config_path").and_then(Value::as_str),
        "configPresent": report.get("config_present").and_then(Value::as_bool),
        "workspace": report.get("workspace").and_then(Value::as_str),
        "apiKeySource": nested_string(report, &["api_key", "source"]),
        "provider": nested_string(report, &["capability", "resolved_provider"]),
        "model": nested_string(report, &["capability", "resolved_model"]),
        "requestPayloadMode": nested_string(report, &["capability", "request_payload_mode"]),
        "sessionRecovery": session_recovery,
    })
}

fn codewhale_config_path() -> PathBuf {
    if let Some(path) = std::env::var_os("CODEWHALE_CONFIG_PATH")
        .or_else(|| std::env::var_os("DEEPSEEK_CONFIG_PATH"))
    {
        return PathBuf::from(path);
    }
    if let Some(base) = std::env::var_os("CODEWHALE_HOME") {
        return PathBuf::from(base).join("config.toml");
    }
    let current = home_dir().join(".codewhale").join("config.toml");
    if current.exists() {
        return current;
    }
    let legacy = home_dir().join(".deepseek").join("config.toml");
    if legacy.exists() {
        return legacy;
    }
    current
}

fn codewhale_config_candidates(cwd: &Path) -> Value {
    let selected = codewhale_config_path();
    let current = home_dir().join(".codewhale").join("config.toml");
    let legacy = home_dir().join(".deepseek").join("config.toml");
    let project_current = cwd.join(".codewhale").join("config.toml");
    let project_legacy = cwd.join(".deepseek").join("config.toml");
    let explicit = std::env::var_os("CODEWHALE_CONFIG_PATH")
        .map(|path| ("CODEWHALE_CONFIG_PATH", PathBuf::from(path)))
        .or_else(|| {
            std::env::var_os("DEEPSEEK_CONFIG_PATH")
                .map(|path| ("DEEPSEEK_CONFIG_PATH", PathBuf::from(path)))
        })
        .or_else(|| {
            std::env::var_os("CODEWHALE_HOME")
                .map(|base| ("CODEWHALE_HOME", PathBuf::from(base).join("config.toml")))
        });
    let selected_source = if let Some((source, path)) = explicit.as_ref() {
        if path == &selected {
            *source
        } else {
            "explicit"
        }
    } else if selected == legacy {
        "legacy-fallback"
    } else {
        "default"
    };
    json!({
        "selected": selected.to_string_lossy(),
        "selectedSource": selected_source,
        "candidates": [
            {"kind":"current","path":current.to_string_lossy(),"present":current.is_file()},
            {"kind":"legacy","path":legacy.to_string_lossy(),"present":legacy.is_file()}
        ],
        "projectOverlays": [
            {"kind":"current-project","path":project_current.to_string_lossy(),"present":project_current.is_file()},
            {"kind":"legacy-project","path":project_legacy.to_string_lossy(),"present":project_legacy.is_file()}
        ]
    })
}

/// R40: parse `key = "value"` (or `key = 'value'`) from a single TOML line.
/// Used by the diagnostic to scan for stale CodeWhale hook events like
/// `message_submit` that pre-date the R22 fix. Tolerates leading
/// whitespace and either quote style.
fn parse_codewhale_toml_string(line: &str, key: &str) -> Option<String> {
    let trimmed = line.trim();
    let prefix = format!("{key} =");
    if !trimmed.starts_with(&prefix) {
        return None;
    }
    let rest = trimmed[prefix.len()..].trim_start();
    if let Some(stripped) = rest.strip_prefix('"') {
        let end = stripped.find('"')?;
        return Some(stripped[..end].to_string());
    }
    if let Some(stripped) = rest.strip_prefix('\'') {
        let end = stripped.find('\'')?;
        return Some(stripped[..end].to_string());
    }
    None
}

fn codewhale_config_compatibility(path: &Path) -> Value {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => {
            return json!({
                "readable": false,
                "legacyModelIds": [],
                "deprecatedTlsBypass": false
            })
        }
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > crate::hook_install::MAX_CONFIG_BYTES
    {
        return json!({
            "readable": false,
            "bytes": metadata.len(),
            "legacyModelIds": [],
            "deprecatedTlsBypass": false
        });
    }
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(_) => {
            return json!({
                "readable": false,
                "bytes": metadata.len(),
                "legacyModelIds": [],
                "deprecatedTlsBypass": false
            })
        }
    };
    let active_lines = raw
        .lines()
        .map(|line| {
            line.split('#')
                .next()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase()
        })
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let active_text = active_lines.join("\n");
    let legacy_model_ids = ["deepseek-chat", "deepseek-reasoner"]
        .into_iter()
        .filter(|model| active_text.contains(model))
        .collect::<Vec<_>>();
    let deprecated_tls_bypass = active_lines.iter().any(|line| {
        let Some((key, value)) = line.split_once('=') else {
            return false;
        };
        key.trim() == "insecure_skip_tls_verify" && value.trim() == "true"
    });
    json!({
        "readable": true,
        "bytes": metadata.len(),
        "legacyModelIds": legacy_model_ids,
        "deprecatedTlsBypass": deprecated_tls_bypass
    })
}

fn nearest_git_root(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|candidate| candidate.join(".git").exists())
        .map(Path::to_path_buf)
}

fn aider_configuration_summary(cwd: &Path) -> Value {
    let mut candidates = Vec::<Value>::new();
    let cwd_config = cwd.join(".aider.conf.yml");
    candidates.push(json!({
        "kind": "working-directory",
        "path": cwd_config.to_string_lossy(),
        "present": cwd_config.is_file()
    }));
    if let Some(git_root) = nearest_git_root(cwd) {
        let path = git_root.join(".aider.conf.yml");
        if path != cwd_config {
            candidates.push(json!({
                "kind": "git-root",
                "path": path.to_string_lossy(),
                "present": path.is_file()
            }));
        }
    }
    let home_config = home_dir().join(".aider.conf.yml");
    if home_config != cwd_config {
        candidates.push(json!({
            "kind": "home",
            "path": home_config.to_string_lossy(),
            "present": home_config.is_file()
        }));
    }
    let credential_environment = [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "DEEPSEEK_API_KEY",
        "OPENROUTER_API_KEY",
        "GEMINI_API_KEY",
        "AZURE_API_KEY",
    ]
    .into_iter()
    .filter(|name| {
        std::env::var_os(name).is_some_and(|value| !value.to_string_lossy().trim().is_empty())
    })
    .collect::<Vec<_>>();
    let model_environment = std::env::var_os("AIDER_MODEL")
        .is_some_and(|value| !value.to_string_lossy().trim().is_empty());
    json!({
        "configCandidates": candidates,
        "credentialEnvironment": credential_environment,
        "modelEnvironment": model_environment
    })
}

fn executable_kind(path: &Path) -> &'static str {
    #[cfg(windows)]
    {
        if is_windows_script(path) {
            return "windows-command-shim";
        }
        if path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| {
                value.eq_ignore_ascii_case("exe") || value.eq_ignore_ascii_case("com")
            })
        {
            return "native-windows";
        }
    }
    if path
        .to_string_lossy()
        .to_ascii_lowercase()
        .contains("node_modules")
    {
        "package-manager-shim"
    } else {
        "native-or-script"
    }
}

// Provider diagnostics are globally single-owner because the UI exposes one
// result at a time. Blocking CLI probes run off the IPC executor;
// DiagnosticControl owns provider, PID and cancellation transitions.
#[tauri::command]
pub async fn diagnose_agent(provider: String, state: State<'_, AppState>) -> Result<Value, String> {
    state.runtime.diagnostic_control.begin(provider.clone())?;
    let runtime = state.runtime.clone();
    let provider_for_worker = provider;
    let task = tauri::async_runtime::spawn_blocking(move || {
        diagnose_agent_sync(provider_for_worker, &runtime.diagnostic_control)
    })
    .await;

    // Release ownership before propagating either the worker result or a join
    // failure. The previous `?` returned early on panic and left diagnostics
    // permanently busy with a stale PID slot.
    state.runtime.diagnostic_control.finish();
    match task {
        Ok(result) => result,
        Err(join_error) => Err(format!("diagnostic task panicked: {join_error}")),
    }
}

/// Requests cooperative cancellation and kills the child that currently owns
/// the diagnostic slot. If cancellation lands between probes, the next PID
/// registration is rejected and that just-spawned process is killed before it
/// can become an untracked child.
#[tauri::command]
pub async fn cancel_diagnostic(state: State<'_, AppState>) -> Result<Value, String> {
    let request = state.runtime.diagnostic_control.request_cancel();
    if !request.active {
        return Ok(json!({"cancelled": false, "reason": "no active diagnostic"}));
    }
    let Some(pid) = request.pid else {
        return Ok(json!({
            "cancelled": true,
            "reason": "cancellation requested between diagnostic probes"
        }));
    };
    match kill_process_tree(pid) {
        Ok(()) => Ok(json!({"cancelled": true, "pid": pid})),
        Err(error) => {
            state
                .runtime
                .diagnostic_control
                .restore_pid_after_failed_termination(pid);
            Ok(json!({
                "cancelled": true,
                "pid": pid,
                "killError": error,
                "reason": "cancellation remains active; the worker will retry process termination"
            }))
        }
    }
}

/// R35.2: Kill a process and all its descendants. On Windows, uses
/// `taskkill /F /T /PID` which kills the whole tree (cmd.exe + Node).
/// On Unix, each probe is spawned in a fresh process group; cancellation sends
/// SIGTERM then SIGKILL to the negative PGID so descendants are included.
fn kill_process_tree(pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        // taskkill /F /T /PID <pid>:
        //   /F = force (no graceful shutdown)
        //   /T = tree (kill all descendants)
        // Verified via web-search of Microsoft docs: "/T Tree kill:
        //   terminates the specified process and any child processes
        //   which were started by it."
        let output = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("failed to spawn taskkill: {e}"))?;
        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            // taskkill returns non-zero if the process already exited —
            // treat "not found" as success (the diagnostic is over anyway).
            let combined = format!("{} {}", stdout, stderr).to_lowercase();
            if combined.contains("not found") || combined.contains("no tasks") {
                Ok(())
            } else {
                Err(format!("taskkill failed: {stderr}"))
            }
        }
    }
    #[cfg(unix)]
    {
        // process_group(0) makes the child PID its PGID. kill(2) with a
        // negative value targets the entire process group.
        let process_group =
            -i32::try_from(pid).map_err(|_| "diagnostic PID exceeds i32".to_string())?;
        if !signal_process_group(process_group, 15)? {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(200));
        let _ = signal_process_group(process_group, 9)?;
        Ok(())
    }
}

#[cfg(unix)]
fn signal_process_group(process_group: i32, signal: i32) -> Result<bool, String> {
    let result = unsafe { libc_kill(process_group, signal) };
    if result == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    // ESRCH is 3 on the supported Unix targets and means the group already
    // exited, which is the desired cancellation result.
    if error.raw_os_error() == Some(3) {
        Ok(false)
    } else {
        Err(format!(
            "failed to signal diagnostic process group {process_group}: {error}"
        ))
    }
}

#[cfg(unix)]
extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

#[cfg(unix)]
unsafe fn libc_kill(pid: i32, sig: i32) -> i32 {
    kill(pid, sig)
}

fn diagnose_agent_sync(provider: String, control: &DiagnosticControl) -> Result<Value, String> {
    let spec = agent_spec(&provider)?;
    // Diagnostics intentionally use the application-owned working directory.
    // The always-on WebView cannot supply an arbitrary path and cause provider
    // CLIs to load untrusted project configs, plugins, hooks, or .env files.
    let working_directory = agent_working_directory(None)?;
    let executable = which(spec.command);
    let companion = executable
        .as_deref()
        .and_then(|path| companion_for(spec, path));
    let mut issues = Vec::<String>::new();
    let mut warnings = Vec::<String>::new();
    if executable.is_none() {
        issues.push(format!("{} CLI was not found in Octopus PATH", spec.title));
    }
    if spec.id == "codewhale" && executable.is_some() && companion.is_none() {
        issues.push(
            "MISSING_COMPANION_BINARY: codewhale-tui was not found beside codewhale or on PATH"
                .into(),
        );
    }
    let version = executable
        .as_deref()
        .map(|path| {
            run_diagnostic_probe(
                path,
                &["--version"],
                &working_directory,
                Duration::from_secs(5),
                control,
            )
        })
        .unwrap_or(Value::Null);
    let companion_version = if spec.id == "codewhale" {
        companion
            .as_deref()
            .map(|path| {
                run_diagnostic_probe(
                    path,
                    &["--version"],
                    &working_directory,
                    Duration::from_secs(5),
                    control,
                )
            })
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    // CodeWhale's detailed command reference identifies `doctor` as a TUI
    // subcommand. R10 (2026-07-30) reversed the probe order so the matched
    // `codewhale-tui doctor --json` runs first; the dispatcher alias is the
    // fallback for command-surface drift. Both attempts remain visible.
    let (doctor, doctor_target, doctor_surface, doctor_json, doctor_attempts) = match spec.id {
        "codewhale" => {
            let result = codewhale_doctor_probe(
                executable.as_deref(),
                companion.as_deref(),
                &working_directory,
                control,
            );
            (
                result.report,
                result.target,
                result.surface,
                result.json,
                Value::Array(result.attempts),
            )
        }
        "claude" => (
            executable
                .as_deref()
                .map(|path| {
                    run_diagnostic_probe(
                        path,
                        &["doctor"],
                        &working_directory,
                        Duration::from_secs(15),
                        control,
                    )
                })
                .unwrap_or(Value::Null),
            executable
                .as_deref()
                .map(|path| path.to_string_lossy().into_owned()),
            executable.as_ref().map(|_| "cli"),
            None,
            Value::Null,
        ),
        _ => (Value::Null, None, None, None, Value::Null),
    };
    let auth = match spec.id {
        "codewhale" => executable
            .as_deref()
            .map(|path| {
                run_diagnostic_probe(
                    path,
                    &["auth", "status"],
                    &working_directory,
                    Duration::from_secs(8),
                    control,
                )
            })
            .unwrap_or(Value::Null),
        "codex" => executable
            .as_deref()
            .map(|path| {
                run_diagnostic_probe(
                    path,
                    &["login", "status"],
                    &working_directory,
                    Duration::from_secs(8),
                    control,
                )
            })
            .unwrap_or(Value::Null),
        "opencode" => executable
            .as_deref()
            .map(|path| {
                // R40.1 (2026-08-01): REVERTED the 0.5.19 "providers list"
                // experiment. The 0.5.19 carpet audit (P1-1) proved
                // `opencode auth list` is still the official command
                // (verified via opencode.ai docs, anomalyco-opencode
                // mintlify CLI overview, and GitHub issue #4533 which
                // references `opencode auth list` output). The 0.5.19
                // "fix" was based on a misreading of `opencode --help`
                // — `opencode providers` is a SEPARATE command for
                // managing provider configurations, not a replacement
                // for `opencode auth list`. Using `providers list` as
                // the primary probe caused every healthy install to
                // run a failing command first, adding latency + noise.
                //
                // R40.1 fix: `auth list` is primary (the official
                // credential-listing command). No fallback — if a
                // future OpenCode build renames it, the diagnostic
                // will surface the failure and we'll add a fixture
                // then. Inventing unverified fallbacks is what got
                // us here.
                run_diagnostic_probe(
                    path,
                    &["auth", "list"],
                    &working_directory,
                    Duration::from_secs(8),
                    control,
                )
            })
            .unwrap_or(Value::Null),
        _ => Value::Null,
    };
    let doctor_summary = codewhale_doctor_summary(doctor_json.as_ref());
    if executable.is_some() && !probe_succeeded(&version) {
        issues.push(format!(
            "{} --version failed: {}",
            spec.title,
            probe_failure_detail(&version)
        ));
    }
    if spec.id == "claude" {
        if let Some(actual) = semverish_from_probe(&version) {
            if version_is_older(&actual, "2.1.200") {
                warnings.push(format!(
                    "Claude Code {actual} predates the 2.1.200 sleep/wake and background-session reliability fixes; upgrade before attributing resumed-session authentication failures to Octopus"
                ));
            }
        }
    }
    if spec.id == "codewhale" && companion.is_some() && !probe_succeeded(&companion_version) {
        issues.push(format!(
            "codewhale-tui --version failed: {}",
            probe_failure_detail(&companion_version)
        ));
    }
    if spec.id == "codewhale" && probe_succeeded(&version) && probe_succeeded(&companion_version) {
        let dispatcher_version = semverish_from_probe(&version);
        let runtime_version = semverish_from_probe(&companion_version);
        if dispatcher_version.is_some()
            && runtime_version.is_some()
            && dispatcher_version != runtime_version
        {
            issues.push(format!(
                "CodeWhale dispatcher/runtime version mismatch: {} vs {}",
                dispatcher_version.unwrap_or_default(),
                runtime_version.unwrap_or_default()
            ));
        }
    }
    if ((spec.id == "codewhale" && companion.is_some())
        || (spec.id == "claude" && executable.is_some()))
        && !probe_succeeded(&doctor)
    {
        issues.push(format!(
            "{} doctor reported a problem: {}",
            spec.title,
            probe_failure_detail(&doctor)
        ));
    }
    if spec.id == "codewhale" && probe_succeeded(&doctor) && doctor_json.is_none() {
        warnings.push("CodeWhale doctor succeeded but did not return parseable JSON; command-surface or output-schema drift may be present".into());
    }
    if spec.id == "codewhale" {
        if doctor_summary
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|status| status.eq_ignore_ascii_case("error"))
        {
            issues.push(format!(
                "CodeWhale doctor JSON reported error{}",
                doctor_summary
                    .get("errorKind")
                    .and_then(Value::as_str)
                    .map(|kind| format!(": {kind}"))
                    .unwrap_or_default()
            ));
        }
        if doctor_summary
            .get("apiKeySource")
            .and_then(Value::as_str)
            .is_some_and(|source| source.eq_ignore_ascii_case("missing"))
        {
            warnings.push("CodeWhale reports no stored or environment API key; local/keyless providers may still work, otherwise authenticate before launch".into());
        }
        if let Some(state) = doctor_summary
            .get("sessionRecovery")
            .and_then(Value::as_str)
        {
            if matches!(
                state,
                "migration_pending" | "migration_incomplete" | "scan_failed"
            ) {
                warnings.push(format!(
                    "CodeWhale legacy session recovery needs attention: {state}"
                ));
            }
        }
    }
    if matches!(spec.id, "codewhale" | "codex" | "opencode")
        && executable.is_some()
        && !probe_succeeded(&auth)
    {
        let qualification = match spec.id {
            "codex" => " Custom model providers using env_key may still work even when the built-in login store is empty.",
            "opencode" => " Environment variables or a project .env file may still provide credentials.",
            "codewhale" => " Local or keyless providers may still work.",
            _ => "",
        };
        warnings.push(format!(
            "{} authentication status could not be confirmed: {}{}",
            spec.title,
            probe_failure_detail(&auth),
            qualification
        ));
    }
    if spec.id == "opencode" && probe_succeeded(&auth) && !opencode_auth_has_entries(&auth) {
        warnings.push("OpenCode reports 0 stored credentials; environment variables or project .env files may still supply credentials".into());
    }
    let terminal = {
        #[cfg(windows)]
        {
            json!({
                "windowsTerminal": which("wt.exe").or_else(|| which("wt")).map(|path| path.to_string_lossy().into_owned()),
                "cmdFallback": which("cmd.exe").map(|path| path.to_string_lossy().into_owned())
            })
        }
        #[cfg(not(windows))]
        {
            Value::Null
        }
    };
    let config = if spec.id == "codewhale" {
        let project_current = working_directory.join(".codewhale").join("config.toml");
        let project_legacy = working_directory.join(".deepseek").join("config.toml");
        if project_current.is_file() && project_legacy.is_file() {
            warnings.push("Both .codewhale/config.toml and legacy .deepseek/config.toml exist in the diagnostic workspace; provider/model resolution can differ across CodeWhale versions".into());
        } else if project_legacy.is_file() {
            warnings.push("Legacy CodeWhale project overlay .deepseek/config.toml is active in the diagnostic workspace; migrate deliberately after comparing provider, model, approval, and sandbox settings".into());
        }
        let path = codewhale_config_path();
        let config_raw = std::fs::read_to_string(&path).ok();
        let hook_block = config_raw
            .as_deref()
            .is_some_and(hook_install::codewhale_config_has_owned_block);
        // R40 (2026-08-01): detect stale `message_submit` (and any other
        // pre-R22) hooks that are still present in the user's config.toml
        // from installs done prior to the R22 fix. These hooks cause
        // CodeWhale to report "message_submit hook failed and blocked"
        // whenever the LLMPET HTTP server is briefly unavailable, which
        // completely blocks the user's prompt from being submitted.
        // The previous diagnostic only checked `hook_block` (the v2
        // marker block), so it reported "all good" while the user's CodeWhale
        // was actually broken. This is the "诊断功能失效" failure mode
        // the user reported.
        let stale_hooks: Vec<String> = config_raw
            .as_deref()
            .map(|raw| {
                // Look for any `event = "..."` line whose value is in
                // the legacy/pre-R22 set AND which is NOT inside an Octopus-owned
                // marker block. The most common offender is
                // `message_submit` (removed in R22).
                let legacy_events = ["message_submit"];
                let mut in_owned_block = false;
                let mut found: Vec<String> = Vec::new();
                let mut current_table_events: Vec<String> = Vec::new();
                let mut current_table_is_outside_owned_block = false;
                for line in raw.lines() {
                    let t = line.trim();
                    if hook_install::is_codewhale_marker_begin(t) {
                        in_owned_block = true;
                        continue;
                    }
                    if hook_install::is_codewhale_marker_end(t) {
                        in_owned_block = false;
                        continue;
                    }
                    if t.starts_with("[[hooks.hooks]]") {
                        // start new table
                        current_table_events.clear();
                        current_table_is_outside_owned_block = !in_owned_block;
                        continue;
                    }
                    if t.starts_with('[') && !t.starts_with("[[hooks.hooks]]") {
                        // different section — flush
                        if current_table_is_outside_owned_block {
                            for ev in &current_table_events {
                                if legacy_events.contains(&ev.as_str()) {
                                    found.push(ev.clone());
                                }
                            }
                        }
                        current_table_events.clear();
                        current_table_is_outside_owned_block = false;
                        continue;
                    }
                    // capture `event = "..."` from inside a hooks table
                    if let Some(val) = parse_codewhale_toml_string(t, "event") {
                        current_table_events.push(val);
                    }
                }
                // flush trailing
                if current_table_is_outside_owned_block {
                    for ev in &current_table_events {
                        if legacy_events.contains(&ev.as_str()) {
                            found.push(ev.clone());
                        }
                    }
                }
                found
            })
            .unwrap_or_default();
        if !stale_hooks.is_empty() {
            // These tables have no exact ownership marker. Surface them for
            // manual review instead of risking deletion of user-owned TOML.
            issues.push(format!(
                "CodeWhale config.toml 仍包含无 Octopus 所有权标记的旧 hook 事件: {}。这些 hook 可能在 Octopus HTTP 服务不可用时阻止消息发送。为避免误删用户 TOML，Octopus 只自动迁移精确 marker 块，不会删除无标记表。请备份后手动删除 event = \"{}\" 的对应 [[hooks.hooks]] 表；安装器生成的旁路备份可用于恢复。",
                stale_hooks.join(", "),
                stale_hooks.join("\" 或 event = \"")
            ));
        }
        let compatibility = codewhale_config_compatibility(&path);
        if let Some(models) = compatibility
            .get("legacyModelIds")
            .and_then(Value::as_array)
            .filter(|models| !models.is_empty())
        {
            let names = models
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ");
            warnings.push(format!(
                "Legacy CodeWhale model id detected ({names}); run doctor/models because direct DeepSeek routes retired these ids while provider-owned routes may keep different mappings"
            ));
        }
        if compatibility
            .get("deprecatedTlsBypass")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            warnings.push(
                "CodeWhale config contains insecure_skip_tls_verify=true; current clients reject this legacy setting and require a trusted SSL_CERT_FILE bundle".into(),
            );
        }
        let mut report = codewhale_config_candidates(&working_directory);
        if let Some(object) = report.as_object_mut() {
            object.insert("present".into(), Value::Bool(path.is_file()));
            object.insert("reLlmpetHookBlock".into(), Value::Bool(hook_block));
            object.insert("stalePreR22Hooks".into(), json!(stale_hooks));
            object.insert("compatibility".into(), compatibility);
        }
        report
    } else {
        Value::Null
    };
    let aider_summary = if spec.id == "aider" {
        let summary = aider_configuration_summary(&working_directory);
        let has_config = summary
            .get("configCandidates")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items.iter().any(|item| {
                    item.get("present")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                })
            });
        let has_credential_env = summary
            .get("credentialEnvironment")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty());
        if executable.is_some() && !has_config && !has_credential_env {
            warnings.push("Aider is installed but no .aider.conf.yml or common credential environment variable is visible to Octopus; keyring, provider-specific config, or interactive setup may still work".into());
        }
        summary
    } else {
        Value::Null
    };
    let path_entry_count = std::env::var_os("PATH")
        .map(|raw| std::env::split_paths(&raw).count())
        .unwrap_or(0);
    Ok(json!({
        "provider": spec.id,
        "ready": issues.is_empty(),
        "issues": issues,
        "warnings": warnings,
        "executableKind": executable.as_deref().map(executable_kind),
        "executable": executable.map(|path| path.to_string_lossy().into_owned()),
        "companion": companion.map(|path| path.to_string_lossy().into_owned()),
        "workingDirectory": working_directory.to_string_lossy(),
        "config": config,
        "versionProbe": version,
        "companionVersionProbe": companion_version,
        "doctorProbe": doctor,
        "doctorTarget": doctor_target,
        "doctorSurface": doctor_surface,
        "doctorAttempts": doctor_attempts,
        "doctorSummary": doctor_summary,
        "authProbe": auth,
        "aiderSummary": aider_summary,
        "terminal": terminal,
        "pathEntryCount": path_entry_count
    }))
}

#[tauri::command]
pub fn launch_agent(provider: String) -> Result<(), String> {
    launch_agent_in(provider, None)
}

#[tauri::command]
pub fn launch_agent_in(provider: String, cwd: Option<String>) -> Result<(), String> {
    let spec = agent_spec(&provider)?;
    let executable = resolve_agent(spec)?;
    let working_directory = agent_working_directory(cwd.as_deref())?;
    launch_terminal(spec, &executable, &working_directory)
}

/// Launch a GUI/IDE version only for providers with a real GUI mapping. Unknown
/// provider names are rejected instead of being passed into a shell.
#[tauri::command]
pub fn launch_agent_gui(provider: String) -> Result<(), String> {
    match provider.as_str() {
        "claude" => {
            if let Some(path) = which("cursor").or_else(|| which("code")) {
                open_gui_application(&path)
            } else {
                launch_agent(provider)
            }
        }
        "codex" => {
            if let Some(path) = which("code").or_else(|| which("cursor")) {
                open_gui_application(&path)
            } else {
                launch_agent(provider)
            }
        }
        "codewhale" | "opencode" | "aider" => launch_agent(provider),
        _ => Err(format!("unsupported agent provider: {provider}")),
    }
}

fn open_gui_application(executable: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        // VS Code/Cursor are frequently exposed as npm-style .cmd shims on
        // Windows. Execute only the already-resolved absolute allowlisted path
        // through cmd.exe; native .exe/.com files bypass the shell entirely.
        if is_windows_script(executable) {
            // R35 (2026-07-31): use raw_arg via append_cmd_tail so the .cmd
            // shim is invoked without CreateProcessW re-quoting the call tail.
            let mut command = Command::new("cmd.exe");
            append_cmd_tail(&mut command, cmd_call(executable));
            return command
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("failed to launch {}: {e}", executable.display()));
        }
    }
    Command::new(executable)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to launch {}: {e}", executable.display()))
}

#[tauri::command]
pub fn focus_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    match platform::focus_session(&app, &state, &session_id) {
        Ok(()) => Ok(()),
        Err(error) => {
            state.runtime.write_log(
                "focus",
                &format!("native focus unavailable for {session_id}: {error}"),
            );
            let _ = app.emit("pet:event", json!({"kind":"say","text":format!("无法直接聚焦该终端：{error}；已打开详情面板。") }));
            open_panel(app)
        }
    }
}

#[tauri::command]
pub fn primary_action(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let stats = state.runtime.stats();
    let active_session = stats
        .get("sessions")
        .and_then(Value::as_array)
        .and_then(|sessions| {
            sessions.iter().find(|session| {
                session
                    .get("status")
                    .and_then(Value::as_str)
                    .is_some_and(|status| !matches!(status, "ended" | "idle"))
            })
        })
        .and_then(|session| session.get("id").and_then(Value::as_str))
        .map(str::to_owned);
    if let Some(session_id) = active_session {
        focus_session(app, state, session_id)
    } else {
        // R22 (2026-07-30): if no providers are configured, open the panel
        // instead of defaulting to 'claude'. The user explicitly chose to
        // have zero providers; launching claude would be surprising.
        let providers = state.runtime.config().providers;
        // R35.1 (2026-07-31): if MORE THAN ONE provider is enabled, do NOT
        // silently launch the first one. The 0.5.11 deep-recheck (P0-5)
        // flagged this as a trust issue: the user enabled multiple
        // providers and primaryAction picked array[0] without asking.
        // We emit a pet:event so the frontend opens its #provider-chooser
        // modal (the frontend has the UI context to render a picker;
        // Rust doesn't). Single provider still launches directly.
        if providers.len() > 1 {
            let _ = app.emit(
                "pet:event",
                json!({"kind":"choose-provider","providers":providers}),
            );
            Ok(())
        } else {
            match providers.into_iter().next() {
                Some(p) => launch_agent(p),
                None => open_panel(app),
            }
        }
    }
}

#[tauri::command]
pub fn open_log(state: State<'_, AppState>) -> Result<(), String> {
    if !state.runtime.log_path.exists() {
        std::fs::write(&state.runtime.log_path, b"").map_err(|e| e.to_string())?;
    }
    open_path(&state.runtime.log_path)
}

#[tauri::command]
pub fn pet_log(state: State<'_, AppState>, tag: String, message: String) {
    state.runtime.write_log(&tag, &message);
}

#[tauri::command]
pub fn ui_busy(platform_state: State<'_, Arc<platform::PlatformState>>, on: bool) {
    platform_state.set_ui_busy(on);
}

#[tauri::command]
pub fn pet_visual_bounds(
    platform_state: State<'_, Arc<platform::PlatformState>>,
    rect: Value,
    agent: Option<String>,
) -> Result<(), String> {
    platform_state.set_visual_bounds(pet_label_for_agent(agent.as_deref()), &rect)
}

#[tauri::command]
pub fn quit_app(app: AppHandle, state: State<'_, AppState>) {
    state
        .runtime
        .cancel_all_pending("Octopus is shutting down; permission denied");
    app.exit(0);
}

#[allow(dead_code)]
fn is_windows_script(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("cmd") || value.eq_ignore_ascii_case("bat"))
}

#[cfg(windows)]
fn cmd_call(path: &Path) -> String {
    format!("call \"{}\"", path.to_string_lossy().replace('"', "\"\""))
}

fn agent_launch_args(spec: AgentSpec) -> &'static [&'static str] {
    // OpenCode documents --dir as its explicit TUI working-directory
    // contract. Keep current_dir as a process-level fallback as well, but pass
    // the provider-native flag so Windows Terminal and wrapper scripts cannot
    // silently reset the workspace to the user's home directory.
    match spec.id {
        "opencode" => &["."],
        _ => &[],
    }
}

#[cfg(windows)]
fn cmd_launch_call(path: &Path, args: &[&str]) -> String {
    let mut command_line = vec![cmd_call(path)];
    command_line.extend(args.iter().map(|value| cmd_quote_arg(value)));
    command_line.join(" ")
}

fn launch_terminal(spec: AgentSpec, executable: &Path, cwd: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let launch_args = agent_launch_args(spec);
        if let Some(wt) = which("wt.exe").or_else(|| which("wt")) {
            let mut command = Command::new(wt);
            command
                .args([
                    "-w",
                    "-1",
                    "new-tab",
                    "--title",
                    spec.title,
                    "--suppressApplicationTitle",
                    "--startingDirectory",
                ])
                .arg(cwd);
            if is_windows_script(executable) {
                // R35 (2026-07-31): use raw_arg so cmd.exe /S /K receives the
                // unescaped `call "C:\path\file.cmd" args...` tail. The previous
                // `.arg(cmd_launch_call(...))` re-escaped the tail per
                // CreateProcessW rules, producing literal `\"...\"` quotes that
                // broke .cmd shims even when the CLI itself was installed.
                // `/K` keeps the terminal open after the CLI exits.
                use std::os::windows::process::CommandExt;
                command
                    .arg("cmd.exe")
                    .args(["/D", "/S", "/K"])
                    .raw_arg(cmd_launch_call(executable, launch_args));
            } else {
                command.arg(executable).args(launch_args.iter().copied());
            }
            if command.spawn().is_ok() {
                return Ok(());
            }
        }
        // Windows Terminal is optional. The fallback is a direct cmd.exe
        // process, not `cmd /C start`, and receives only an absolute allowlisted
        // executable path plus provider-owned static arguments.
        let command_line = if is_windows_script(executable) {
            cmd_launch_call(executable, launch_args)
        } else {
            let mut parts = vec![format!(
                "\"{}\"",
                executable.to_string_lossy().replace('"', "\"\"")
            )];
            parts.extend(launch_args.iter().map(|value| cmd_quote_arg(value)));
            parts.join(" ")
        };
        // R35: same raw_arg fix as the Windows Terminal path above. The
        // `.args(["/D", "/S", "/K"]).arg(command_line)` form re-escaped
        // command_line, producing literal `\"C:\\...\\file.cmd\"` quotes.
        let mut command = Command::new("cmd.exe");
        {
            use std::os::windows::process::CommandExt;
            command.args(["/D", "/S", "/K"]).raw_arg(command_line);
        }
        command.current_dir(cwd).spawn().map(|_| ()).map_err(|e| {
            format!(
                "failed to launch {} in Windows Terminal or cmd.exe: {e}",
                spec.title
            )
        })
    }
    #[cfg(target_os = "macos")]
    {
        fn shell_quote(value: &str) -> String {
            format!("'{}'", value.replace('\'', "'\"'\"'"))
        }
        let mut command = vec![shell_quote(&executable.to_string_lossy())];
        command.extend(agent_launch_args(spec).iter().map(|arg| shell_quote(arg)));
        let shell = format!(
            "cd {} && exec {}",
            shell_quote(&cwd.to_string_lossy()),
            command.join(" ")
        );
        let escaped = shell.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!("tell application \"Terminal\" to do script \"{escaped}\"");
        Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("failed to launch {} in Terminal: {e}", spec.title))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let provider_args = agent_launch_args(spec)
            .iter()
            .map(|arg| OsString::from(*arg))
            .collect::<Vec<_>>();
        let terminal_args = |prefix: &str| {
            let mut args = vec![OsString::from(prefix), executable.as_os_str().to_owned()];
            args.extend(provider_args.iter().cloned());
            args
        };
        let attempts = [
            ("x-terminal-emulator", terminal_args("-e")),
            ("gnome-terminal", terminal_args("--")),
            ("konsole", terminal_args("-e")),
            ("xterm", terminal_args("-e")),
        ];
        for (program, args) in attempts {
            if Command::new(program)
                .args(args)
                .current_dir(cwd)
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
        Err(format!(
            "no supported terminal emulator found for {}",
            spec.title
        ))
    }
}

fn open_path(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Avoid routing a user-profile-derived path through cmd.exe. A home
        // directory containing '&', '^' or '%' must not become shell syntax.
        Command::new("explorer.exe")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}
