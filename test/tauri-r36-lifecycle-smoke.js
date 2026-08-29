#!/usr/bin/env node
'use strict';

// R36 (2026-07-31) — 0.5.14 trust & interaction lifecycle smoke.
//
// Locks the 5 R36 fixes from the 0.5.12 carpet audit roadmap §14:
//
//   R36-1  DiagnosticControl: one global active diagnostic job (reject
//          duplicate concurrent diagnose_agent for the same provider)
//   R36-2  geometry revision/ack: onResized listener replaces 260ms timer
//          as primary clear mechanism (timer kept as fallback)
//   R36-3  hook verify-only on startup: verify_enabled replaces sync_enabled
//          (no auto-modify external configs on launch)
//   R36-4  log rotation: 5 files × 2 MiB, rotate on size limit
//   R36-5  prefers-reduced-motion: CSS media query disables animations

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const petJs = read('frontend/renderer/pet.js');
const petCss = read('frontend/renderer/pet.css');
const panelCss = read('frontend/renderer/panel.css');
const commands = read('src-tauri/src/commands.rs');
const model = read('src-tauri/src/model.rs');
const diagnosticControl = read('src-tauri/src/diagnostic_control.rs');
const hookInstall = read('src-tauri/src/hook_install.rs');
const lib = read('src-tauri/src/lib.rs');

// ──────────────────────────────────────────────────────────────────────────
// R36-1: DiagnosticControl — one atomic lifecycle owner
// ──────────────────────────────────────────────────────────────────────────

assert(model.includes('pub diagnostic_control: crate::diagnostic_control::DiagnosticControl'),
  'Runtime must delegate diagnostic lifecycle ownership to DiagnosticControl');
assert(diagnosticControl.includes('struct DiagnosticState')
  && diagnosticControl.includes('provider: Option<String>')
  && diagnosticControl.includes('pids: HashSet<u32>')
  && diagnosticControl.includes('cancel_requested: bool'),
  'provider, PIDs and cancellation must share one mutex-owned state (R22: pids is now HashSet for parallel probes)');
assert(diagnosticControl.includes('diagnostic already in progress'),
  'DiagnosticControl must reject overlapping provider diagnostics');
assert(commands.includes('diagnostic_control.begin(provider.clone())'),
  'diagnose_agent must acquire the single-owner diagnostic control');
assert(commands.includes('state.runtime.diagnostic_control.finish();'),
  'diagnose_agent must release ownership after worker completion or panic');
assert(commands.includes('diagnostic_control.request_cancel()'),
  'cancel_diagnostic must request cancellation through the same owner');

// ──────────────────────────────────────────────────────────────────────────
// R36-2: geometry revision/ack (onResized replaces 260ms timer as primary)
// ──────────────────────────────────────────────────────────────────────────

assert(petJs.includes('let geometryRevision = 0'),
  'R36: pet.js must declare geometryRevision counter');
assert(petJs.includes('let expectedPetSize = null'),
  'R36: pet.js must declare expectedPetSize for ack comparison');
assert(petJs.includes('let geometryAckUnlisten = null'),
  'R36: pet.js must declare geometryAckUnlisten for listener cleanup');
assert(petJs.includes('function markGeometryBusy(expectedSize)'),
  'R36: markGeometryBusy must accept expectedSize parameter');
assert(petJs.includes("w.onResized(() => {"),
  'R36: markGeometryBusy must register window-scoped onResized listener');
assert(petJs.includes('clearGeometryBusy(myRevision)'),
  'R36: markGeometryBusy must call clearGeometryBusy on ack');
assert(petJs.includes('function clearGeometryBusy(myRevision)'),
  'R36: pet.js must define clearGeometryBusy function');
assert(petJs.includes('geometryAckUnlisten()'),
  'R36: clearGeometryBusy must unlisten the onResized listener');
// markGeometryBusy is called with the expected size
assert(petJs.includes('markGeometryBusy(size)'),
  'R36: setRequestedPetSize must pass expected size to markGeometryBusy');
// The 260ms timer is still there as fallback
assert(petJs.includes("}, 260);"),
  'R36: 260ms fallback timer must still exist');

// ──────────────────────────────────────────────────────────────────────────
// R36-3: hook verify-only on startup (no auto-modify external configs)
// ──────────────────────────────────────────────────────────────────────────

assert(hookInstall.includes('pub fn verify_enabled('),
  'R36: hook_install.rs must define verify_enabled function');
assert(hookInstall.includes('fn is_hook_installed(id: &str) -> bool'),
  'R36: hook_install.rs must define is_hook_installed predicate');
assert(hookInstall.includes('fn file_contains(path: impl AsRef<Path>, marker: &str) -> bool'),
  'R36: hook_install.rs must define file_contains helper');
// verify_enabled reports "missing" state (not "error") for uninstalled hooks
assert(hookInstall.includes('"missing"'),
  'R36: verify_enabled must report "missing" state for uninstalled hooks');
// startup uses verify_enabled, not sync_enabled
assert(lib.includes('hook_install::verify_enabled'),
  'R36: lib.rs startup must call hook_install::verify_enabled (not sync_enabled)');
assert(!lib.includes('hook_install::sync_enabled'),
  'R36: lib.rs startup must NOT call hook_install::sync_enabled (was auto-modify)');

// ──────────────────────────────────────────────────────────────────────────
// R36-4: log rotation (5 files × 2 MiB)
// ──────────────────────────────────────────────────────────────────────────

assert(model.includes('const MAX_LOG_SIZE: u64 = 2 * 1024 * 1024'),
  'R36: write_log must define MAX_LOG_SIZE = 2 MiB');
assert(model.includes('const MAX_LOG_FILES: u8 = 5'),
  'R36: write_log must define MAX_LOG_FILES = 5');
assert(model.includes('rotate_log(&self.log_path, MAX_LOG_FILES)'),
  'R36: write_log must call rotate_log when size exceeds limit');
assert(model.includes('fn rotate_log(path: &Path, max_files: u8)'),
  'R36: model.rs must define rotate_log function');
assert(model.includes('fs::remove_file(&oldest)'),
  'R36: rotate_log must delete the oldest file');
assert(model.includes('fs::rename(path, &first)'),
  'R36: rotate_log must rename current log to .1.log');

// ──────────────────────────────────────────────────────────────────────────
// R36-5: prefers-reduced-motion CSS
// ──────────────────────────────────────────────────────────────────────────

assert(petCss.includes('@media (prefers-reduced-motion: reduce)'),
  'R36: pet.css must include prefers-reduced-motion media query');
// R39: changed from animation-duration:0.001s to animation:none (truly disables)
assert(petCss.includes('animation: none !important'),
  'R39: pet.css reduced-motion must use animation:none (not 0.001s)');
assert(panelCss.includes('@media (prefers-reduced-motion: reduce)'),
  'R36: panel.css must include prefers-reduced-motion media query');

console.log('tauri-r36-lifecycle-smoke: ok (5 R36 fixes locked: R36-1 DiagnosticControl global owner, R36-2 geometry revision/ack, R36-3 hook verify-only startup, R36-4 log rotation, R36-5 prefers-reduced-motion)');
