#!/usr/bin/env node
'use strict';

// R32 (2026-07-31) — Bridge error visibility + permission await + empty provider.
//
// Background: the R30-recheck roadmap identified 4 P0 regressions where the
// code said one thing in comments but did another at runtime:
//   1. pet.js cat lazy preload referenced undefined `config.skin` (ReferenceError)
//   2. panel.js still locked the last provider checkbox despite the comment
//      saying "users can now uncheck all"
//   3. tauri-bridge.js claimed "state-changing ops MUST use call() + await"
//      but setProviders / decidePermission / etc. still used send()
//   4. pet.js removed the choice card on click BEFORE the IPC resolved,
//      so an IPC failure left the user thinking they answered
//
// This smoke locks the fixes:
//   - pet.js: maybePreloadCatAssets uses `skin` (not `config.skin`)
//   - panel.js: no `newActive.length === 0` revert branch
//   - panel.js: setProviders callers await + revert on failure
//   - tauri-bridge.js: setProviders / decidePermission / decideCwPermission
//     / decideCwPermissionBatch / setSessionPrefs use call() not send()
//   - pet.js: submitDecision wrapper exists + all submit sites use it
//   - shared/toast.js + #re-llmpet-toast element exist in both windows
//   - bridge send() still emits octopus:bridge-error (R30 contract preserved)

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const petJs = read('frontend/renderer/pet.js');
const panelJs = read('frontend/renderer/panel.js');
const bridge = read('frontend/renderer/tauri-bridge.js');
const toastJs = read('frontend/shared/toast.js');
const panelHtml = read('frontend/renderer/panel.html');
const petHtml = read('frontend/renderer/pet.html');
const panelCss = read('frontend/renderer/panel.css');
const petCss = read('frontend/renderer/pet.css');

// ── P0-1: pet.js cat lazy preload uses `skin`, not `config.skin` ──────────
assert(petJs.includes("if (skin === 'cat' && catAssetCache.size === 0)"),
  'pet.js maybePreloadCatAssets must reference `skin` (not `config.skin`)');
assert(!petJs.includes('config.skin === \'cat\''),
  'pet.js must NOT reference the undefined `config.skin`');

// ── P0-2: panel.js allows empty provider selection ───────────────────────
// The old revert branch `if (newActive.length === 0) { e.target.checked = true; return; }`
// must be GONE — only the comment documenting its removal may remain.
assert(!panelJs.match(/if\s*\(\s*newActive\.length\s*===\s*0\s*\)\s*\{[^}]*checked\s*=\s*true/),
  'panel.js must NOT revert checkbox when provider count drops to 0 (old guard branch)');
assert(panelJs.includes("window.pet.setProviders(newActive)"),
  'panel.js must call setProviders with newActive (which may be [])');
assert(panelJs.includes('.catch((err) =>'),
  'panel.js setProviders call must have a .catch handler for failure rollback');

// ── P0-3: tauri-bridge.js uses call() for state-changing commands ────────
assert(bridge.includes("setProviders: (ids) => call('set_providers'"),
  'tauri-bridge.js setProviders must use call() (awaitable)');
assert(bridge.includes("setSessionPrefs: (pinned, archived) => call('set_session_prefs'"),
  'tauri-bridge.js setSessionPrefs must use call() (awaitable)');
assert(bridge.includes("decidePermission: (permId, behavior) => call('decide_permission'"),
  'tauri-bridge.js decidePermission must use call() (security-critical)');
assert(bridge.includes("decideCwPermission: (permId, behavior) => call('decide_permission'"),
  'tauri-bridge.js decideCwPermission must use call()');
assert(bridge.includes("decideCwPermissionBatch: (permId, mode) => call('decide_permission_batch'"),
  'tauri-bridge.js decideCwPermissionBatch must use call()');
// Confirm we did NOT break the R30 bridge-error contract on send()
assert(bridge.includes("octopus:bridge-error"),
  'tauri-bridge.js send() must still dispatch octopus:bridge-error (R30 contract)');

// ── P0-4: pet.js submitDecision wrapper exists + all sites use it ────────
assert(petJs.includes('function submitDecision('),
  'pet.js must define submitDecision() wrapper');
assert(petJs.includes('routeDecision(choice, behavior)'),
  'pet.js submitDecision must call routeDecision (awaited)');
assert(petJs.includes('finishChoice(choice, successMsg)'),
  'pet.js submitDecision must call finishChoice ONLY on success');
assert(petJs.includes("'octopus:bridge-error'"),
  'pet.js must dispatch octopus:bridge-error on IPC failure');
// All submit sites must go through submitDecision (not direct decidePermission)
assert(petJs.includes("submitDecision(c, { type: 'elicitation-submit'"),
  'pet.js elicitation submit must use submitDecision');
assert(petJs.includes("submitDecision(c, { type: 'plan-feedback'"),
  'pet.js plan-feedback submit must use submitDecision');
assert(petJs.includes("submitDecision(choice, { __cw_batch:"),
  'pet.js CW batch submit must use submitDecision');
assert(petJs.includes("submitDecision(choice, key, msg)"),
  'pet.js submitPerm must use submitDecision');
// gotoSession: no double routeDecision call
assert(petJs.match(/gotoSession[\s\S]{0,800}?routeDecision\(choice, 'deny'\)[\s\S]{0,400}?finishChoice/) ||
       petJs.includes("gotoSession deny failed"),
  'pet.js gotoSession must await routeDecision before finishChoice');

// ── P0-5: shared toast infrastructure ─────────────────────────────────────
assert(fs.existsSync(path.join(root, 'frontend/shared/toast.js')),
  'frontend/shared/toast.js must exist');
assert(toastJs.includes("octopus:bridge-error"),
  'toast.js must listen for octopus:bridge-error');
assert(toastJs.includes("getElementById('re-llmpet-toast')"),
  'toast.js must look up #re-llmpet-toast element');
assert(toastJs.includes("role=\"alert\""),
  'toast.js documentation must reference role=alert for a11y');

// ── P0-6: HTML host elements exist in both windows ────────────────────────
assert(panelHtml.includes('id="re-llmpet-toast"'),
  'panel.html must have #re-llmpet-toast container');
assert(panelHtml.includes('../shared/toast.js'),
  'panel.html must include ../shared/toast.js');
assert(petHtml.includes('id="re-llmpet-toast"'),
  'pet.html must have #re-llmpet-toast container');
assert(petHtml.includes('../shared/toast.js'),
  'pet.html must include ../shared/toast.js');

// ── P0-7: CSS toast styles exist in both windows ──────────────────────────
assert(panelCss.includes('.re-llmpet-toast'),
  'panel.css must define .re-llmpet-toast styles');
assert(panelCss.includes('.re-llmpet-toast.show'),
  'panel.css must define .re-llmpet-toast.show (visible state)');
assert(petCss.includes('.re-llmpet-toast'),
  'pet.css must define .re-llmpet-toast styles');
assert(petCss.includes('.re-llmpet-toast.show'),
  'pet.css must define .re-llmpet-toast.show (visible state)');

// ── Negative: no leftover fire-and-forget for security-critical commands ─
// Allow send() for genuinely fire-and-forget ops, but NOT for these.
const forbiddenSendPatterns = [
  /send\(['"]set_providers['"]/,
  /send\(['"]decide_permission['"]/,
  /send\(['"]decide_permission_batch['"]/,
  /send\(['"]set_session_prefs['"]/,
];
for (const pat of forbiddenSendPatterns) {
  assert(!bridge.match(pat),
    `tauri-bridge.js must NOT use send() for ${pat} (use call() instead)`);
}

console.log('tauri-r32-bridge-error-visibility-smoke: ok (4 P0 fixes + toast UI + 7 contract checks)');
