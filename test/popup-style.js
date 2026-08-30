'use strict';

// Popup surface style/regression guard — Tauri port (2026-08-29).
//
// History: the original Electron test asserted needs-input popup styling plus
// a long tail of main-process (main.js/app/*.js/preload.js) geometry and DSH
// wiring. Those processes were deleted with the Electron exit; their Tauri
// equivalents are Rust-side and locked by test/tauri-drag-terminal-phase3-smoke.js
// (place_pet_anchor / work-area clamping / latest-value resize coalescing) and
// test/pet-runtime-startup-smoke.js (session lifecycle). This file now guards
// the renderer popup contract only: needs-input card structure, scroll
// containment, and skin animations that must stay on inner artwork layers.
// CSS/JS assertions updated to the CURRENT frontend/renderer sources (R50).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'renderer', 'pet.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'renderer', 'pet.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'renderer', 'pet.html'), 'utf8');

// ── Needs Input surface ──────────────────────────────────────────────────────
// The dark card (rgba(26,26,29,...)) is the current needs-input skin. R50: the
// old test demanded an inset-only shadow because Electron transparent windows
// clipped outer shadows at the window bounds (issue #7). The Tauri pet window
// sizes the window to the popup (fitPopup), so the current design intentionally
// uses an outer depth shadow; keep only "an explicit depth treatment exists".
const askRules = [...css.matchAll(/(?:^|\n)\.ask\s*\{([^}]*)\}/g)];
assert(askRules.length > 0, 'missing .ask surface rule');
const surfaceRule = askRules.map((m) => m[1]).find((rule) => /background\s*:\s*rgba\(26, 26, 29/.test(rule));
assert(surfaceRule, 'the dark needs-input surface rule must exist');
const shadow = surfaceRule && /box-shadow\s*:\s*([^;]+);/.exec(surfaceRule);
assert(shadow, 'the .ask surface must define its depth treatment explicitly');
assert(/position\s*:\s*absolute\s*;/.test(surfaceRule), 'the needs-input card must be pinned inside the pet window');
assert(/overflow-y\s*:\s*auto\s*;/.test(surfaceRule), 'the popup shell must be able to scroll oversized content');
assert(/max-height\s*:\s*calc\(100vh - 30px\)/.test(surfaceRule), 'popup must never outgrow the window viewport');

// Only the middle content region scrolls; header and footer stay fixed.
assert(/\.ask-scroll\s*\{[^}]*min-height\s*:\s*0\s*;[^}]*overflow-y\s*:\s*auto\s*;/s.test(css),
  'only the middle content region should scroll');
assert(/\.ask-scroll::-webkit-scrollbar\s*\{[^}]*width\s*:\s*7px\s*;/s.test(css),
  'the content scrollbar must stay compact (7px)');
assert(/\.ask-sess\s*\{[^}]*text-overflow\s*:\s*ellipsis\s*;[^}]*white-space\s*:\s*nowrap\s*;/s.test(css),
  'fixed session header must stay on one compact line');
assert(/\.ask-q,\s*\.ask-ol,\s*\.ask-od\s*\{[^}]*overflow-wrap\s*:\s*anywhere\s*;/s.test(css),
  'long question and option text must wrap inside the card');
assert(/\.ask-toolbar\s*\{[^}]*display\s*:\s*flex\s*;[^}]*flex\s*:\s*0 0 auto\s*;/s.test(css),
  'all footer actions should share one fixed compact row');
assert(/class="ask-scroll"[^>]*>[\s\S]*class="ask-card"[\s\S]*class="ask-toolbar"/s.test(html),
  'fixed header and toolbar must sit outside the scrolling content');
assert(/id="ask-back"[\s\S]*id="ask-submit"[\s\S]*id="ask-term"/s.test(html),
  'footer actions should use back, submit, terminal order');

// Popup shells (sessions / needs-input / todo) clip to the window viewport
// instead of spilling across the desktop.
assert(/\.sesslist,\s*\.ask,\s*\.todopop\s*\{[^}]*max-height\s*:\s*calc\(100vh - 210px\)/s.test(css),
  'popup shells must clip to the viewport instead of spilling across the desktop');

// ── Window sizing contract ───────────────────────────────────────────────────
assert(/const POPUP_W = 520;/.test(js), 'popup window should provide more horizontal room');
assert(/const ASK_VIEWPORT_MAX_H = 520;/.test(js), 'ask measurement must use the same vertical cap');
assert(/const POPUP_BOTTOM = 200;/.test(js), 'popup must grow from the pet-anchored bottom band');
assert(/el\.style\.maxHeight = 'none';/.test(js),
  'fitPopup must release the viewport-derived max-height before measuring true content height');
assert(/Math\.min\(contentH, ASK_VIEWPORT_MAX_H\)/.test(js),
  'ask viewport height must be capped by ASK_VIEWPORT_MAX_H');
assert(/POPUP_BOTTOM \+ viewportH \+ 24/.test(js),
  'popup window height must derive from the measured content plus the anchor band');
assert(/window\.innerWidth[^\n]*POPUP_W/.test(js),
  'fitPopup must resize to the active surface width before measuring content height');

// ── Skin animations stay on inner artwork ────────────────────────────────────
assert(/#mascot\.idle #mascot-img\s*\{[^}]*animation\s*:\s*bob/s.test(css),
  'mascot idle motion must animate the artwork inside a stationary hit/anchor box');
assert(/#mascot\.act-work #mascot-img/.test(css),
  'mascot work motion must also keep the outer geometry stationary');
assert(!/#(?:mascot|pixel|cat)(?:\.[\w-]+)+\s*\{[^}]*animation\s*:/s.test(css),
  'skin state animations must not move the outer geometry used for popup anchoring and hit testing');
assert(/#pixel\.waiting \.pixel-sprite\s*\{[^}]*animation\s*:\s*attn/s.test(css)
  && /#pixel\.error \.pixel-sprite\s*\{[^}]*animation\s*:\s*errPersist\s*2\.4s/s.test(css),
  'pixel attention/error motion must animate only its inner artwork (R50: errShake → errPersist 2.4s)');

// ── Session dot anchor ───────────────────────────────────────────────────────
// R50: the per-skin .sessions width overrides and justify-content:center are
// gone; the dot row is centred by the #stage column (align-items: center) and
// stays a flex row so dots never wrap around the pet.
assert(/#stage\s*\{[^}]*flex-direction\s*:\s*column\s*;[^}]*align-items\s*:\s*center\s*;/s.test(css),
  'the stage column must keep HUD surfaces centred over the pet anchor');
assert(/\.sessions\s*\{[^}]*display\s*:\s*flex\s*;/s.test(css),
  'session dots must stay on one anchored row');

console.log('popup style checks passed');
