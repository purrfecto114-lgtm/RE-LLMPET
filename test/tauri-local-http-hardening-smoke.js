'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const server = read('src-tauri/src/http_server.rs');
const client = read('src-tauri/src/hook_client.rs');
const installer = read('src-tauri/src/hook_install.rs');
const nodeInstaller = read('scripts/install-native-hooks.js');

// Authorization material stays in the 0600 runtime file and HTTP header, never hook URLs.
assert.match(server, /const TOKEN_HEADER: &str = "x-re-llmpet-token"/);
assert.match(server, /fn client_identity_allowed/);
assert.match(server, /get\(SERVER_HEADER\)/);
assert.match(server, /fn authorized[\s\S]*get\(TOKEN_HEADER\)/);
const authBlock = server.slice(server.indexOf('fn authorized'), server.indexOf('fn constant_time_eq'));
assert.doesNotMatch(authBlock, /query|get\("token"\)/);
assert.match(client, /X-Re-Llmpet-Token: \{\}/);
assert.match(client, /X-Re-Llmpet-Server: re-llmpet/);
assert.match(client, /x-re-llmpet-server: re-llmpet/);

// R44 0.5.41: use 'fn uninstall_claude()' (with parens) to avoid matching
// the new 'fn uninstall_claude_at(' variant added for receipt-driven uninstall.
const claudeBlock = installer.slice(installer.indexOf('pub fn install_claude'), installer.indexOf('fn uninstall_claude()'));
assert.match(claudeBlock, /PermissionRequest/);
assert.match(claudeBlock, /command_hook\(permission, 600\)/);
assert.doesNotMatch(claudeBlock, /\?token=|"type":"http"/);
assert.doesNotMatch(nodeInstaller, /\?token=|encodeURIComponent\(runtime\.token\)/);
assert.match(nodeInstaller, /--permission PermissionRequest/);

// Existing defenses remain active.
for (const needle of [
  'peer_addr()', 'ip().is_loopback()', 'host_allowed', 'contains_key("origin")',
  'contains_key("referer")', 'MAX_HEADER_BYTES', 'MAX_PERMISSION_BYTES',
  'MAX_CLIENT_THREADS', 'constant_time_eq', 'duplicate critical header',
  'transfer-encoding unsupported', 'application/json required',
]) assert(server.includes(needle), `local HTTP defense missing: ${needle}`);

console.log('tauri-local-http-hardening-smoke: ok');
