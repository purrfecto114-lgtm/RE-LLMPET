#!/usr/bin/env node
'use strict';

// R38.1 (2026-08-01) — 0.5.17 correctness closure smoke.
//
// Locks the 5 fixes from the 0.5.16 full audit roadmap:
//
//   P0-1  Singleton StatsCoalescer (dirty+scheduled flags, no task storm)
//   P0-2  Diagnostic cancel keeps provider locked until worker terminal
//   P0-3  Panel init visibility renders cached stats
//   P0-4  closePanel uses call() not send(), panelVisible deferred to event
//   P1-1  set_providers never top-level rejects after commit

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const model = read('src-tauri/src/model.rs');
const commands = read('src-tauri/src/commands.rs');
const httpServer = read('src-tauri/src/http_server.rs');
const bridge = read('frontend/renderer/tauri-bridge.js');
const panelJs = read('frontend/renderer/panel.js');

// ──────────────────────────────────────────────────────────────────────────
// P0-1: Singleton StatsCoalescer
// ──────────────────────────────────────────────────────────────────────────

assert(model.includes('pub stats_dirty: Mutex<bool>'),
  'R38.1: model.rs must have stats_dirty field');
assert(model.includes('pub stats_scheduled: Mutex<bool>'),
  'R38.1: model.rs must have stats_scheduled field');
assert(model.includes('pub stats_revision: Mutex<u64>'),
  'R38.1: model.rs must have stats_revision field');
assert(model.includes('stats_dirty: Mutex::new(false)'),
  'R38.1: AppState::new must initialize stats_dirty');
assert(model.includes('stats_scheduled: Mutex::new(false)'),
  'R38.1: AppState::new must initialize stats_scheduled');
assert(model.includes('stats_revision: Mutex::new(0)'),
  'R38.1: AppState::new must initialize stats_revision');
// http_server.rs uses dirty+scheduled pattern
assert(httpServer.includes('*dirty_guard = true'),
  'R38.1: http_server.rs must set dirty flag on throttled event');
assert(httpServer.includes('already_scheduled'),
  'R38.1: http_server.rs must check scheduled flag before spawning');
assert(httpServer.includes('if !already_scheduled'),
  'R38.1: http_server.rs must only spawn if not already scheduled');
assert(httpServer.includes('fn do_emit_stats'),
  'R38.1: http_server.rs must have do_emit_stats function');
assert(httpServer.includes('__revision'),
  'R38.1: do_emit_stats must attach __revision to stats payload');
// commands.rs also uses dirty flag + revision
assert(commands.includes('stats_dirty'),
  'R38.1: commands.rs emit_stats_throttled must reference stats_dirty');
assert(commands.includes('__revision'),
  'R38.1: commands.rs must attach __revision to stats payload');

// ──────────────────────────────────────────────────────────────────────────
// P0-2: Diagnostic cancel keeps provider locked
// ──────────────────────────────────────────────────────────────────────────

// cancel_diagnostic should NOT clear active_diagnostic_provider in code
const cancelBlock = commands.slice(
  commands.indexOf('pub async fn cancel_diagnostic'),
  commands.indexOf('/// R35.2: Kill a process')
);
const cancelCodeOnly = cancelBlock.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
assert(!cancelCodeOnly.includes('*provider_guard = None'),
  'R38.1: cancel_diagnostic code must NOT clear active_diagnostic_provider (was race)');

// ──────────────────────────────────────────────────────────────────────────
// P0-3: Panel init visibility renders cached stats
// ──────────────────────────────────────────────────────────────────────────

assert(panelJs.includes('const cached = pendingStats || lastStats'),
  'R38.1: panel.js init isVisible must check pendingStats || lastStats');
assert(panelJs.includes('render(cached)'),
  'R38.1: panel.js init isVisible must render cached stats');

// ──────────────────────────────────────────────────────────────────────────
// P0-4: closePanel uses call() not send()
// ──────────────────────────────────────────────────────────────────────────

assert(bridge.includes("closePanel: () => call('close_panel')"),
  'R38.1: bridge closePanel must use call() not send()');
// close button handler must NOT set panelVisible=false directly
const closeHandlerBlock = panelJs.slice(
  panelJs.indexOf("$('close').addEventListener('click', () => {"),
  panelJs.indexOf('// R35.1: clean up window-scoped')
);
assert(!closeHandlerBlock.includes('panelVisible = false'),
  'R38.1: close button must NOT set panelVisible=false (defer to panel:hidden event)');

// ──────────────────────────────────────────────────────────────────────────
// P1-1: set_providers never top-level rejects after commit
// ──────────────────────────────────────────────────────────────────────────

assert(commands.includes('infra_error'),
  'R38.1: set_providers must catch resync_current error as infra_error');
assert(commands.includes('"infrastructureError": infra_error'),
  'R38.1: set_providers must return infrastructureError in result');
assert(!commands.includes('let statuses = hook_install::resync_current(&state.runtime)?'),
  'R38.1: set_providers must NOT use ? on resync_current (was top-level reject)');

console.log('tauri-r381-correctness-closure-smoke: ok (5 fixes locked: P0-1 singleton coalescer, P0-2 cancel keeps lock, P0-3 init renders cache, P0-4 closePanel call, P1-1 no post-commit reject)');
