use crate::hook_install;
use crate::model::{AppState, Point};
use crate::platform;
use serde_json::{json, Value};
use std::path::Path;
use std::process::Command;
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
pub fn set_mode(app: AppHandle, state: State<'_, AppState>, mode: String) -> Result<(), String> {
    state.runtime.update_config(|config| config.mode = mode)?;
    emit_config(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn set_skin(app: AppHandle, state: State<'_, AppState>, skin: String) -> Result<(), String> {
    state.runtime.update_config(|config| config.skin = skin)?;
    emit_config(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn set_budget(app: AppHandle, state: State<'_, AppState>, value: f64) -> Result<(), String> {
    state.runtime.update_config(|config| config.budget5h = value)?;
    emit_config(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn set_currency(app: AppHandle, state: State<'_, AppState>, currency: String) -> Result<(), String> {
    state.runtime.update_config(|config| config.currency = currency)?;
    emit_config(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn toggle_mute(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.runtime.update_config(|config| config.muted = !config.muted)?;
    emit_config(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn set_providers(app: AppHandle, state: State<'_, AppState>, ids: Vec<String>) -> Result<(), String> {
    state.runtime.update_config(|config| config.providers = ids)?;
    let statuses = hook_install::resync_current(&state.runtime)?;
    emit_config(&app, &state);
    let errors: Vec<String> = statuses.into_iter().filter(|s| s.state == "error").map(|s| format!("{}: {}", s.id, s.message)).collect();
    if !errors.is_empty() {
        let _ = app.emit("pet:event", json!({"kind":"error","text":errors.join("；")}));
    }
    Ok(())
}

#[tauri::command]
pub fn territory_toggle_auto(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let config = state.runtime.update_config(|config| config.territory = !config.territory)?;
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
pub fn territory_run_now(app: AppHandle) {
    let _ = app.emit(
        "pet:event",
        json!({"kind":"say","text":"Tauri 核心已接管桌宠；领地巡视的原生平台适配尚未在本阶段启用。"}),
    );
}

#[tauri::command]
pub fn open_panel(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("panel").ok_or("panel window missing")?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_panel(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("panel").ok_or("panel window missing")?;
    window.hide().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_win_pos(app: AppHandle) -> Result<[i32; 2], String> {
    let window = app.get_webview_window("pet").ok_or("pet window missing")?;
    let position = window.outer_position().map_err(|e| e.to_string())?;
    // Renderer contract: return the position as [x, y].
    Ok([position.x, position.y])
}

#[tauri::command]
pub fn set_win_pos(app: AppHandle, state: State<'_, AppState>, x: i32, y: i32) -> Result<(), String> {
    let window = app.get_webview_window("pet").ok_or("pet window missing")?;
    window
        .set_position(Position::Physical(PhysicalPosition::new(x, y)))
        .map_err(|e| e.to_string())?;
    state.runtime.update_config(|config| config.pet_position = Some(Point { x, y }))?;
    emit_config(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn set_ignore_mouse(app: AppHandle, ignore: bool) -> Result<(), String> {
    app.get_webview_window("pet")
        .ok_or("pet window missing")?
        .set_ignore_cursor_events(ignore)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_pet_tall(app: AppHandle, tall: bool) -> Result<(), String> {
    set_pet_size(app, 320.0, if tall { 620.0 } else { 340.0 })
}

#[tauri::command]
pub fn set_pet_big(app: AppHandle, on: bool) -> Result<(), String> {
    set_pet_size(app, if on { 520.0 } else { 320.0 }, if on { 700.0 } else { 340.0 })
}

#[tauri::command]
pub fn set_pet_size(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let (width, height) = if width <= 0.0 || height <= 0.0 {
        (320.0, 340.0)
    } else {
        (width.clamp(240.0, 1200.0), height.clamp(240.0, 1200.0))
    };
    app.get_webview_window("pet")
        .ok_or("pet window missing")?
        .set_size(Size::Physical(PhysicalSize::new(width.round() as u32, height.round() as u32)))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_panel_height(app: AppHandle, height: f64) -> Result<(), String> {
    let window = app.get_webview_window("panel").ok_or("panel window missing")?;
    let current = window.outer_size().map_err(|e| e.to_string())?;
    let height = if height <= 0.0 { 720 } else { height.round().clamp(480.0, 1200.0) as u32 };
    window
        .set_size(Size::Physical(PhysicalSize::new(current.width.max(560), height)))
        .map_err(|e| e.to_string())
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

#[tauri::command]
pub fn launch_agent(provider: String) -> Result<(), String> {
    let command = match provider.as_str() {
        "codewhale" => "codewhale",
        "codex" => "codex",
        "opencode" => "opencode",
        "aider" => "aider",
        _ => "claude",
    };
    launch_terminal(command)
}

#[tauri::command]
pub fn focus_session(app: AppHandle, state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    match platform::focus_session(&app, &state, &session_id) {
        Ok(()) => Ok(()),
        Err(error) => {
            state.runtime.write_log("focus", &format!("native focus unavailable for {session_id}: {error}"));
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
        .and_then(|sessions| sessions.iter().find(|session| {
            session.get("status").and_then(Value::as_str).is_some_and(|status| !matches!(status, "ended" | "idle"))
        }))
        .and_then(|session| session.get("id").and_then(Value::as_str))
        .map(str::to_owned);
    if let Some(session_id) = active_session {
        focus_session(app, state, session_id)
    } else {
        let provider = state.runtime.config().providers.into_iter().next().unwrap_or_else(|| "claude".into());
        launch_agent(provider)
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
pub fn ui_busy(_on: bool) {}

#[tauri::command]
pub fn pet_visual_bounds(_rect: Value) {}

#[tauri::command]
pub fn quit_app(app: AppHandle, state: State<'_, AppState>) {
    state.runtime.cancel_all_pending("Octopus is shutting down; permission denied");
    app.exit(0);
}

fn launch_terminal(command: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", "cmd", "/K", command])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let escaped = command.replace('"', "\\\"");
        let script = format!("tell application \"Terminal\" to do script \"{escaped}\"");
        Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let candidates = [
            ("x-terminal-emulator", vec!["-e", command]),
            ("gnome-terminal", vec!["--", command]),
            ("konsole", vec!["-e", command]),
            ("xterm", vec!["-e", command]),
        ];
        for (program, args) in candidates {
            if Command::new(program).args(args).spawn().is_ok() {
                return Ok(());
            }
        }
        Command::new(command).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}

fn open_path(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let path = path.to_string_lossy().into_owned();
        Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(path).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open").arg(path).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}
