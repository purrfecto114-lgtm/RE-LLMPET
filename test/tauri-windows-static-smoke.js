'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const json = (file) => JSON.parse(read(file));

const windows = json('src-tauri/tauri.windows.conf.json');
assert.deepStrictEqual(windows.bundle.targets, ['nsis']);
assert.strictEqual(windows.bundle.windows.webviewInstallMode.type, 'downloadBootstrapper');
assert.strictEqual(windows.bundle.windows.webviewInstallMode.silent, true);

const ico = fs.readFileSync(path.join(root, 'src-tauri/icons/icon.ico'));
assert(ico.length > 1024, 'Windows icon should not be an empty placeholder');
assert.strictEqual(ico.readUInt16LE(0), 0, 'ICO reserved word');
assert.strictEqual(ico.readUInt16LE(2), 1, 'ICO type');
assert(ico.readUInt16LE(4) >= 1, 'ICO image count');

const commands = read('src-tauri/src/commands.rs');
assert(commands.includes('#[cfg(target_os = "windows")]'));
assert(commands.includes('.args(["/C", "start", "", "cmd", "/K", command])'));
assert(!commands.includes('disableHardwareAcceleration'));

const main = read('src-tauri/src/main.rs');
const hook = read('src-tauri/src/hook_client.rs');
assert(main.includes('--octopus-hook'), 'packaged executable must support native hook mode');
assert(hook.includes('USERPROFILE'), 'hook client needs a Windows home fallback');
assert(hook.includes('X-Octopus-Token'), 'hook transport must authenticate local requests');

const packageJson = json('package.json');
assert.strictEqual(packageJson.dependencies.electron, undefined);
assert.strictEqual(packageJson.devDependencies.electron, undefined);
assert(packageJson.scripts['package:win'].includes('--bundles nsis'));

console.log('tauri-windows-static-smoke: ok');
