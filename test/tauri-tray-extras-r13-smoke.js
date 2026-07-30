#!/usr/bin/env node
'use strict';

// R13 (2026-07-30) — Tray extras: settings placeholder + uninstall hooks + tooltip.
//
// Background: R12 added the 4 high-value submenus (language/skin/budget/mute).
// R13 closes out the remaining upstream Electron tray items that are safe to
// port without window-mode rework:
//
//   1. "Settings" — disabled placeholder so the tray visually matches upstream.
//   2. "Uninstall Claude hooks" — single-provider hook cleanup via a new
//      `uninstall_hooks` Tauri command that wraps `hook_install::uninstall_provider`.
//   3. Tray tooltip — localized via `i18n::tray_label(lang, "tray.tooltip")`;
//      refresh_tray_menu now also calls `tray.set_tooltip` so it tracks
//      language switches.
//
// Shape submenu (pet/panel/hidePet) is deferred to R14 because Tauri has no
// menubar mode; the rewrite needs window-hide side effects in `set_mode`.
//
// This smoke locks:
//   - build_tray_menu includes the settings placeholder + uninstall item.
//   - on_menu_event routes uninstall_claude_hooks to the new command.
//   - TrayIconBuilder sets a tooltip; refresh_tray_menu updates it.
//   - The new `uninstall_hooks` Tauri command exists, is registered in
//     lib.rs invoke_handler and in build.rs COMMMANDS list.
//   - hook_install.rs exposes a public uninstall_provider_hooks wrapper.
//   - i18n.rs and i18n.js both contain tray.settings / tray.uninstallHook /
//     tray.tooltip for zh/en/ja.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const lib = read('src-tauri/src/lib.rs');
const commands = read('src-tauri/src/commands.rs');
const hookInstall = read('src-tauri/src/hook_install.rs');
const build = read('src-tauri/build.rs');
const i18nRust = read('src-tauri/src/i18n.rs');
const i18nJs = read('frontend/shared/i18n.js');

// ── build_tray_menu: settings placeholder + uninstall item ────────────────
const buildFn = lib.slice(lib.indexOf('fn build_tray_menu'), lib.indexOf('/// Read the current language'));
assert(buildFn.includes('"settings"'), 'build_tray_menu must include a settings item');
assert(buildFn.includes('i18n::tray_label(lang, "tray.settings")'), 'settings label must come from tray.settings');
// settings must be disabled (4th arg to MenuItem::with_id is `enabled: bool`)
// The call spans multiple lines; use a multiline-friendly regex.
const settingsCallRe = /MenuItem::with_id\(\s*app,\s*"settings"\s*,\s*i18n::tray_label\([^)]+\)\s*,\s*false\s*,/;
assert(settingsCallRe.test(buildFn),
  'settings item must be disabled (enabled=false, 4th arg to MenuItem::with_id)');
assert(buildFn.includes('"uninstall_claude_hooks"'), 'build_tray_menu must include uninstall_claude_hooks item');
assert(buildFn.includes('i18n::tray_label(lang, "tray.uninstallHook")'), 'uninstall label must come from tray.uninstallHook');

// ── TrayIconBuilder: tooltip ───────────────────────────────────────────────
assert(lib.includes('.tooltip(i18n::tray_label('), 'TrayIconBuilder must set a tooltip via i18n::tray_label');
assert(lib.includes('tray.set_tooltip(Some(i18n::tray_label('),
  'refresh_tray_menu must call tray.set_tooltip so the tooltip tracks language switches');

// ── on_menu_event: uninstall_claude_hooks handler ─────────────────────────
const handler = lib.slice(lib.indexOf('.on_menu_event'), lib.indexOf('.on_tray_icon_event'));
assert(handler.includes('"uninstall_claude_hooks" =>'), 'on_menu_event must handle uninstall_claude_hooks');
assert(handler.includes('uninstall_hooks('), 'uninstall_claude_hooks must call the uninstall_hooks command');
assert(handler.includes('"claude".into()'), 'uninstall_claude_hooks must default to the claude provider');

// ── commands.rs: uninstall_hooks Tauri command ────────────────────────────
assert(commands.includes('#[tauri::command]\npub fn uninstall_hooks(') ||
       commands.includes('pub fn uninstall_hooks('),
  'commands.rs must define pub fn uninstall_hooks');
assert(commands.includes('crate::hook_install::uninstall_provider_hooks'),
  'uninstall_hooks must call hook_install::uninstall_provider_hooks');
// Must validate provider against the 5-provider allowlist
assert(commands.includes('"claude", "codewhale", "codex", "opencode", "aider"'),
  'uninstall_hooks must validate provider against the 5-provider allowlist');
// Must resync provider statuses after uninstall
assert(commands.includes('hook_install::resync_current'),
  'uninstall_hooks must resync provider statuses after uninstall');

// ── hook_install.rs: public wrapper ───────────────────────────────────────
assert(hookInstall.includes('pub fn uninstall_provider_hooks(id: &str) -> Result<PathBuf, String>'),
  'hook_install.rs must expose pub fn uninstall_provider_hooks');
assert(hookInstall.includes('uninstall_provider(id)'),
  'uninstall_provider_hooks must delegate to uninstall_provider');

// ── Registration: lib.rs invoke_handler + build.rs COMMANDS ───────────────
const handlerBlock = lib.slice(lib.indexOf('generate_handler!['), lib.indexOf('])'));
assert(handlerBlock.includes('uninstall_hooks,'), 'lib.rs invoke_handler must register uninstall_hooks');
assert(build.includes('"uninstall_hooks"'), 'build.rs COMMANDS must include uninstall_hooks');

// ── i18n parity: tray.settings / tray.uninstallHook / tray.tooltip ────────
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

const requiredKeys = ['tray.settings', 'tray.uninstallHook', 'tray.tooltip'];
for (const key of requiredKeys) {
  assert(zhJs.has(key), `i18n.js zh missing key: ${key}`);
  assert(enJs.has(key), `i18n.js en missing key: ${key}`);
  assert(jaJs.has(key), `i18n.js ja missing key: ${key}`);
  assert(i18nRust.includes(`"${key}"`), `i18n.rs missing key: ${key}`);
}

console.log('tauri-tray-extras-r13-smoke: ok (settings placeholder + uninstall hooks + tooltip + i18n parity verified)');
