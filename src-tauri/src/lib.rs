mod commands;
pub mod hook_client;
mod hook_install;
mod http_server;
mod i18n;
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
                    // R24 (2026-07-30): pet_position is stored as LOGICAL
                    // coordinates (per R22 commit_win_pos fix). Convert to
                    // physical before calling set_position, which expects
                    // PhysicalPosition. Without this, a 150%-scale display
                    // would place the pet at 2/3 of the saved position.
                    let scale = window.scale_factor().unwrap_or(1.0);
                    let phys_x = (position.x as f64 * scale).round() as i32;
                    let phys_y = (position.y as f64 * scale).round() as i32;
                    let _ = window.set_position(Position::Physical(
                        PhysicalPosition::new(phys_x, phys_y),
                    ));
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
            platform_for_setup.start_cursor_hit_test(app.handle().clone());
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
            set_language,
            set_mode,
            uninstall_hooks,
            set_skin,
            set_session_prefs,
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
            commit_win_pos,
            set_ignore_mouse,
            set_pet_tall,
            set_pet_big,
            set_pet_size,
            set_panel_height,
            focus_pet,
            blur_pet,
            decide_permission,
            decide_permission_batch,
            diagnose_agent,
            launch_agent,
            launch_agent_in,
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
            if let Some(tray) = app_handle.tray_by_id("main-tray") {
                let _ = tray.set_visible(false);
            }
            let _ = app_handle.remove_tray_by_id("main-tray");
            let state = app_handle.state::<AppState>();
            state.runtime.write_log("shutdown", "tray icon removed");
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

fn build_tray_menu<R: tauri::Runtime>(
    app: &impl tauri::Manager<R>,
    lang: &str,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, SubmenuBuilder};
    let show = MenuItem::with_id(
        app,
        "show",
        i18n::tray_label(lang, "tray.showPet"),
        true,
        None::<&str>,
    )?;
    let panel = MenuItem::with_id(
        app,
        "panel",
        i18n::tray_label(lang, "tray.panel"),
        true,
        None::<&str>,
    )?;
    let log = MenuItem::with_id(
        app,
        "log",
        i18n::tray_label(lang, "tray.openLog"),
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        "quit",
        i18n::tray_label(lang, "tray.quit"),
        true,
        None::<&str>,
    )?;
    // New-agent submenu: launch any of the 5 providers, not just Claude.
    // Item ids stay stable across languages so the on_menu_event handler
    // never needs to know which language produced the label.
    let launch_claude = MenuItem::with_id(
        app,
        "launch_claude",
        i18n::tray_label(lang, "tray.launchClaude"),
        true,
        None::<&str>,
    )?;
    let launch_cw = MenuItem::with_id(
        app,
        "launch_codewhale",
        i18n::tray_label(lang, "tray.launchCodewhale"),
        true,
        None::<&str>,
    )?;
    let launch_codex = MenuItem::with_id(
        app,
        "launch_codex",
        i18n::tray_label(lang, "tray.launchCodex"),
        true,
        None::<&str>,
    )?;
    let launch_opencode = MenuItem::with_id(
        app,
        "launch_opencode",
        i18n::tray_label(lang, "tray.launchOpencode"),
        true,
        None::<&str>,
    )?;
    let launch_aider = MenuItem::with_id(
        app,
        "launch_aider",
        i18n::tray_label(lang, "tray.launchAider"),
        true,
        None::<&str>,
    )?;
    let launch_menu = SubmenuBuilder::new(app, i18n::tray_label(lang, "tray.launchAgent"))
        .item(&launch_claude)
        .item(&launch_cw)
        .item(&launch_codex)
        .item(&launch_opencode)
        .item(&launch_aider)
        .build()?;

    // R12 (2026-07-30): language submenu (radio-like via CheckMenuItem;
    // on pick we update config + persist + emit + call refresh_tray_menu
    // which rebuilds the menu so the new selection shows the check mark).
    let config = app.state::<AppState>().runtime.config();
    let lang_zh = CheckMenuItem::with_id(
        app,
        "lang_zh",
        i18n::tray_label(lang, "lang.zh"),
        true,
        lang == "zh",
        None::<&str>,
    )?;
    let lang_en = CheckMenuItem::with_id(
        app,
        "lang_en",
        i18n::tray_label(lang, "lang.en"),
        true,
        lang == "en",
        None::<&str>,
    )?;
    let lang_ja = CheckMenuItem::with_id(
        app,
        "lang_ja",
        i18n::tray_label(lang, "lang.ja"),
        true,
        lang == "ja",
        None::<&str>,
    )?;
    let lang_menu = SubmenuBuilder::new(app, i18n::tray_label(lang, "tray.language"))
        .item(&lang_zh)
        .item(&lang_en)
        .item(&lang_ja)
        .build()?;

    // Skin submenu — 3 skins, only the active one is checked.
    let skin_mascot = CheckMenuItem::with_id(
        app,
        "skin_mascot",
        i18n::tray_label(lang, "skin.mascot"),
        true,
        config.skin == "mascot",
        None::<&str>,
    )?;
    let skin_pixel = CheckMenuItem::with_id(
        app,
        "skin_pixel",
        i18n::tray_label(lang, "skin.pixel"),
        true,
        config.skin == "pixel",
        None::<&str>,
    )?;
    let skin_cat = CheckMenuItem::with_id(
        app,
        "skin_cat",
        i18n::tray_label(lang, "skin.cat"),
        true,
        config.skin == "cat",
        None::<&str>,
    )?;
    let skin_menu = SubmenuBuilder::new(app, i18n::tray_label(lang, "tray.skin"))
        .item(&skin_mascot)
        .item(&skin_pixel)
        .item(&skin_cat)
        .build()?;

    // 5h budget submenu — Off + 5 preset values. The upstream Electron
    // tray uses $10/$20/$30/$50/$100; we keep the same presets. Values
    // are formatted as "$N" in every locale (currency symbol is universal
    // enough; the "Off" label is localized via tray.budgetOff).
    let budget_off = CheckMenuItem::with_id(
        app,
        "budget_0",
        i18n::tray_label(lang, "tray.budgetOff"),
        true,
        config.budget5h == 0.0,
        None::<&str>,
    )?;
    let budget_10 = CheckMenuItem::with_id(
        app,
        "budget_10",
        "$10",
        true,
        config.budget5h == 10.0,
        None::<&str>,
    )?;
    let budget_20 = CheckMenuItem::with_id(
        app,
        "budget_20",
        "$20",
        true,
        config.budget5h == 20.0,
        None::<&str>,
    )?;
    let budget_30 = CheckMenuItem::with_id(
        app,
        "budget_30",
        "$30",
        true,
        config.budget5h == 30.0,
        None::<&str>,
    )?;
    let budget_50 = CheckMenuItem::with_id(
        app,
        "budget_50",
        "$50",
        true,
        config.budget5h == 50.0,
        None::<&str>,
    )?;
    let budget_100 = CheckMenuItem::with_id(
        app,
        "budget_100",
        "$100",
        true,
        config.budget5h == 100.0,
        None::<&str>,
    )?;
    let budget_menu = SubmenuBuilder::new(app, i18n::tray_label(lang, "tray.budget"))
        .item(&budget_off)
        .item(&budget_10)
        .item(&budget_20)
        .item(&budget_30)
        .item(&budget_50)
        .item(&budget_100)
        .build()?;

    // R14 (2026-07-30): shape submenu — replaces the upstream Electron
    // "menubar" mode. Tauri has no native menubar; "hidePet" hides the pet
    // window so the user gets a tray-only experience. "pet" is the default
    // floating pet; "panel" is reserved for a future corner-panel layout
    // (currently the panel is a separate window opened from the tray).
    let shape_pet = CheckMenuItem::with_id(
        app,
        "shape_pet",
        i18n::tray_label(lang, "shape.pet"),
        true,
        config.mode == "pet",
        None::<&str>,
    )?;
    let shape_panel = CheckMenuItem::with_id(
        app,
        "shape_panel",
        i18n::tray_label(lang, "shape.panel"),
        true,
        config.mode == "panel",
        None::<&str>,
    )?;
    let shape_hide = CheckMenuItem::with_id(
        app,
        "shape_hidePet",
        i18n::tray_label(lang, "shape.hidePet"),
        true,
        config.mode == "hidePet",
        None::<&str>,
    )?;
    let shape_menu = SubmenuBuilder::new(app, i18n::tray_label(lang, "tray.shape"))
        .item(&shape_pet)
        .item(&shape_panel)
        .item(&shape_hide)
        .build()?;

    // Mute toggle — single check item, label flips between mute/unmute
    // depending on current state. on_menu_event routes to toggle_mute
    // which already persists + emits; refresh_tray_menu rebuilds so the
    // label and check mark both update.
    let mute_label = if config.muted {
        i18n::tray_label(lang, "tray.unmute")
    } else {
        i18n::tray_label(lang, "tray.mute")
    };
    let mute_item = CheckMenuItem::with_id(
        app,
        "toggle_mute",
        mute_label,
        true,
        config.muted,
        None::<&str>,
    )?;

    // R13 (2026-07-30): "Settings" is a disabled placeholder so the tray
    // visually matches the upstream Electron layout. A real settings panel
    // is reachable from the dashboard; this item signals that the tray is
    // not the place for full settings.
    let settings = MenuItem::with_id(
        app,
        "settings",
        i18n::tray_label(lang, "tray.settings"),
        false,
        None::<&str>,
    )?;

    // R13: "Uninstall Claude hooks" — single-provider hook cleanup.
    // Default provider is Claude (matches upstream Electron tray label);
    // the underlying command accepts any of the 5 providers.
    let uninstall_hooks = MenuItem::with_id(
        app,
        "uninstall_claude_hooks",
        i18n::tray_label(lang, "tray.uninstallHook"),
        true,
        None::<&str>,
    )?;

    // Separators between logical groups: launch / settings / quit.
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;

    Menu::with_items(
        app,
        &[
            &show,
            &panel,
            &sep1,
            &lang_menu,
            &skin_menu,
            &budget_menu,
            &shape_menu,
            &mute_item,
            &sep2,
            &settings,
            &launch_menu,
            &log,
            &uninstall_hooks,
            &sep3,
            &quit,
        ],
    )
}

/// Read the current language from `AppState` and rebuild the tray menu so
/// the OS-rendered labels track the renderer language switch.
/// Called from `set_language` after the config is updated and emitted.
pub fn refresh_tray_menu(app: &tauri::AppHandle) {
    let lang = app.state::<AppState>().runtime.config().lang;
    let Some(tray) = app.tray_by_id("main-tray") else {
        return;
    };
    // R13: also refresh the tooltip so it tracks language switches.
    let _ = tray.set_tooltip(Some(i18n::tray_label(&lang, "tray.tooltip")));
    match build_tray_menu(app, &lang) {
        Ok(menu) => {
            if let Err(error) = tray.set_menu(Some(menu)) {
                app.state::<AppState>().runtime.write_log(
                    "tray",
                    &format!("refresh_tray_menu set_menu failed: {error}"),
                );
            }
        }
        Err(error) => {
            app.state::<AppState>()
                .runtime
                .write_log("tray", &format!("refresh_tray_menu build failed: {error}"));
        }
    }
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    // R11 (2026-07-30): tray labels are localized via `i18n::tray_label`
    // using the same dictionary as `frontend/shared/i18n.js`.
    // `refresh_tray_menu` (above) rebuilds the menu when the user changes
    // the language from the panel.
    let lang = app.state::<AppState>().runtime.config().lang;
    let menu = build_tray_menu(app, &lang)?;

    // R10 (2026-07-30): TrayIconBuilder::new() takes no args in Tauri 2.11.5;
    // use `with_id` to assign the "main-tray" id that RunEvent::ExitRequested
    // uses via `app_handle.tray_by_id("main-tray")`. The earlier `.new("main-tray")`
    // form was a compile error (E0061) — see docs/MIGRATION_R9_UNDERSTANDING_REPORT
    // §6.4 and the public commit log "fix(lib): TrayIconBuilder::new() takes no
    // args in Tauri 2.11.5 (E0061)". The fix was never applied to this zip.
    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        // R13 (2026-07-30): localized tooltip; refresh_tray_menu rebuilds
        // the menu but does not yet update the tooltip. The tooltip is
        // set once at startup with the current language; a future round
        // could extend refresh_tray_menu to call tray.set_tooltip too.
        .tooltip(i18n::tray_label(&lang, "tray.tooltip"))
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
            // R12 (2026-07-30): tray-driven config switches. Each branch
            // mirrors the corresponding #[tauri::command] in commands.rs:
            // update_config + emit_config + (for lang/mute) refresh_tray_menu
            // so the OS-rendered check mark and label track the new state.
            // lang_*: set_language also calls refresh_tray_menu internally,
            // so we don't double-refresh here.
            "lang_zh" => {
                let _ = set_language(app.clone(), app.state::<AppState>(), "zh".into());
            }
            "lang_en" => {
                let _ = set_language(app.clone(), app.state::<AppState>(), "en".into());
            }
            "lang_ja" => {
                let _ = set_language(app.clone(), app.state::<AppState>(), "ja".into());
            }
            "skin_mascot" | "skin_pixel" | "skin_cat" => {
                let skin = match event.id.as_ref() {
                    "skin_mascot" => "mascot",
                    "skin_pixel" => "pixel",
                    "skin_cat" => "cat",
                    _ => return,
                };
                let _ = set_skin(app.clone(), app.state::<AppState>(), skin.into());
                // Skin change doesn't change labels, but the check mark
                // moves; rebuild so the new selection is visually marked.
                refresh_tray_menu(app);
            }
            "budget_0" | "budget_10" | "budget_20" | "budget_30" | "budget_50" | "budget_100" => {
                let value: f64 = match event.id.as_ref() {
                    "budget_0" => 0.0,
                    "budget_10" => 10.0,
                    "budget_20" => 20.0,
                    "budget_30" => 30.0,
                    "budget_50" => 50.0,
                    "budget_100" => 100.0,
                    _ => return,
                };
                let _ = set_budget(app.clone(), app.state::<AppState>(), value);
                refresh_tray_menu(app);
            }
            // R14 (2026-07-30): shape submenu routes to set_mode. set_mode
            // now has a window side-effect (hidePet hides the pet window;
            // pet/panel show it). refresh_tray_menu moves the check mark.
            "shape_pet" | "shape_panel" | "shape_hidePet" => {
                let mode = match event.id.as_ref() {
                    "shape_pet" => "pet",
                    "shape_panel" => "panel",
                    "shape_hidePet" => "hidePet",
                    _ => return,
                };
                let _ = set_mode(app.clone(), app.state::<AppState>(), mode.into());
                refresh_tray_menu(app);
            }
            "toggle_mute" => {
                let _ = toggle_mute(app.clone(), app.state::<AppState>());
                // Mute label flips between tray.mute and tray.unmute;
                // rebuild so the label and check mark both update.
                refresh_tray_menu(app);
            }
            "log" => {
                let state = app.state::<AppState>();
                let _ = open_log(state);
            }
            // R13 (2026-07-30): tray-driven single-provider hook uninstall.
            // The menu id is "uninstall_claude_hooks" to match the upstream
            // Electron label, but the underlying command accepts any of the
            // 5 providers. Future tray revisions could expose a submenu with
            // one entry per provider.
            "uninstall_claude_hooks" => {
                let _ = uninstall_hooks(app.clone(), app.state::<AppState>(), "claude".into());
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
    let _tray = builder.build(app)?;
    // R10 (2026-07-30): drop the redundant managed-handle registration. With
    // `with_id`, Tauri already tracks the tray by id and `tray_by_id("main-tray")`
    // works without holding an extra managed handle. Keeping a second handle
    // would create ambiguous ownership on shutdown.
    Ok(())
}
