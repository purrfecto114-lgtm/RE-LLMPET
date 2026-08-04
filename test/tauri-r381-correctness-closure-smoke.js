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

assert(model.includes('pub struct StatsCoalescerState'),
  'R38.1/R40.1: model.rs must define the consolidated coalescer state');
assert(model.includes('pub stats_coalescer: Mutex<StatsCoalescerState>'),
  'R38.1/R40.1: Runtime must own one coalescer mutex');
assert(model.includes('pub stats_revision: Mutex<u64>'),
  'R38.1: model.rs must have stats_revision field');
assert(model.includes('stats_coalescer: Mutex::new(StatsCoalescerState::default())'),
  'R38.1/R40.1: AppState::new must initialize the coalescer');
assert(model.includes('stats_revision: Mutex::new(0)'),
  'R38.1: AppState::new must initialize stats_revision');
assert(!model.includes('pub stats_dirty:') && !model.includes('pub stats_scheduled:') && !model.includes('last_stats_emit'),
  'R45: obsolete split state must be removed rather than retained for smoke tests');
// R40.1: the split-mutex design was consolidated into a single
// `stats_coalescer: Mutex<StatsCoalescerState>`. The R38.1 assertions
// below check for the new consolidated pattern instead of the old
// `*dirty_guard = true` / `already_scheduled` strings.
assert(httpServer.includes('guard.dirty = true'),
  'R38.1/R40.1: http_server.rs must set dirty flag on throttled event (now via consolidated state)');
assert(httpServer.includes('guard.scheduled'),
  'R38.1/R40.1: http_server.rs must check scheduled flag before spawning (now via consolidated state)');
assert(httpServer.includes('CoalescerAction::ScheduleTrailing'),
  'R38.1/R40.1: http_server.rs must schedule trailing timer only if not already scheduled');
assert(httpServer.includes('pub(crate) fn emit_stats_now'),
  'R38.1/R45: http_server.rs must own the immediate stats emitter');
assert(httpServer.includes('__revision'),
  'R38.1: shared stats emitter must attach __revision to stats payload');
// commands.rs delegates to the sole revision owner instead of duplicating
// payload mutation or revision counters.
assert(commands.includes('crate::http_server::emit_stats_now'),
  'R38.1/R45: commands.rs must delegate instead of duplicating coalescer logic');
assert(!commands.includes('stats_with_rev'),
  'commands.rs must not reintroduce a second revisioned stats emitter');

// ──────────────────────────────────────────────────────────────────────────
// P0-2: Diagnostic cancel keeps provider locked
// ──────────────────────────────────────────────────────────────────────────

// cancel_diagnostic marks cancellation but does not release ownership. The
// async diagnose wrapper calls finish only after the blocking worker returns.
const cancelBlock = commands.slice(
  commands.indexOf('pub async fn cancel_diagnostic'),
  commands.indexOf('/// R35.2: Kill a process')
);
const cancelCodeOnly = cancelBlock.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
assert(cancelCodeOnly.includes('diagnostic_control.request_cancel()'),
  'cancel_diagnostic must atomically mark the active diagnostic cancelled');
assert(!cancelCodeOnly.includes('diagnostic_control.finish()'),
  'cancel_diagnostic must not release provider ownership before worker exit');

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
