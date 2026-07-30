#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const rust = fs.readFileSync(path.join(ROOT, 'src-tauri/src/hook_install.rs'), 'utf8');
const installer = fs.readFileSync(path.join(ROOT, 'scripts/install-native-hooks.js'), 'utf8');

const rustEvents = rust.match(/const CLAUDE_EVENTS:[\s\S]*?= \[([\s\S]*?)\];/);
assert(rustEvents, 'CLAUDE_EVENTS missing');
assert(!rustEvents[1].includes('"PreToolUse"'), 'Rust generic Claude event list still contains PreToolUse');
assert(rust.includes('Some("PreToolUse"), false, true'), 'Rust specialized PreToolUse command is missing --pretool');
assert(rust.includes('add_group(hooks, "PreToolUse", command_hook(pretool, 600))'), 'Rust specialized PreToolUse timeout is not 600 seconds');

const jsEvents = installer.match(/const EVENTS = \[([\s\S]*?)\];/);
assert(jsEvents, 'native installer EVENTS missing');
assert(!jsEvents[1].includes("'PreToolUse'"), 'Node generic Claude event list still contains PreToolUse');
assert(installer.includes('--pretool PreToolUse'), 'Node installer specialized PreToolUse command is missing');
assert(installer.includes("sync(settings.hooks, 'PreToolUse', pretoolHook, isOurs)"), 'Node installer does not install the specialized PreToolUse hook');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-pretool-r8-'));
const claudeDir = path.join(home, '.claude');
fs.mkdirSync(claudeDir, { recursive: true });
const fakeBin = path.join(home, 'octopus-hook');
fs.writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

function install() {
  return spawnSync(process.execPath, ['scripts/install-native-hooks.js', `--hook-bin=${fakeBin}`], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  });
}

for (let pass = 0; pass < 2; pass++) {
  const result = install();
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
}

const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
const owned = (settings.hooks.PreToolUse || [])
  .flatMap((group) => group.hooks || [])
  .filter((hook) => typeof hook.command === 'string' && hook.command.includes('--octopus-hook'));
assert.strictEqual(owned.length, 1, 'PreToolUse must contain exactly one Octopus hook after repeated installation');
assert(owned[0].command.includes('--pretool PreToolUse'), 'installed PreToolUse hook is not the specialized command');
assert.strictEqual(owned[0].timeout, 600, 'installed PreToolUse timeout must be 600 seconds');

fs.rmSync(home, { recursive: true, force: true });
console.log('tauri-claude-pretool-hook-r8-smoke: ok (10 checks)');
