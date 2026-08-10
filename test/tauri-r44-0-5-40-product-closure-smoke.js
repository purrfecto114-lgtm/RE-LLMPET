#!/usr/bin/env node
'use strict';

// R44 0.5.50 (Roadmap v6) — Product Closure & Config Durability smoke.
//
// Locks the 0.5.50 deliverables from Roadmap v6:
//
//   P0-01  Config recovery commands in panel capability + bridge + UI
//   P0-02  metadata errors correctly classified (NotFound vs Unreadable)
//   P0-03  reset failure restores old ConfigState (rollback)
//   P0-04  backup_and_reset_config returns ResetResult (not PathBuf)
//   P0-05  post-clean verify failure returns Unreadable (not Removed)
//   P0-06  drift is now an enum (driftStatus), not just bool
//
// User closure: when config is quarantined, user can now reach
// backup-and-reset from the panel UI (not just DevTools).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const model = read('src-tauri/src/model.rs');
const commands = read('src-tauri/src/commands.rs');
const hookInstall = read('src-tauri/src/hook_install.rs');
const panelJson = JSON.parse(read('src-tauri/capabilities/panel.json'));
const petJson = JSON.parse(read('src-tauri/capabilities/pet.json'));
const bridge = read('frontend/renderer/tauri-bridge.js');
const panelHtml = read('frontend/renderer/panel.html');
const panelJs = read('frontend/renderer/panel.js');
const panelCss = read('frontend/renderer/panel.css');
const i18n = read('frontend/shared/i18n.js');
const changelog = read('CHANGELOG.md');
const packageJson = JSON.parse(read('package.json'));

// ──────────────────────────────────────────────────────────────────────────
// Version
// ──────────────────────────────────────────────────────────────────────────

assert.strictEqual(packageJson.version, '0.5.50',
  '0.5.50: package.json version must be 0.5.50');

// ──────────────────────────────────────────────────────────────────────────
// P0-01: Config recovery commands in panel capability + bridge + UI
// ──────────────────────────────────────────────────────────────────────────

// Panel capability must authorize the three recovery commands
const panelPerms = panelJson.permissions;
assert(panelPerms.includes('allow-get-config-state'),
  'P0-01: panel.json must include allow-get-config-state');
assert(panelPerms.includes('allow-backup-and-reset-config'),
  'P0-01: panel.json must include allow-backup-and-reset-config');
assert(panelPerms.includes('allow-get-install-receipts'),
  'P0-01: panel.json must include allow-get-install-receipts');

// Pet capability must NOT authorize these (privileged, panel-only)
const petPerms = petJson.permissions;
assert(!petPerms.includes('allow-get-config-state'),
  'P0-01: pet.json must NOT include allow-get-config-state (panel-only)');
assert(!petPerms.includes('allow-backup-and-reset-config'),
  'P0-01: pet.json must NOT include allow-backup-and-reset-config (panel-only)');

// Bridge must expose the three functions
assert(bridge.includes('getConfigState: () => call(\'get_config_state\')'),
  'P0-01: tauri-bridge.js must expose getConfigState');
assert(bridge.includes('backupAndResetConfig: () => call(\'backup_and_reset_config\')'),
  'P0-01: tauri-bridge.js must expose backupAndResetConfig');
assert(bridge.includes('getInstallReceipts: () => call(\'get_install_receipts\')'),
  'P0-01: tauri-bridge.js must expose getInstallReceipts');

// Panel HTML must have recovery overlay
assert(panelHtml.includes('id="recovery-overlay"'),
  'P0-01: panel.html must have recovery-overlay div');
assert(panelHtml.includes('id="recovery-backup-reset"'),
  'P0-01: panel.html must have recovery-backup-reset button');
assert(panelHtml.includes('id="recovery-retry"'),
  'P0-01: panel.html must have recovery-retry button');

// Panel JS must check config state on startup
assert(panelJs.includes('window.pet.getConfigState()'),
  'P0-01: panel.js must call getConfigState on startup');
assert(panelJs.includes('showRecoveryOverlay'),
  'P0-01: panel.js must have showRecoveryOverlay function');
assert(panelJs.includes('cs.quarantined'),
  'P0-01: panel.js must check cs.quarantined');

// Panel CSS must style the recovery overlay
assert(panelCss.includes('.recovery-overlay'),
  'P0-01: panel.css must have .recovery-overlay style');
assert(panelCss.includes('.recovery-card'),
  'P0-01: panel.css must have .recovery-card style');

// i18n must have recovery keys in all three languages
const recoveryKeys = [
  'recovery.title', 'recovery.explain', 'recovery.backupReset',
  'recovery.retry', 'recovery.close', 'recovery.warn',
  'recovery.backupPathLabel', 'recovery.resetDone',
  'recovery.resetFailed', 'recovery.confirm'
];
for (const key of recoveryKeys) {
  const count = (i18n.match(new RegExp(`'${key}':`, 'g')) || []).length;
  assert.strictEqual(count, 3,
    `P0-01: i18n.js must have ${key} in all 3 languages (zh/en/ja), got ${count}`);
}

// ──────────────────────────────────────────────────────────────────────────
// P0-02: metadata errors correctly classified
// ──────────────────────────────────────────────────────────────────────────

// load_config must distinguish NotFound from other metadata errors
assert(/Err\((?:e|error)\) if (?:e|error)\.kind\(\) == std::io::ErrorKind::NotFound =>/.test(model),
  'P0-02: load_config must check ErrorKind::NotFound specifically');
assert(model.includes('fs::symlink_metadata(path)'),
  'P0-02: load_config must reject symlink config paths instead of following them');
assert(model.includes('ConfigState::Unreadable'),
  'P0-02: load_config must return Unreadable for non-NotFound metadata errors');

// ──────────────────────────────────────────────────────────────────────────
// P0-03 + P0-04: reset transaction + ResetResult
// ──────────────────────────────────────────────────────────────────────────

assert(model.includes('pub struct ResetResult'),
  'P0-04: ResetResult struct must be defined');
assert(model.includes('pub fn backup_and_reset_config(&self) -> Result<ResetResult, String>'),
  'P0-04: backup_and_reset_config must return Result<ResetResult, String>');
// Rollback: must restore old state on failure
assert(model.includes('old_state'),
  'P0-03: backup_and_reset_config must snapshot old_state for rollback');
assert(model.includes('state restored to'),
  'P0-03: backup_and_reset_config must restore old state on failure');
// backup_path must be Option (not fake config_path)
assert(model.includes('backup_path: Option<PathBuf>'),
  'P0-04: ResetResult.backup_path must be Option<PathBuf>');

// commands.rs must use structured result
assert(commands.includes('"backupCreated": result.backup_created'),
  'P0-04: commands.rs must expose backupCreated field');
assert(commands.includes('"backupPath": result.backup_path.map'),
  'P0-04: commands.rs must expose backupPath as Option');

// ──────────────────────────────────────────────────────────────────────────
// P0-05: post-clean verify failure returns Unreadable
// ──────────────────────────────────────────────────────────────────────────

// The old `if let Ok(post_raw) = ...` pattern must be replaced with
// `match fs::read_to_string(...) { Ok(...) => ..., Err(e) => Unreadable }`
assert(!hookInstall.includes('if let Ok(post_raw) = fs::read_to_string'),
  'P0-05: old if-let-Ok post-clean pattern must be removed (false Removed on read fail)');
assert(hookInstall.includes('post-clean verify read failed'),
  'P0-05: post-clean verify must return Unreadable with "post-clean verify read failed" message');

// ──────────────────────────────────────────────────────────────────────────
// P0-06: drift is now an enum (driftStatus)
// ──────────────────────────────────────────────────────────────────────────

assert(commands.includes('"driftStatus"'),
  'P0-06: commands.rs must include driftStatus field');
// All 6 drift states must be referenced
const driftStates = ['unchanged', 'changed', 'missing', 'unreadable', 'noReceipt', 'invalidReceipt'];
for (const state of driftStates) {
  assert(commands.includes(`"${state}"`),
    `P0-06: commands.rs must reference drift state "${state}"`);
}
// driftDetected must still exist (backward compat) but derived from driftStatus
assert(commands.includes('let drift_detected = drift_status == "changed"'),
  'P0-06: driftDetected must be derived from driftStatus == "changed"');

// ──────────────────────────────────────────────────────────────────────────
// CHANGELOG
// ──────────────────────────────────────────────────────────────────────────

assert(changelog.includes('0.5.50'),
  'CHANGELOG must have 0.5.50 entry');

console.log('✓ R44 0.5.50 (Roadmap v6) product closure smoke: all assertions passed');
