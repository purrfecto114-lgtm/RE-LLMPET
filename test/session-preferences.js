'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sanitize } = require('../backend/config');

const cfg = sanitize({
  pinnedSessions: ['a', 'a', '', null, ' b '],
  archivedSessions: ['b', 'c', 'c', 42],
});
assert.deepStrictEqual(cfg.pinnedSessions, ['a', 'b'], 'pins are trimmed and deduplicated');
assert.deepStrictEqual(cfg.archivedSessions, ['c'], 'a pinned session cannot remain archived');

assert.strictEqual(sanitize({ skin: 'whale' }).skin, 'whale',
  'the whale skin must survive config sanitization');
assert.strictEqual(sanitize({ skin: 'unknown-skin' }).skin, 'mascot',
  'unknown skins must still fail closed to the default');

const root = path.join(__dirname, '..');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'pet.js'), 'utf8');
const markup = fs.readFileSync(path.join(root, 'renderer', 'pet.html'), 'utf8');

assert(preload.includes("ipcRenderer.send('set-session-prefs'"), 'preload must expose session preference writes');
assert(main.includes("ipcMain.on('set-session-prefs'"), 'main must persist session preferences');
for (const id of ['sl-search', 'sl-filters', 'sl-archived-toggle']) {
  assert(markup.includes(`id="${id}"`), `session manager is missing ${id}`);
}
assert(renderer.includes('pinnedSessionIds') && renderer.includes('archivedSessionIds'));

console.log('session preference checks passed');
