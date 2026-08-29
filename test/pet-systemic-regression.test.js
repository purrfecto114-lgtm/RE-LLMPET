'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const policySource = read('frontend/renderer/pet-runtime-policy.js');
const sandbox = { window: {} };
vm.runInNewContext(policySource, sandbox);
const policy = sandbox.window.OctoPetRuntimePolicy;

const rows = [
  { sessionId: 'child', providerId: 'opencode', state: 'working', idleMs: 10, headless: true },
  { sessionId: 'main', providerId: 'opencode', state: 'working', idleMs: 20 },
  { sessionId: 'main', providerId: 'opencode', state: 'working', idleMs: 30 },
  { sessionId: 'old-error', providerId: 'codewhale', state: 'error', idleMs: 120000 },
];
assert.strictEqual(policy.resolveProvider(rows, ['claude', 'opencode'], 'aggregate'), 'opencode');
assert.strictEqual(policy.resolveProvider([], ['codewhale'], 'aggregate'), 'codewhale');
assert.strictEqual(policy.resolveProvider([], [], 'aggregate'), null);
assert.strictEqual(JSON.stringify(policy.projectVisibleSessions(rows).map((row) => row.sessionId)), JSON.stringify(['main', 'old-error']));
assert.strictEqual(policy.toolAction('task', 'opencode'), 'summon');
assert.strictEqual(policy.toolAction('Agent', 'opencode'), 'summon');
assert.strictEqual(policy.toolAction('unrecognised', 'opencode'), 'work');
assert.strictEqual(policy.aggregateState({ errorCount: 1, sessions: rows }), 'working',
  'a stale error must not mask a newer working session');
assert.strictEqual(policy.aggregateState({ errorCount: 1, sessions: [
  { sessionId: 'fresh-error', state: 'error', idleMs: 1000 },
] }), 'error');

const pet = read('frontend/renderer/pet.js');
assert(!pet.includes("img.style.opacity = '0'"), 'image swap must not blank the current frame');
assert(pet.includes('requestRadialViewport'), 'radial opening must request its viewport before measuring');
assert(pet.includes('patchSessionDots'), 'session dots must use keyed patching');

const hook = read('src-tauri/src/hook_install.rs');
assert(hook.includes('event?.properties?.info?.parentID'), 'OpenCode child session parent must be retained');
assert(hook.includes('headless: Boolean(parentID)'), 'OpenCode child sessions must be marked headless');
assert(hook.includes('input?.sessionID\n    || input?.metadata?.sessionID'),
  'current OpenCode top-level sessionID must be preferred with legacy metadata fallback');

console.log('pet-systemic-regression: ok');
