#!/usr/bin/env node
'use strict';

// R11 (2026-07-30) — Tray i18n + refresh_tray_menu contract.
//
// Background: R8's setup_tray built the tray once with hard-coded Chinese
// strings. Switching language from the panel left the OS-rendered tray
// labels stuck in Chinese. R11 introduced:
//
//   1. `src-tauri/src/i18n.rs` — a small static dictionary that mirrors the
//      `tray.*` and `skin.*` keys from `frontend/shared/i18n.js` for
//      zh/en/ja, plus a `tray_label(lang, key)` lookup.
//   2. `build_tray_menu(app, lang)` in `lib.rs` — uses `i18n::tray_label`
//      for every label so the menu tracks the configured language.
//   3. `pub fn refresh_tray_menu(app: &AppHandle)` — reads the current
//      lang from AppState, rebuilds the menu, and calls
//      `TrayIcon::set_menu(Some(menu))`.
//   4. `set_language` calls `refresh_tray_menu` after `emit_config` so a
//      panel language switch instantly refreshes the tray.
//
// This smoke cross-checks that:
//   - the Rust i18n table has the same keys and values as the frontend
//     dictionary for every tray-related key in all three languages;
//   - setup_tray and refresh_tray_menu both route through build_tray_menu;
//   - set_language calls refresh_tray_menu;
//   - the tray id ("main-tray") is stable so refresh can look it up.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const i18nRust = read('src-tauri/src/i18n.rs');
const i18nJs = read('frontend/shared/i18n.js');
const lib = read('src-tauri/src/lib.rs');
const commands = read('src-tauri/src/commands.rs');

// ── Parse the Rust TRAY_LABELS table ───────────────────────────────────────
// Each row is `("key", "zh", "en", "ja"),`. We tolerate whitespace.
const rustRowRe = /\("([^"]+)",\s*"([^"]*)",\s*"([^"]*)",\s*"([^"]*)"\)/g;
const rustTable = new Map();
let m;
while ((m = rustRowRe.exec(i18nRust)) !== null) {
  const [, key, zh, en, ja] = m;
  if (rustTable.has(key)) {
    throw new Error(`duplicate key in i18n.rs: ${key}`);
  }
  rustTable.set(key, { zh, en, ja });
}
assert(rustTable.size >= 20, `expected ≥20 i18n.rs entries, got ${rustTable.size}`);

// ── Parse the frontend i18n.js for the same keys ───────────────────────────
// The file has three blocks: `const zh = { ... };`, `const en = { ... };`,
// `const ja = { ... };`. Each key is `'key': 'value',` on its own line.
function parseLangBlock(src, lang) {
  const start = src.indexOf(`const ${lang} = {`);
  if (start < 0) throw new Error(`lang block ${lang} not found in i18n.js`);
  // Find the matching closing `};` — naive depth counter on `{`/`}`.
  let depth = 0;
  let end = -1;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) throw new Error(`unterminated ${lang} block in i18n.js`);
  const block = src.slice(start, end);
  const out = new Map();
  const lineRe = /^\s*'([^']+)':\s*'((?:[^'\\]|\\.)*)',?\s*$/gm;
  let mm;
  while ((mm = lineRe.exec(block)) !== null) {
    const [, key, raw] = mm;
    // Unescape simple \' \\ sequences
    const value = raw.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    out.set(key, value);
  }
  return out;
}

const zhJs = parseLangBlock(i18nJs, 'zh');
const enJs = parseLangBlock(i18nJs, 'en');
const jaJs = parseLangBlock(i18nJs, 'ja');

// ── Cross-check every Rust key against the frontend dictionary ─────────────
const mismatches = [];
const missing = [];
for (const [key, { zh, en, ja }] of rustTable) {
  for (const [lang, jsMap, rustVal] of [
    ['zh', zhJs, zh],
    ['en', enJs, en],
    ['ja', jaJs, ja],
  ]) {
    if (!jsMap.has(key)) {
      missing.push(`${lang}.${key}`);
    } else if (jsMap.get(key) !== rustVal) {
      mismatches.push(`${lang}.${key}: rust=${JSON.stringify(rustVal)} js=${JSON.stringify(jsMap.get(key))}`);
    }
  }
}
assert(missing.length === 0, `keys present in i18n.rs but missing from i18n.js: ${missing.join(', ')}`);
assert(mismatches.length === 0, `i18n.rs vs i18n.js value mismatches:\n${mismatches.join('\n')}`);

// ── lib.rs: setup_tray and refresh_tray_menu must both use build_tray_menu ─
assert(/\bfn\s+build_tray_menu\b/.test(lib), 'lib.rs must define build_tray_menu');
assert(lib.includes('i18n::tray_label('), 'lib.rs must call i18n::tray_label for tray labels');
assert(lib.includes('pub fn refresh_tray_menu(app: &tauri::AppHandle)'),
  'lib.rs must expose pub fn refresh_tray_menu(app: &tauri::AppHandle)');
assert(lib.includes('tray.set_menu(Some(menu))'),
  'refresh_tray_menu must call TrayIcon::set_menu(Some(menu))');
assert(/fn setup_tray[\s\S]*?build_tray_menu\(app/.test(lib),
  'setup_tray must build its menu via build_tray_menu(app, lang)');

// ── commands.rs: set_language must call refresh_tray_menu ──────────────────
assert(commands.includes('pub fn set_language('),
  'commands.rs must define pub fn set_language');
assert(commands.includes('crate::refresh_tray_menu(&app)'),
  'set_language must call crate::refresh_tray_menu(&app) after emit_config');

// ── tray id stability ──────────────────────────────────────────────────────
assert(lib.includes('TrayIconBuilder::with_id("main-tray")'),
  'tray id must remain "main-tray" so refresh_tray_menu can look it up');
assert(lib.includes('tray_by_id("main-tray")'),
  'refresh_tray_menu must look up the tray via tray_by_id("main-tray")');

// ── i18n.rs API surface ────────────────────────────────────────────────────
assert(i18nRust.includes('pub const TRAY_LABELS'),
  'i18n.rs must expose pub const TRAY_LABELS');
assert(i18nRust.includes('pub fn tray_label(lang: &str, key: &str) -> &\'static str'),
  'i18n.rs must expose pub fn tray_label(lang, key)');
// AUDIT-FIX (2026-07-30): known_keys() was dead code; wire it into the
// smoke so the function is actually used and future maintainers can't
// remove it without noticing. The function must return every key in the
// TRAY_LABELS table — we verify by counting.
assert(i18nRust.includes('pub fn known_keys() -> Vec<&\'static str>'),
  'i18n.rs must expose pub fn known_keys() -> Vec<&\'static str>');
assert(i18nRust.includes('TRAY_LABELS.iter().map(|(k, _, _, _)| *k).collect()'),
  'known_keys() must enumerate every key in TRAY_LABELS');

console.log(`tauri-tray-i18n-r11-smoke: ok (${rustTable.size} keys cross-checked against frontend/shared/i18n.js for zh/en/ja)`);
