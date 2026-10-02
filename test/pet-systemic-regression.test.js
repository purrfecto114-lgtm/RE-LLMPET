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

// R54: the OpenCode plugin source moved to plugin_sources.rs (hook_install.rs
// growth budget). R58-1c (v6): the plugin NEVER reads Message.Info.parentID
// (that is the parent MESSAGE id upstream — v5 misread it as a session
// parent and headless-ified every top-level session after turn one);
// child lineage is learned from session.created's info.parentID into a
// childSessions map and stamped on every later frame via stampParent().
const hook = read('src-tauri/src/plugin_sources.rs');
assert(hook.includes('info.parentID'), 'OpenCode child session parent must be retained');
assert(hook.includes('childSessions.set(base.session_id, info.parentID)'),
  'OpenCode child sessions must be learned into the lineage map');
assert(hook.includes('stampParent(base)'),
  'later child frames must be stamped from the lineage map');
assert(!hook.includes('msg?.parentID'),
  'message-level parentID must never be read as a session parent (R54 v5 regression)');
// R58-RV-5 P0 (v7): the GENERIC lineage read must be gated to session-object
// events — an ungated block reads Message.Info.parentID (parent MESSAGE id)
// on every message.updated frame and headless-ifies all top-level sessions.
assert(hook.includes('type === "session.created" || type === "session.updated"'),
  'the generic info.parentID read must be gated to session.created/updated');
assert(hook.includes('childSessions.delete(base.session_id)'),
  'session.deleted must free the lineage slot');
assert(hook.includes('input?.sessionID\n    || input?.metadata?.sessionID'),
  'current OpenCode top-level sessionID must be preferred with legacy metadata fallback');

console.log('pet-systemic-regression: ok');
