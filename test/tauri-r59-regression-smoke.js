'use strict';

// R59 (2026-10-03) regression smoke — locks in the three user-reported fixes:
//   1. glib VariantStrIter unsoundness (RUSTSEC-2024-0429): ecosystem-locked
//      via tao/muda gtk 0.18 — documented audit ignore + advisory note
//      (.cargo/audit.toml), NOT silently dropped.
//   2. 双宠副宠物被吞 (regression): commit_win_pos slot decided by window
//      LABEL (not the "codex" agent literal); second-pet URL query sync moved
//      into the renderer (pet-agent-view.syncDuoQuery) to kill the startup
//      eval race that dropped navigations.
//   3. 闲逛还是不可用 (hardcode): opencode + aider runners added (any
//      provider), frontend gate removed (backend authority + PATH fallback
//      dirs), owner routing config-driven, trilingual missions/postcards.
//   4. 自定义桌宠表情: expression studio (new settings window) with the
//      backend command surface, capability wiring, renderer override layer.
// Run: node test/tauri-r59-regression-smoke.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// ── 1. RUSTSEC-2024-0429 (glib VariantStrIter) ──────────────────────────────
const auditToml = read('src-tauri/.cargo/audit.toml');
assert(auditToml.includes('RUSTSEC-2024-0429'),
  'the glib unsoundness advisory must be ignored EXPLICITLY (with rationale), not dropped');
assert(auditToml.includes('tao'),
  'the ignore must document the ecosystem lock (tao/muda pin gtk 0.18 → glib 0.18)');
const lock = read('src-tauri/Cargo.lock');
const glibVersion = lock.match(/name = "glib"\nversion = "([^"]+)"/)[1];
assert(glibVersion.startsWith('0.18.'),
  `glib stays on the ecosystem-locked 0.18 line (found ${glibVersion}; a jump to >=0.20 means the ignore must be removed)`);

// ── 2. duo slot regression ─────────────────────────────────────────────────
const commands = read('src-tauri/src/commands.rs');
assert(commands.includes('if label == "pet-codex" {'),
  'commit_win_pos must write the position slot by window label');
assert(!commands.includes('agent.as_deref() == Some("codex")'),
  'the literal codex agent comparison must be gone from commit_win_pos');
assert(!commands.includes('fn sync_duo_provider_url('),
  'the startup eval-based URL sync (race source) must be gone');
const agentView = read('frontend/renderer/pet-agent-view.js');
assert(agentView.includes('function syncDuoQuery(cfg)'),
  'the second-pet URL query self-alignment lives in the identity owner module');
assert(agentView.includes("current !== desired"),
  'the query sync must no-op when already aligned (no reload loop)');
const petJs = read('frontend/renderer/pet.js');
assert(petJs.includes('petAgentView.syncDuoQuery(cfg);'),
  'applyConfigSnapshot must run the query sync');

// ── 3. wander for every provider ───────────────────────────────────────────
const travel = read('src-tauri/src/travel.rs');
assert(travel.includes('pub const WANDER_SUPPORTED_PROVIDERS: [&str; 5]'),
  'single-source wander capability set must be a 5-provider const');
for (const provider of ['claude', 'codex', 'codewhale', 'opencode', 'aider']) {
  assert(travel.includes(`"${provider}"`), `wander runner set must include ${provider}`);
}
// opencode runner: `opencode run <prompt>` (argv).
const opencodeArm = travel.slice(
  travel.indexOf('"opencode" => {'),
  travel.indexOf('"aider" => {', travel.indexOf('"opencode" => {')),
);
assert(opencodeArm.includes('"run".to_string()') && opencodeArm.includes('PromptDelivery::Argv'),
  'opencode wander must use the headless `run` subcommand with argv prompt');
// aider runner: --message one-shot, exits, no git needed at cwd=home.
const aiderArm = travel.slice(
  travel.indexOf('"aider" => {'),
  travel.indexOf('// codex (and any future runner)', travel.indexOf('"aider" => {')),
);
for (const flag of ['--yes-always', '--no-git', '--no-auto-lint', '--no-stream', '--message']) {
  assert(aiderArm.includes(`"${flag}"`), `aider wander args must include ${flag}`);
}
assert(aiderArm.includes('PromptDelivery::Argv'),
  'aider prompt rides argv (lands directly after --message)');
// Backend authority: find_executable layers PATH → commands::which → fallback dirs.
assert(travel.includes('crate::commands::which(provider)'),
  'find_executable must reuse the launcher resolver (one discovery policy)');
assert(travel.includes('fn fallback_cli_dirs()'),
  'GUI-launch fallback directories must be scanned');
assert(travel.includes('/opt/homebrew/bin'),
  'homebrew (Apple Silicon) must be covered for Finder-launched pets');
// Config-driven owner routing for legacy callers.
assert(/fn owner_for_provider\(provider: &str, duo_provider: &str\)/.test(travel),
  'owner_for_provider must take the configured pairing');
// Trilingual wander surface.
assert(travel.includes('fn travel_started_text(lang: &str, mode: &str)'),
  'travel started event text must be trilingual');
assert(travel.includes('fn build_prompt(trip: &ActiveTrip, lang: &str)'),
  'the postcard prompt must follow config.lang');
for (const provider of ['opencode', 'aider']) {
  assert(travel.includes(`"${provider}"`), 'provider names must cover the new runners');
}
// Frontend: gate removed, backend decides, mission=null restores variety.
const travelView = read('frontend/renderer/pet-travel-view.js');
assert(!travelView.includes('no wander-capable provider enabled'),
  'the frontend gate that hard-failed opencode/aider-only users must be gone');
assert(travelView.includes('api.startWander(null, target)'),
  'wander must let the backend pick the mission AND the provider');
assert(travelView.includes('supportedList().includes(target)'),
  'the pet provider is forwarded only when it has a runner');
// Single source travels with the config snapshot.
const model = read('src-tauri/src/model.rs');
assert(model.includes('"wanderSupported".into()'),
  'config_view must expose wanderSupported (single source for the frontend)');
assert(model.includes('crate::travel::WANDER_SUPPORTED_PROVIDERS'),
  'the injected set must come from travel.rs, not a second hand copy');
assert(petJs.includes('if (Array.isArray(cfg.wanderSupported)) wanderSupportedList = cfg.wanderSupported;'),
  'pet.js must consume the backend wanderSupported snapshot');
assert(petJs.includes('wanderCapable.includes(s.providerId || s.provider)'),
  'the 🧳 session button must use the backend-capable set');

// ── 4. expression studio ───────────────────────────────────────────────────
const expr = read('src-tauri/src/custom_expressions.rs');
assert(expr.includes('pub(crate) const EXPRESSION_STATES: [&str; 27]'),
  'the Rust state whitelist must exist');
// Cross-check against the renderer vocabulary (single source of truth).
const states = require(path.join(root, 'frontend/shared/states.js'));
assert.deepStrictEqual(
  expr.match(/EXPRESSION_STATES: \[&str; 27\] = \[([\s\S]*?)\];/)[1]
    .split(',').map((word) => word.trim().replace(/"/g, '')).filter(Boolean),
  states.RENDER_STATE_WORDS,
  'the Rust EXPRESSION_STATES mirror must equal states.js RENDER_STATE_WORDS',
);
assert(expr.includes('fn base64_encode') && expr.includes('fn base64_decode'),
  'the no-new-dependency base64 helpers must exist');
assert(expr.includes('fn bytes_match_ext'),
  'magic-byte sniffing must validate the claimed image type');
assert(expr.includes('MAX_ASSET_BYTES'),
  'the override payload must be size-bounded');
assert(expr.includes('fs::rename(&temp, &target)'),
  'overrides must be written atomically (temp + rename)');
assert(expr.includes('emit("expressions:changed"'),
  'override changes must broadcast to the pet + studio windows');
// Registration surface: lib.rs + build.rs + capabilities + conf.
const lib = read('src-tauri/src/lib.rs');
for (const command of [
  'get_custom_expressions', 'save_custom_expression', 'clear_custom_expression',
  'set_custom_expressions_enabled', 'read_custom_expression',
  'open_expressions', 'close_expressions',
]) {
  assert(lib.includes(command + ','),
    `lib.rs invoke_handler must register ${command}`);
  assert(read('src-tauri/build.rs').includes(`"${command}"`),
    `build.rs COMMANDS must register ${command}`);
}
const buildRs = read('src-tauri/build.rs');
assert(buildRs.includes('"get_custom_expressions"'), 'build.rs must list the expression commands');
const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
const studioWindow = conf.app.windows.find((window) => window.label === 'expression-studio');
assert(studioWindow && studioWindow.url === 'renderer/expressions.html' && studioWindow.visible === false,
  'the studio window must be declared hidden at startup (panel lifecycle)');
assert(conf.app.security.capabilities.includes('expression-studio'),
  'the studio capability must be referenced');
const studioCap = JSON.parse(read('src-tauri/capabilities/expression-studio.json'));
assert.deepStrictEqual(studioCap.windows, ['expression-studio']);
for (const permission of [
  'allow-get-custom-expressions', 'allow-save-custom-expression',
  'allow-clear-custom-expression', 'allow-set-custom-expressions-enabled',
  'allow-read-custom-expression', 'allow-close-expressions',
]) {
  assert(studioCap.permissions.includes(permission),
    `studio capability must allow ${permission}`);
}
const petCap = JSON.parse(read('src-tauri/capabilities/pet.json'));
assert(petCap.permissions.includes('allow-get-custom-expressions')
  && petCap.permissions.includes('allow-read-custom-expression'),
  'the pet window must be able to read the override table');
// Window lifecycle parity with the panel (native close = hide).
assert(lib.includes('window.label() == "expression-studio"'),
  'native studio close must prevent_close + hide (panel parity)');
assert(lib.includes('"expression-studio"]'), 'the DWM corner list must include the studio');
// Config field.
assert(model.includes('pub custom_expressions: Option<bool>'),
  'AppConfig must carry the customExpressions enable flag');
// Frontend: bridge + override layer + page + entry points.
const bridge = read('frontend/renderer/tauri-bridge.js');
for (const method of [
  'getCustomExpressions', 'saveCustomExpression', 'clearCustomExpression',
  'setCustomExpressionsEnabled', 'readCustomExpression',
  'openExpressions', 'closeExpressions', 'onExpressionsChanged',
]) {
  assert(bridge.includes(method + ':'), `tauri-bridge must expose ${method}`);
}
assert(fs.existsSync(path.join(root, 'frontend/renderer/expressions.html')),
  'the studio page must exist');
assert(fs.existsSync(path.join(root, 'frontend/renderer/expressions.js')),
  'the studio controller must exist');
assert(fs.existsSync(path.join(root, 'frontend/renderer/pet-expressions.js')),
  'the pet-side override layer must exist');
// R60: the swap chain moved to the focused frame-table owner module.
const frameTable = read('frontend/renderer/pet-frame-table.js');
assert(frameTable.includes('function expressionAwareSwap'),
  'asset swaps must be override-aware (incl. the 60s pose-rotation timer)');
assert(read('frontend/renderer/pet.html').includes('pet-frame-table.js'),
  'pet.html must load the frame-table owner');
assert(petJs.includes('petExpressions.configure('),
  'the pet must subscribe to the override table');
assert(read('frontend/renderer/pet.html').includes('pet-expressions.js'),
  'pet.html must load the override layer');
assert(read('frontend/renderer/pet-radial-menu.js').includes("key: 'menu.expressions'"),
  'the radial menu must expose the studio');
// i18n parity (spot keys; the i18n.js test owns full parity).
const i18n = read('frontend/shared/i18n.js');
for (const key of ['expr.title', 'expr.enable', 'expr.state.idle', 'expr.state.lookout', 'menu.expressions']) {
  assert((i18n.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || []).length === 3,
    `i18n key ${key} must exist in zh/en/ja`);
}

console.log('tauri-r59-regression-smoke: ok (glib advisory ignore + duo slot label fix + wander any-provider + expression studio)');
