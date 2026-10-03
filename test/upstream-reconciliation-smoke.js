
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));

// The rewrite still preserves the upstream skins and three-language renderer
// contract, but intentionally removes the meme selector/player/catalog surface.
for (const asset of [
  'frontend/assets/mascot.png',
  'frontend/assets/mascot-work.png',
  'frontend/assets/cat/cat-idle.gif',
]) assert(exists(asset), `retained upstream visual asset missing: ${asset}`);

for (const removed of [
  'resources/memes/catalog.json',
  'frontend/shared/memes.js',
  'frontend/assets/memes',
  'scripts/generate-public-meme-catalog.js',
]) assert(!exists(removed), `removed meme surface returned: ${removed}`);

const i18nSource = read('frontend/shared/i18n.js');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(i18nSource, sandbox, { filename: 'i18n.js' });
const i18n = sandbox.window.OctoI18n;
assert.deepStrictEqual(Array.from(i18n.LANGS), ['zh', 'en', 'ja']);
for (const lang of i18n.LANGS) {
  i18n.setLang(lang);
  assert.notStrictEqual(i18n.t('panel.title'), 'panel.title');
  assert.notStrictEqual(i18n.t('menu.panel'), 'menu.panel');
  assert(!/RE-LLMPET|LLMPET/.test(i18n.t('panel.title')), 'visible legacy branding remains');
}

const model = read('src-tauri/src/model.rs');
const commands = read('src-tauri/src/commands.rs');
const build = read('src-tauri/build.rs');
const lib = read('src-tauri/src/lib.rs');
const bridge = read('frontend/renderer/tauri-bridge.js');
const panel = read('frontend/renderer/panel.html');
const pet = read('frontend/renderer/pet.html');
assert(model.includes('pub lang: String'));
assert(model.includes('"zh" | "en" | "ja"'));
assert(commands.includes('pub fn set_language'));
assert(build.includes('"set_language"'));
assert(lib.includes('set_language,'));
assert(bridge.includes("setLanguage: (lang) => call('set_language', { lang })"));
for (const html of [panel, pet]) {
  const i18nAt = html.indexOf('../shared/i18n.js');
  const rendererAt = html.indexOf('tauri-bridge.js');
  assert(i18nAt >= 0 && i18nAt < rendererAt, 'i18n must load before renderer scripts');
}
assert(panel.includes('id="language"'), 'panel must expose the language switcher');
assert(panel.includes('data-i18n="panel.todayCost"'));
assert(pet.includes('data-i18n="sess.title"'));
assert(!pet.includes('sl-meme-view') && !pet.includes('meme-player'), 'meme UI must stay removed');
assert(pet.includes('id="sl-session-view"'));

console.log('upstream-reconciliation-smoke: ok (skins/i18n retained, meme feature removed)');
