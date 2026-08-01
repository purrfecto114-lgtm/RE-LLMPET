'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
// Collapse whitespace so assertions survive `cargo fmt` reflow.
const compact = (s) => s.replace(/\s+/g, ' ');
const installer = read('src-tauri/src/hook_install.rs');
const installerC = compact(installer);
const client = read('src-tauri/src/hook_client.rs');
const model = read('src-tauri/src/model.rs');
const commands = read('src-tauri/src/commands.rs');
const lib = read('src-tauri/src/lib.rs');
const panel = read('frontend/renderer/panel.js');
const pet = read('frontend/renderer/pet.js');
const bridge = read('frontend/renderer/tauri-bridge.js');

for (const id of ['claude', 'codewhale', 'codex', 'opencode', 'aider']) {
  assert(installer.includes(`"${id}"`), `provider missing in native installer: ${id}`);
  assert(panel.includes(`${id}:`), `provider missing in renderer metadata: ${id}`);
}
for (const [id, label] of Object.entries({ claude: 'Claude', codewhale: 'CodeWhale', codex: 'Codex', opencode: 'OpenCode', aider: 'Aider' })) {
  assert(pet.includes(`${id}: '${label}'`), `pet provider label missing: ${id}`);
}
for (const id of ['claude', 'codewhale', 'codex', 'opencode', 'aider']) {
  assert(pet.includes(`${id}:`), `pet provider icon missing: ${id}`);
  assert(panel.includes(`${id}:`), `panel provider cost/status metadata missing: ${id}`);
}
assert(pet.includes("const provIcon = PROVIDER_ICONS[s.provider] || '•';"), 'session HUD must not fall back to the Claude icon');
assert(bridge.includes("launchAgent: (provider) => send('launch_agent', { provider })"));
// R35.2: the new-session button now routes through chooseProviderAndLaunch
// (which uses launchAgentChecked for single-provider or opens a chooser
// for multi-provider). The old direct `window.pet.launchAgent(provider)`
// call is gone. Assert the new routing function exists.
assert(pet.includes('chooseProviderAndLaunch()'), 'new-session button must route through chooseProviderAndLaunch (R35.2)');
assert(!pet.includes("if (pid === 'codewhale')"), 'provider-specific renderer launch branch must stay removed');
assert(installer.includes('sync_enabled'));
assert(installer.includes('resync_current'));
assert(commands.includes('hook_install::resync_current'));
// R36: startup uses verify_enabled; sync_enabled still exists in hook_install.rs.
assert(lib.includes('hook_install::verify_enabled') || lib.includes('hook_install::sync_enabled'));

// CodeWhale: current TOML shape, current maintained events and fail-safe ask.
for (const needle of [
  '[[hooks.hooks]]', 'tool_call_before', 'turn_end', 'subagent_spawn',
  'subagent_complete', 'CODEWHALE_HOME', 'background = true',
]) assert(installer.includes(needle), `CodeWhale migration missing: ${needle}`);
for (const obsolete of ['subagent_start", "subagent_stop', 'plan_start', 'shell_start']) {
  assert(!installer.includes(obsolete), `obsolete/unverified CodeWhale event installed: ${obsolete}`);
}
assert(client.includes('"decision":"ask"'));
assert(client.includes('DEEPSEEK_TOOL_ARGS'));
assert(client.includes('CODEWHALE_TOOL_ARGS'));
assert(installerC.includes('hook_command_with_flags(&executable, "claude", Some("PreToolUse"), false, true)'));
assert(installerC.includes('if pretool { args.push_str(" --pretool"); }'));
assert(installerC.includes('cmd.exe /D /S /C')); // Windows quoted-path invocation
assert(installerC.includes('unterminated Octopus marker block'));
assert(installerC.includes('unmatched Octopus marker end'));
assert(client.includes('native_event'));
assert(installerC.includes('if permission { "false" } else { "true" }'));

// Codex: current hooks.json nested group schema and explicit trust state.
for (const needle of [
  '.codex', 'hooks.json', '"matcher":"","hooks":[desired]',
  'PermissionRequest', 'commandWindows', '/hooks', 'external-after-trust',
]) assert(installer.includes(needle), `Codex migration missing: ${needle}`);
assert(!installer.includes('timeoutSec'), 'obsolete guessed Codex timeoutSec schema retained');
assert(!installer.includes('hooks = "./hooks.json"'), 'Codex should auto-discover ~/.codex/hooks.json');

// OpenCode: official ESM plugin form, current events, no external permission steering.
for (const needle of [
  'export const LLMPETPlugin', '"tool.execute.before"', '"tool.execute.after"',
  'permission.asked', 'permission.replied', 'session.idle', 'session.error',
  'permissionBubble":false', 'llmpet-octopus.js',
]) assert(installer.includes(needle), `OpenCode migration missing: ${needle}`);
assert(!installer.includes('module.exports'));
// R40: plugin marker was bumped from v2 -> v3 to flag the
// session.status mapping rewrite. Accept either marker so the test
// doesn't break on future version bumps.
const pluginMatch = installer.match(/r#"(\/\/ octopus-opencode-plugin-v\d+[\s\S]*?)"#\n}/);
assert(pluginMatch, 'embedded OpenCode plugin source not found');
const temp = path.join(os.tmpdir(), `llmpet-opencode-${process.pid}.mjs`);
fs.writeFileSync(temp, pluginMatch[1]);
const pluginCheck = spawnSync(process.execPath, ['--check', temp], { encoding: 'utf8' });
fs.rmSync(temp, { force: true });
assert.strictEqual(pluginCheck.status, 0, pluginCheck.stderr);

// Aider: YAML config uses underscore (notifications_command); the CLI flag
// uses hyphen (--notifications-command). The installer must write the YAML form.
assert(installer.includes('notifications_command:'));
assert(installer.includes('notifications: true\\nnotifications_command:'));
assert(installer.includes('turn-end-only'));
assert(client.includes('stable_session("aider"'));

// Renderer contract: persisted Vec becomes a richer runtime view.
assert(model.includes('pub fn config_view(&self) -> Value'));
assert(model.includes('"active": config.providers'));
assert(model.includes('"statuses": statuses'));
assert(commands.includes('pub fn get_config') && commands.includes('-> Value'));
assert(panel.includes('permissionMode'));

// No known phase-1 accidental duplicate expression regressions.
assert(!/entry\.clone\(\)\s*entry\.clone\(\)/.test(model));
assert(!/unwrap_or_default\(\)\s*\.unwrap_or_default\(\)/.test(model));

console.log('tauri-provider-phase2-smoke: ok');
