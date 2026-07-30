use crate::hook_install;
use crate::model::{home_dir, AppState, Point};
use crate::platform;
use serde_json::{json, Value};
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, State};

fn emit_config(app: &AppHandle, state: &AppState) {
    let config = state.runtime.config_view();
    let _ = app.emit("pet:config", config.clone());
    let _ = app.emit("panel:config", config);
}

fn emit_stats(app: &AppHandle, state: &AppState) {
    let stats = state.runtime.stats();
    let _ = app.emit("pet:stats", stats.clone());
    let _ = app.emit("panel:stats", stats);
}

fn emit_price(app: &AppHandle, state: &AppState) {
    let _ = app.emit("panel:price", state.runtime.price_info());
}

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> Value {
    state.runtime.config_view()
}

#[tauri::command]
pub fn get_stats(state: State<'_, AppState>) -> Value {
    state.runtime.stats()
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
    if let Some(window) = app.get_webview_window("pet") {
        let result = if mode == "hidePet" {
            window.hide()
        } else {
            // show() then set_focus() so returning from hidePet brings the
            // pet back to the foreground, matching upstream behavior.
            window.show().and_then(|_| window.set_focus())
        };
        if let Err(error) = result {
            state.runtime.write_log(
                "mode",
                &format!("set_mode window side-effect failed: {error}"),
            );
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
#[tauri::command]
pub fn uninstall_hooks(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: String,
) -> Result<Value, String> {
    let provider = provider.trim().to_lowercase();
    // R22: "all" cleans every provider + clears config.providers
    if provider == "all" {
        let mut paths = Vec::new();
        for id in ["claude", "codewhale", "codex", "opencode", "aider"] {
            if let Ok(path) = crate::hook_install::uninstall_provider_hooks(id) {
                paths.push(json!({"provider": id, "path": path.to_string_lossy()}));
            }
        }
        state.runtime.update_config(|config| {
            config.providers.clear();
        })?;
        state.runtime.write_log("tray", "uninstalled ALL provider hooks + cleared config.providers");
        let _ = crate::hook_install::resync_current(&state.runtime);
        emit_config(&app, &state);
        return Ok(json!({
            "provider": "all",
            "paths": paths,
            "message": "All Octopus hooks removed; config.providers cleared"
        }));
    }
    if !["claude", "codewhale", "codex", "opencode", "aider"].contains(&provider.as_str()) {
        return Err(format!("unsupported provider: {provider}"));
    }
    let path = crate::hook_install::uninstall_provider_hooks(&provider)?;
    state.runtime.write_log(
        "tray",
        &format!("uninstalled hooks for {provider}: {}", path.display()),
    );
    // R22: also remove this provider from config.providers so it doesn't
    // get re-synced on next resync.
    state.runtime.update_config(|config| {
        config.providers.retain(|p| p != &provider);
    })?;
    // Resync provider statuses so the panel reflects the new state.
    let _ = crate::hook_install::resync_current(&state.runtime);
    emit_config(&app, &state);
    Ok(json!({
        "provider": provider,
        "path": path.to_string_lossy(),
        "message": "Octopus hooks removed for this provider; user config preserved"
    }))
}

#[tauri::command]
pub fn set_skin(app: AppHandle, state: State<'_, AppState>, skin: String) -> Result<(), String> {
    state.runtime.update_config(|config| config.skin = skin)?;
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
) -> Result<(), String> {
    state
        .runtime
        .update_config(|config| config.providers = ids)?;
    let statuses = hook_install::resync_current(&state.runtime)?;
    emit_config(&app, &state);
    let errors: Vec<String> = statuses
        .into_iter()
        .filter(|s| s.state == "error")
        .map(|s| format!("{}: {}", s.id, s.message))
        .collect();
    if !errors.is_empty() {
        let _ = app.emit(
            "pet:event",
            json!({"kind":"error","text":errors.join("；")}),
        );
    }
    Ok(())
}

#[tauri::command]
pub fn territory_toggle_auto(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let config = state
        .runtime
        .update_config(|config| config.territory = !config.territory)?;
    emit_config(&app, &state);
    let message = if config.territory {
        "领地模式已开启；第一阶段只保留开关，原生窗口推动适配仍按平台逐项迁移。"
    } else {
        "领地模式已关闭。"
    };
    let _ = app.emit("pet:event", json!({"kind":"say","text":message}));
    Ok(())
}

#[tauri::command]
pub fn territory_run_now(app: AppHandle, platform_state: State<'_, Arc<platform::PlatformState>>) {
    if platform_state.is_ui_busy() {
        let _ = app.emit(
            "pet:event",
            json!({"kind":"say","text":"界面操作尚未结束，已暂缓巡视以避免抢焦点。"}),
        );
        return;
    }
    let _ = app.emit(
        "pet:event",
        json!({"kind":"say","text":"Tauri 核心已接管桌宠；领地巡视的原生平台适配尚未在本阶段启用。"}),
    );
}

#[tauri::command]
pub fn open_panel(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("panel")
        .ok_or("panel window missing")?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_panel(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("panel")
        .ok_or("panel window missing")?;
    window.hide().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_win_pos(app: AppHandle) -> Result<[i32; 2], String> {
    let window = app.get_webview_window("pet").ok_or("pet window missing")?;
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
pub fn set_win_pos(app: AppHandle, x: i32, y: i32) -> Result<(), String> {
    // R22 (2026-07-30): accept LOGICAL position from the renderer (which
    // uses e.screenX — CSS/logical pixels) and convert to physical internally.
    // The old code used PhysicalPosition directly, causing DPI mismatch on
    // scaled displays (pet moved slower/faster than mouse).
    let window = app.get_webview_window("pet").ok_or("pet window missing")?;
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
pub fn commit_win_pos(app: AppHandle, state: State<'_, AppState>) -> Result<[i32; 2], String> {
    let window = app.get_webview_window("pet").ok_or("pet window missing")?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);
    // R22: store and return LOGICAL position for consistency with get_win_pos.
    let logical_x = (position.x as f64 / scale).round() as i32;
    let logical_y = (position.y as f64 / scale).round() as i32;
    state.runtime.update_config(|config| {
        config.pet_position = Some(Point {
            x: logical_x,
            y: logical_y,
        });
    })?;
    emit_config(&app, &state);
    Ok([logical_x, logical_y])
}

#[tauri::command]
pub fn set_ignore_mouse(
    platform_state: State<'_, Arc<platform::PlatformState>>,
    ignore: bool,
) -> Result<(), String> {
    // Electron supported `forward: true`, allowing ignored windows to keep
    // receiving mousemove events. Tauri intentionally exposes only a strict
    // ignore toggle, so the native cursor hit-test loop owns the applied state.
    platform_state.request_mouse_ignore(ignore);
    Ok(())
}

#[tauri::command]
pub fn set_pet_tall(app: AppHandle, tall: bool) -> Result<(), String> {
    set_pet_size(app, 320.0, if tall { 620.0 } else { 340.0 })
}

#[tauri::command]
pub fn set_pet_big(app: AppHandle, on: bool) -> Result<(), String> {
    set_pet_size(
        app,
        if on { 520.0 } else { 320.0 },
        if on { 700.0 } else { 340.0 },
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
pub fn set_pet_size(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let (width, height) = if width <= 0.0 || height <= 0.0 {
        (320.0, 340.0)
    } else {
        (width.clamp(240.0, 1200.0), height.clamp(240.0, 1200.0))
    };
    let window = app.get_webview_window("pet").ok_or("pet window missing")?;
    resize_pet_anchored(&window, width, height)
}

#[tauri::command]
pub fn set_panel_height(app: AppHandle, height: f64) -> Result<(), String> {
    let window = app
        .get_webview_window("panel")
        .ok_or("panel window missing")?;
    let scale = window
        .scale_factor()
        .ok()
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(1.0);
    let current = window.outer_size().map_err(|error| error.to_string())?;
    let logical_height = if height <= 0.0 {
        720.0
    } else {
        height.clamp(480.0, 1200.0)
    };
    let min_width = logical_to_physical(560.0, scale);
    window
        .set_size(Size::Physical(PhysicalSize::new(
            current.width.max(min_width),
            logical_to_physical(logical_height, scale),
        )))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn focus_pet(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("pet").ok_or("pet window missing")?;
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
    emit_stats(&app, &state);
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
    emit_stats(&app, &state);
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
            return extensions
                .into_iter()
                .map(|extension| format!("{command}{extension}").into())
                .collect();
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
        return path
            .metadata()
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
    }
    #[cfg(windows)]
    {
        true
    }
}

/// Resolve through the application's inherited PATH without invoking a shell.
/// This deliberately returns an absolute path so terminal launch never reparses
/// renderer-controlled text as a command line.

/// R22 (2026-07-30): canonicalize a path and strip the Windows `\\?\` prefix.
/// The prefix is added by `std::fs::canonicalize` when resolving symlinks or
/// long paths. Windows Terminal (`wt.exe`) and `cmd.exe` cannot handle the
/// `\\?\` prefix for `.cmd`/`.bat` script files — they treat it as a native
/// executable and fail with `0x800700c1` (STATUS_INVALID_IMAGE_FORMAT).
/// Stripping the prefix restores compatibility with all Windows shell tools.
fn canonicalize_path(path: &Path) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(path).ok().or_else(|| Some(path.to_path_buf()))?;
    #[cfg(windows)]
    {
        let s = canonical.to_string_lossy();
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            return Some(PathBuf::from(stripped));
        }
    }
    Some(canonical)
}

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
                return std::fs::canonicalize(&path).ok().or(Some(path));
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
    let text = String::from_utf8_lossy(bytes);
    let mut value = serde_json::from_str::<Value>(text.trim()).ok()?;
    redact_sensitive_json(&mut value);
    Some(value)
}

fn bounded_probe_text(bytes: &[u8]) -> String {
    let filtered: String = String::from_utf8_lossy(bytes)
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

#[cfg(windows)]
fn cmd_quote_arg(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[cfg(windows)]
fn cmd_probe_call(path: &Path, args: &[&str]) -> String {
    let mut command_line = vec![cmd_call(path)];
    command_line.extend(args.iter().map(|value| cmd_quote_arg(*value)));
    command_line.join(" ")
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

fn run_probe_capture(
    executable: &Path,
    args: &[&str],
    cwd: &Path,
    timeout: Duration,
) -> ProbeCapture {
    #[cfg(windows)]
    let mut command = if is_windows_script(executable) {
        let mut command = Command::new("cmd.exe");
        command
            .args(["/D", "/S", "/C"])
            .arg(cmd_probe_call(executable, args));
        command
    } else {
        let mut command = Command::new(executable);
        command.args(args);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new(executable);
        command.args(args);
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
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(pipe) = stdout {
            let _ = pipe.take(64 * 1024).read_to_end(&mut bytes);
        }
        bytes
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(pipe) = stderr {
            let _ = pipe.take(64 * 1024).read_to_end(&mut bytes);
        }
        bytes
    });
    let started = Instant::now();
    let (status, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (Some(status), false),
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                break (child.wait().ok(), true);
            }
            Err(_) => break (None, false),
        }
    };
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    let parsed_json = sanitized_probe_json(&stdout).or_else(|| sanitized_probe_json(&stderr));
    ProbeCapture {
        report: json!({
            "started": true,
            "timedOut": timed_out,
            "success": status.as_ref().is_some_and(|value| value.success()),
            "exitCode": status.and_then(|value| value.code()),
            "stdout": bounded_probe_text(&stdout),
            "stderr": bounded_probe_text(&stderr)
        }),
        json: parsed_json,
    }
}

fn run_probe(executable: &Path, args: &[&str], cwd: &Path, timeout: Duration) -> Value {
    run_probe_capture(executable, args, cwd, timeout).report
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
        let capture = run_probe_capture(path, &["doctor", "--json"], cwd, Duration::from_secs(15));
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
                let capture =
                    run_probe_capture(path, &["doctor", "--json"], cwd, Duration::from_secs(15));
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
        .split(|ch| matches!(ch, '.' | '-' | '+'))
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

fn codewhale_config_compatibility(path: &Path) -> Value {
    const MAX_CONFIG_BYTES: u64 = 256 * 1024;
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
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_CONFIG_BYTES
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

#[tauri::command]
pub fn diagnose_agent(provider: String) -> Result<Value, String> {
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
            run_probe(
                path,
                &["--version"],
                &working_directory,
                Duration::from_secs(5),
            )
        })
        .unwrap_or(Value::Null);
    let companion_version = if spec.id == "codewhale" {
        companion
            .as_deref()
            .map(|path| {
                run_probe(
                    path,
                    &["--version"],
                    &working_directory,
                    Duration::from_secs(5),
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
                    run_probe(
                        path,
                        &["doctor"],
                        &working_directory,
                        Duration::from_secs(15),
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
                run_probe(
                    path,
                    &["auth", "status"],
                    &working_directory,
                    Duration::from_secs(8),
                )
            })
            .unwrap_or(Value::Null),
        "codex" => executable
            .as_deref()
            .map(|path| {
                run_probe(
                    path,
                    &["login", "status"],
                    &working_directory,
                    Duration::from_secs(8),
                )
            })
            .unwrap_or(Value::Null),
        "opencode" => executable
            .as_deref()
            .map(|path| {
                run_probe(
                    path,
                    &["auth", "list"],
                    &working_directory,
                    Duration::from_secs(8),
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
        let hook_block = std::fs::read_to_string(&path)
            .ok()
            .is_some_and(|raw| raw.contains("# >>> octopus:codewhale-hooks:v2 >>>"));
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
            object.insert("octopusHookBlock".into(), Value::Bool(hook_block));
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
            return Command::new("cmd.exe")
                .args(["/D", "/S", "/C"])
                .arg(cmd_call(executable))
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
        let provider = state
            .runtime
            .config()
            .providers
            .into_iter()
            .next();
        match provider {
            Some(p) => launch_agent(p),
            None => open_panel(app),
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
) -> Result<(), String> {
    platform_state.set_visual_bounds(&rect)
}

#[tauri::command]
pub fn quit_app(app: AppHandle, state: State<'_, AppState>) {
    state
        .runtime
        .cancel_all_pending("Octopus is shutting down; permission denied");
    app.exit(0);
}

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
        "opencode" => &["--dir", "."],
        _ => &[],
    }
}

#[cfg(windows)]
fn cmd_launch_call(path: &Path, args: &[&str]) -> String {
    let mut command_line = vec![cmd_call(path)];
    command_line.extend(args.iter().map(|value| cmd_quote_arg(*value)));
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
                command
                    .arg("cmd.exe")
                    .args(["/D", "/S", "/K"])
                    .arg(cmd_launch_call(executable, launch_args));
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
            parts.extend(launch_args.iter().map(|value| cmd_quote_arg(*value)));
            parts.join(" ")
        };
        Command::new("cmd.exe")
            .args(["/D", "/S", "/K"])
            .arg(command_line)
            .current_dir(cwd)
            .spawn()
            .map(|_| ())
            .map_err(|e| {
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
        command.extend(agent_launch_args(spec).iter().map(|arg| shell_quote(*arg)));
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
