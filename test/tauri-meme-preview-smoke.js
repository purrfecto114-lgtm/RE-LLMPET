'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const catalog = JSON.parse(read('resources/memes/catalog.json'));
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(read('frontend/shared/memes.js'), sandbox, { filename: 'memes.js' });
const publicCatalog = sandbox.window.LLMPET_MEMES;

assert.strictEqual(publicCatalog.items.length, catalog.items.length);
assert(!fs.existsSync(path.join(ROOT, 'frontend/assets/memes/catalog.json')), 'full catalog must not be shipped in frontendDist');
const serialized = JSON.stringify(publicCatalog);
for (const forbidden of ['"prompt"', 'promptText', '你糊弄我是吧', 'an apology is not a deliverable', '謝罪は成果物ではありません']) {
  assert(!serialized.includes(forbidden), `renderer meme data leaked instruction body: ${forbidden}`);
}
for (const item of publicCatalog.items) {
  assert(/^[a-z0-9][a-z0-9-]*$/.test(item.id));
  for (const media of [item.media.gif, item.media.audio]) {
    assert(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/.test(media), `unsafe media path: ${media}`);
    assert(fs.existsSync(path.join(ROOT, 'frontend/assets/memes', media)), `missing media: ${media}`);
  }
  assert(['zh', 'en', 'ja'].every((lang) => item.copy[lang] && item.copy[lang].label));
}

const html = read('frontend/renderer/pet.html');
const js = read('frontend/renderer/pet.js');
const css = read('frontend/renderer/pet.css');
assert(html.includes('id="sl-meme-view"') && html.includes('id="meme-player"'));
assert(html.includes('id="sl-back"') && html.includes('id="sl-session-view"'));
assert(html.indexOf('../shared/memes.js') < html.indexOf('pet.js'));
assert(js.includes('function openMemePicker(session = null)'));
assert(js.includes('function playMemePreview(item)'));
assert(js.includes("memeStatus.textContent = `${copy.reactionLabel} · ${t('meme.noDispatcher')}`"));
assert(!js.includes('triggerMeme('), 'preview-only migration must not pretend to dispatch prompts');
assert(css.includes('.sl-meme-grid') && css.includes('.sl-meme-card') && css.includes('.meme-player img'));
assert(js.includes("new Audio(`../assets/memes/${item.media.audio}`)"));
// R35 (2026-07-31): INTERACTIVE_HIT_SEL now starts with #pet-anchor so the
// native hit-test region follows the stable anchor rect (P0-1 fix). The
// meme-preview smoke just needs to confirm the selector is still declared
// and still aliases HIT_SEL — it doesn't care about the exact selector
// contents. The R35 smoke owns the detailed content check.
assert(js.includes('const INTERACTIVE_HIT_SEL ='));
assert(js.includes('const HIT_SEL = INTERACTIVE_HIT_SEL;'));

console.log('tauri-meme-preview-smoke: ok');
