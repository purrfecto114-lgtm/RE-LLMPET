#!/usr/bin/env node
'use strict';

// R34 (2026-07-31) — Config transaction + structured provider result +
// uninstall partial-failure + release signing fail-closed + setSessionPrefs
// await/catch/rollback.
//
// Background: the 0.5.7 source audit identified 4 P0 + 1 P1 issues where the
// code silently dropped failures or contradicted its own documentation. This
// smoke locks the R34 fixes so they cannot regress.
//
// Locked fixes:
//   1. model.rs update_config: copy-on-write (snapshot → save → commit)
//   2. commands.rs set_providers: returns structured { ok, selected, providers }
//      and rejects on partial failure
//   3. commands.rs uninstall_hooks('all'): returns { allHooksRemoved, results,
//      failures } and does NOT clear config.providers on partial failure
//   4. release.yml: tag pushes without TAURI_SIGNING_PRIVATE_KEY exit 1
//   5. panel.js setSessionPrefs caller: snapshot → optimistic update →
//      await → revert on failure → toast

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const model = read('src-tauri/src/model.rs');
const commands = read('src-tauri/src/commands.rs');
const release = read('.github/workflows/release.yml');
const panelJs = read('frontend/renderer/panel.js');

// ── P0-1: update_config is copy-on-write ──────────────────────────────────
// The old `let mut guard = ...; update(&mut guard); save_config(&guard)?`
// mutated shared state before persisting. The new code snapshots, mutates
// the snapshot, saves, THEN commits to the Mutex.
assert(model.includes('let candidate = {'),
  'model.rs update_config must snapshot into a `candidate` local');
assert(model.includes('save_config(&self.config_path, &candidate)?'),
  'model.rs update_config must persist the candidate BEFORE committing');
assert(model.includes('*guard = candidate'),
  'model.rs update_config must commit the candidate to the Mutex AFTER save');
assert(model.includes('copy-on-write transaction'),
  'model.rs update_config must document the copy-on-write rationale');

// ── P0-2: set_providers returns structured result ─────────────────────────
// R35.2 (2026-07-31): set_providers no longer returns Err on partial hook
// failure. The 0.5.12 carpet audit P0-2 flagged that the old Err-after-commit
// caused disk/memory/UI split-brain. Now it ALWAYS returns Ok with
// { selectedSaved, allHooksOk, selected, hookResults, errors }.
assert(commands.includes('pub fn set_providers('),
  'commands.rs must define set_providers');
assert(commands.match(/pub fn set_providers\([\s\S]*?\) -> Result<Value, String>/),
  'set_providers must return Result<Value, String> (was Result<(), String>)');
// R35.2: the return shape changed from { ok, selected, providers } to
// { selectedSaved, allHooksOk, selected, hookResults, errors }.
assert(commands.includes('"selectedSaved": true'),
  'R35.2: set_providers must return selectedSaved=true (selection always persists)');
assert(commands.includes('"allHooksOk": all_hooks_ok'),
  'R35.2: set_providers must return allHooksOk flag (hook results separated)');
assert(commands.includes('"hookResults": providers'),
  'R35.2: set_providers must return hookResults array (per-provider install outcome)');
assert(commands.includes('"selected": ids'),
  'set_providers must echo back the user-requested `selected` list');
assert(commands.includes('"installed": s.installed'),
  'set_providers must include per-provider `installed` flag');
// R35.2: the old `return Err(errors.join(...))` is GONE — the Promise
// resolves so the frontend keeps the checkbox in sync with disk.
assert(!commands.includes('return Err(errors.join'),
  'R35.2: set_providers must NOT return Err on partial hook failure (was split-brain)');

// ── P0-3: uninstall_hooks('all') does not swallow failures ───────────────
assert(commands.includes('"allHooksRemoved": all_succeeded'),
  'uninstall_hooks must return allHooksRemoved flag');
assert(commands.includes('"results": results'),
  'uninstall_hooks must return per-provider results array');
assert(commands.includes('"failures": failures'),
  'uninstall_hooks must return failures array');
assert(commands.includes('"status": "failed"'),
  'uninstall_hooks must mark failed providers with status=failed');
assert(commands.includes('if all_succeeded'),
  'uninstall_hooks must check all_succeeded for reporting');
assert(commands.includes('could not be removed'),
  'uninstall_hooks must surface partial failure in message');

// ── P0-4: release.yml tag pushes fail-closed without signing key ──────────
assert(release.includes('Tag release v$VERSION requires TAURI_SIGNING_PRIVATE_KEY'),
  'release.yml must emit ::error:: when tag push lacks signing key');
assert(release.includes('Use workflow_dispatch for unsigned draft builds instead'),
  'release.yml must direct users to workflow_dispatch for unsigned builds');
assert(release.match(/if \[ -z "\$\{\{ env\.TAURI_SIGNING_PRIVATE_KEY \}\}" \]; then[\s\S]*?exit 1/),
  'release.yml tag-without-key branch must exit 1 (fail-closed)');
// The old warning + unsigned prerelease path must be GONE for tag pushes.
assert(!release.includes('UNSIGNED PRERELEASE'),
  'release.yml must NOT publish unsigned public prereleases on tag pushes');

// ── P1-1: panel.js setSessionPrefs caller awaits + reverts on failure ────
assert(panelJs.includes('const prevPinned = sessionPinned.slice()'),
  'panel.js must snapshot prevPinned before optimistic update');
assert(panelJs.includes('const prevArchived = sessionArchived.slice()'),
  'panel.js must snapshot prevArchived before optimistic update');
assert(panelJs.match(/setSessionPrefs[\s\S]{0,200}?\.catch\(\(err\) =>/),
  'panel.js setSessionPrefs call must have .catch handler');
assert(panelJs.includes('sessionPinned = prevPinned'),
  'panel.js must revert sessionPinned on IPC failure');
assert(panelJs.includes('sessionArchived = prevArchived'),
  'panel.js must revert sessionArchived on IPC failure');
assert(panelJs.includes("command: 'set_session_prefs'"),
  'panel.js must dispatch re-llmpet:bridge-error with command=set_session_prefs');

console.log('tauri-r34-config-transaction-smoke: ok (5 P0/P1 fixes locked)');
