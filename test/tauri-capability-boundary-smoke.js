'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const json = (file) => JSON.parse(read(file));
const permission = (command) => `allow-${command.replaceAll('_', '-')}`;

const config = json('src-tauri/tauri.conf.json');
// R59: the expression studio joins the capability roster with its own
// least-privilege window (custom expression overrides).
assert.deepStrictEqual(config.app.security.capabilities, ['pet', 'panel', 'expression-studio']);
const build = read('src-tauri/build.rs');
assert.match(build, /AppManifest::new\(\)\.commands\(COMMANDS\)/);

const manifestCommands = new Set([...build.matchAll(/^\s*"([a-z0-9_]+)",$/gm)].map((match) => match[1]));
const handler = read('src-tauri/src/lib.rs').match(/generate_handler!\[([\s\S]*?)\]\)/);
assert(handler, 'invoke handler missing');
const registered = new Set(handler[1].split(',').map((item) => item.trim()).filter(Boolean));
assert.deepStrictEqual([...manifestCommands].sort(), [...registered].sort(), 'ACL manifest and invoke handler drifted');

const pet = json('src-tauri/capabilities/pet.json');
const panel = json('src-tauri/capabilities/panel.json');
const studio = json('src-tauri/capabilities/expression-studio.json');
assert.deepStrictEqual(pet.windows, ['pet', 'pet-codex']);
assert.deepStrictEqual(panel.windows, ['panel']);
assert.deepStrictEqual(studio.windows, ['expression-studio']);

const petRequired = [
  'get_config', 'get_stats', 'get_win_pos', 'set_win_pos', 'commit_win_pos', 'set_ignore_mouse',
  'set_pet_size', 'set_skin', 'set_currency', 'toggle_mute', 'territory_run_now',
  'open_panel', 'blur_pet', 'decide_permission', 'decide_permission_batch',
  'launch_agent', 'focus_session', 'primary_action', 'open_log', 'pet_log',
  'ui_busy', 'pet_visual_bounds', 'quit_app', 'set_session_prefs', 'set_pet_mode',
  'get_travel', 'start_travel', 'start_wander', 'cancel_travel',
];
const panelRequired = [
  'get_config', 'get_stats', 'get_price_info', 'refresh_model_prices',
  'set_price_auto_update', 'set_mode', 'set_skin', 'set_budget', 'set_providers',
  'close_panel', 'set_panel_height',
  // R28 (2026-07-30): panel needs diagnose + launch for the provider
  // diagnostic card and "launch checked" button.
  'diagnose_agent', 'launch_agent', 'launch_agent_gui', 'set_session_prefs',
  'set_pet_mode', 'get_travel',
];
for (const command of petRequired) assert(pet.permissions.includes(permission(command)), `pet missing ${command}`);
for (const command of panelRequired) assert(panel.permissions.includes(permission(command)), `panel missing ${command}`);

for (const privileged of ['decide_permission', 'decide_permission_batch', 'open_log', 'quit_app']) {
  assert(!panel.permissions.includes(permission(privileged)), `panel unexpectedly exposes ${privileged}`);
}
for (const configuration of ['set_providers', 'refresh_model_prices', 'set_price_auto_update']) {
  assert(!pet.permissions.includes(permission(configuration)), `pet unexpectedly exposes ${configuration}`);
}
// R59: the studio window is a settings surface — it must not expose the
// privileged pet/panel surfaces (permissions, logs, process launch).
for (const privileged of ['decide_permission', 'decide_permission_batch', 'open_log', 'quit_app',
  'launch_agent', 'launch_agent_gui', 'set_providers', 'start_wander', 'start_travel']) {
  assert(!studio.permissions.includes(permission(privileged)),
    `expression-studio unexpectedly exposes ${privileged}`);
}
assert(!fs.existsSync(path.join(ROOT, 'src-tauri/capabilities/default.json')), 'broad shared capability must stay removed');

console.log('tauri-capability-boundary-smoke: ok');
