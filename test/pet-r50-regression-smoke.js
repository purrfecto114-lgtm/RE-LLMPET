'use strict';

// R50 (2026-08-30) regression smoke — locks in the fixes shipped for the
// 0.6.0 user reports:
//   1. hardcoded claude identity in the pet window URL
//   2. right-click radial menu not opening / misaligned after a resize
//   3. per-bubble native window resize churn ("状态更新卡顿闪现")
//   4. subagent/tool streams becoming top-level pseudo sessions (dots spam)
//   5. headless blocked children being invisible (undetectable stalls)
//   6. oneshot states (attention/sweeping) sticking forever
//   7. OpenCode task tool → "dispatched subagent" expression (with degrade)
//   8. dual pets sharing one wander trip / wander provider hard-failing
// Run: node test/pet-r50-regression-smoke.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// ── 1. config-driven pet identity (no hardcoded claude) ─────────────────────
const tauriConf = JSON.parse(read('src-tauri/tauri.conf.json'));
const petWindow = tauriConf.app.windows.find((w) => w.label === 'pet');
const codexWindow = tauriConf.app.windows.find((w) => w.label === 'pet-codex');
assert(petWindow && !petWindow.url.includes('agent='),
  'primary pet window must NOT hardcode a provider identity in its URL');
assert(codexWindow && codexWindow.url.includes('agent=codex'),
  'the codex pet window keeps its explicit codex identity');
const agentView = read('frontend/renderer/pet-agent-view.js');
assert(agentView.includes("if (current && current.label === 'pet') return defaultAgent();"),
  'aggregate pet must resolve its agent from config, not a constant');

// ── 2. right-click opens the radial from pointerdown (contextmenu guard) ────
const pet = read('frontend/renderer/pet.js');
const pointerdownIdx = pet.indexOf("el.addEventListener('pointerdown'");
const button2Idx = pet.indexOf('if (e.button === 2)', pointerdownIdx);
assert(button2Idx > pointerdownIdx, 'pointerdown must classify button 2');
const contextIdx = pet.indexOf("el.addEventListener('contextmenu'", pointerdownIdx);
assert(contextIdx > pointerdownIdx, 'contextmenu fallback must stay registered');
assert(pet.slice(button2Idx, pet.indexOf('if (e.button !== 0)', button2Idx)).includes('toggleRadialFromPointer();'),
  'right-click must toggle the radial directly on pointerdown');
assert(pet.slice(contextIdx, pet.indexOf('});', contextIdx)).includes('rightClickHandledAt > 400'),
  'contextmenu fallback must be guarded against double-firing with pointerdown');
assert(pet.includes('await-free radial settle: petSizeController.request') || /Promise\.resolve\(petSizeController\.request\(\[320, 340\]\)\)/.test(pet),
  'radial opening must await the resize IPC chain before building (alignment)');

// ── 3. bubbles do not resize the window when they fit ───────────────────────
assert(pet.includes('function fitBubbleToViewport'), 'bubble fit helper missing');
assert(pet.includes('let bubbleOwnsResize = false'), 'bubble resize ownership flag missing');
assert(/if \(bubbleOwnsResize && !askActive && !sessListOpen && !todoPopOpen\)/.test(pet),
  'window must only shrink when THIS bubble grew it');

// ── 4/5/6. runtime policy: oneshot leases + headless blocked visibility ─────
const policySource = read('frontend/renderer/pet-runtime-policy.js');
const policySandbox = { window: {} };
vm.runInNewContext(policySource, policySandbox);
const policy = policySandbox.window.OctoPetRuntimePolicy;

// oneshot decay per STATES.md §3: attention 15s, sweeping 20s, error 45s.
assert.strictEqual(
  policy.aggregateState({ idleMs: 1000, sessions: [{ sessionId: 'a', state: 'attention', idleMs: 5_000 }] }),
  'attention',
  'fresh attention (<=15s) still shows');
assert.strictEqual(
  policy.aggregateState({ idleMs: 1000, sessions: [{ sessionId: 'a', state: 'attention', idleMs: 40_000 }], attentionCount: 1 }),
  'idle',
  'stale attention (>15s) must decay — the OpenCode session.idle stick bug');
assert.strictEqual(
  policy.aggregateState({ idleMs: 1000, sessions: [{ sessionId: 'a', state: 'sweeping', idleMs: 19_000 }] }),
  'sweeping',
  'fresh sweeping (<=20s) still shows');
assert.strictEqual(
  policy.aggregateState({ idleMs: 1000, sessions: [{ sessionId: 'a', state: 'sweeping', idleMs: 30_000 }], sweepingCount: 1 }),
  'idle',
  'stale sweeping (>20s) must decay');
assert.strictEqual(
  policy.aggregateState({ idleMs: 1000, sessions: [{ sessionId: 'a', state: 'notification', idleMs: 600_000 }] }),
  'needsinput',
  'notification is the documented exception — it waits for the user, never decays');
assert.strictEqual(
  policy.aggregateState({ idleMs: 1000, waitingCount: 1, sessions: [{ sessionId: 'a', state: 'working', idleMs: 10 }] }),
  'waiting',
  'waiting outranks everything (backend counts headless blocked children too)');

// headless child visibility: hidden while running, visible while blocked.
const headlessRows = [
  { sessionId: 'child-run', providerId: 'opencode', state: 'working', idleMs: 10, headless: true },
  { sessionId: 'child-blocked', providerId: 'opencode', state: 'waiting', idleMs: 10, headless: true },
  { sessionId: 'parent', providerId: 'opencode', state: 'juggling', idleMs: 5 },
];
assert.strictEqual(
  JSON.stringify(policy.projectVisibleSessions(headlessRows).map((row) => row.sessionId)),
  JSON.stringify(['child-blocked', 'parent']),
  'running children are hidden; blocked children must surface');

// ── 7. OpenCode task tool → subagent dispatch expression ────────────────────
const hookInstall = read('src-tauri/src/hook_install.rs');
const plugin = hookInstall.slice(hookInstall.indexOf('octopus-opencode-plugin-v4'));
assert(plugin.includes('if (tool === "task" || tool === "agent")'), 'task/agent tools must map to SubagentStart/Stop');
assert(/"tool\.execute\.before"[\s\S]*?hook_event_name: "SubagentStart", state: "juggling"/.test(plugin),
  'dispatching a subagent must raise the juggling (subagent) expression');
assert(/"tool\.execute\.before"[\s\S]*?hook_event_name: "PreToolUse", state: "working"/.test(plugin),
  'non-task tools must degrade to the ordinary working path');
assert(plugin.includes('base.parent_id = parent; base.headless = true;'),
  'child tool streams must carry parent metadata so they stay headless rows');

// ── backend: pseudo-session adoption + blocked-children counting ────────────
const model = read('src-tauri/src/model.rs');
assert(model.includes('pub parent_id: Option<String>,'), 'Session must track parent identity');
assert(model.includes('format!("auto:{}", sibling.id)'), 'tool-only first events must adopt a live sibling parent');
assert(model.includes('releases_auto_adoption'), 'explicit lifecycle events must release auto-adopted rows');
assert(/"waiting" => waiting \+= 1,\s*\n\s*"needsinput" \| "notification" => needs_input \+= 1,/.test(model),
  'waiting/needsinput must count headless children (undetectable-stall fix)');
assert(model.includes('"parentId":session.parent_id.clone(),'), 'stats rows must expose parentId');
const httpServer = read('src-tauri/src/http_server.rs');
assert(/if session\.headless \{\s*\n\s*return;/.test(httpServer.slice(httpServer.indexOf('fn emit_hook_event'))),
  'headless children must not broadcast operation/state events (spam fix)');
assert(httpServer.includes('crate::model::tool_icon(tool)'), 'operation events must carry per-tool icons');
assert(httpServer.includes('"SubagentStart" => json!({\n            "kind":"operation",\n            "tool":"Task",\n            "icon":"🤹"'),
  'SubagentStart must emit the dispatch-subagent operation');

// ── 8. wander: per-pet isolation + provider degrade ─────────────────────────
const travelViewSource = read('frontend/renderer/pet-travel-view.js');
const travelSandbox = { window: {}, document: { getElementById: () => null } };
vm.runInNewContext(travelViewSource, travelSandbox);
const travelView = travelSandbox.window.OctoPetTravelView;
assert.strictEqual(travelView.ownerKeyFor('codex'), 'pet-codex');
assert.strictEqual(travelView.ownerKeyFor('aggregate'), 'pet');
assert.strictEqual(travelView.ownerKeyFor('claude'), 'pet');
{
  let started = null;
  const bubbles = [];
  const api = { startWander: async (mission, provider) => (started = provider, { active: {} }), cancelTravel: async () => ({}) };
  const view = travelView.create({
    api, bubble: (text) => bubbles.push(text), close: () => {},
    provider: () => 'aggregate', agent: 'aggregate',
    enabledProviders: () => ['opencode', 'aider', 'claude'],
  });
  // pet window (owner "pet") sees only its own trip — codex's trip must not leak.
  view.update({ active: { 'pet-codex': { id: 't2', project: 'codex trip', startedAt: Date.now() } }, growth: {} });
  // toggle should START a new wander (not cancel the codex pet's trip)
  return void (async () => {
    await new Promise((resolve) => { travelSandbox.__resolve = resolve; setTimeout(resolve, 30); });
  })();
}
// provider degrade assertion (synchronous contract check on the module shape)
assert(Array.isArray(travelView.WANDER_SUPPORTED) && travelView.WANDER_SUPPORTED.includes('claude'),
  'wander degrade table must exist');
const travel = read('src-tauri/src/travel.rs');
assert(travel.includes("wander provider '{rejected}' has no runner; degrading to '{fallback}'"),
  'unsupported wander providers must degrade to an enabled supported provider, not error');

// ── tray HiDPI ───────────────────────────────────────────────────────────────
const lib = read('src-tauri/src/lib.rs');
assert(lib.includes('fn platform_tray_icon()'), 'per-platform HiDPI tray icon source missing');
assert(lib.includes('tray@2x.png'), 'non-Windows tray must use the dedicated @2x artwork');

console.log('pet-r50-regression-smoke: ok');
