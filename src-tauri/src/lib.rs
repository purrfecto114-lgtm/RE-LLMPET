mod commands;
pub mod hook_client;
mod hook_install;
mod http_server;
mod metering;
mod model;
mod platform;
mod pricing_sync;
mod transcript;

use commands::*;
use model::AppState;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, PhysicalPosition, Position, RunEvent};

pub fn run() {
    let platform_state = Arc::new(platform::PlatformState::default());
    let platform_for_setup = platform_state.clone();
    let platform_for_events = platform_state.clone();
    let tray_removed = Arc::new(AtomicBool::new(false));

    let app = tauri::Builder::default()
        .manage(AppState::new())
        .manage(platform_state)
        .setup(move |app| {
            setup_tray(app)?;
            let state = app.state::<AppState>();
            if let Some(position) = state.runtime.config().pet_position {
                if let Some(window) = app.get_webview_window("pet") {
                    let _ = window.set_position(Position::Physical(PhysicalPosition::new(
                        position.x, position.y,
                    )));
                }
            }
            if let Err(error) =
                platform_for_setup.recover_windows(app.handle(), &state.runtime, true)
            {
                state
                    .runtime
                    .write_log("display", &format!("startup recovery skipped: {error}"));
            }
            platform_for_setup.start_health_check(app.handle().clone(), state.runtime.clone());
            match http_server::start(state.runtime.clone(), app.handle().clone()) {
                Ok(server) => {
                    state.runtime.write_log(
                        "startup",
                        &format!("Tauri core ready on port {}", server.port),
                    );
                    let config = state.runtime.config();
                    let statuses = hook_install::sync_enabled(
                        &state.runtime,
                        server.port,
                        &server.token,
                        config.perm_hook,
                        &config.providers,
                    );
                    for status in statuses.iter().filter(|status| status.state == "error") {
                        state.runtime.write_log(
                            "hooks",
                            &format!("{} hook sync failed: {}", status.id, status.message),
                        );
                    }
                }
                Err(error) => {
                    state
                        .runtime
                        .write_log("startup", &format!("HTTP server disabled: {error}"));
                    let _ = app.emit(
                        "pet:event",
                        json!({"kind":"error","text":format!("本地 Agent 服务启动失败：{error}")}),
                    );
                }
            }
            pricing_sync::start(state.runtime.clone(), app.handle().clone());
            let config = state.runtime.config_view();
            let stats = state.runtime.stats();
            let _ = app.emit("pet:config", config.clone());
            let _ = app.emit("panel:config", config);
            let _ = app.emit("pet:stats", stats.clone());
            let _ = app.emit("panel:stats", stats);
            let _ = app.emit("panel:price", state.runtime.price_info());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            get_stats,
            get_price_info,
            refresh_model_prices,
            set_price_auto_update,
            set_mode,
            set_skin,
            set_budget,
            set_currency,
            toggle_mute,
            set_providers,
            territory_toggle_auto,
            territory_run_now,
            open_panel,
            close_panel,
            get_win_pos,
            set_win_pos,
            set_ignore_mouse,
            set_pet_tall,
            set_pet_big,
            set_pet_size,
            set_panel_height,
            focus_pet,
            blur_pet,
            decide_permission,
            decide_permission_batch,
            launch_agent,
            launch_agent_gui,
            focus_session,
            primary_action,
            open_log,
            pet_log,
            ui_busy,
            pet_visual_bounds,
            quit_app
        ])
        .build(tauri::generate_context!())
        .expect("error while building Octopus");

    app.run(move |app_handle, event| match event {
        RunEvent::ExitRequested { .. } => {
            if tray_removed.swap(true, Ordering::Relaxed) {
                return;
            }
            // Hide all webview windows so the app appears to quit immediately
            // even if the event loop takes a moment to drain.
            if let Some(pet) = app_handle.get_webview_window("pet") {
                let _ = pet.hide();
            }
            if let Some(panel) = app_handle.get_webview_window("panel") {
                let _ = panel.hide();
            }
            let state = app_handle.state::<AppState>();
            state
                .runtime
                .write_log("shutdown", "windows hidden on exit request");
        }
        RunEvent::Resumed => {
            let state = app_handle.state::<AppState>();
            if let Err(error) =
                platform_for_events.recover_windows(app_handle, &state.runtime, true)
            {
                state
                    .runtime
                    .write_log("display", &format!("resume recovery failed: {error}"));
            }
        }
        _ => {}
    });
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Submenu, SubmenuBuilder};
    let show = MenuItem::with_id(app, "show", "显示桌宠", true, None::<&str>)?;
    let panel = MenuItem::with_id(app, "panel", "打开详情", true, None::<&str>)?;
    let log = MenuItem::with_id(app, "log", "打开日志", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    // New-agent submenu: launch any of the 5 providers, not just Claude.
    let launch_claude = MenuItem::with_id(app, "launch_claude", "Claude Code", true, None::<&str>)?;
    let launch_cw = MenuItem::with_id(app, "launch_codewhale", "CodeWhale", true, None::<&str>)?;
    let launch_codex = MenuItem::with_id(app, "launch_codex", "Codex", true, None::<&str>)?;
    let launch_opencode =
        MenuItem::with_id(app, "launch_opencode", "OpenCode", true, None::<&str>)?;
    let launch_aider = MenuItem::with_id(app, "launch_aider", "Aider", true, None::<&str>)?;
    let launch_menu = SubmenuBuilder::new(app, "新开 Agent")
        .item(&launch_claude)
        .item(&launch_cw)
        .item(&launch_codex)
        .item(&launch_opencode)
        .item(&launch_aider)
        .build()?;
    let menu = Menu::with_items(app, &[&show, &panel, &launch_menu, &log, &quit])?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("pet") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "panel" => {
                let _ = open_panel(app.clone());
            }
            "launch_claude" => {
                let _ = launch_agent("claude".into());
            }
            "launch_codewhale" => {
                let _ = launch_agent("codewhale".into());
            }
            "launch_codex" => {
                let _ = launch_agent("codex".into());
            }
            "launch_opencode" => {
                let _ = launch_agent("opencode".into());
            }
            "launch_aider" => {
                let _ = launch_agent("aider".into());
            }
            "log" => {
                let state = app.state::<AppState>();
                let _ = open_log(state);
            }
            "quit" => {
                let state = app.state::<AppState>();
                state
                    .runtime
                    .cancel_all_pending("Octopus is shutting down; permission denied");
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("pet") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let tray = builder.build(app)?;
    app.manage(tray);
    Ok(())
}
