'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const main = read('main.js');
const preload = read('preload.js');
const config = read('backend/config.js');
const readme = read('README.md');

assert(fs.existsSync(path.join(root, 'backend/codex-watch.js')), 'Codex watcher must ship with the app');
assert(fs.existsSync(path.join(root, 'test/codex-watch.js')), 'Codex watcher regression tests must remain in the suite');
assert(/require\('\.\/backend\/codex-watch'\)/.test(main), 'main process must load the Codex watcher');
assert(/codexWatch\s*=\s*createCodexWatch\(/.test(main), 'main process must create the Codex watcher');
assert(/codexWatch\.start\(\)/.test(main), 'main process must start the Codex watcher');
assert(/if \(codexWatch\) codexWatch\.stop\(\)/.test(main), 'app shutdown must stop the Codex watcher');
assert(/function sendPetEvent\(ev\)/.test(main), 'Codex events must reach the pet window');
assert(/function createPetWindows\(\)/.test(main) && /makePetWindow\('all'\)/.test(main), 'the single pet window must monitor every backend');
assert(/skin: 'mascot'/.test(config), 'pet skin must have a safe default');
assert(!/petMode|skinCodex|dshPet/.test(config), 'dual-pet config fields must be gone');
assert(/launchCodex: \(\) => ipcRenderer\.send\('launch-codex'\)/.test(preload), 'renderer must be able to launch Codex');
assert(!/closePet/.test(preload), 'dual-pet close channel must be gone');
assert(/p\.name === 'request_user_input'/.test(read('backend/codex-watch.js')), 'Codex request_user_input function calls must be intercepted before generic tools');
assert(/function buildCodexChoice\(/.test(read('backend/adapter.js')), 'Codex choice payloads must reach the pet adapter');
assert(/function renderCodexElicitation\(/.test(read('renderer/pet.js')), 'the pet must render mirrored Codex questions and options');
assert(/codex:\/\/threads\//.test(main), 'the Codex choice card must deep-link to the owning desktop thread');
assert(/Claude Code \/ Codex/.test(readme) && /Codex 后端/.test(readme), 'public documentation must describe Codex support');
assert(pkg.scripts.test.includes('test/codex-watch.js'), 'npm test must execute Codex watcher tests');
assert(pkg.scripts.test.includes('test/codex-integration.js'), 'npm test must execute the Codex integration contract');

console.log('codex integration checks passed');
