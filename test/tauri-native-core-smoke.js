'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const cargo = read('src-tauri/Cargo.toml');
assert(cargo.includes('tauri = { version = "=2.11.5"'));
assert(cargo.includes('tauri-build = { version = "=2.6.3"'));
assert(!/electron/i.test(cargo));

const server = read('src-tauri/src/http_server.rs');
for (const needle of [
  '127.0.0.1',
  'x-octopus-token',
  'MAX_HEADER_BYTES',
  'MAX_STATE_BYTES',
  'MAX_PERMISSION_BYTES',
  'contains_key("origin")',
  'contains_key("referer")',
  'application/json required',
  'MAX_CLIENT_THREADS',
  'transfer-encoding unsupported',
]) assert(server.includes(needle), `missing local-server hardening: ${needle}`);
assert(server.includes('Uuid::new_v4().simple()'));
assert(!server.includes('0.0.0.0'));

const hook = read('src-tauri/src/hook_client.rs');
for (const needle of [
  '--pretool',
  'hookSpecificOutput',
  'hookEventName',
  'permissionDecision',
  'permissionDecisionReason',
  'bash_is_read_only',
  'stdin payload too large',
  'server rejected hook',
]) assert(hook.includes(needle), `missing native-hook behavior: ${needle}`);
assert(hook.includes('"hookEventName": "PreToolUse"'));
assert(!hook.includes('json!({"permissionDecision":decision})'));
const readOnlyBlock = hook.match(/const READ_ONLY:[\s\S]*?\];/);
assert(readOnlyBlock, 'READ_ONLY allow-list missing');
for (const mutatingTool of ['TaskCreate', 'TaskUpdate', 'TaskStop', 'TodoWrite', 'Skill']) {
  assert(!readOnlyBlock[0].includes(`"${mutatingTool}"`), `mutating tool auto-approved: ${mutatingTool}`);
}
const safeBlock = hook.match(/const SAFE:[\s\S]*?\];/);
assert(safeBlock, 'SAFE shell allow-list missing');
for (const unsafeShell of ['"find"', '"less"', '"env"', '"printenv"']) {
  assert(!safeBlock[0].includes(unsafeShell), `unsafe shell command auto-approved: ${unsafeShell}`);
}
assert(!hook.includes('"rev-parse" | "config"'));
assert(hook.includes('url.starts_with("https://")'));
assert(!hook.includes('url.starts_with("https://") || url.starts_with("http://")'));

const autoDecision = server.match(/fn automatic_decision[\s\S]*?\n}/);
assert(autoDecision, 'automatic_decision missing');
for (const mutatingTool of ['TaskCreate', 'TaskUpdate', 'TaskStop', 'TodoWrite']) {
  assert(!autoDecision[0].includes(`"${mutatingTool}"`), `server auto-approved mutating tool: ${mutatingTool}`);
}
assert(autoDecision[0].includes('url.starts_with("https://")'));
assert(!autoDecision[0].includes('url.starts_with("http://")'));

const installer = read('src-tauri/src/hook_install.rs');
for (const needle of [
  'Merge-safe Claude hook installation',
  'remove_all_ours',
  'sync_enabled',
  'write_json_atomic',
  'PermissionRequest',
  '--octopus-hook',
]) assert(installer.includes(needle), `missing Rust hook installer behavior: ${needle}`);

const lib = read('src-tauri/src/lib.rs');
assert(lib.includes('hook_install::sync_enabled'));
assert(lib.includes('http_server::start'));
assert(lib.includes('app.manage(tray)'));

console.log('tauri-native-core-smoke: ok');
