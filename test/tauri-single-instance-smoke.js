#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const lib = read('src-tauri/src/lib.rs');
const server = read('src-tauri/src/http_server.rs');
const probe = read('src-tauri/src/instance_probe.rs');

assert(lib.includes('mod instance_probe;'));
assert(lib.includes('instance_probe::activate_runtime_instance(&runtime_path)'));
assert(lib.indexOf('instance_probe::activate_runtime_instance(&runtime_path)') < lib.indexOf('tauri::Builder::default()'),
  'ordinary duplicates must exit before Tauri windows and runtime workers are constructed');
assert(lib.includes('Err(http_server::StartError::AlreadyRunning(port))'));
assert(lib.includes('app.handle().exit(0);'));
assert(lib.indexOf('http_server::start') < lib.indexOf('setup_tray(app)?'),
  'duplicate detection must run before tray and background workers start');
assert(server.includes('ErrorKind::AddrInUse'));
assert(server.includes('instance_probe::activate_existing_with_retry(runtime_path, port, 4)'));
assert(server.includes('StartError::AlreadyRunning(port)'));
assert(server.includes('"/activate" =>'));
assert(server.includes('window.show()') && server.includes('window.set_focus()'));
assert(!probe.includes('GET /state HTTP/1.1'), 'public state must not be an ownership proof');
assert(probe.includes('POST /activate HTTP/1.1'));
assert(probe.includes('runtime.port != expected_port'));
assert(probe.includes('MAX_RESPONSE_BYTES'));
assert(probe.includes('remove_runtime_if_owned'));
assert(server.includes('#[derive(Debug)]\npub struct ServerInfo'));
assert(!server.includes('#[derive(Debug, Clone)]\npub struct ServerInfo'), 'runtime credential lease must not be clonable');
assert(server.includes('impl Drop for ServerInfo'));
assert(server.includes('let spawn_result = thread::Builder::new()'));
assert(server.includes('remove_runtime_if_owned(&runtime_path, port, &token, pid)'),
  'accept-loop spawn failure must revoke the already-published runtime credential');
assert(lib.includes('if !app.manage(server)'));
assert(lib.includes('HTTP server lease is already managed'));
assert(lib.includes('HTTP server unavailable:'));
assert(lib.includes('Octopus local Agent service could not start'),
  'the app must not continue as a deceptively healthy UI without its provider control plane');
assert(!lib.includes('HTTP server disabled:'), 'server startup failure must not silently degrade');
assert(probe.split('\n').length <= 240,
  'instance probing must remain a focused module rather than grow into http_server.rs');

console.log('tauri-single-instance-smoke: ok');
