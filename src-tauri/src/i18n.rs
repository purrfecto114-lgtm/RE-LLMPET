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
pub const TRAY_LABELS: &[(&str, &str, &str, &str)] = &[
    (
        "tray.tooltip",
        "LLMPET — Claude Code / Codex 桌宠",
        "LLMPET — Claude Code / Codex desk pet",
        "LLMPET — Claude Code / Codex デスクトップペット",
    ),
    (
        "tray.panel",
        "📊 详情面板",
        "📊 Dashboard",
        "📊 ダッシュボード",
    ),
    (
        "tray.showPet",
        "🐙 显示桌宠",
        "🐙 Show pet",
        "🐙 ペットを表示",
    ),
    ("tray.settings", "⚙️ 设置", "⚙️ Settings", "⚙️ 設定"),
    (
        "tray.language",
        "　🌐 语言 / Language",
        "　🌐 Language / 语言",
        "　🌐 言語 / Language",
    ),
    ("tray.skin", "　形象", "　Skin", "　見た目"),
    ("tray.shape", "　形态", "　Layout", "　表示形式"),
    ("tray.budget", "　5h 预算", "　5h budget", "　5時間の予算"),
    ("tray.budgetOff", "关闭", "Off", "オフ"),
    ("tray.mute", "　🔇 静音", "　🔇 Mute", "　🔇 ミュート"),
    (
        "tray.unmute",
        "　🔔 取消静音",
        "　🔔 Unmute",
        "　🔔 ミュート解除",
    ),
    (
        "tray.openLog",
        "📄 打开日志",
        "📄 Open log",
        "📄 ログを開く",
    ),
    (
        "tray.uninstallHook",
        "🧹 卸载 Claude 钩子",
        "🧹 Uninstall Claude hooks",
        "🧹 Claude フックを削除",
    ),
    ("tray.quit", "⏻ 退出", "⏻ Quit", "⏻ 終了"),
    (
        "tray.launchAgent",
        "新开 Agent",
        "Launch agent",
        "エージェントを起動",
    ),
    (
        "tray.launchClaude",
        "🚀 唤起 Claude",
        "🚀 Launch Claude",
        "🚀 Claude を起動",
    ),
    (
        "tray.launchCodewhale",
        "🐳 唤起 CodeWhale",
        "🐳 Launch CodeWhale",
        "🐳 CodeWhale を起動",
    ),
    (
        "tray.launchCodex",
        "🛰️ 唤起 Codex",
        "🛰️ Launch Codex",
        "🛰️ Codex を起動",
    ),
    (
        "tray.launchOpencode",
        "🔌 唤起 OpenCode",
        "🔌 Launch OpenCode",
        "🔌 OpenCode を起動",
    ),
    (
        "tray.launchAider",
        "🤝 唤起 Aider",
        "🤝 Launch Aider",
        "🤝 Aider を起動",
    ),
    ("skin.mascot", "章鱼", "Octopus", "タコ"),
    ("skin.pixel", "像素怪兽", "Pixel monster", "ドット怪獣"),
    ("skin.cat", "月薪喵", "Payday Cat", "給料ニャン"),
    // R12 (2026-07-30): language submenu labels and shape submenu labels.
    ("lang.zh", "简体中文", "简体中文", "简体中文"),
    ("lang.en", "English", "English", "English"),
    ("lang.ja", "日本語", "日本語", "日本語"),
    ("shape.pet", "浮游桌宠", "Floating pet", "浮遊ペット"),
    ("shape.panel", "角落面板", "Corner panel", "隅のパネル"),
    (
        "shape.hidePet",
        "仅托盘（隐藏桌宠）",
        "Tray only (hide pet)",
        "トレイのみ（ペット非表示）",
    ),
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
    // Unreachable in practice: smoke test enumerates every key.
    // Leak the key so the return type stays 'static.
    Box::leak(key.to_string().into_boxed_str())
}

/// Return the list of all keys this module knows about. Used by the
/// smoke test to verify every key has a matching entry in the frontend
/// dictionary. Not called from Rust production code, so allow(dead_code).
#[allow(dead_code)]
pub fn known_keys() -> Vec<&'static str> {
    TRAY_LABELS.iter().map(|(k, _, _, _)| *k).collect()
}
