'use strict';

// R58-IMPL-C smoke: 闲逛/双宠自由搭配 (duo_provider free pairing).
//
// Locks in the R58 design:
//   1. config.duo_provider (serde default "codex" = 0.6.6 behavior, sanitize
//      whitelist over the five registry providers);
//   2. wander owner derivation (initiating window label) — no more provider-
//      derived owner mismatch (defects A/B);
//   3. no unconditional "claude" wander fallback — CLI existence pre-check
//      (pick_wander_provider) + localized error;
//   4. start_project whitelist aligned with wander (codewhale included);
//   5. set_duo_provider command surface (build.rs/capabilities/lib.rs);
//   6. frontend generalization (window-label identity, config-driven duo
//      partition, bridge owner attachment, panel selector, i18n keys).
// Structural assertions + vm functional probes (r46/r50 smoke style).
// Run: node test/tauri-duo-provider-r58-smoke.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// ── 1. model.rs: duo_provider field + default + sanitize ─────────────────────
const model = read('src-tauri/src/model.rs');
assert(model.includes('fn default_duo_provider()'), 'default_duo_provider fn missing');
assert(model.includes('pub duo_provider: String'), 'AppConfig.duo_provider field missing');
assert(model.includes('#[serde(default = "default_duo_provider")]'),
  'duo_provider must carry the serde default (old configs deserialize as codex)');
assert(model.includes('duo_provider: default_duo_provider(),'),
  'Default impl must keep the codex pairing (0.6.6 behavior)');
assert(model.includes('self.duo_provider = default_duo_provider();'),
  'sanitize must coerce invalid duo_provider back to codex');
assert(/duo_provider\.as_str\(\),\s*\n\s*"claude" \| "codewhale" \| "codex" \| "opencode" \| "aider"/.test(model),
  'sanitize whitelist must cover the five registry providers');
assert(model.includes('pub fn duo_provider(&self) -> String'),
  'Runtime::duo_provider lightweight accessor missing (hot-path pet_label_for_agent)');

// ── 2. travel.rs: owner param + no claude fallback ───────────────────────────
const travel = read('src-tauri/src/travel.rs');
assert(/pub fn start_wander\([\s\S]*?provider: Option<String>,\s*\n\s*owner: Option<String>,/.test(travel),
  'start_wander must accept the initiating window owner');
assert(/fn start\([\s\S]*?provider: &str,\s*\n\s*owner: Option<&str>,/.test(travel),
  'start() must accept an optional owner (None → owner_for_provider legacy path)');
assert(!travel.includes('supported_by_config'),
  'the old supported_by_config + unconditional "claude" fallback must be gone');
assert(travel.includes('fn pick_wander_provider('),
  'CLI-existence candidate picker missing (upstream findCli approach)');
assert(travel.includes('fn is_wander_supported('),
  'wander supported set helper missing (single source of truth)');
assert(travel.includes('fn wander_no_cli_message('),
  'localized no-CLI error missing');
assert(travel.includes('find_executable(value).is_ok()'),
  'candidates must be pre-checked with find_executable');
// Degrade log retained for diagnosability (r50 smoke anchor).
assert(travel.includes("wander provider '{rejected}' has no runner; degrading to '{provider}'"),
  'R50 degrade log line must stay');
// start_project whitelist aligned with wander (codewhale project travel).
assert(travel.includes('if !is_wander_supported(&session.provider)'),
  'start_project whitelist must reuse the wander supported set (codewhale included)');
// Old postcard provider fallback stays (data compatibility with 0.6.x travel.json).
assert(/provider: if provider\.is_empty\(\) \{\s*\n\s*"claude"\.into\(\)/.test(travel),
  'legacy postcard provider fallback must stay for data compatibility');

// ── 3. commands.rs: set_duo_provider + config-aware routing ──────────────────
const commands = read('src-tauri/src/commands.rs');
assert(commands.includes('pub fn set_duo_provider('), 'set_duo_provider command missing');
assert(commands.includes('unsupported duo provider: {provider}'),
  'set_duo_provider must whitelist the five registry providers');
assert(commands.includes('agent.as_deref() == Some(config.duo_provider.as_str())'),
  'set_skin must select the second-pet skin by config.duo_provider (agent=codex stays equivalent)');
assert(commands.includes('fn pet_label_for_agent(app: &AppHandle, agent: Option<&str>)'),
  'pet_label_for_agent must be config-aware (semantic provider from config.duo_provider)');
assert(commands.includes('state.runtime.duo_provider()'),
  'pet_label_for_agent must read the pairing without a full config clone');
assert(commands.includes('fn sync_duo_provider_url('),
  'second-pet window URL sync helper missing');
assert(commands.includes("window.location.replace('/renderer/pet.html"),
  'URL sync must navigate the pet-codex window to the paired provider');
assert(commands.includes('sync_duo_provider_url(app, config);'),
  'sync_pet_windows must run the URL sync (covers set_pet_mode/set_duo_provider/startup/tray)');

// ── 4. registration surface: build.rs + capabilities + lib.rs ───────────────
const buildRs = read('src-tauri/build.rs');
assert(buildRs.includes('"set_duo_provider"'), 'build.rs COMMANDS must register set_duo_provider');
const petCap = read('src-tauri/capabilities/pet.json');
const panelCap = read('src-tauri/capabilities/panel.json');
assert(petCap.includes('allow-set-duo-provider'), 'pet capability must allow set_duo_provider');
assert(panelCap.includes('allow-set-duo-provider'), 'panel capability must allow set_duo_provider');
const lib = read('src-tauri/src/lib.rs');
assert(lib.includes('set_duo_provider,'), 'lib.rs invoke_handler must register set_duo_provider');
// The static window config must not pin the second pet's provider identity.
const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
const secondWindow = conf.app.windows.find((w) => w.label === 'pet-codex');
assert(secondWindow && !secondWindow.url.includes('agent='),
  'the pet-codex window URL must not hardcode ?agent=codex (pairing is config-driven)');

// ── 5. frontend: window-label identity + config-driven partition (vm probes) ─
function agentViewSandbox(label, petApi) {
  const sandbox = {
    window: {
      location: { search: '' },
      pet: petApi || { defaultAgent: () => 'aggregate' },
      __TAURI__: { window: { getCurrentWindow: () => ({ label }) } },
    },
  };
  sandbox.window.window = sandbox.window;
  vm.runInNewContext(read('frontend/renderer/pet-agent-view.js'), sandbox);
  return sandbox.window.OctoPetAgentView;
}

const secondView = agentViewSandbox('pet-codex');
assert.strictEqual(secondView.currentAgent(), 'pet-codex',
  'second pet identity is the window label, independent of the paired provider');
const primaryView = agentViewSandbox('pet');
assert.strictEqual(primaryView.currentAgent(), 'aggregate',
  'primary pet keeps the config-driven default agent');

// Default pairing (codex) keeps the 0.6.6 partition bit-identical.
assert.strictEqual(secondView.eventBelongs({ provider: 'codex' }, 'duo', 'pet-codex'), true);
assert.strictEqual(secondView.eventBelongs({ provider: 'claude' }, 'duo', 'pet-codex'), false);
assert.strictEqual(primaryView.eventBelongs({ provider: 'codex' }, 'duo', 'aggregate'), false);
assert.strictEqual(primaryView.eventBelongs({ provider: 'claude' }, 'duo', 'aggregate'), true);

// Free pairing: duoProvider='opencode' re-slices without a reload.
secondView.setDuoProvider('opencode');
primaryView.setDuoProvider('opencode');
assert.strictEqual(secondView.eventBelongs({ provider: 'opencode' }, 'duo', 'pet-codex'), true);
assert.strictEqual(secondView.eventBelongs({ provider: 'claude' }, 'duo', 'pet-codex'), false);
assert.strictEqual(primaryView.eventBelongs({ provider: 'opencode' }, 'duo', 'aggregate'), false);
assert.strictEqual(primaryView.eventBelongs({ provider: 'codex' }, 'duo', 'aggregate'), true,
  'codex becomes a primary-pet provider once the pairing moves elsewhere');

// Travel lifecycle events route by trip OWNER (initiator keeps feedback even
// when the provider degraded to the other pet's pairing — research defect B).
assert.strictEqual(
  primaryView.eventBelongs({ trip: { owner: 'pet', provider: 'codex' } }, 'duo', 'aggregate'),
  true,
  'a main-window trip stays on the main pet even with a degraded codex provider');
assert.strictEqual(
  secondView.eventBelongs({ trip: { owner: 'pet', provider: 'codex' } }, 'duo', 'pet-codex'),
  false,
  'the second pet must not adopt the main window\u2019s trip');
// Single mode: no partition (unchanged 0.6.6 behavior).
assert.strictEqual(primaryView.eventBelongs({ provider: 'codex' }, 'single', 'aggregate'), true);

// filterStats partition follows the pairing.
const snapshot = {
  sessions: [
    { sessionId: 'a', providerId: 'opencode', state: 'working', idleMs: 10 },
    { sessionId: 'b', providerId: 'claude', state: 'thinking', idleMs: 20 },
  ],
  waitingCount: 0, needsinputCount: 0, workingCount: 1, thinkingCount: 1,
};
const secondStats = secondView.filterStats(snapshot, 'duo', 'pet-codex');
assert.strictEqual(secondStats.sessions.length, 1);
assert.strictEqual(secondStats.sessions[0].providerId, 'opencode');
assert.strictEqual(secondStats.codexUsage, undefined, 'codex rollout surfaces only matter to the paired window');
const primaryStats = primaryView.filterStats(snapshot, 'duo', 'aggregate');
assert.strictEqual(primaryStats.sessions.length, 1);
assert.strictEqual(primaryStats.sessions[0].providerId, 'claude');

// pet-runtime-policy: resolveProvider gains the duo param (3-arg calls keep
// the 0.6.6 behavior).
const policySandbox = { window: {} };
vm.runInNewContext(read('frontend/renderer/pet-runtime-policy.js'), policySandbox);
const policy = policySandbox.window.OctoPetRuntimePolicy;
assert.strictEqual(policy.resolveProvider([], ['codewhale'], 'aggregate'), 'codewhale',
  'legacy 3-arg call must keep working (default pairing codex)');
assert.strictEqual(
  policy.resolveProvider([{ providerId: 'opencode', idleMs: 5 }, { providerId: 'claude', idleMs: 50 }], ['opencode', 'claude'], 'pet-codex', 'opencode'),
  'opencode',
  'the second pet resolves to its paired provider');
assert.strictEqual(
  policy.resolveProvider([{ providerId: 'opencode', idleMs: 5 }, { providerId: 'claude', idleMs: 50 }], ['opencode', 'claude'], 'aggregate', 'opencode'),
  'claude',
  'the primary pet resolves from every provider EXCEPT the pairing');

// pet-travel-view: ownerKeyFor maps the window identity (and legacy codex).
const travelSandbox = { window: {}, document: { getElementById: () => null } };
vm.runInNewContext(read('frontend/renderer/pet-travel-view.js'), travelSandbox);
const travelView = travelSandbox.window.OctoPetTravelView;
assert.strictEqual(travelView.ownerKeyFor('pet-codex'), 'pet-codex');
assert.strictEqual(travelView.ownerKeyFor('codex'), 'pet-codex');
assert.strictEqual(travelView.ownerKeyFor('aggregate'), 'pet');
assert.strictEqual(travelView.ownerKeyFor('claude'), 'pet');

// ── 6. frontend: bridge + pet.js + panel + i18n ─────────────────────────────
const bridge = read('frontend/renderer/tauri-bridge.js');
assert(bridge.includes('setDuoProvider: (duoProvider) => call(\'set_duo_provider\''),
  'bridge must expose setDuoProvider (panel selector)');
assert(bridge.includes('owner: currentOwnerLabel()'),
  'startWander must attach the initiating window label as the trip owner');
assert(bridge.includes('function duoPetProvider()'),
  'bridge must resolve the second-pet pairing from the config snapshot');
assert(bridge.includes("if (current && current.label === 'pet-codex') return duoPetProvider();"),
  'per-agent commands from the second window must route by the paired provider');
assert(bridge.includes("const primary = active.find((p) => p !== duo);"),
  'defaultPetAgent must skip the paired provider (not just codex)');

const petJs = read('frontend/renderer/pet.js');
assert(petJs.includes("let duoProvider = 'codex';"),
  'pet.js must snapshot the pairing (codex fallback = 0.6.6)');
assert(petJs.includes('petAgentView.setDuoProvider(duoProvider);'),
  'config pushes must update the agent view partition');
assert(petJs.includes("PET_AGENT === 'pet-codex' && petMode === 'duo' ? cfg.skinCodex : cfg.skin"),
  'skin selection must use the window identity (pet-codex), not the codex literal');
assert(petJs.includes("PET_AGENT === 'pet-codex' && petMode === 'duo' ? cfg.petPositionCodex : cfg.petPosition"),
  'position selection must use the window identity');
assert(petJs.includes('runtimePolicy.resolveProvider(curSessions, activeProviders, PET_AGENT, duoProvider)'),
  'wander provider resolution must account for the pairing');
assert(petJs.includes('window.OctoPetTravelView.WANDER_SUPPORTED.includes(s.providerId || s.provider)'),
  'the project-travel button must use the travel supported set (codewhale included)');

const panelHtml = read('frontend/renderer/panel.html');
assert(panelHtml.includes('id="duo-provider"'), 'panel second-pet selector missing');
for (const option of ['value="codex"', 'value="claude"', 'value="codewhale"', 'value="opencode"', 'value="aider"']) {
  assert(panelHtml.includes(option), `panel selector option missing: ${option}`);
}
const panelJs = read('frontend/renderer/panel.js');
assert(panelJs.includes('window.pet.setDuoProvider(v)'),
  'panel selector must call set_duo_provider through the write controller');
assert(panelJs.includes("duoSelect.value = config.duoProvider || 'codex';"),
  'panel must load the current pairing from the config snapshot');

const i18n = require('../frontend/shared/i18n');
for (const lang of i18n.LANGS) {
  assert(i18n.DICT[lang]['panel.duoProvider'], `panel.duoProvider missing in ${lang}`);
}
assert(i18n.DICT.zh['panel.duo'] === '双宠 · 自由搭配', 'zh duo label must drop the hardcoded Claude + Codex text');
assert(i18n.DICT.en['panel.duo'] === 'Duo · Free Pairing', 'en duo label must drop the hardcoded pairing');
assert(i18n.DICT.ja['panel.duo'] === 'デュオ · 自由組み合わせ', 'ja duo label must drop the hardcoded pairing');

console.log('tauri-duo-provider-r58-smoke: ok (duo_provider free pairing + wander owner derivation + no-claude-fallback)');
