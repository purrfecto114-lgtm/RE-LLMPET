'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const json = (file) => JSON.parse(read(file));
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');

const provenance = json('reports/upstream-import-provenance.json');
assert(provenance.sourceRepository === 'https://github.com/myunwang/LLMPET');
for (const item of provenance.files) {
  const destinationHash = sha256(item.destinationPath);
  if (item.byteIdentical) {
    assert.strictEqual(destinationHash, item.sha256, `${item.destinationPath} hash drifted`);
    continue;
  }

  assert(item.sourceSha256 && item.destinationSha256, `${item.destinationPath} adapted provenance must retain both hashes`);
  assert(item.adaptation, `${item.destinationPath} adapted provenance must explain the migration`);
  assert.strictEqual(destinationHash, item.destinationSha256, `${item.destinationPath} adapted hash drifted`);
}

const catalog = json('resources/memes/catalog.json');
assert.strictEqual(catalog.schemaVersion, 1);
assert(catalog.items.length >= 2, 'upstream meme catalog should contain the imported actions');
for (const item of catalog.items) {
  assert(/^[a-z0-9-]{1,64}$/.test(item.id), `unsafe meme id: ${item.id}`);
  assert(item.media && item.media.gif && item.media.audio);
  for (const rel of [item.media.gif, item.media.audio]) {
    assert(!path.isAbsolute(rel) && !rel.split(/[\\/]/).includes('..'), `unsafe meme path: ${rel}`);
    assert(fs.existsSync(path.join(root, 'frontend', 'assets', 'memes', rel)), `missing meme media: ${rel}`);
  }
  assert(Number(item.media.durationMs) > 0 && Number(item.media.durationMs) <= 15000, 'meme duration must be bounded');
}

const memeSandbox = { window: {} };
vm.createContext(memeSandbox);
vm.runInContext(read('frontend/shared/memes.js'), memeSandbox, { filename: 'memes.js' });
const publicMemes = memeSandbox.window.LLMPET_MEMES;
assert(publicMemes && publicMemes.schemaVersion === 1);
assert.strictEqual(publicMemes.sourceSha256, sha256('resources/memes/catalog.json'));
assert.strictEqual(publicMemes.items.length, catalog.items.length);
const publicJson = JSON.stringify(publicMemes);
assert(!publicJson.includes('\"prompt\"') && !publicJson.includes('promptText'), 'renderer manifest must exclude instruction bodies');
assert(!publicJson.includes('你糊弄我是吧') && !publicJson.includes('an apology is not a deliverable'));
for (const item of publicMemes.items) {
  assert(item.copy.zh && item.copy.en && item.copy.ja, `localized public copy missing: ${item.id}`);
  assert(fs.existsSync(path.join(root, 'frontend', 'assets', 'memes', item.media.gif)));
  assert(fs.existsSync(path.join(root, 'frontend', 'assets', 'memes', item.media.audio)));
}

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
assert(bridge.includes("setLanguage: (lang) => send('set_language', { lang })"));
for (const html of [panel, pet]) {
  const i18nAt = html.indexOf('../shared/i18n.js');
  const rendererAt = html.indexOf('tauri-bridge.js');
  assert(i18nAt >= 0 && i18nAt < rendererAt, 'i18n must load before renderer scripts');
}
const memeManifestAt = pet.indexOf('../shared/memes.js');
const petRendererAt = pet.indexOf('pet.js');
assert(memeManifestAt >= 0 && memeManifestAt < petRendererAt, 'public meme manifest must load before pet.js');
assert(panel.includes('id="language"'), 'panel must expose the language switcher');
assert(panel.includes('data-i18n="panel.todayCost"'));
assert(pet.includes('data-i18n="sess.title"'));
assert(pet.includes('id="sl-meme-view"') && pet.includes('id="meme-player"'));
assert(pet.includes('id="sl-back"') && pet.includes('id="sl-session-view"'));

console.log('upstream-reconciliation-smoke: ok');
