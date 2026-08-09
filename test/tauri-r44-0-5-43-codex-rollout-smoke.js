#!/usr/bin/env node
'use strict';

// R44 0.5.49: Codex rollout watcher + parity matrix verification.
//
// Verifies:
// 1. codex_rollout.rs exists and is registered as a module
// 2. model.rs stats() injects codexLimits + codexUsage
// 3. UPSTREAM_PARITY_MATRIX.json exists and has correct structure
// 4. Territory implementation replaces the former backend stub

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const lib = read('src-tauri/src/lib.rs');
const model = read('src-tauri/src/model.rs');
const commands = read('src-tauri/src/commands.rs');
const codexRollout = read('src-tauri/src/codex_rollout.rs');
const parityMatrix = JSON.parse(read('docs/UPSTREAM_PARITY_MATRIX.json'));
const changelog = read('CHANGELOG.md');
const packageJson = JSON.parse(read('package.json'));

// Version
assert.strictEqual(packageJson.version, '0.5.49',
  '0.5.49: package.json version must be 0.5.49');

// ── 1. codex_rollout module ──────────────────────────────────────────────
assert.ok(lib.includes('mod codex_rollout;'),
  '1: lib.rs must declare mod codex_rollout');
assert.ok(codexRollout.includes('pub fn snapshot(app_dir: &Path)'),
  '1: codex_rollout.rs must have app-dir-aware pub fn snapshot(app_dir: &Path)');
assert.ok(codexRollout.includes('token_count'),
  '1: codex_rollout.rs must parse token_count events');
assert.ok(codexRollout.includes('rate_limits'),
  '1: codex_rollout.rs must parse rate_limits');
assert.ok(codexRollout.includes('used_percent'),
  '1: codex_rollout.rs must extract used_percent from rate limits');
assert.ok(codexRollout.includes('plan_type'),
  '1: codex_rollout.rs must extract plan_type');
assert.ok(codexRollout.includes('sessions'),
  '1: codex_rollout.rs must scan sessions directory');

// ── 2. model.rs injects Codex data ──────────────────────────────────────
assert.ok(model.includes('crate::codex_rollout::snapshot(&self.app_dir)'),
  '2: model.rs must call codex_rollout::snapshot(&self.app_dir)');
assert.ok(model.includes('"codexLimits"'),
  '2: model.rs must inject codexLimits into stats');
assert.ok(model.includes('"codexUsage"'),
  '2: model.rs must inject codexUsage into stats');

// ── 3. UPSTREAM_PARITY_MATRIX.json ──────────────────────────────────────
assert.ok(parityMatrix.schemaVersion === 1,
  '3: parity matrix must have schemaVersion 1');
assert.ok(parityMatrix.upstreamCommit === 'd51311eb7f3a4efb678f425a20bef360f383295c',
  '3: parity matrix must record upstream commit SHA');
assert.ok(Array.isArray(parityMatrix.items) && parityMatrix.items.length >= 20,
  '3: parity matrix must have at least 20 items');

// Check key items
const findItem = (feature) => parityMatrix.items.find(i => i.feature === feature);
const codexRolloutItem = findItem('Codex rollout watcher (token usage + rate limits)');
assert.ok(codexRolloutItem && codexRolloutItem.reStatus === 'complete',
  '3: Codex rollout watcher must be marked complete');
assert.ok(codexRolloutItem.implementedIn === '0.5.46',
  '3: Codex rollout watcher must be marked implementedIn 0.5.46 (historical: feature shipped in 0.5.46) (historical: feature shipped in 0.5.49)');

const territoryItem = findItem('Territory mode (macOS)');
assert.ok(territoryItem && territoryItem.reStatus === 'complete',
  '3: Territory mode must be marked complete after native implementation');

const memeItem = findItem('Meme action system');
assert.ok(memeItem && memeItem.reStatus === 'excluded',
  '3: Meme action system must be marked excluded');

// ── 4. Territory implementation ────────────────────────────────────────
assert.ok(commands.includes('crate::territory::run_now'),
  '4: territory commands must invoke the real territory module');
assert.ok(!commands.includes('领地模式已开启（stub'),
  '4: territory toggle must no longer claim to be a stub');
assert.ok(!commands.includes('领地巡视尚未实现（stub）'),
  '4: territory run-now must no longer claim to be unimplemented');

// ── 5. CHANGELOG ────────────────────────────────────────────────────────
assert.ok(changelog.includes('0.5.49'),
  'CHANGELOG must have 0.5.49 entry');

console.log('✓ R44 0.5.49 Codex rollout + parity matrix smoke: all assertions passed');
