#!/usr/bin/env node
'use strict';

// R38 (2026-08-01) — 0.5.16 correctness blocker patch smoke.
//
// Locks the 4 P0 fixes from the 0.5.15 full audit branch roadmap:
//
//   P0-1  Fix getCurrentWindow() API — was using nonexistent getCurrent()
//   P0-2  Diagnostic registry — global mutual exclusion (no cross-provider races)
//   P0-3  Stats trailing flush — dropped events get a deferred re-emit
//   P0-4  Panel visibility — Rust emits panel:hidden + init-time isVisible()

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const bridge = read('frontend/renderer/tauri-bridge.js');
const petJs = read('frontend/renderer/pet.js');
const panelJs = read('frontend/renderer/panel.js');
const commands = read('src-tauri/src/commands.rs');
const httpServer = read('src-tauri/src/http_server.rs');

// ──────────────────────────────────────────────────────────────────────────
// P0-1: getCurrentWindow() API fix
// ──────────────────────────────────────────────────────────────────────────

assert(bridge.includes('function getCurrentTauriWindow()'),
  'R38: tauri-bridge.js must define getCurrentTauriWindow helper');
assert(bridge.includes('api.getCurrentWindow'),
  'R38: getCurrentTauriWindow must try getCurrentWindow() (Tauri 2 API)');
// Comments mentioning the old API are OK — only code lines must not call it.
const bridgeCodeOnly = bridge.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
assert(!bridgeCodeOnly.includes('.window.getCurrent()'),
  'R38: tauri-bridge.js code must NOT call .window.getCurrent()');
assert(petJs.includes('getCurrentTauriWindow()'),
  'R38: pet.js must use getCurrentTauriWindow()');
assert(panelJs.includes('getCurrentTauriWindow()'),
  'R38: panel.js must use getCurrentTauriWindow()');
// Verify no remaining incorrect getCurrent() calls in code
const petCodeOnly = petJs.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const panelCodeOnly = panelJs.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
assert(!petCodeOnly.includes('.window.getCurrent()'),
  'R38: pet.js code must NOT call .window.getCurrent()');
assert(!panelCodeOnly.includes('.window.getCurrent()'),
  'R38: panel.js code must NOT call .window.getCurrent()');

// ──────────────────────────────────────────────────────────────────────────
// P0-2: Diagnostic registry — global mutual exclusion
// ──────────────────────────────────────────────────────────────────────────

// The guard must reject ANY active diagnostic, not just same-provider
assert(commands.includes('if let Some(active) = provider_guard.as_ref()'),
  'R38: diagnose_agent must check for ANY active diagnostic');
assert(!commands.includes('if active == &provider'),
  'R38: diagnose_agent must NOT do per-provider matching (was race-prone)');

// ──────────────────────────────────────────────────────────────────────────
// P0-3: Stats trailing flush
// ──────────────────────────────────────────────────────────────────────────

assert(httpServer.includes('tauri::async_runtime::spawn_blocking'),
  'R38: http_server.rs emit_stats must spawn a trailing flush task');
assert(httpServer.includes('std::thread::sleep'),
  'R38: trailing flush must use std::thread::sleep (tokio not directly in scope)');
assert(httpServer.includes('STATS_THROTTLE_MS as u64'),
  'R38: trailing flush must sleep for STATS_THROTTLE_MS');

// ──────────────────────────────────────────────────────────────────────────
// P0-4: Panel visibility — panel:hidden event + init-time isVisible()
// ──────────────────────────────────────────────────────────────────────────

assert(commands.includes('app.emit("panel:hidden"'),
  'R38: close_panel must emit panel:hidden event');
assert(panelJs.includes("ev.listen('panel:hidden'"),
  'R38: panel.js must subscribe to panel:hidden event');
assert(panelJs.includes('panelVisible = false'),
  'R38: panel:hidden handler must set panelVisible = false');
assert(panelJs.includes('w.isVisible()'),
  'R38: panel.js must check initial visibility via isVisible()');

console.log('tauri-r38-correctness-blocker-smoke: ok (4 P0 fixes locked: P0-1 getCurrentWindow API, P0-2 global diagnostic mutex, P0-3 stats trailing flush, P0-4 panel:hidden event + init visibility)');
