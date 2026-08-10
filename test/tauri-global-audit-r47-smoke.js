#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const travel = read('src-tauri/src/travel.rs');
const codex = read('src-tauri/src/codex_rollout.rs');
const metering = read('src-tauri/src/metering.rs');
const migration = read('src-tauri/src/migration.rs');
const secureFile = read('src-tauri/src/secure_file.rs');
const instanceProbe = read('src-tauri/src/instance_probe.rs');
const hookClient = read('src-tauri/src/hook_client.rs');
const hookInstall = read('src-tauri/src/hook_install.rs');
const httpServer = read('src-tauri/src/http_server.rs');
const territory = read('src-tauri/src/territory.rs');
const model = read('src-tauri/src/model.rs');
const commands = read('src-tauri/src/commands.rs');
const lib = read('src-tauri/src/lib.rs');
const build = read('src-tauri/build.rs');
const bridge = read('frontend/renderer/tauri-bridge.js');
const petJs = read('frontend/renderer/pet.js');
const panelJs = read('frontend/renderer/panel.js');
const prefClient = read('frontend/shared/session-pref-client.js');
const petCap = read('src-tauri/capabilities/pet.json');
const panelCap = read('src-tauri/capabilities/panel.json');

// Travel prompts are private stdin data, not command-line/process-list data.
assert(travel.includes('.stdin(Stdio::piped())'));
assert(travel.includes('write_all(prompt.as_bytes())'));
assert(travel.includes('.process_group(0)'));
assert(travel.includes('kill_process_tree(pid)'));
assert(travel.includes('try_wait()'));
assert(travel.indexOf('try_wait()') < travel.indexOf('self.cancel.load(Ordering::Acquire)'));
assert(!/command\.args\([^\n]*prompt/.test(travel));
for (const token of [
  'MAX_TRAVEL_STATE_BYTES', 'read_travel_value',
  'unknown_travel_document_is_not_marked_for_conversion',
  'codex_wander_enables_hosted_search_before_exec', 'native web_search',
]) assert(travel.includes(token), `travel audit token missing: ${token}`);
assert(travel.indexOf('args.push("--search"') < travel.indexOf('"exec",'));

// Every runtime credential reader shares one bounded, race-aware path.
for (const token of [
  'symlink_metadata(path)', 'file_type().is_symlink()', 'same_opened_file',
  'file.take(max_bytes.saturating_add(1))', 'changed while reading',
]) assert(secureFile.includes(token), `secure file token missing: ${token}`);
for (const source of [instanceProbe, hookClient, hookInstall]) {
  assert(source.includes('read_regular_bounded'), 'runtime credential reader bypasses secure_file');
}

// Codex accounting must use per-turn usage/deltas and cache parsed files.
for (const token of [
  'last_token_usage', 'delta_from(previous_cumulative)', 'CachedFile',
  'modified_ms', 'SNAPSHOT_CACHE_MS', 'load_official_fallback(app_dir)',
  'cache.files.remove(&path)', 'read_regular_file_bounded',
  'same_opened_file(&metadata, &opened)', 'file.take(max_bytes.saturating_add(1))',
]) assert(codex.includes(token), `Codex audit token missing: ${token}`);
assert(!codex.includes('one-shot scan of today'));

// Official imports become native data; transient PID caches never migrate.
for (const token of [
  '.official-import-v3.json', 'runtime-cache-not-migrated',
  'import_official_usage', 'official-electron-import',
  'claude:assistant:{record_key}', 'officialImportedEvents',
  'same_opened_file', 'incremental-nonblocking',
]) assert(migration.includes(token) || metering.includes(token), `migration audit token missing: ${token}`);
const migrationFiles = migration.slice(migration.indexOf('const FILES'), migration.indexOf('];', migration.indexOf('const FILES')));
const migrationLoop = migration.slice(migration.indexOf('for name in FILES'), migration.indexOf('if retry_needed'));
assert(migrationLoop.indexOf('symlink_metadata(&from)') < migrationLoop.indexOf('symlink_metadata(&to)'), 'official source must exist before a target conflict can burn the marker');
assert(!migrationFiles.includes('pidwalk-cache.json'));
assert(migration.includes('later_official_files_import_even_after_receipt_exists'));

// Territory assigns every rival to its own monitor/work area.
for (const token of ['choose_work_area', 'available_monitors()', 'edge_target', 'workArea', 'is_rival_process', 'rival == process_lower']) {
  assert(territory.includes(token), `Territory multi-monitor token missing: ${token}`);
}

// Pin/archive is a single-row transaction, while the legacy bulk API remains compatible.
for (const token of ['pub fn set_session_pref(', 'pinned: Option<bool>', 'archived: Option<bool>']) {
  assert(commands.includes(token), `atomic preference token missing: ${token}`);
}
assert(lib.includes('set_session_pref,'));
assert(build.includes('"set_session_pref"'));
assert(bridge.includes("setSessionPref: (sessionId, pinned, archived) => call('set_session_pref'"));
assert(prefClient.includes("typeof api.setSessionPref === 'function'"));
assert(petJs.includes('pendingSessionPrefs.add(s.sessionId)') && panelJs.includes('pendingSessionPrefs.add(sid)'));
assert(petJs.includes("pinnedSet[previous.pinned ? 'add' : 'delete'](sessionId)"));
assert(petJs.includes('Promise.resolve().then(() => window.OctoSessionPrefs.save('));
assert(panelJs.includes('Promise.resolve().then(() => window.OctoSessionPrefs.save('));
assert(read('frontend/shared/toast.js').includes("'set_session_pref'"));
assert(!petJs.includes('function syncSessionPrefs()'));
assert(petCap.includes('allow-set-session-pref') && panelCap.includes('allow-set-session-pref'));

// Config and anonymous session identities are bounded and conflict-free.
assert(model.includes('sanitize_session_ids(self.pinned_sessions'));
assert(model.includes('sanitize_session_ids(self.archived_sessions, &pinned)'));
assert(model.includes('format!("{provider}:default")'));
assert(httpServer.includes('format!("{provider}:default")'), 'permission fallback must use the same provider-scoped anonymous session id');
assert(model.includes('.map(|value| value.to_ascii_lowercase())'));
assert(httpServer.includes('.map(|value| value.to_ascii_lowercase())')); 


// Recent operations and context are real, bounded, and share the final UI ordering.
for (const token of [
  'struct RecentOperation', 'recent_ops: Mutex<VecDeque<RecentOperation>>',
  'recent.push_front(operation)', 'recent.truncate(50)', '.take(30)',
  '"lastOps":last_ops', 'let active_row = rows.first()', '"context":context',
]) assert(model.includes(token), `status contract token missing: ${token}`);
assert(!model.includes('"lastOps":[]'));
assert(!model.includes('"context":Value::Null'));
assert(model.includes('let todo_row = rows.iter().find'));
assert(!model.includes('let todo_session = sessions'));
assert(model.includes('same_opened_config_file'));
assert(model.includes('fs::symlink_metadata(path)'));

// R18 de-idealized: bg now marks itself as unavailable instead of showing fake zeros
assert(model.includes('"available":false'));
assert(model.includes('pidwalk'));

// Audit decisions are recorded for maintainers and parity tracking is current.
const matrix = JSON.parse(read('docs/UPSTREAM_PARITY_MATRIX.json'));
const item = (name) => matrix.items.find((entry) => entry.feature === name);
assert.strictEqual(item('lastOps (recent operations)').reStatus, 'complete');
assert.strictEqual(item('Context summary').reStatus, 'complete');
assert.match(item('Background task status').upstream, /Placeholder/);
assert(fs.existsSync(path.join(root, 'docs/GLOBAL_AUDIT_2026-08-04.md')));

console.log('tauri-global-audit-r47-smoke: ok');
