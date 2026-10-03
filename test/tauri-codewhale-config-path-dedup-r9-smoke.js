'use strict';

// R9 smoke: codewhale_config_path() must be a single shared definition.
// Previously duplicated in commands.rs:2111 and hook_install.rs:1430 (identical impls),
// which risked drift if one was updated without the other.
//
// This test locks:
//   1. hook_install.rs has `pub fn codewhale_config_path` (canonical, shared).
//   2. commands.rs does NOT have a local `fn codewhale_config_path` definition.
//   3. commands.rs calls `crate::hook_install::codewhale_config_path()` (shared).
//   4. The precedence chain is documented (CODEWHALE_CONFIG_PATH → DEEPSEEK_CONFIG_PATH →
//      CODEWHALE_HOME → ~/.codewhale/config.toml → legacy ~/.deepseek/config.toml).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const commands = read('src-tauri/src/commands.rs');
const hookInstall = read('src-tauri/src/hook_install.rs');

// ── 1. hook_install.rs has the canonical pub fn ──
assert(hookInstall.includes('pub fn codewhale_config_path() -> PathBuf'),
  'hook_install.rs must have `pub fn codewhale_config_path` (canonical shared definition)');

// ── 2. commands.rs does NOT have a local definition ──
// Look for `fn codewhale_config_path` at the start of a line (function definition).
// `crate::hook_install::codewhale_config_path()` calls should NOT match this pattern.
const localDef = commands.match(/^fn codewhale_config_path\b/m);
assert(!localDef,
  'commands.rs must NOT have a local `fn codewhale_config_path` definition (use shared hook_install:: version)');

// ── 3. commands.rs calls the shared version ──
assert(commands.includes('crate::hook_install::codewhale_config_path()'),
  'commands.rs must call `crate::hook_install::codewhale_config_path()` (shared definition)');

// Count occurrences — there should be at least 2 (codewhale_config_candidates + diagnose_agent_sync)
const callCount = (commands.match(/crate::hook_install::codewhale_config_path\(\)/g) || []).length;
assert(callCount >= 2,
  `commands.rs must call the shared codewhale_config_path() in at least 2 places (found ${callCount})`);

// ── 4. Precedence chain documented in hook_install.rs ──
assert(hookInstall.includes('CODEWHALE_CONFIG_PATH') && hookInstall.includes('DEEPSEEK_CONFIG_PATH'),
  'codewhale_config_path must document CODEWHALE_CONFIG_PATH and DEEPSEEK_CONFIG_PATH precedence');
assert(hookInstall.includes('CODEWHALE_HOME'),
  'codewhale_config_path must document CODEWHALE_HOME precedence');
assert(hookInstall.includes('.deepseek'),
  'codewhale_config_path must check legacy ~/.deepseek/config.toml path');

// ── 5. R9 comment marker for traceability ──
assert(hookInstall.includes('R9: shared config path resolver'),
  'hook_install.rs must have R9 comment marker for traceability');

console.log('tauri-codewhale-config-path-dedup-r9-smoke: ok (single shared codewhale_config_path verified, no duplicate in commands.rs)');
