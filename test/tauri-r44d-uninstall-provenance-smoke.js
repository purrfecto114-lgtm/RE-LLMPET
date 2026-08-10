#!/usr/bin/env node
'use strict';

// R44 Phase 0D (2026-08-03) — 0.5.53 uninstall provenance + drift detection.
//
// Locks the Phase 0D deliverables:
//
//   P0D-1  New IPC command `get_install_receipts` registered in
//          tauri::generate_handler! and exposed as a Rust command.
//
//   P0D-2  `uninstall_hooks` response now carries priorReceipt /
//          installedAt / backupPath / driftDetected so the frontend
//          can show "you installed on X, backup at Y, drift: yes/no"
//          in the uninstall confirmation dialog.
//
//   P0D-3  `current_drift_signature` is a pub fn in hook_install.rs
//          so commands.rs can compute the live file signature and
//          compare it to the receipt's `drift_signature` field.
//
//   P0D-4  If `driftDetected` is true, the uninstall message warns
//          "config was modified after install — verify backup".
//
//   P0D-5  The "all" uninstall path still works (it doesn't surface
//          per-provider receipts — that's intentional, "all" is a
//          bulk operation and the user doesn't need per-provider
//          provenance for it; the existing `results` array carries
//          per-provider status).
//
//   P0D-6  Backward compat: if no receipt exists (installed before
//          0.5.53), uninstall still succeeds; priorReceipt is null
//          and driftDetected is false (no signature to compare).
//
// Phase 0D is the bridge between Phase 0C (receipt creation) and
// Phase 0E (real-machine destructive testing).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const hookInstall = read('src-tauri/src/hook_install.rs');
const commands = read('src-tauri/src/commands.rs');
const lib = read('src-tauri/src/lib.rs');
const changelog = read('CHANGELOG.md');
const packageJson = JSON.parse(read('package.json'));

// ──────────────────────────────────────────────────────────────────────────
// Version (still 0.5.53 — Phase 0D ships in the same release as 0C)
// ──────────────────────────────────────────────────────────────────────────

assert.strictEqual(packageJson.version, '0.5.53',
  'P0D: package.json version must remain 0.5.53 (Phase 0C+0D ship together)');

// ──────────────────────────────────────────────────────────────────────────
// P0D-1: get_install_receipts IPC command registered
// ──────────────────────────────────────────────────────────────────────────

// The Rust command must exist
assert.ok(commands.includes('pub fn get_install_receipts() -> Value'),
  'P0D-1: get_install_receipts command must be defined in commands.rs');
// It must be registered in the invoke_handler
assert.ok(lib.includes('get_install_receipts'),
  'P0D-1: get_install_receipts must be registered in tauri::generate_handler!');
// It must call the hook_install::read_install_receipts() pub fn
assert.ok(commands.includes('crate::hook_install::read_install_receipts()'),
  'P0D-1: get_install_receipts must call hook_install::read_install_receipts()');

// ──────────────────────────────────────────────────────────────────────────
// P0D-2: uninstall_hooks response carries receipt fields
// ──────────────────────────────────────────────────────────────────────────

// R44 0.5.53: the single-provider and bulk paths now share a `run_one`
// helper. The receipt snapshot + drift computation must happen BEFORE
// the cleanup call inside that helper.
const runOneSection = commands.slice(
  commands.indexOf('let run_one = |id: &str|'),
  commands.indexOf('let targets:')
);
assert.ok(runOneSection.includes('let prior_receipt = crate::hook_install::read_install_receipts()'),
  'P0D-2: run_one helper must snapshot prior_receipt');
assert.ok(runOneSection.includes('crate::hook_install::current_drift_signature'),
  'P0D-2: run_one helper must compute drift signature');
const receiptIdx = runOneSection.indexOf('let prior_receipt');
const cleanupIdx = runOneSection.indexOf('crate::hook_install::uninstall_provider_hooks(id)');
assert.ok(receiptIdx >= 0 && cleanupIdx >= 0 && receiptIdx < cleanupIdx,
  'P0D-2: receipt snapshot MUST come before uninstall_provider_hooks (audit fix C9+C10)');
assert.ok(commands.includes('"priorReceipt": prior_receipt'),
  'P0D-2: uninstall_hooks response must include priorReceipt field');
assert.ok(commands.includes('"installedAt": installed_at'),
  'P0D-2: uninstall_hooks response must include installedAt field');
assert.ok(commands.includes('"backupPath": backup_path'),
  'P0D-2: uninstall_hooks response must include backupPath field');
assert.ok(commands.includes('"driftDetected": drift_detected'),
  'P0D-2: uninstall_hooks response must include driftDetected field');

// ──────────────────────────────────────────────────────────────────────────
// P0D-3: current_drift_signature is pub
// ──────────────────────────────────────────────────────────────────────────

assert.ok(
  hookInstall.includes('pub fn current_drift_signature(path: &Path) -> Option<String>'),
  'P0D-3: current_drift_signature must be pub fn in hook_install.rs'
);
assert.ok(commands.includes('crate::hook_install::current_drift_signature'),
  'P0D-3: commands.rs must call current_drift_signature to compare against receipt');

// ──────────────────────────────────────────────────────────────────────────
// P0D-4: Drift warning message
// ──────────────────────────────────────────────────────────────────────────

assert.ok(
  commands.includes('config was modified after install — verify backup'),
  'P0D-4: driftDetected=true must surface a warning message'
);
// The non-drift message must still mention "user config preserved"
assert.ok(
  commands.includes('user config preserved'),
  'P0D-4: driftDetected=false must keep the existing "user config preserved" message'
);

// ──────────────────────────────────────────────────────────────────────────
// P0D-5: "all" uninstall path reuses single-provider pipeline (0.5.53 §4)
// ──────────────────────────────────────────────────────────────────────────

// R44 0.5.53 (roadmap v5 §4): "all" must call the same run_one pipeline
// as single-provider. The bulk response includes results[] with each
// provider's CleanupResult, plus allHooksVerifiedAbsent (renamed from
// allHooksRemoved but aliased for backward compat).
assert.ok(commands.includes('"allHooksVerifiedAbsent": all_clean'),
  'P0D-5: "all" uninstall must return allHooksVerifiedAbsent (0.5.53 §4)');
assert.ok(commands.includes('"allHooksRemoved": all_clean'),
  'P0D-5: "all" uninstall must keep allHooksRemoved alias for backward compat');
assert.ok(commands.includes('"results": results'),
  'P0D-5: "all" uninstall must return per-provider results array');
assert.ok(commands.includes('all_providers.to_vec()'),
  'P0D-5: "all" must iterate all_providers via the same run_one pipeline (0.5.53 §4)');

// ──────────────────────────────────────────────────────────────────────────
// P0D-6: Backward compat — absent receipt doesn't break uninstall
// ──────────────────────────────────────────────────────────────────────────

// The run_one helper handles None receipt gracefully (drift_detected=false).
assert.ok(commands.includes('None => false'),
  'P0D-6: absent receipt must produce drift_detected=false (no crash)');

// ──────────────────────────────────────────────────────────────────────────
// P0D-7: User-requirement traceability
// ──────────────────────────────────────────────────────────────────────────

// The commands.rs comment block must reference Phase 0D and the receipt
// use case so future maintainers understand WHY the response now carries
// priorReceipt.
assert.ok(commands.includes('R44 Phase 0D'),
  'P0D-7: commands.rs must reference R44 Phase 0D in comments');

// ──────────────────────────────────────────────────────────────────────────
// P0D-8: CHANGELOG mentions Phase 0D
// ──────────────────────────────────────────────────────────────────────────

assert.ok(changelog.includes('Phase 0D') || changelog.includes('0D'),
  'P0D-8: CHANGELOG must mention Phase 0D');

console.log('✓ R44 Phase 0D (0.5.53) uninstall provenance smoke: all assertions passed');
