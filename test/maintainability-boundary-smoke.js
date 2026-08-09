'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const panel = read('frontend/renderer/panel.js');
const pet = read('frontend/renderer/pet.js');
const bridge = read('frontend/renderer/tauri-bridge.js');
const panelHtml = read('frontend/renderer/panel.html');
const petHtml = read('frontend/renderer/pet.html');
const platform = read('src-tauri/src/platform.rs');
const hooks = read('src-tauri/src/hook_install.rs');
const commands = read('src-tauri/src/commands.rs');
const diagnosticControl = read('src-tauri/src/diagnostic_control.rs');
const diagnosticIo = read('src-tauri/src/diagnostic_io.rs');
const instanceProbe = read('src-tauri/src/instance_probe.rs');
const releaseAssetVerifier = read('scripts/verify-release-assets.js');
const configWriteController = read('frontend/shared/config-write-controller.js');
const boundaries = read('docs/ARCHITECTURE_BOUNDARIES.md');
const codeOnly = (source) => source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

// Tauri event ownership belongs to one bridge. Renderer feature files consume
// named subscriptions and cannot create unmanaged global listeners.
assert(!/\b(?:ev|event)\.listen\s*\(/.test(codeOnly(panel)), 'panel.js must not own raw Tauri listeners');
assert(!/\b(?:ev|event)\.listen\s*\(/.test(codeOnly(pet)), 'pet.js must not own raw Tauri listeners');
assert(bridge.includes('subscriptionDisposers') && bridge.includes('disposeSubscriptions'),
  'bridge must centrally own listener teardown');
assert(bridge.includes('bridgeDisposed') && bridge.includes('beforeunload'),
  'bridge must close the async listen-after-unload race');

// Async sequencing lives in small pure modules instead of growing renderer
// files with timestamp heuristics and promise chains.
assert(panelHtml.includes('../shared/panel-fit-controller.js'));
assert(petHtml.includes('../shared/latest-value-controller.js'));
for (const legacy of ['pendingFitHeight', 'lastFitRequestTs', 'lastFitHeight']) {
  assert(!panel.includes(legacy), `panel.js must not reintroduce inline ${legacy} state`);
}
for (const legacy of ['petSizeChain', 'lastSentPetSize']) {
  assert(!pet.includes(legacy), `pet.js must not reintroduce inline ${legacy} state`);
}
assert(panel.includes('OctoPanelFit.createPanelFitController'));
assert(pet.includes('OctoLatestValue.createLatestValueController'));
assert(/function chooseProviderAndLaunch\(\) \{\s*openProviderChooser\(\);\s*\}/.test(pet),
  'new Agent must always open the explicit provider chooser');

// Cursor polling computes geometry once per tick and exits early while hidden.
assert.strictEqual((platform.match(/window\.cursor_position\(\)\.ok\(\)/g) || []).length, 1,
  'non-Windows cursor polling must query cursor position once per active tick');
assert(platform.includes('GetCursorPos'),
  'Windows click-through recovery must use a system-global cursor query');
assert(!platform.includes('fn should_ignore_cursor'));
assert(!platform.includes('fn cursor_poll_delay'));
assert(platform.includes('struct CursorHitDecision'));

// New external ownership uses Octopus. Legacy identifiers remain only in
// explicit migration arrays and compatibility storage/protocol paths.
assert(hooks.includes('# >>> octopus:codewhale-hooks:v4 >>>'));
assert(hooks.includes('# >>> octopus:aider-notification:v4 >>>'));
assert(hooks.includes('octopus-opencode-plugin-v3'));
assert(hooks.includes('name = \\"octopus-{event}\\"'));
assert(hooks.includes('CW_MARKERS') && hooks.includes('AIDER_MARKERS'));
assert(hooks.includes('enum HookPresence')
  && hooks.includes('HookPresence::Mixed')
  && hooks.includes('block_marker_presence')
  && hooks.includes('is_current_hook_installed(id)'),
  'explicit resync must migrate legacy ownership instead of idempotently skipping it');
assert(hooks.includes('command_is_ours') && hooks.includes('json_config_contains_our_hooks'));
assert(!commands.includes('# >>> re-llmpet:codewhale-hooks:v3 >>>'),
  'diagnostics must not hard-code one legacy CodeWhale marker');
assert(commands.includes('PanelPlacement::CenterOnPet')
  && commands.includes('PanelPlacement::PreserveCurrentCenter'),
  'initial centering and incremental fitting must have explicit placement policies');
assert(commands.includes('diagnostic_control.begin(provider.clone())')
  && commands.includes('diagnostic_control.finish()')
  && commands.includes('.process_group(0)'),
  'diagnostic ownership and process-tree cancellation must stay centralized');
assert(diagnosticControl.includes('struct DiagnosticState')
  && diagnosticControl.includes('claim_pid_for_termination'),
  'diagnostic lifecycle must remain a focused state owner');
assert(diagnosticIo.includes('fn drain_bounded') && diagnosticIo.includes('read == 0'),
  'diagnostic output must be drained to EOF without unbounded retention');
assert(commands.includes('drain_bounded(pipe, 64 * 1024)')
  && commands.includes('if cancelled || timed_out'),
  'diagnostics must not close full pipes early or trust timeout-truncated JSON');
assert(!commands.includes('active_diagnostic_pid') && !commands.includes('active_diagnostic_provider'),
  'commands.rs must not reintroduce split diagnostic fields');
assert(boundaries.includes('tauri-bridge.js')
  && boundaries.includes('latest-value-controller.js')
  && boundaries.includes('config-write-controller.js')
  && boundaries.includes('panel-fit-controller.js'),
  'architecture ownership rules must remain documented');

// The remaining large files are yellow-zone debt, not extension points. These
// budgets are deliberately just above the audited baseline: new stateful
// behavior must be extracted rather than accreted here. The focused controller
// modules have a much smaller budget so they remain reviewable.
const lineCount = (source) => source.split('\n').length;
for (const [name, source, maxLines] of [
  ["frontend/renderer/pet.js", pet, 2500],
  ['frontend/renderer/panel.js', panel, 1650],
  ['src-tauri/src/commands.rs', commands, 3250],
  ['src-tauri/src/hook_install.rs', hooks, 2300],
  ['frontend/shared/latest-value-controller.js', read('frontend/shared/latest-value-controller.js'), 220],
  ['frontend/shared/panel-fit-controller.js', read('frontend/shared/panel-fit-controller.js'), 220],
  ['frontend/shared/config-write-controller.js', configWriteController, 140],
  ['frontend/shared/session-pref-client.js', read('frontend/shared/session-pref-client.js'), 100],
  ['src-tauri/src/diagnostic_control.rs', diagnosticControl, 180],
  ['src-tauri/src/diagnostic_io.rs', diagnosticIo, 100],
  ['src-tauri/src/instance_probe.rs', instanceProbe, 240],
  ['scripts/verify-release-assets.js', releaseAssetVerifier, 180],
]) {
  assert(lineCount(source) <= maxLines,
    `${name} exceeded its audited growth budget (${lineCount(source)} > ${maxLines}); extract a focused owner`);
}

assert(!bridge.includes('installReLlmpetBridge'));
assert(!/\[re-llmpet\]/.test(bridge), 'new bridge logs must use Octopus branding');

console.log('maintainability-boundary-smoke: ok');
