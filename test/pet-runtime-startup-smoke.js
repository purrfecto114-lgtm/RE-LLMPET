'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pet = fs.readFileSync(path.join(ROOT, 'frontend/renderer/pet.js'), 'utf8');
const lifecycle = fs.readFileSync(path.join(ROOT, 'frontend/renderer/pet-session-lifecycle.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'frontend/renderer/pet.html'), 'utf8');

const travelCreate = pet.indexOf('window.OctoPetTravelView.create');
assert(travelCreate > 0, 'travel view construction missing');
const lifecycleCreate = pet.indexOf('window.OctoPetSessionLifecycle.create');
const lifecycleBinding = pet.indexOf('open: openSessList');
assert(lifecycleCreate >= 0 && lifecycleCreate < travelCreate, 'session lifecycle must be constructed before travel view');
assert(lifecycleBinding >= 0 && lifecycleBinding < travelCreate, 'session callbacks must be bound before travel view');
for (const name of ['function open()', 'function close()', 'function toggle()']) {
  assert(lifecycle.includes(name), `session lifecycle owner missing ${name}`);
}
assert(html.indexOf('pet-session-lifecycle.js') < html.indexOf('pet.js'), 'session lifecycle script must load before pet.js');

const skinInit = pet.indexOf("let skin = 'mascot'");
const idleSchedule = Math.min(
  ...['requestIdleCallback(maybePreloadCatAssets', 'setTimeout(maybePreloadCatAssets']
    .map((token) => pet.indexOf(token))
    .filter((index) => index >= 0),
);
assert(skinInit >= 0 && skinInit < idleSchedule, 'skin must be initialized before deferred preload scheduling');
assert.strictEqual((pet.match(/let skin = 'mascot'/g) || []).length, 1, 'skin state must have one canonical declaration');
assert.match(pet, /const agentTag = document\.getElementById\('agent-tag'\)/, 'agent-tag DOM owner must be explicitly declared');

console.log('pet-runtime-startup-smoke: ok');
