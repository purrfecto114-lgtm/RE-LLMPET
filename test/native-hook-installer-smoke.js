'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-native-hook-'));
const claudeDir = path.join(home, '.claude');
const runtimeDir = path.join(home, '.octopus');
fs.mkdirSync(claudeDir, { recursive: true });
fs.mkdirSync(runtimeDir, { recursive: true });
const fakeBin = path.join(home, 'octopus-hook');
fs.writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
fs.writeFileSync(path.join(runtimeDir, 'runtime.json'), JSON.stringify({
  app: 'octopus', port: 41330, token: 'A'.repeat(64), pid: 123,
}));
const foreignHook = { type: 'command', command: 'echo keep-me', timeout: 5 };
fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
  theme: 'dark',
  hooks: { Stop: [{ matcher: '', hooks: [foreignHook] }] },
}, null, 2));

function run(args) {
  return spawnSync(process.execPath, ['scripts/install-native-hooks.js', ...args], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  });
}

const installed = run([`--hook-bin=${fakeBin}`]);
assert.strictEqual(installed.status, 0, installed.stderr || installed.stdout);
let settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
assert.strictEqual(settings.theme, 'dark');
assert(settings.hooks.Stop[0].hooks.some((hook) => hook.command === foreignHook.command), 'foreign hook was not preserved');
const nativeCommands = Object.values(settings.hooks).flatMap((groups) => groups).flatMap((group) => group.hooks || []).filter((hook) => typeof hook.command === 'string' && hook.command.includes('octopus-hook'));
assert(nativeCommands.length >= 20, 'native lifecycle/permission hooks missing');
const permission = settings.hooks.PermissionRequest.flatMap((group) => group.hooks).find((hook) => hook.type === 'command');
assert(permission && permission.command.includes('--permission PermissionRequest'));
assert(!JSON.stringify(settings).includes('?token='), 'runtime token leaked into Claude hook configuration');

const uninstalled = run(['--uninstall']);
assert.strictEqual(uninstalled.status, 0, uninstalled.stderr || uninstalled.stdout);
settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
assert(settings.hooks.Stop[0].hooks.some((hook) => hook.command === foreignHook.command), 'foreign hook was removed during uninstall');
const leftovers = Object.values(settings.hooks).flatMap((groups) => groups).flatMap((group) => group.hooks || []).filter((hook) => (hook.command || '').includes('octopus-hook') || (hook.url || '').includes('/permission'));
assert.strictEqual(leftovers.length, 0, 'native hooks were not fully removed');

fs.rmSync(home, { recursive: true, force: true });
console.log('native-hook-installer-smoke: ok');
