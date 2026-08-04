#!/usr/bin/env node
'use strict';

// R44 0.5.43 (roadmap v5) — correctness closure smoke.
//
// Locks the 7 deliverables from roadmap v5 §0.5.43:
//
//   §1  Node installer no longer claims HTTP hooks as ours
//   §2  Config quarantine state machine (ConfigState enum on Runtime)
//   §3  Typed CleanupResult enum replacing Result<PathBuf, String>
//   §4  Bulk uninstall reuses single-provider pipeline (run_one helper)
//   §5  SHA-256 drift signature (replaces size+mtime)
//   §6  strip_legacy_codewhale_hooks dead code DELETED
//   §7  Phase 0E script fixed (bulk path docs, devtools note, new tests)
//
// Also locks the new IPC commands: get_config_state, backup_and_reset_config.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const hookInstall = read('src-tauri/src/hook_install.rs');
const commands = read('src-tauri/src/commands.rs');
const model = read('src-tauri/src/model.rs');
const lib = read('src-tauri/src/lib.rs');
const build = read('src-tauri/build.rs');
const cargo = read('src-tauri/Cargo.toml');
const installer = read('scripts/install-native-hooks.js');
const phase0e = read('scripts/phase-0e-destructive-test.sh');
const changelog = read('CHANGELOG.md');
const packageJson = JSON.parse(read('package.json'));

// ──────────────────────────────────────────────────────────────────────────
// Version
// ──────────────────────────────────────────────────────────────────────────

assert.strictEqual(packageJson.version, '0.5.43',
  '0.5.43: package.json version must be 0.5.43');

// ──────────────────────────────────────────────────────────────────────────
// §1: Node installer no longer claims HTTP hooks
// ──────────────────────────────────────────────────────────────────────────

assert.ok(!installer.includes('function isOurHttp'),
  '§1: isOurHttp function must be REMOVED from install-native-hooks.js');
assert.ok(installer.includes('isOurHttp'),
  '§1: a comment explaining why isOurHttp was removed must remain');
// The PermissionRequest sync must use isOurs only (not isOurs || isOurHttp)
assert.ok(installer.includes("sync(settings.hooks, 'PermissionRequest', permissionHook, isOurs)]"),
  '§1: PermissionRequest install must use isOurs only (no isOurHttp fallback)');

// ──────────────────────────────────────────────────────────────────────────
// §2: ConfigState enum on Runtime
// ──────────────────────────────────────────────────────────────────────────

assert.ok(model.includes('pub enum ConfigState'),
  '§2: ConfigState enum must be defined in model.rs');
assert.ok(model.includes('pub config_state: Mutex<ConfigState>'),
  '§2: Runtime must have config_state: Mutex<ConfigState> field');
// All 6 variants required by roadmap v5 §2
for (const variant of ['Healthy', 'NotFound', 'ParseError', 'Unreadable', 'TooLarge', 'SchemaTooNew']) {
  assert.ok(model.includes(`${variant} {`) || model.includes(`${variant},`) || model.includes(variant + ' '),
    `§2: ConfigState must have ${variant} variant`);
}
// load_config must return (AppConfig, ConfigState)
assert.ok(model.includes('pub fn load_config(path: &Path) -> (AppConfig, ConfigState)'),
  '§2: load_config must return (AppConfig, ConfigState) tuple');
// The old global atomic must be GONE
assert.ok(!model.includes('static CONFIG_WRITE_DISABLED'),
  '§2: global CONFIG_WRITE_DISABLED AtomicBool must be REMOVED');
assert.ok(!model.includes('config_write_disabled: std::sync::atomic::AtomicBool'),
  '§2: config_write_disabled AtomicBool field must be REMOVED from Runtime');
// Runtime::save_config (instance method) must check quarantine
assert.ok(model.includes('pub fn save_config(&self, config: &AppConfig) -> Result<(), String>'),
  '§2: Runtime must have save_config instance method that checks quarantine');
assert.ok(model.includes('if !state.writes_allowed()'),
  '§2: Runtime::save_config must check state.writes_allowed() before writing');
// backup_and_reset_config recovery method
// R44 0.5.43: signature changed to Result<ResetResult, String> (transactional)
assert.ok(
  model.includes('pub fn backup_and_reset_config(&self) -> Result<ResetResult, String>') ||
  model.includes('pub fn backup_and_reset_config(&self) -> Result<PathBuf, String>'),
  '§2: Runtime must have backup_and_reset_config recovery method'
);

// New IPC commands registered
assert.ok(commands.includes('pub fn get_config_state('),
  '§2: get_config_state IPC command must be defined');
assert.ok(commands.includes('pub fn backup_and_reset_config('),
  '§2: backup_and_reset_config IPC command must be defined');
assert.ok(lib.includes('get_config_state'),
  '§2: get_config_state must be registered in invoke_handler');
assert.ok(lib.includes('backup_and_reset_config'),
  '§2: backup_and_reset_config must be registered in invoke_handler');
assert.ok(build.includes('"get_config_state"'),
  '§2: get_config_state must be in build.rs COMMANDS');
assert.ok(build.includes('"backup_and_reset_config"'),
  '§2: backup_and_reset_config must be in build.rs COMMANDS');

// ──────────────────────────────────────────────────────────────────────────
// §3: CleanupResult enum
// ──────────────────────────────────────────────────────────────────────────

assert.ok(hookInstall.includes('pub enum CleanupResult'),
  '§3: CleanupResult enum must be defined in hook_install.rs');
// All 8 variants required by roadmap v5 §3
for (const variant of ['Removed', 'NotFound', 'Unowned', 'Changed', 'PathDrift', 'Unreadable', 'Residue', 'ManualActionRequired']) {
  assert.ok(hookInstall.includes(`${variant} {`) || hookInstall.includes(`${variant},`),
    `§3: CleanupResult must have ${variant} variant`);
}
// to_json, is_clean, is_hard_failure methods
assert.ok(hookInstall.includes('pub fn to_json(&self) -> Value'),
  '§3: CleanupResult must have to_json method');
assert.ok(hookInstall.includes('pub fn is_clean(&self) -> bool'),
  '§3: CleanupResult must have is_clean method');
assert.ok(hookInstall.includes('pub fn is_hard_failure(&self) -> bool'),
  '§3: CleanupResult must have is_hard_failure method');
// uninstall_provider_hooks must return CleanupResult (NOT Result<PathBuf, String>)
assert.ok(hookInstall.includes('pub fn uninstall_provider_hooks(id: &str) -> CleanupResult'),
  '§3: uninstall_provider_hooks must return CleanupResult');
// OpenCode uninstall must NOT return Removed when file wasn't deleted
const opencodeSection = hookInstall.slice(
  hookInstall.indexOf('fn uninstall_opencode()'),
  hookInstall.indexOf('fn install_aider(')
);
assert.ok(opencodeSection.includes('CleanupResult::Unowned { path }'),
  '§3: uninstall_opencode must return Unowned when file is not ours (not Removed/Ok)');
assert.ok(opencodeSection.includes('CleanupResult::NotFound { path }'),
  '§3: uninstall_opencode must return NotFound when file does not exist');
assert.ok(opencodeSection.includes('CleanupResult::Unreadable'),
  '§3: uninstall_opencode must return Unreadable when file cannot be read');

// ──────────────────────────────────────────────────────────────────────────
// §4: Bulk uninstall reuses single-provider pipeline
// ──────────────────────────────────────────────────────────────────────────

assert.ok(commands.includes('let run_one = |id: &str|'),
  '§4: uninstall_hooks must have a run_one helper used by both paths');
assert.ok(commands.includes('all_providers.to_vec()'),
  '§4: bulk path must iterate all_providers via run_one (not a separate loop)');
assert.ok(commands.includes('"allHooksVerifiedAbsent": all_clean'),
  '§4: bulk response must include allHooksVerifiedAbsent (canonical)');
assert.ok(commands.includes('"allHooksRemoved": all_clean'),
  '§4: bulk response must keep allHooksRemoved alias for backward compat');
// The old separate if-provider=="all" block with its own match must be gone
assert.ok(!commands.includes('Ok(path) => {\n                    results.push(json!({\n                        "provider": id,\n                        "status": "removed"'),
  '§4: old bulk loop with Ok(path)/Err(err) must be replaced by run_one pipeline');

// ──────────────────────────────────────────────────────────────────────────
// §5: SHA-256 drift signature
// ──────────────────────────────────────────────────────────────────────────

assert.ok(cargo.includes('sha2 = "0.10"'),
  '§5: sha2 crate must be added to Cargo.toml dependencies');
assert.ok(hookInstall.includes('use sha2::{Digest, Sha256}') || hookInstall.includes('use sha2::{Sha256, Digest}'),
  '§5: drift_signature must use sha2::Sha256');
assert.ok(hookInstall.includes('hasher.finalize()'),
  '§5: drift_signature must call hasher.finalize()');
// The old size+mtime signature must be GONE
assert.ok(!hookInstall.includes('size={size};mtime={mtime}'),
  '§5: old size+mtime signature format must be REMOVED');
assert.ok(!hookInstall.includes('let size = meta.len();'),
  '§5: old size+mtime code path must be REMOVED from drift_signature');

// ──────────────────────────────────────────────────────────────────────────
// §6: strip_legacy_codewhale_hooks DELETED
// ──────────────────────────────────────────────────────────────────────────

assert.ok(!hookInstall.includes('fn strip_legacy_codewhale_hooks'),
  '§6: strip_legacy_codewhale_hooks function must be DELETED');
assert.ok(!hookInstall.includes('fn parse_toml_string_value'),
  '§6: parse_toml_string_value helper must be DELETED (only used by deleted function)');
// A tombstone comment must explain why it was removed
assert.ok(hookInstall.includes('were DELETED') && hookInstall.includes('strip_legacy_codewhale_hooks'),
  '§6: tombstone comment must explain the deletion of strip_legacy_codewhale_hooks');

// ──────────────────────────────────────────────────────────────────────────
// §7: Phase 0E script fixed
// ──────────────────────────────────────────────────────────────────────────

// Test 8 description must mention the new bulk pipeline behavior
assert.ok(phase0e.includes('allHooksVerifiedAbsent'),
  '§7: Phase 0E Test 8 must mention allHooksVerifiedAbsent');
assert.ok(phase0e.includes('CleanupResult'),
  '§7: Phase 0E Test 8 must mention CleanupResult in the expected response');
// Test 9 must mention devtools access method
assert.ok(phase0e.includes('right-click -> Inspect Element'),
  '§7: Phase 0E Test 9 must explain how to open devtools');
// Test 9 must mention the new get_config_state IPC
assert.ok(phase0e.includes('get_config_state'),
  '§7: Phase 0E Test 9 must test the new get_config_state IPC');
assert.ok(phase0e.includes('backup_and_reset_config'),
  '§7: Phase 0E Test 9 must test the new backup_and_reset_config IPC');
// New tests 11 and 12 for SHA-256 drift + CleanupResult variants
assert.ok(phase0e.includes('Test 11: SHA-256 drift detection'),
  '§7: Phase 0E must have Test 11 for SHA-256 drift detection');
assert.ok(phase0e.includes('Test 12: CleanupResult variants'),
  '§7: Phase 0E must have Test 12 for CleanupResult variants');

// ──────────────────────────────────────────────────────────────────────────
// CHANGELOG
// ──────────────────────────────────────────────────────────────────────────

assert.ok(changelog.includes('0.5.43'),
  'CHANGELOG must have 0.5.43 entry');

console.log('✓ R44 0.5.43 (roadmap v5) correctness closure smoke: all assertions passed');
