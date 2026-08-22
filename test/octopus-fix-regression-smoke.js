
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));

const css = read('frontend/renderer/pet.css');
assert(css.includes('#pixel.error .pixel-sprite { animation: errShake'), 'error animation must stay on inner sprite');
assert(css.includes('#mascot.act-work #mascot-img, #pixel.act-work .pixel-sprite'), 'busy animation must stay on inner visual layers');
assert(!/#pixel\.error\s*\{[^}]*animation:/s.test(css), 'outer pixel hit container must not animate');
assert(!/#mascot\.act-work\s*\{[^}]*animation:/s.test(css), 'outer mascot hit container must not animate');
assert(css.includes('.provider-chooser {') && css.includes('position: fixed;') && css.includes('inset: 0;'), 'provider backdrop must cover the expanded pet window');
assert(css.includes('filter: none;'), 'transparent popup must not use compositor drop-shadow');

const pet = read('frontend/renderer/pet.js');
assert(pet.includes("window.pet.onWindowBlur(() => dismissTransientUi('native-blur'))"), 'native blur must dismiss transient UI');
assert(pet.includes('availableProviders') && pet.includes('openProviderChooser'), 'new Agent must have a provider chooser path');
assert(pet.includes("['claude', 'codewhale', 'codex', 'opencode', 'dsh']"), 'chooser must know every supported provider');

const panel = read('frontend/renderer/panel.js');
assert.strictEqual((panel.match(/\$\('close'\)\.addEventListener/g) || []).length, 1, 'panel close button must have one listener');
assert(panel.includes('providerLabel') && panel.includes("t('panel.waiting')"), 'panel subtitle must derive provider and clear stale state');
assert(!panel.includes("s.providerId || s.provider || 'claude'"), 'missing provider must not be hard-coded as Claude');

const commands = read('src-tauri/src/commands.rs');
for (const needle of ['fit_and_center_panel', 'PanelPlacement::PreserveCurrentCenter', 'monitor.work_area()', 'PANEL_WORK_AREA_MARGIN', 'set_position(Position::Physical', 'set_panel_height']) {
  assert(commands.includes(needle), `panel geometry fix missing: ${needle}`);
}
const config = JSON.parse(read('src-tauri/tauri.conf.json'));
const petWindow = config.app.windows.find((w) => w.label === 'pet');
const panelWindow = config.app.windows.find((w) => w.label === 'panel');
assert.strictEqual(config.productName, 'Octopus');
assert.strictEqual(config.identifier, 'io.github.purrfecto114.octopus');
assert.strictEqual(petWindow.shadow, false);
assert.strictEqual(panelWindow.decorations, false);
assert.strictEqual(panelWindow.shadow, false);

const hookInstall = read('src-tauri/src/hook_install.rs');
assert(hookInstall.includes('ensure_codewhale_hooks_enabled'), 'CodeWhale global hooks switch must be enabled');
assert(hookInstall.includes('enabled = true'), 'CodeWhale [hooks] enabled=true missing');
assert(hookInstall.includes('const MARKER: &str = "--octopus-hook";'));
assert(hookInstall.includes('const LEGACY_MARKER: &str = "--re-llmpet-hook";'));
assert(!hookInstall.includes('if command.contains("re-llmpet")'), 'hook cleanup must not use broad repository-name ownership');
const hookClient = read('src-tauri/src/hook_client.rs');
assert(/"tool_call_before"\s*=>\s*\("PreToolUse"\.into\(\),\s*"working"\)/s.test(hookClient), 'CodeWhale tool start must become working');
assert(hookClient.includes('codewhale_env_only'), 'CodeWhale env-only events must not block on stdin');

const platform = read('src-tauri/src/platform.rs');
for (const needle of ['CURSOR_HIT_TEST_NEAR_MS', 'CURSOR_HIT_TEST_FAR_MS', 'CURSOR_HIT_TEST_IDLE_MS', 'CURSOR_HIT_TEST_HIDDEN_MS', 'window.is_visible()']) {
  assert(platform.includes(needle), `adaptive cursor polling missing: ${needle}`);
}

for (const removed of [
  'frontend/shared/memes.js',
  'frontend/assets/memes',
  'resources/memes',
  'scripts/generate-public-meme-catalog.js',
  'test/tauri-meme-preview-smoke.js',
  'docs/MEME_ASSET_PROVENANCE.md',
]) assert(!exists(removed), `meme feature residue remains: ${removed}`);
assert(!read('frontend/renderer/pet.html').includes('meme-'), 'meme UI must be removed');
assert(!read('package.json').includes('meme:'), 'meme scripts must be removed');

console.log('octopus-fix-regression-smoke: ok');
