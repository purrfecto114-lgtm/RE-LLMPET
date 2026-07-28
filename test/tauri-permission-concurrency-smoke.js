'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const model = read('src-tauri/src/model.rs');
const server = read('src-tauri/src/http_server.rs');
const pet = read('frontend/renderer/pet.js');

assert.match(model, /pub signature: String/);
assert.match(model, /pub fn permission_signature/);
assert.match(model, /find\(\|entry\| entry\.signature == permission\.signature\)/);
assert.match(model, /"pendingChoices":pending_choices/);
assert.match(model, /"pendingPermissionCount":pending\.len\(\)/);
assert.match(model, /mark_session_after_permission/);
assert.match(model, /if event == \"SessionEnd\"/);
assert.match(model, /close_session_pending/);
assert.match(model, /filter\(\|entry\| entry\.session_id == session_id\)/);
assert.match(server, /runtime\.register_permission\(candidate\)/);
assert.match(server, /if !duplicate_retry/);
assert.match(server, /let decision = guard\.clone\(\)/);
assert.doesNotMatch(server, /guard\.take\(\)/);
assert.match(pet, /c\.permId \|\| ''/);
assert.match(pet, /stats && stats\.pendingChoices/);
assert.match(pet, /curPendingChoices/);

console.log('tauri-permission-concurrency-smoke: ok');
