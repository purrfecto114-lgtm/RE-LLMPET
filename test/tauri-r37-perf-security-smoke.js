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

assert(model.includes('pub last_stats_emit: Mutex<Option<Instant>>'),
  'R37: Runtime must have last_stats_emit field');
assert(model.includes('last_stats_emit: Mutex::new(None)'),
  'R37: AppState::new must initialize last_stats_emit');
assert(commands.includes('fn emit_stats_throttled(app: &AppHandle, state: &AppState, force: bool)'),
  'R37: commands.rs must define emit_stats_throttled with force parameter');
assert(commands.includes('STATS_THROTTLE_MS: u128 = 150'),
  'R37: commands.rs must define STATS_THROTTLE_MS = 150');
assert(commands.includes('emit_stats_throttled(&app, &state, true)'),
  'R37: decide_permission must use force=true for immediate UI feedback');
// http_server.rs also throttles
assert(httpServer.includes('STATS_THROTTLE_MS: u128 = 150'),
  'R37: http_server.rs must also throttle emit_stats');
assert(httpServer.includes('last_stats_emit'),
  'R37: http_server.rs must reference last_stats_emit');

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

assert(platform.includes('const CURSOR_HIT_TEST_IDLE_MS: u64 = 250;'),
  'R37: platform.rs must define CURSOR_HIT_TEST_IDLE_MS = 250');
assert(platform.includes('CURSOR_HIT_TEST_IDLE_MS'),
  'R37: cursor hit-test loop must use IDLE_MS constant');
assert(platform.includes('let requested = state.mouse_ignore_requested.load(Ordering::Acquire)'),
  'R37: cursor hit-test must check mouse_ignore_requested before choosing sleep interval');
assert(platform.includes('let sleep_ms = if requested'),
  'R37: cursor hit-test must choose sleep_ms adaptively');
// The original 24ms constant is still there for active mode
assert(platform.includes('const CURSOR_HIT_TEST_MS: u64 = 24;'),
  'R37: CURSOR_HIT_TEST_MS = 24 must still exist for active mode');

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
