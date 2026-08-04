#!/usr/bin/env node
'use strict';

// R37 (2026-08-01) — 0.5.15 performance & security closure smoke.
//
// Locks the 4 R37 fixes from the 0.5.12 carpet audit roadmap §14:
//
//   R37-4  Stats push throttling: 150ms minimum interval between emits
//   R37-5  Hidden panel render suppression: skip DOM rebuild when hidden
//   R37-6  Cursor hit-test adaptive backoff: 250ms idle vs 24ms active
//   R37-8  Capability minimization: replace core:default with explicit core:*

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const panelJs = read('frontend/renderer/panel.js');
const commands = read('src-tauri/src/commands.rs');
const model = read('src-tauri/src/model.rs');
const httpServer = read('src-tauri/src/http_server.rs');
const platform = read('src-tauri/src/platform.rs');
const petCap = read('src-tauri/capabilities/pet.json');
const panelCap = read('src-tauri/capabilities/panel.json');

// ──────────────────────────────────────────────────────────────────────────
// R37-4: Stats push throttling (150ms minimum interval)
// ──────────────────────────────────────────────────────────────────────────

assert(model.includes('pub stats_coalescer: Mutex<StatsCoalescerState>'),
  'R37/R40: Runtime must have one consolidated stats coalescer');
assert(model.includes('stats_coalescer: Mutex::new(StatsCoalescerState::default())'),
  'R37/R40: AppState::new must initialize the consolidated coalescer');
assert(httpServer.includes('STATS_THROTTLE_MS: u128 = 150'),
  'R37: http_server.rs must throttle stats emits');
assert(commands.includes('crate::http_server::emit_stats_now(app, &state.runtime)'),
  'R37/R45: permission commands must use the shared immediate emitter');
assert(commands.includes('emit_stats_now(&app, &state)'),
  'R37/R45: user permission decisions must emit immediately');
assert(httpServer.includes('pub(crate) fn emit_stats_now'),
  'R37/R45: http_server.rs must own the sole immediate stats emitter');
assert(!model.includes('last_stats_emit') && !model.includes('stats_dirty') && !model.includes('stats_scheduled'),
  'R45: obsolete split-mutex compatibility fields must not return');

// ──────────────────────────────────────────────────────────────────────────
// R37-5: Hidden panel render suppression
// ──────────────────────────────────────────────────────────────────────────

assert(panelJs.includes('let panelVisible = false;'),
  'R37: panel.js must declare panelVisible flag');
assert(panelJs.includes('let pendingStats = null;'),
  'R37: panel.js must declare pendingStats for cached-while-hidden stats');
// render() checks panelVisible and caches if hidden
assert(panelJs.includes('if (!panelVisible)'),
  'R37: render() must check panelVisible before DOM rebuild');
assert(panelJs.includes('pendingStats = s;'),
  'R37: render() must cache stats in pendingStats when hidden');
// resetAutoFitOnShow sets panelVisible = true and renders pending stats
assert(panelJs.includes('panelVisible = true;'),
  'R37: resetAutoFitOnShow must set panelVisible = true');
assert(panelJs.includes('if (pendingStats)'),
  'R37: resetAutoFitOnShow must check pendingStats');
// close button sets panelVisible = false
assert(panelJs.includes('panelVisible = false;'),
  'R37: close button handler must set panelVisible = false');

// ──────────────────────────────────────────────────────────────────────────
// R37-6: Cursor hit-test adaptive backoff
// ──────────────────────────────────────────────────────────────────────────

for (const [name, value] of [
  ['CURSOR_HIT_TEST_NEAR_MS', '45'],
  ['CURSOR_HIT_TEST_FAR_MS', '240'],
  ['CURSOR_HIT_TEST_IDLE_MS', '500'],
  ['CURSOR_HIT_TEST_HIDDEN_MS', '1000'],
]) {
  assert(platform.includes(`const ${name}: u64 = ${value};`),
    `R37: adaptive cursor constant missing: ${name}=${value}`);
}
assert(platform.includes('fn cursor_hit_decision') && platform.includes('struct CursorHitDecision'),
  'R37: cursor hit-test must compute ignore state and cadence in one decision');
assert(platform.includes('!window.is_visible().unwrap_or(false)'),
  'R37: hidden pet window must use the slowest cadence');
assert(platform.includes('!self.mouse_ignore_requested.load(Ordering::Acquire)'),
  'R37: idle mode must avoid active cursor hit-testing');

// ──────────────────────────────────────────────────────────────────────────
// R37-8: Capability minimization (replace core:default)
// ──────────────────────────────────────────────────────────────────────────

assert(!petCap.includes('"core:default"'),
  'R37: pet.json must NOT contain core:default (replaced with explicit permissions)');
assert(!panelCap.includes('"core:default"'),
  'R37: panel.json must NOT contain core:default (replaced with explicit permissions)');
assert(petCap.includes('"core:event:default"'),
  'R37: pet.json must include core:event:default');
assert(petCap.includes('"core:window:default"'),
  'R37: pet.json must include core:window:default');
assert(panelCap.includes('"core:event:default"'),
  'R37: panel.json must include core:event:default');
assert(panelCap.includes('"core:window:default"'),
  'R37: panel.json must include core:window:default');

console.log('tauri-r37-perf-security-smoke: ok (4 R37 fixes locked: R37-4 stats throttle, R37-5 hidden panel render skip, R37-6 cursor hit-test backoff, R37-8 capability minimization)');
