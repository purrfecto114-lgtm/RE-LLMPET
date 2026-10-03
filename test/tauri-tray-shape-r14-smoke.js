#!/usr/bin/env node
'use strict';

// R14 (2026-07-30) — Tray shape submenu + set_mode window side-effect.
//
// Background: R13 closed out the tray visual elements except the shape
// submenu. R14 adds it. The upstream Electron tray exposed three radio
// items: pet / panel / menubar. Tauri has no native menubar mode, so R14
// rewrites menubar → hidePet (tray-only, pet window hidden). This smoke
// locks:
//
//   1. Structural: build_tray_menu constructs the shape submenu with 3
//      CheckMenuItem (shape_pet / shape_panel / shape_hidePet).
//   2. Routing: on_menu_event routes shape_* to set_mode + refresh_tray_menu.
//   3. set_mode window side-effect: hidePet hides the pet window; pet/panel
//      show it. set_mode validates mode against the 4-value allowlist.
//   4. model.rs sanitize accepts "hidePet" as a valid mode.
//   5. i18n parity: shape.pet / shape.panel / shape.hidePet / tray.shape
//      exist in i18n.rs AND i18n.js for zh/en/ja.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const lib = read('src-tauri/src/lib.rs');
const commands = read('src-tauri/src/commands.rs');
const model = read('src-tauri/src/model.rs');
const i18nRust = read('src-tauri/src/i18n.rs');
const i18nJs = read('frontend/shared/i18n.js');

// ── build_tray_menu: shape submenu ─────────────────────────────────────────
const buildFn = lib.slice(lib.indexOf('fn build_tray_menu'), lib.indexOf('/// Read the current language'));
assert(buildFn.includes('"shape_pet"'), 'shape submenu must include shape_pet');
assert(buildFn.includes('"shape_panel"'), 'shape submenu must include shape_panel');
assert(buildFn.includes('"shape_hidePet"'), 'shape submenu must include shape_hidePet (NOT shape_menubar)');
assert(!buildFn.includes('"shape_menubar"'), 'shape submenu must NOT use the legacy shape_menubar id');
assert(buildFn.includes('i18n::tray_label(lang, "shape.pet")'), 'shape_pet label must come from shape.pet');
assert(buildFn.includes('i18n::tray_label(lang, "shape.panel")'), 'shape_panel label must come from shape.panel');
assert(buildFn.includes('i18n::tray_label(lang, "shape.hidePet")'), 'shape_hidePet label must come from shape.hidePet');
assert(buildFn.includes('i18n::tray_label(lang, "tray.shape")'), 'shape submenu title must be tray.shape');
// Check state must read config.mode
assert(buildFn.includes('config.mode == "pet"'), 'shape_pet check must read config.mode == "pet"');
assert(buildFn.includes('config.mode == "hidePet"'), 'shape_hidePet check must read config.mode == "hidePet"');
// shape_menu must be in the final Menu::with_items array
assert(buildFn.includes('&shape_menu,'), 'shape_menu must be in the Menu::with_items array');

// ── on_menu_event: shape routing ───────────────────────────────────────────
const handler = lib.slice(lib.indexOf('.on_menu_event'), lib.indexOf('.on_tray_icon_event'));
assert(handler.includes('"shape_pet" | "shape_panel" | "shape_hidePet"'),
  'shape ids must be matched together in on_menu_event');
assert(handler.includes('set_mode(app.clone()'), 'shape_* must call set_mode');
const shapeBlock = handler.slice(handler.indexOf('"shape_pet"'), handler.indexOf('"toggle_mute"'));
assert(shapeBlock.includes('refresh_tray_menu(app)'), 'shape handler must call refresh_tray_menu');
// Verify the id→mode mapping
assert(shapeBlock.includes('"shape_pet" => "pet"'), 'shape_pet must map to mode "pet"');
assert(shapeBlock.includes('"shape_panel" => "panel"'), 'shape_panel must map to mode "panel"');
assert(shapeBlock.includes('"shape_hidePet" => "hidePet"'), 'shape_hidePet must map to mode "hidePet"');

// ── set_mode: validation + window side-effect ─────────────────────────────
const setModeFn = commands.slice(commands.indexOf('pub fn set_mode('), commands.indexOf('#[tauri::command]\npub fn set_skin'));
assert(setModeFn.includes('"pet" | "panel" | "menubar" | "hidePet"'),
  'set_mode must validate mode against the 4-value allowlist (pet/panel/menubar/hidePet)');
assert(setModeFn.includes('unsupported mode:'),
  'set_mode must return a clear error for unknown modes');
assert(setModeFn.includes('sync_pet_windows(&app, &config)'),
  'set_mode must route visibility through the dual-pet synchronizer');
assert(setModeFn.includes('get_webview_window("pet")') && setModeFn.includes('window.set_focus()'),
  'set_mode must focus the primary pet after restoring pet mode');
const syncPetFn = commands.slice(commands.indexOf('pub(crate) fn sync_pet_windows'), commands.indexOf('fn emit_config'));
assert(syncPetFn.includes('window.hide()') && syncPetFn.includes('window.show()'),
  'dual-pet synchronizer must hide and show pet windows');
assert(syncPetFn.includes('get_webview_window("pet")') && syncPetFn.includes('get_webview_window("pet-codex")'),
  'dual-pet synchronizer must operate on both pet windows');
assert(syncPetFn.includes('config.pet_mode == "duo"'),
  'Codex pet visibility must follow duo mode');

// ── model.rs: sanitize accepts hidePet ─────────────────────────────────────
assert(model.includes('"pet" | "panel" | "menubar" | "hidePet"'),
  'model.rs sanitize must accept "hidePet" as a valid mode value');

// ── i18n parity ────────────────────────────────────────────────────────────
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

const requiredKeys = ['shape.pet', 'shape.panel', 'shape.hidePet', 'tray.shape'];
for (const key of requiredKeys) {
  assert(zhJs.has(key), `i18n.js zh missing key: ${key}`);
  assert(enJs.has(key), `i18n.js en missing key: ${key}`);
  assert(jaJs.has(key), `i18n.js ja missing key: ${key}`);
  assert(i18nRust.includes(`"${key}"`), `i18n.rs missing key: ${key}`);
}

console.log('tauri-tray-shape-r14-smoke: ok (shape submenu + set_mode window side-effect + sanitize + i18n parity verified)');
