#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));

const conf = json('src-tauri/tauri.conf.json');
const model = read('src-tauri/src/model.rs');
const commands = read('src-tauri/src/commands.rs');
const platform = read('src-tauri/src/platform.rs');
const lib = read('src-tauri/src/lib.rs');
const travel = read('src-tauri/src/travel.rs');
const territory = read('src-tauri/src/territory.rs');
const migration = read('src-tauri/src/migration.rs');
const bridge = read('frontend/renderer/tauri-bridge.js');
const petHtml = read('frontend/renderer/pet.html');
const petJs = read('frontend/renderer/pet.js');
const petAgent = read('frontend/renderer/pet-agent-view.js');
const petTravel = read('frontend/renderer/pet-travel-view.js');
const panelHtml = read('frontend/renderer/panel.html');
const panelJs = read('frontend/renderer/panel.js');
const petCap = read('src-tauri/capabilities/pet.json');
const panelCap = read('src-tauri/capabilities/panel.json');

// P1 — two unique Tauri windows, independent identity/skin/position and native state.
const windows = conf.app.windows;
const primary = windows.find((w) => w.label === 'pet');
const codex = windows.find((w) => w.label === 'pet-codex');
assert(primary && codex, 'dual-pet mode requires pet and pet-codex windows');
assert(primary.url.includes('agent=claude') && codex.url.includes('agent=codex'), 'each pet window must have a stable provider identity');
for (const token of ['pub pet_mode: String', 'pub skin_codex: String', 'pub pet_position_codex: Option<Point>']) {
  assert(model.includes(token), `dual-pet config field missing: ${token}`);
}
assert(commands.includes('pub fn set_pet_mode') && commands.includes('sync_pet_windows'), 'dual-pet mode command/synchronizer missing');
assert(platform.includes('Mutex<HashMap<String, bool>>') && platform.includes('Mutex<HashMap<String, VisualBounds>>'), 'click-through state must be isolated by window label');
assert(platform.includes('for label in ["pet", "pet-codex"]'), 'native cursor/recovery workers must cover both pets');
assert(petAgent.includes("get('agent') === 'codex'") && petAgent.includes('event.provider || (event.trip && event.trip.provider)') && petAgent.includes('const latest = sessions[0] || null'), 'renderer must isolate direct/nested provider events without overriding backend state priority');
assert(petJs.includes('!eventBelongsToThisPet(event)'), 'travel lifecycle events must stay on their provider-specific pet');

// P1 — pet HUD search/filter/pin/archive with persisted preferences.
for (const token of ['id="sl-search"', 'data-filter="claude"', 'data-filter="codex"', 'data-filter="attention"', 'data-filter="archived"']) {
  assert(petHtml.includes(token), `pet HUD control missing: ${token}`);
}
for (const token of ['slQuery', 'visibleSessions()', 's.providerId || s.provider', 'pinnedSet', 'archivedSet', 'syncSessionPrefs()', "configWrites.request('sessionPrefs'", 'window.pet.setSessionPrefs']) {
  assert(petJs.includes(token), `pet HUD behavior missing: ${token}`);
}
assert(petCap.includes('allow-set-session-prefs'), 'pet HUD must be permitted to persist pin/archive preferences');

// P2 — real Todo ingest, per-session storage, and top-level stats.
for (const token of ['pub struct TodoItem', 'pub id: Option<String>', 'extract_todo_snapshot', 'extract_todo_patch', 'apply_todo_patch', 'todo_response', '"todos":top_todos', '"todosProject":todos_project']) {
  assert(model.includes(token), `real Todo pipeline missing: ${token}`);
}
for (const token of ['"TodoWrite" if event == "PostToolUse"', '"TaskList" if event == "PostToolUse"', '"TaskCreate"', '"TaskUpdate"', '"TaskGet"', 'response.get("tasks")', 'patch.deleted']) {
  assert(model.includes(token), `current Claude Task tool pipeline missing: ${token}`);
}
assert(!/"todos"\s*:\s*\[\]/.test(model.slice(model.indexOf('pub fn stats_snapshot'))), 'stats must not retain the old fixed empty Todo placeholder');

// P2 — travel/wander/growth with safe CLI isolation, single-flight, timeout, cancel, persistence and official migration.
for (const token of ['MAX_TRAVEL_MS', 'MAX_OUTPUT_BYTES', 'another trip is already running', 'pub fn start_project', 'pub fn start_wander', 'pub fn cancel', 'growth_view', 'write_private_atomic', 'private_output_file', 'travel output exceeded 2 MiB', 'official_travel_to_persisted', 'persisted.active = active', 'interrupted_postcard', 'converted_official', 'provider: &str', 'cached input as a subset']) {
  assert(travel.includes(token), `travel implementation missing: ${token}`);
}
for (const token of ['--permission-mode', 'plan', '--tools', 'Read,Glob,Grep', 'WebSearch,WebFetch', '--strict-mcp-config', '--no-session-persistence']) {
  assert(travel.includes(token), `Claude travel isolation flag missing: ${token}`);
}
for (const token of ['exec', '--ephemeral', '--sandbox', 'read-only', '--ask-for-approval', 'never']) {
  assert(travel.includes(token), `Codex travel isolation flag missing: ${token}`);
}
for (const token of ['getTravel', 'startTravel', 'startWander', 'cancelTravel']) {
  assert(bridge.includes(token), `travel bridge API missing: ${token}`);
}
assert(petHtml.includes('id="sl-wander"') && petHtml.includes('pet-travel-view.js') && petJs.includes('travelView.update') && petTravel.includes('api.startWander'), 'pet HUD travel controls/status missing');
assert(panelHtml.includes('id="travel-growth"') && panelHtml.includes('id="travel-postcard"') && panelJs.includes('const travel = s.travel || {}'), 'panel travel/growth mailbox missing');

// P3 — Territory performs real macOS discovery and rival-window movement, not a message-only stub.
assert(territory.includes('tell application "System Events"'), 'Territory must inspect macOS application windows');
assert(territory.includes('DEFAULT_RIVALS') && territory.includes('config.territory_rivals') && territory.includes('eq_ignore_ascii_case'), 'Territory custom rivals must extend and deduplicate the built-in list');
assert(territory.includes('config.mode != "hidePet"'), 'Territory patrol must not unhide pets when hidePet mode is active');
assert(territory.includes('set position of window') && territory.includes('Command::new("osascript")'), 'Territory must move rival windows through the macOS accessibility API');
assert(territory.includes('"kind":"territory","phase":"spotted"') && territory.includes('"phase":"victory"'), 'Territory must emit patrol lifecycle events');
assert(!territory.toLowerCase().includes('stub'), 'Territory source must not remain a stub');
assert(commands.includes('crate::territory::run_now') && lib.includes('territory::start_auto'), 'Territory commands and patrol worker must be wired');

// P3 — one-time, non-destructive official ~/.octopus import.
for (const token of ['.octopus', '.official-import-v1.json', 'MAX_IMPORT_BYTES', 'target data path is not a real directory', 'migration marker is not a regular file', 'symlink_metadata', 'target-exists', 'set_private_permissions', 'copy_regular_private', 'same_file', 'publish_noclobber', 'fs::hard_link', 'startup will retry']) {
  assert(migration.includes(token), `official data migration safeguard missing: ${token}`);
}
for (const file of ['config.json', 'usage.json', 'codex-usage.json', 'pricing.json', 'travel.json', 'pidwalk-cache.json']) {
  assert(migration.includes(`"${file}"`), `official migration file missing: ${file}`);
}
assert(model.includes('import_official_data') && model.includes('officialMigration'), 'migration must run before load and be visible in diagnostics');

// Capability boundary must expose only the new commands each surface uses.
for (const token of ['allow-get-travel', 'allow-start-travel', 'allow-start-wander', 'allow-cancel-travel']) {
  assert(petCap.includes(token), `pet travel capability missing: ${token}`);
}
assert(panelCap.includes('allow-set-pet-mode') && panelCap.includes('allow-get-travel'), 'panel dual-pet/travel capabilities missing');

console.log('tauri-feature-parity-r46-smoke: ok (dual pets + HUD + travel/growth + Todo + Territory + official migration)');
