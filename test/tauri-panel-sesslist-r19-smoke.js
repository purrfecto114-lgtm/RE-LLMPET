#!/usr/bin/env node
'use strict';

// R19 (2026-07-30) — Session list pin/archive + attention filter.
//
// Background: R8 had basic search + provider filter but lacked the upstream
// Electron panel's pin/archive/attention features. R19 adds:
//   - AppConfig.pinned_sessions + archived_sessions fields
//   - set_session_prefs Tauri command (sanitize + dedup + pin-wins)
//   - setSessionPrefs in tauri-bridge.js
//   - renderSessList: pin/archive buttons + attention filter + archive toggle
//   - 9 new i18n keys × 3 langs
//
// This smoke locks:
//   1. AppConfig has pinned_sessions + archived_sessions.
//   2. set_session_prefs command exists, sanitizes, dedupes, pin-wins.
//   3. Registered in lib.rs invoke_handler + build.rs COMMANDS.
//   4. tauri-bridge.js exposes setSessionPrefs.
//   5. panel.html has attention + show-archived buttons.
//   6. panel.js renderSessList filters by attention/archive, sorts pinned top,
//      renders pin/archive buttons, persists via setSessionPrefs.
//   7. i18n.js has all 9 sess.* keys in zh/en/ja.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const model = read('src-tauri/src/model.rs');
const commands = read('src-tauri/src/commands.rs');
const lib = read('src-tauri/src/lib.rs');
const build = read('src-tauri/build.rs');
const bridge = read('frontend/renderer/tauri-bridge.js');
const panelHtml = read('frontend/renderer/panel.html');
const panelJs = read('frontend/renderer/panel.js');
const i18nJs = read('frontend/shared/i18n.js');

// ── AppConfig fields ───────────────────────────────────────────────────────
assert(model.includes('pub pinned_sessions: Vec<String>'), 'AppConfig must have pinned_sessions');
assert(model.includes('pub archived_sessions: Vec<String>'), 'AppConfig must have archived_sessions');
assert(model.includes('pinned_sessions: Vec::new()'), 'AppConfig default must init pinned_sessions');
assert(model.includes('archived_sessions: Vec::new()'), 'AppConfig default must init archived_sessions');

// ── set_session_prefs command ──────────────────────────────────────────────
assert(commands.includes('pub fn set_session_prefs('), 'commands.rs must define set_session_prefs');
assert(commands.includes('fn sanitize_ids('), 'set_session_prefs must have sanitize_ids helper');
assert(commands.includes('256'), 'sanitize_ids must bound session ids to 256 chars');
assert(commands.includes('pinned_set'), 'set_session_prefs must implement pin-wins (drop pinned from archived)');
assert(commands.includes('config.pinned_sessions = pinned_clean'), 'set_session_prefs must persist pinned');
assert(commands.includes('config.archived_sessions = archived_clean'), 'set_session_prefs must persist archived');

// ── Registration ───────────────────────────────────────────────────────────
const handlerBlock = lib.slice(lib.indexOf('generate_handler!['), lib.indexOf('])'));
assert(handlerBlock.includes('set_session_prefs,'), 'lib.rs invoke_handler must register set_session_prefs');
assert(build.includes('"set_session_prefs"'), 'build.rs COMMANDS must include set_session_prefs');

// ── tauri-bridge.js ────────────────────────────────────────────────────────
// R32 (2026-07-31): setSessionPrefs upgraded from send() to call() — session
// prefs persist user intent (pin/archive), so silent loss on IPC failure is
// unacceptable. The assertion accepts either form for forward-compat with
// future reverts, but call() is the expected form.
assert(bridge.includes('setSessionPrefs: (pinned, archived) => call(\'set_session_prefs\''),
  'tauri-bridge.js must expose setSessionPrefs as call() (R32: awaitable)');

// ── panel.html: attention + archive buttons ────────────────────────────────
assert(panelHtml.includes('id="sess-attention"'), 'panel.html must have #sess-attention button');
assert(panelHtml.includes('id="sess-show-archived"'), 'panel.html must have #sess-show-archived button');
assert(panelHtml.includes('class="sess-filter-btn"'), 'buttons must have sess-filter-btn class');
assert(panelHtml.includes('data-i18n="sess.filterAttention"'), 'attention button must have data-i18n');
assert(panelHtml.includes('data-i18n="sess.showArchived"'), 'archive button must have data-i18n');

// ── panel.js: state + render + persist ─────────────────────────────────────
assert(panelJs.includes('let sessionPinned = []'), 'panel.js must declare sessionPinned state');
assert(panelJs.includes('let sessionArchived = []'), 'panel.js must declare sessionArchived state');
assert(panelJs.includes('let sessionAttentionOnly = false'), 'panel.js must declare sessionAttentionOnly state');
assert(panelJs.includes('let sessionShowArchived = false'), 'panel.js must declare sessionShowArchived state');
// renderSessList filtering
assert(panelJs.includes('sessionAttentionOnly && s.state !== \'waiting\' && s.state !== \'needsinput\''),
  'renderSessList must filter by attention (waiting/needsinput)');
assert(panelJs.includes('archivedSet.has(sid) && !sessionShowArchived'),
  'renderSessList must hide archived unless toggled');
assert(panelJs.includes('pinnedSet.has(String(a.sessionId'), 'renderSessList must sort pinned to top');
// pin/archive buttons
assert(panelJs.includes('class="sess-pin"'), 'renderSessList must render pin buttons');
assert(panelJs.includes('class="sess-archive"'), 'renderSessList must render archive buttons');
assert(panelJs.includes('window.pet.setSessionPrefs(sessionPinned, sessionArchived)'),
  'pin/archive click must persist via setSessionPrefs');
// config sync
assert(panelJs.includes('cfg.pinnedSessions'), 'onConfig must sync pinnedSessions from config');
assert(panelJs.includes('cfg.archivedSessions'), 'onConfig must sync archivedSessions from config');
// attention/archive toggle handlers
assert(panelJs.includes('sessAttention.addEventListener'), 'attention button must have click handler');
assert(panelJs.includes('sessShowArchived.addEventListener'), 'archive button must have click handler');

// ── i18n.js: 9 new sess.* keys in 3 langs ──────────────────────────────────
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
  'sess.search', 'sess.filters', 'sess.filterAll', 'sess.filterAttention',
  'sess.showArchived', 'sess.pin', 'sess.unpin', 'sess.archive', 'sess.unarchive',
];
for (const key of requiredKeys) {
  assert(zhJs.has(key), `i18n.js zh missing key: ${key}`);
  assert(enJs.has(key), `i18n.js en missing key: ${key}`);
  assert(jaJs.has(key), `i18n.js ja missing key: ${key}`);
}

console.log('tauri-panel-sesslist-r19-smoke: ok (AppConfig + set_session_prefs + bridge + HTML + JS state/filter/render/persist + 9 i18n keys × 3 langs verified)');
