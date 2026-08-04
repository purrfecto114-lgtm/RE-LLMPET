#!/usr/bin/env node
'use strict';

// R44 0.5.44: Codex rollout watcher + parity matrix verification.
//
// Verifies:
// 1. codex_rollout.rs exists and is registered as a module
// 2. model.rs stats() injects codexLimits + codexUsage
// 3. UPSTREAM_PARITY_MATRIX.json exists and has correct structure
// 4. Territory functions are honestly marked as stubs

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
assert.strictEqual(packageJson.version, '0.5.44',
  '0.5.44: package.json version must be 0.5.44');

// ── 1. codex_rollout module ──────────────────────────────────────────────
assert.ok(lib.includes('mod codex_rollout;'),
  '1: lib.rs must declare mod codex_rollout');
assert.ok(codexRollout.includes('pub fn snapshot()'),
  '1: codex_rollout.rs must have pub fn snapshot()');
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
assert.ok(model.includes('crate::codex_rollout::snapshot()'),
  '2: model.rs must call codex_rollout::snapshot()');
assert.ok(model.includes('"codexLimits"'),
  '2: model.rs must inject codexLimits into stats');
assert.ok(model.includes('"codexUsage"'),
  '2: model.rs must inject codexUsage into stats');

// ── 3. UPSTREAM_PARITY_MATRIX.json ──────────────────────────────────────
assert.ok(parityMatrix.schemaVersion === 1,
  '3: parity matrix must have schemaVersion 1');
assert.ok(parityMatrix.upstreamCommit === '5ba09a7a60f0f665337c03c1ab1d40a326dc5f96',
  '3: parity matrix must record upstream commit SHA');
assert.ok(Array.isArray(parityMatrix.items) && parityMatrix.items.length >= 20,
  '3: parity matrix must have at least 20 items');

// Check key items
const findItem = (feature) => parityMatrix.items.find(i => i.feature === feature);
const codexRolloutItem = findItem('Codex rollout watcher (token usage + rate limits)');
assert.ok(codexRolloutItem && codexRolloutItem.reStatus === 'complete',
  '3: Codex rollout watcher must be marked complete');
assert.ok(codexRolloutItem.implementedIn === '0.5.44',
  '3: Codex rollout watcher must be marked implementedIn 0.5.44');

const territoryItem = findItem('Territory mode (macOS)');
assert.ok(territoryItem && territoryItem.reStatus === 'stub',
  '3: Territory mode must be honestly marked as stub');

const memeItem = findItem('Meme action system');
assert.ok(memeItem && memeItem.reStatus === 'excluded',
  '3: Meme action system must be marked excluded');

// ── 4. Territory stub honesty ───────────────────────────────────────────
assert.ok(commands.includes('领地模式已开启（stub'),
  '4: territory_toggle_auto must show "stub" in message');
assert.ok(commands.includes('领地巡视尚未实现（stub）'),
  '4: territory_run_now must show "stub" in message');

// ── 5. CHANGELOG ────────────────────────────────────────────────────────
assert.ok(changelog.includes('0.5.44'),
  'CHANGELOG must have 0.5.44 entry');

console.log('✓ R44 0.5.44 Codex rollout + parity matrix smoke: all assertions passed');
