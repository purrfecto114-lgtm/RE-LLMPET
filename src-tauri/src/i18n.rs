//! R11 (2026-07-30) — Native-side i18n for the system tray.
//!
//! The frontend `frontend/shared/i18n.js` is the canonical source of truth
//! for every user-visible string. The Rust side only needs a small subset
//! of those strings for native surfaces the renderer cannot reach — most
//! notably the system-tray menu (which is built by the OS, not the WebView).
//!
//! To stay in lockstep with the frontend dictionary without parsing
//! JavaScript at runtime, this module inlines the same `tray.*` and
//! `skin.*` keys for `zh`/`en`/`ja`. `test/tauri-tray-i18n-r11-smoke.js`
//! cross-checks every key in this module against `frontend/shared/i18n.js`
//! for all three languages, so a future maintainer who updates one side
//! without the other will see a smoke failure.
//!
//! Adding a new tray label:
//!   1. Add the key to `frontend/shared/i18n.js` for zh/en/ja.
//!   2. Add the same three values to the `TRAY_LABELS` table below.
//!   3. Re-run `npm test` — `tauri-tray-i18n-r11-smoke.js` verifies parity.
//!
//! Future enhancement (deferred): generate this module from `i18n.js` at
//! build time via `build.rs` so the table cannot drift. Until that build
//! step exists, the smoke test is the contract.

/// All native-side labels currently consumed by `setup_tray` and
/// `refresh_tray_menu`. Each row is `(key, zh, en, ja)`. Add a new row
/// when the tray grows a new label.
///
/// R58-IMPL-D (B9): rows below the divider are TOAST labels (not menu
/// labels). They share the same table + parity smoke because the r11
/// contract covers every key in this module; the toast.* keys are consumed
/// by `tray_toast_error` / `emit_tray_toast` (lib.rs) and `toggle_mute`
/// (commands.rs), and mirrored frontend keys (toast.rebuildDone /
/// toast.exportDone) are consumed by panel.js / panel-export.js.
///
/// R22 (2026-07-30): `#[rustfmt::skip]` keeps the table on single lines
/// so it stays human-readable (56 rows, one per line) and the smoke-test
/// regex can parse each row. Without this, `cargo fmt`'s default
/// `array_width=60` splits long rows (e.g. Japanese text) into 6 lines
/// per entry, making the table unreadable and breaking the cross-source
/// consistency smoke. `#[rustfmt::skip]` is stable since Rust 1.30
/// (RFC 2103) and is the canonical Rust community pattern for static
/// lookup tables.
#[rustfmt::skip]
pub const TRAY_LABELS: &[(&str, &str, &str, &str)] = &[
    ("tray.tooltip",        "Octopus — Claude Code / Codex 桌宠",   "Octopus — Claude Code / Codex desk pet",   "Octopus — Claude Code / Codex デスクトップペット"),
    ("tray.panel",          "📊 详情面板",                         "📊 Dashboard",                            "📊 ダッシュボード"),
    ("tray.showPet",        "🐙 显示桌宠",                         "🐙 Show pet",                             "🐙 ペットを表示"),
    ("tray.settings",       "⚙️ 设置",                             "⚙️ Settings",                             "⚙️ 設定"),
    ("tray.settingsMenu",   "⚙️ 设置",                             "⚙️ Settings",                             "⚙️ 設定"),
    ("tray.refreshPrice",   "🔄 刷新价格",                         "🔄 Refresh prices",                       "🔄 価格を更新"),
    ("tray.priceAuto",      "价格自动更新",                        "Auto-update prices",                      "価格の自動更新"),
    ("tray.openDiagnostics","🔍 诊断信息",                         "🔍 Diagnostics",                          "🔍 診断情報"),
    ("tray.openLogDir",     "📁 打开数据目录",                     "📁 Open data directory",                  "📁 データディレクトリを開く"),
    ("tray.language",       "　🌐 语言 / Language",                "　🌐 Language / 语言",                    "　🌐 言語 / Language"),
    ("tray.skin",           "　形象",                              "　Skin",                                  "　見た目"),
    ("tray.shape",          "　形态",                              "　Layout",                                "　表示形式"),
    ("tray.budget",         "　5h 预算",                           "　5h budget",                             "　5時間の予算"),
    ("tray.budgetOff",      "关闭",                                "Off",                                     "オフ"),
    ("tray.mute",           "　🔇 静音",                           "　🔇 Mute",                               "　🔇 ミュート"),
    ("tray.unmute",         "　🔔 取消静音",                       "　🔔 Unmute",                             "　🔔 ミュート解除"),
    ("tray.openLog",        "📄 打开日志",                         "📄 Open log",                             "📄 ログを開く"),
    // R58-IMPL-D (A5): the tray item now cleans ALL five providers, not
    // just Claude — the label says so.
    ("tray.uninstallHook",  "🧹 卸载全部钩子",                     "🧹 Uninstall all hooks",                  "🧹 すべてのフックを削除"),
    ("tray.quit",           "⏻ 退出",                             "⏻ Quit",                                 "⏻ 終了"),
    ("tray.launchAgent",    "新开 Agent",                          "Launch agent",                            "エージェントを起動"),
    ("tray.launchClaude",   "🚀 唤起 Claude",                     "🚀 Launch Claude",                        "🚀 Claude を起動"),
    ("tray.launchCodewhale","🐳 唤起 CodeWhale",                 "🐳 Launch CodeWhale",                    "🐳 CodeWhale を起動"),
    ("tray.launchCodex",    "🛰️ 唤起 Codex",                     "🛰️ Launch Codex",                        "🛰️ Codex を起動"),
    ("tray.launchOpencode", "🔌 唤起 OpenCode",                    "🔌 Launch OpenCode",                       "🔌 OpenCode を起動"),
    ("tray.launchAider",    "🤝 唤起 Aider",                      "🤝 Launch Aider",                        "🤝 Aider を起動"),
    ("skin.mascot",         "章鱼",                                "Octopus",                                 "タコ"),
    ("skin.pixel",          "像素怪兽",                            "Pixel monster",                           "ドット怪獣"),
    ("skin.cat",            "月薪喵",                              "Payday Cat",                              "給料ニャン"),
    ("skin.whale",          "鲸鱼女仆",                            "Whale Maid",                              "クジラメイド"),
    ("lang.zh",             "简体中文",                            "简体中文",                                "简体中文"),
    ("lang.en",             "English",                             "English",                                 "English"),
    ("lang.ja",             "日本語",                              "日本語",                                  "日本語"),
    ("shape.pet",           "浮游桌宠",                            "Floating pet",                            "浮遊ペット"),
    ("shape.panel",         "角落面板",                            "Corner panel",                            "隅のパネル"),
    ("shape.hidePet",       "仅托盘（隐藏桌宠）",                  "Tray only (hide pet)",                    "トレイのみ（ペット非表示）"),
    // ── R58-IMPL-D (B6/B9): toast labels (see the module comment) ──────────
    ("toast.launchFail",    "🚀 启动失败",                         "🚀 Launch failed",                         "🚀 起動に失敗しました"),
    ("toast.openLogFail",   "📄 打开日志失败",                     "📄 Failed to open log",                    "📄 ログを開けませんでした"),
    ("toast.openDirFail",   "📁 打开数据目录失败",                 "📁 Failed to open data directory",         "📁 データディレクトリを開けませんでした"),
    ("toast.openPanelFail", "📊 打开面板失败",                     "📊 Failed to open panel",                  "📊 パネルを開けませんでした"),
    ("toast.saveFail",      "⚠️ 设置保存失败",                     "⚠️ Failed to save settings",               "⚠️ 設定の保存に失敗しました"),
    ("toast.muted",         "🔇 已静音",                           "🔇 Muted",                                 "🔇 ミュートしました"),
    ("toast.unmuted",       "🔔 已取消静音",                       "🔔 Unmuted",                               "🔔 ミュートを解除しました"),
    ("toast.rebuildDone",   "✅ 重算完成：{count} 个事件，花费变化 {delta}", "✅ Rebuilt: {count} events, cost delta {delta}", "✅ 再計算完了：{count} イベント、費用変化 {delta}"),
    ("toast.exportDone",    "✅ 已导出：{file}",                    "✅ Exported: {file}",                       "✅ エクスポート済み：{file}"),
    ("tray.toastPriceQueued",    "💰 价格刷新已入队",               "💰 Price refresh queued",                  "💰 価格更新をキューに入れました"),
    ("tray.toastUninstallDone",  "🧹 全部 Provider 钩子已卸载",     "🧹 All provider hooks uninstalled",        "🧹 すべてのプロバイダーフックを削除しました"),
    ("tray.toastUninstallFail",  "🧹 卸载失败",                     "🧹 Uninstall failed",                      "🧹 削除に失敗しました"),
    // ── R60-F9/F13 (backend say texts + price toast) ──────────────────
    // Rust-resolved pet bubbles: the backend reads runtime.config().lang
    // at emission time and sends the FINAL text (same pattern as the
    // travel.rs trilingual helpers). The r11 parity smoke requires every
    // row here to be mirrored key-for-key in frontend/shared/i18n.js.
    ("say.focus-fail",          "会话进程仍在运行，但无法聚焦它的窗口（macOS 请检查辅助功能权限）。为避免双进程写同一会话，未重新拉起。", "The session process is still running, but its window could not be focused (check the macOS Accessibility permission). Not relaunching, to avoid two processes writing the same session.", "セッションのプロセスはまだ実行中ですが、ウィンドウを前面に出せませんでした（macOS のアクセシビリティ権限を確認してください）。同じセッションを二つのプロセスが書き込まないよう、再起動はしていません。"),
    ("say.probe-lease-hold",    "这个会话的任务仍在运行（心跳未超时），未重新拉起终端；若终端确实已关，请约 90 秒后再试。", "This session's task is still running (heartbeat not stale); the terminal was not relaunched. If the terminal is really gone, try again in about 90 seconds.", "このセッションのタスクはまだ実行中です（ハートビート未タイムアウト）。ターミナルは再起動しませんでした。ターミナルが本当に閉じている場合は、約 90 秒後にもう一度お試しください。"),
    ("say.probe-untracked",     "该会话由后台观察器跟踪，无法聚焦或重开，已为你打开详情面板。", "This session is tracked by a background observer and cannot be focused or reopened; the dashboard has been opened for you.", "このセッションはバックグラウンドの観測器が追跡しているため、前面表示も再起動もできません。代わりに詳細パネルを開きました。"),
    ("say.probe-relaunch-fail", "无法重新打开会话：{error}。已为你打开详情面板。", "Could not reopen the session: {error}. The dashboard has been opened for you.", "セッションを再び開けませんでした：{error}。代わりに詳細パネルを開きました。"),
    ("say.territory-unsupported", "对手桌宠推挤仅支持 macOS/Windows，已把章鱼窗带回前台。", "Territory rival push requires macOS/Windows. Octopus window brought to front.", "ライバルペットの押し出しは macOS/Windows 専用です。タコのウィンドウを最前面に戻しました。"),
    ("say.territory-clear",     "巡逻完成，没有发现对手桌宠。", "Patrol complete, no rival pets found.", "パトロール完了、ライバルペットは見つかりませんでした。"),
    ("say.territory-disabled",  "已关闭领地模式。", "Territory mode disabled.", "テリトリーモードをオフにしました。"),
    ("say.resume-reopened",     "已为你重新打开这个会话。", "Reopened this session for you.", "このセッションを再び開きました。"),
    ("toast.priceFail",         "⚠️ 价格刷新失败",                   "⚠️ Price refresh failed",                  "⚠️ 価格の更新に失敗しました"),
];

/// Return the localized value for `key` in `lang`, falling back to `zh`
/// when the language is unknown. If `key` is not in the table, returns
/// the key itself (visible in the UI rather than silently empty — the
/// smoke test catches this case before it ships).
pub fn tray_label(lang: &str, key: &str) -> &'static str {
    for (k, zh, en, ja) in TRAY_LABELS {
        if *k == key {
            return match lang {
                "en" => en,
                "ja" => ja,
                _ => zh, // zh and unknown fall back to Chinese (project primary locale)
            };
        }
    }
    // R25 (2026-07-30): return a static fallback instead of Box::leak.
    // The old code leaked on every missing-key lookup — unbounded memory
    // growth if the smoke test ever missed a key. This const is 'static
    // and zero-allocation.
    MISSING_KEY_FALLBACK
}

/// Static fallback for missing i18n keys. Visible as `<?>` in the UI
/// so the bug is immediately noticeable rather than silently empty.
const MISSING_KEY_FALLBACK: &str = "<?>";

/// Return the list of all keys this module knows about. Used by the
/// smoke test to verify every key has a matching entry in the frontend
/// dictionary. Not called from Rust production code, so allow(dead_code).
#[allow(dead_code)]
pub fn known_keys() -> Vec<&'static str> {
    TRAY_LABELS.iter().map(|(k, _, _, _)| *k).collect()
}
