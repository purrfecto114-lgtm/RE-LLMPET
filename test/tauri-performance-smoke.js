'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pet = fs.readFileSync(path.join(ROOT, 'frontend', 'renderer', 'pet.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const commands = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'commands.rs'), 'utf8');
const bridge = fs.readFileSync(path.join(ROOT, 'frontend', 'renderer', 'tauri-bridge.js'), 'utf8');

assert(!/uiBusyInterval/.test(pet), '700ms UI-busy polling must be removed');
assert(!/visualBoundsInterval/.test(pet), '3s visual-bounds polling must be removed');
assert(!/setInterval\s*\(\s*reportPetVisualBounds/.test(pet), 'visual bounds must be event driven');
assert(/function syncUiBusy/.test(pet), 'event-driven UI busy synchronizer missing');
assert(/new ResizeObserver/.test(pet), 'ResizeObserver bounds synchronization missing');
assert(/visualBoundsObserver\.disconnect\(\)/.test(pet), 'observer cleanup missing');

assert(!/cargo tauri (?:dev|build)[^\n\"]*--manifest-path/.test(JSON.stringify(pkg.scripts)),
  'Tauri CLI scripts must not pass Cargo-only --manifest-path');
assert(!(pkg.dependencies || {}).electron && !(pkg.devDependencies || {}).electron, 'default rewrite dependency graph must exclude Electron');

assert(/Result<\[i32; 2\], String>/.test(commands), 'get_win_pos must preserve renderer [x,y] contract');
assert(/Array\.isArray\(pos\)/.test(bridge), 'bridge must normalize window-position result');
assert(/behavior: Value/.test(commands), 'permission command must accept the compatible structured behavior surface');

console.log('tauri-performance-smoke: ok (permanent 700ms/3s polling removed)');
