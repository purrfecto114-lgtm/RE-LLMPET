'use strict';

// R60 rewrite locks (RV-G review): the module extraction initially lost
// three behaviors while every existing test stayed green (string-presence
// assertions pointed at pet.js; the moved code was invisible to them).
// This smoke locks the R60 extraction + review-fix batch so a future
// refactor cannot silently drop the same wiring again.
//   1. sm deps showBubble wiring (RV-B P0 — transient bubble text chain)
//   2. fx micro-motion boot calls (RV-A/RV-C — blink/peek)
//   3. PIXEL_MAP/buildPixel (RV-A P0 — pixel skin renders)
//   4. frame-table reapply fallback (P0-1 — studio delete/disable restores)
//   5. bridge cancelTravel owner (RV-I P1-1 — duo cancel isolation)
//   6. filterStats pendingChoices slicing (RV-I P1-2 — duo card split)
//   7. dead event arms stay dead (P2-1/P2-2 — longcmd/cancel)
//   8. travel terminal single-channel (P1-1)
//   9. single-mode sound gate (RV-I P2-3)
//  10. sesslist signature/scroll preservation (RV-B P1)
// Run: node test/tauri-r60-rewrite-smoke.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const pet = read('frontend/renderer/pet.js');
const router = read('frontend/renderer/pet-event-router.js');
const frameTable = read('frontend/renderer/pet-frame-table.js');
const agentView = read('frontend/renderer/pet-agent-view.js');
const bridge = read('frontend/renderer/tauri-bridge.js');

// ── 1. state-machine showBubble wiring (RV-B P0) ───────────────────────────
assert(pet.includes('showBubble: (text, holdMs) => bubbleApi.showBubble(text, holdMs)'),
  'the state machine must receive the bubble API — transient text (round-done/greet/say/territory/travel) was silently dead without it');

// ── 2. micro-motion boot calls (RV-A/RV-C P1) ─────────────────────────────
assert(pet.includes('fx.scheduleBlink();') && pet.includes('fx.scheduleIdleAction();'),
  'blink/peek chains must be started at assembly — defining them in pet-fx.js without boot calls is a silent no-op');

// ── 3. pixel skin sprite (RV-A P0) ────────────────────────────────────────
assert(pet.includes('const PIXEL_MAP') && pet.includes('buildPixel();'),
  'the pixel skin body is JS-injected SVG — dropping PIXEL_MAP/buildPixel renders an empty pet');

// ── 4. P0-1 reapply fallback (studio delete/disable) ──────────────────────
const reapplyBlock = frameTable.slice(frameTable.indexOf('function reapply()'), frameTable.indexOf('function applyForSkin'));
assert(reapplyBlock.includes('petExpressions.hasOverride(s)') && reapplyBlock.includes('updateMascot(s)'),
  'reapply() must fall back to the BASE asset when the state has no override — otherwise a studio delete freezes the deleted image');
assert(pet.includes("rerender: () => frames.reapply()"),
  'the expressions:changed hook must route through the frame-table owner');

// ── 5. cancelTravel carries the window owner (RV-I P1-1) ──────────────────
assert(/cancelTravel: \(\) => call\('cancel_travel', \{ owner: currentOwnerLabel\(\) \}\)/.test(bridge),
  'per-owner duo cancel requires the bridge to send the initiating window label — the backend contract alone is not end-to-end');

// ── 6. pendingChoices slicing in duo mode (RV-I P1-2) ─────────────────────
assert(agentView.includes('pendingChoices: (snapshot.pendingChoices || []).filter'),
  'filterStats must slice pendingChoices — unsliced spread rendered claude cards on BOTH pet windows');

// ── 7. dead arms stay dead ────────────────────────────────────────────────
assert(!router.includes("case 'longcmd'") && !/TABLE\['longcmd'\]|'longcmd'\(/.test(router),
  'longcmd has no backend producer (0.6.8 audit) — it must not come back');
assert(!/TABLE\['cancel'\]|'cancel'\s*\(\s*ev\s*\)\s*\{/.test(router) && !router.includes("case 'cancel'"),
  'the W12 cancel channel was never wired in the Tauri backend — queue reconciliation happens via refreshAsk');

// ── 8. travel terminal single-channel (P1-1) ─────────────────────────────
const travelArm = router.slice(router.indexOf('travel(ev)'), router.indexOf('territory(ev)'));
assert(travelArm.includes("ev.phase === 'started'") && !travelArm.includes('completed') && !travelArm.includes('failed') && !travelArm.includes('cancelled'),
  'the router travel arm must only render `started` — terminal phases render once via pet:travel (pet.js onTravel)');
assert(pet.includes("if (event.phase === 'completed')") && pet.includes("if (event.phase === 'cancelled')"),
  'the onTravel handler owns the terminal phases');

// ── 9. single-mode sound gate (RV-I P2-3) ─────────────────────────────────
assert(router.includes('const canPlaySound') && router.includes('if (canPlaySound())'),
  'event sounds must be gated — the hidden pet-codex webview processes broadcasts and used to double-beep in single mode');
assert(pet.includes("canPlaySound: () => petMode !== 'single' || PET_AGENT !== 'pet-codex'"),
  'the gate must be petMode-aware: single → primary only, duo → both windows for their own events');
assert(pet.includes("if (petMode !== 'single' || PET_AGENT !== 'pet-codex') fx.SOUND.bigDone()"),
  'the onTravel completion horn must use the same gate');

// ── 10. sesslist signature + scroll preservation (RV-B P1) ───────────────
assert(pet.includes('lastSessListSig') && pet.includes('prevScrollTop'),
  'the session list must skip rebuilds when content is unchanged and preserve scrollTop when it rebuilds');
assert(pet.includes('if (sessListOpen) { lastAskSig = \'\'; return; }'),
  'refreshAsk must not steal the panel while the session list is open (ping-pong fix)');

// ── assembly sanity: every new module is loaded before pet.js ─────────────
const html = read('frontend/renderer/pet.html');
const order = ['pet-frame-table.js', 'pet-fx.js', 'pet-state-machine.js', 'pet-bubble.js',
  'pet-aggregate.js', 'pet-event-router.js', 'pet-drag.js', 'pet.js'];
let last = -1;
for (const name of order) {
  const idx = html.indexOf(name);
  assert(idx > last, `${name} must load after the previous dependency (found at ${idx})`);
  last = idx;
}

console.log('tauri-r60-rewrite-smoke: ok (R60 extraction wiring + review-fix batch locked)');
