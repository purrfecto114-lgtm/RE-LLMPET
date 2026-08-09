#!/usr/bin/env node
'use strict';

// R44 0.5.49 — Config durability + receipt-driven uninstall + idempotent sync.
//
// This version focuses on real user impact, not blindly following the roadmap:
//   1. schemaVersion + unknown-field preservation (prevents data loss)
//   2. Receipt-driven uninstall (fixes OpenCode/CodeWhale env-var drift)
//   3. Idempotent sync (prevents backup churn on repeated saves)
//
// Deferred (over-engineering without updater/real-machine evidence):
//   - 6-state receipt state machine
//   - Full 5-step install transaction
//   - Separate Legacy Repair flow
//   - Exact owner parameter parsing
//   - Install ID UUID

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const model = read('src-tauri/src/model.rs');
const hookInstall = read('src-tauri/src/hook_install.rs');
const commands = read('src-tauri/src/commands.rs');
const changelog = read('CHANGELOG.md');
const packageJson = JSON.parse(read('package.json'));

// Version
assert.strictEqual(packageJson.version, '0.5.49',
  '0.5.49: package.json version must be 0.5.49');

// ──────────────────────────────────────────────────────────────────────────
// 1. schemaVersion + unknown-field preservation
// ──────────────────────────────────────────────────────────────────────────

assert.ok(model.includes('pub schema_version: u32'),
  '1: AppConfig must have schema_version field');
assert.ok(model.includes('pub const CURRENT_SCHEMA_VERSION: u32 = 2'),
  '1: CURRENT_SCHEMA_VERSION constant must be defined');
assert.ok(model.includes('#[serde(flatten)]'),
  '1: AppConfig must have #[serde(flatten)] for extras');
assert.ok(model.includes('pub extras: serde_json::Map<String, Value>'),
  '1: AppConfig must have extras Map for unknown-field preservation');
// Default must include new fields
assert.ok(model.includes('schema_version: CURRENT_SCHEMA_VERSION'),
  '1: Default impl must set schema_version');
assert.ok(model.includes('extras: serde_json::Map::new()'),
  '1: Default impl must initialize empty extras');
// load_config must check schema version
assert.ok(model.includes('config.schema_version > CURRENT_SCHEMA_VERSION'),
  '1: load_config must check schema_version against CURRENT_SCHEMA_VERSION');
assert.ok(model.includes('ConfigState::SchemaTooNew'),
  '1: load_config must return SchemaTooNew for future versions');
// sanitize must upgrade old schema versions
assert.ok(model.includes('self.schema_version < CURRENT_SCHEMA_VERSION'),
  '1: sanitize must upgrade old schema versions to current');

// ──────────────────────────────────────────────────────────────────────────
// 2. Receipt-driven uninstall
// ──────────────────────────────────────────────────────────────────────────

assert.ok(hookInstall.includes('fn cleanup_provider_with_path('),
  '2: cleanup_provider_with_path must exist for receipt-driven uninstall');
assert.ok(hookInstall.includes('pub fn uninstall_provider_hooks_with_path('),
  '2: public wrapper uninstall_provider_hooks_with_path must exist');
assert.ok(hookInstall.includes('fn uninstall_claude_at('),
  '2: uninstall_claude_at (path-specific) must exist');
assert.ok(hookInstall.includes('fn uninstall_codex_at('),
  '2: uninstall_codex_at (path-specific) must exist');
assert.ok(hookInstall.includes('fn uninstall_opencode_at('),
  '2: uninstall_opencode_at (path-specific) must exist');
assert.ok(hookInstall.includes('fn opencode_plugin_path('),
  '2: opencode_plugin_path helper must exist (extracted from uninstall_opencode)');
// commands.rs must pass receipt path to cleanup
assert.ok(commands.includes('uninstall_provider_hooks_with_path'),
  '2: commands.rs must call uninstall_provider_hooks_with_path when receipt path available');
assert.ok(commands.includes('receipt_path'),
  '2: commands.rs must extract receipt_path from prior_receipt');

// ──────────────────────────────────────────────────────────────────────────
// 3. Idempotent sync
// ──────────────────────────────────────────────────────────────────────────

assert.ok(hookInstall.includes('if is_current_hook_installed(id)'),
  '3: sync_enabled must skip only current hooks; legacy/mixed hooks must migrate');
assert.ok(hookInstall.includes('幂等跳过'),
  '3: sync_enabled must return idempotent-skip message');
assert.ok(hookInstall.includes('fn provider_config_path('),
  '3: provider_config_path helper must exist for idempotent-skip status');

// ──────────────────────────────────────────────────────────────────────────
// CHANGELOG
// ──────────────────────────────────────────────────────────────────────────

assert.ok(changelog.includes('0.5.49'),
  'CHANGELOG must have 0.5.49 entry');

console.log('✓ R44 0.5.49 config durability + receipt-driven uninstall smoke: all assertions passed');
