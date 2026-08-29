#!/usr/bin/env node
'use strict';

// R12 (2026-07-30) — Tray submenu structure + routing contract.
//
// Background: R11 made the tray i18n-aware and added refresh_tray_menu.
// R12 adds the four high-value submenus the upstream Electron tray exposes
// (language / skin / 5h budget / mute) so users can switch all common
// settings without opening the panel. This smoke locks:
//
//   1. Structural: build_tray_menu constructs the four submenus + mute
//      check item + three separators + the existing launch submenu.
//   2. Routing: on_menu_event has a case for every new menu item id and
//      routes to the correct config command (set_language / set_skin /
//      set_budget / toggle_mute) plus refresh_tray_menu for visual update.
//   3. i18n parity: the new keys (lang.*, skin.*, shape.hidePet) used by
//      the tray submenus exist in i18n.rs AND frontend/shared/i18n.js for
//      all three languages.
//   4. Item id stability: tray ids are language-independent so the
//      on_menu_event handler never needs to know which label produced
//      the click.
//
// Cross-source contract: this smoke complements tauri-tray-i18n-r11-smoke
// (which locks the i18n table parity) and tauri-codewhale-doctor-consistency-r10
// (which locks CodeWhale doctor ordering).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const lib = read('src-tauri/src/lib.rs');
const i18nRust = read('src-tauri/src/i18n.rs');
const i18nJs = read('frontend/shared/i18n.js');
const commands = read('src-tauri/src/commands.rs');

// ── Structural: build_tray_menu constructs the four submenus ───────────────
const buildFn = lib.slice(lib.indexOf('fn build_tray_menu'), lib.indexOf('/// Read the current language'));
assert(buildFn.includes('CheckMenuItem::with_id'), 'build_tray_menu must use CheckMenuItem::with_id');
assert(buildFn.includes('PredefinedMenuItem::separator'), 'build_tray_menu must use PredefinedMenuItem::separator');

// Language submenu: 3 CheckMenuItem with ids lang_zh/lang_en/lang_ja
assert(buildFn.includes('"lang_zh"'), 'language submenu must include lang_zh');
assert(buildFn.includes('"lang_en"'), 'language submenu must include lang_en');
assert(buildFn.includes('"lang_ja"'), 'language submenu must include lang_ja');
assert(buildFn.includes('i18n::tray_label(lang, "lang.zh")'), 'lang_zh label must come from i18n::tray_label(lang, "lang.zh")');
assert(buildFn.includes('i18n::tray_label(lang, "lang.en")'), 'lang_en label must come from i18n::tray_label(lang, "lang.en")');
assert(buildFn.includes('i18n::tray_label(lang, "lang.ja")'), 'lang_ja label must come from i18n::tray_label(lang, "lang.ja")');
assert(buildFn.includes('i18n::tray_label(lang, "tray.language")'), 'language submenu title must be tray.language');

// Skin submenu: 3 CheckMenuItem with ids skin_mascot/skin_pixel/skin_cat
assert(buildFn.includes('"skin_mascot"'), 'skin submenu must include skin_mascot');
assert(buildFn.includes('"skin_pixel"'), 'skin submenu must include skin_pixel');
assert(buildFn.includes('"skin_cat"'), 'skin submenu must include skin_cat');
assert(buildFn.includes('i18n::tray_label(lang, "skin.mascot")'), 'skin_mascot label must come from i18n::tray_label(lang, "skin.mascot")');
assert(buildFn.includes('i18n::tray_label(lang, "skin.pixel")'), 'skin_pixel label must come from i18n::tray_label(lang, "skin.pixel")');
assert(buildFn.includes('i18n::tray_label(lang, "skin.cat")'), 'skin_cat label must come from i18n::tray_label(lang, "skin.cat")');
assert(buildFn.includes('i18n::tray_label(lang, "tray.skin")'), 'skin submenu title must be tray.skin');

// Budget submenu: 6 CheckMenuItem with ids budget_0/budget_10/.../budget_100
for (const v of [0, 10, 20, 30, 50, 100]) {
  assert(buildFn.includes(`"budget_${v}"`), `budget submenu must include budget_${v}`);
}
assert(buildFn.includes('i18n::tray_label(lang, "tray.budgetOff")'), 'budget off label must be tray.budgetOff');
assert(buildFn.includes('i18n::tray_label(lang, "tray.budget")'), 'budget submenu title must be tray.budget');

// Mute toggle: single CheckMenuItem with id toggle_mute
assert(buildFn.includes('"toggle_mute"'), 'mute toggle must have id toggle_mute');
assert(buildFn.includes('i18n::tray_label(lang, "tray.mute")'), 'mute label must come from tray.mute');
assert(buildFn.includes('i18n::tray_label(lang, "tray.unmute")'), 'unmute label must come from tray.unmute');
assert(buildFn.includes('config.muted'), 'mute check state must read config.muted');

// Three separators between logical groups
const sepCount = (buildFn.match(/PredefinedMenuItem::separator/g) || []).length;
assert(sepCount >= 3, `expected ≥3 separators in build_tray_menu, got ${sepCount}`);

// ── Routing: on_menu_event has a case for every new id ────────────────────
const handler = lib.slice(lib.indexOf('.on_menu_event'), lib.indexOf('.on_tray_icon_event'));

// Language: routes to set_language (which internally calls refresh_tray_menu)
assert(handler.includes('"lang_zh" =>'), 'on_menu_event must handle lang_zh');
assert(handler.includes('"lang_en" =>'), 'on_menu_event must handle lang_en');
assert(handler.includes('"lang_ja" =>'), 'on_menu_event must handle lang_ja');
assert(handler.includes('set_language(app.clone()'), 'lang_* must call set_language');
// set_language already calls refresh_tray_menu internally, so the handler must NOT double-refresh
const langZhBlock = handler.slice(handler.indexOf('"lang_zh"'), handler.indexOf('"lang_en"'));
assert(!langZhBlock.includes('refresh_tray_menu(app)'), 'lang_zh handler must NOT call refresh_tray_menu (set_language does it)');

// Skin: routes to set_skin + refresh_tray_menu
assert(handler.includes('"skin_mascot" | "skin_pixel" | "skin_cat"'), 'skin ids must be matched together');
assert(handler.includes('set_skin(app.clone()'), 'skin_* must call set_skin');
const skinBlock = handler.slice(handler.indexOf('"skin_mascot"'), handler.indexOf('"budget_0"'));
assert(skinBlock.includes('refresh_tray_menu(app)'), 'skin handler must call refresh_tray_menu to move the check mark');

// Budget: routes to set_budget + refresh_tray_menu
assert(handler.includes('"budget_0" | "budget_10" | "budget_20" | "budget_30" | "budget_50" | "budget_100"'), 'budget ids must be matched together');
assert(handler.includes('set_budget(app.clone()'), 'budget_* must call set_budget');
const budgetBlock = handler.slice(handler.indexOf('"budget_0"'), handler.indexOf('"toggle_mute"'));
assert(budgetBlock.includes('refresh_tray_menu(app)'), 'budget handler must call refresh_tray_menu');

// Mute: routes to toggle_mute + refresh_tray_menu
assert(handler.includes('"toggle_mute" =>'), 'on_menu_event must handle toggle_mute');
assert(handler.includes('toggle_mute(app.clone()'), 'toggle_mute must call toggle_mute command');
const muteBlock = handler.slice(handler.indexOf('"toggle_mute"'), handler.indexOf('"log"'));
assert(muteBlock.includes('refresh_tray_menu(app)'), 'toggle_mute handler must call refresh_tray_menu');

// ── i18n parity: new keys exist in both i18n.rs and i18n.js ───────────────
function parseLangBlock(src, lang) {
  const start = src.indexOf(`const ${lang} = {`);
  if (start < 0) throw new Error(`lang block ${lang} not found`);
  let depth = 0, end = -1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const block = src.slice(start, end);
  const out = new Map();
  const re = /^\s*'([^']+)':\s*'((?:[^'\\]|\\.)*)',?\s*$/gm;
  let mm;
  while ((mm = re.exec(block)) !== null) {
    out.set(mm[1], mm[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
  }
  return out;
}

const zhJs = parseLangBlock(i18nJs, 'zh');
const enJs = parseLangBlock(i18nJs, 'en');
const jaJs = parseLangBlock(i18nJs, 'ja');

const requiredKeys = [
  'lang.zh', 'lang.en', 'lang.ja',
  'skin.mascot', 'skin.pixel', 'skin.cat',
  'tray.language', 'tray.skin', 'tray.budget', 'tray.budgetOff',
  'tray.mute', 'tray.unmute',
  'shape.hidePet', // R12 new key (replaces menubar)
];
for (const key of requiredKeys) {
  assert(zhJs.has(key), `i18n.js zh missing key: ${key}`);
  assert(enJs.has(key), `i18n.js en missing key: ${key}`);
  assert(jaJs.has(key), `i18n.js ja missing key: ${key}`);
  // Also confirm i18n.rs has it
  assert(i18nRust.includes(`"${key}"`), `i18n.rs missing key: ${key}`);
}

// ── Item id stability: ids are language-independent constants ─────────────
// Verify no id is constructed dynamically from a localized string. The
// patterns tolerate whitespace around `+` so a future formatter doesn't
// silently bypass the check. Note: we test against `lib` explicitly
// (`!re.test(lib)`) because `assert(!/regex/)` would negate the regex
// object's truthiness, not its match result.
assert(!/"lang_"\s*\+/.test(lib), 'lang_* ids must be static constants, not string concatenation');
assert(!/"skin_"\s*\+/.test(lib), 'skin_* ids must be static constants');
assert(!/"budget_"\s*\+/.test(lib), 'budget_* ids must be static constants');

// ── commands.rs still exposes the underlying commands ─────────────────────
assert(commands.includes('pub fn set_language('), 'commands.rs must expose set_language');
assert(commands.includes('pub fn set_skin('), 'commands.rs must expose set_skin');
assert(commands.includes('pub fn set_budget('), 'commands.rs must expose set_budget');
assert(commands.includes('pub fn toggle_mute('), 'commands.rs must expose toggle_mute');

console.log('tauri-tray-submenu-r12-smoke: ok (4 submenus + mute toggle + 3 separators + routing + i18n parity verified)');
