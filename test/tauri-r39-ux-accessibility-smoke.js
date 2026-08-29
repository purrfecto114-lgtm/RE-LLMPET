#!/usr/bin/env node
'use strict';

// R39 (2026-08-01) — 0.5.18 UX & accessibility smoke.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const petCss = read('frontend/renderer/pet.css');
const panelCss = read('frontend/renderer/panel.css');
const panelJs = read('frontend/renderer/panel.js');
const toast = read('frontend/shared/toast.js');
const tauriConf = read('src-tauri/tauri.conf.json');
const commands = read('src-tauri/src/commands.rs');

// R39-1: prefers-reduced-motion uses animation:none (not 0.001s)
assert(petCss.includes('animation: none !important'),
  'R39: pet.css reduced-motion must use animation:none');
assert(panelCss.includes('animation: none !important'),
  'R39: panel.css reduced-motion must use animation:none');
assert(!petCss.includes('animation-duration: 0.001s'),
  'R39: pet.css must NOT use 0.001s (was not truly disabled)');

// R39-2: Panel responsive — min-width 420 + single-column breakpoint
assert(tauriConf.includes('"minWidth": 420'),
  'R39: tauri.conf.json panel minWidth must be 420 (was 520)');
assert(commands.includes('const PANEL_MIN_WIDTH: f64 = 420.0;'),
  'R39: shared panel min width must be 420 logical pixels');
assert(panelCss.includes('@media (max-width: 699px)'),
  'R39: panel.css must have single-column breakpoint under 700px');
assert(panelCss.includes('columns: 1'),
  'R39: panel.css single-column must set columns:1');

// R39-3: Diagnostic loading view has hint text
assert(panelJs.includes('diag-hint'),
  'R39: diagnostic loading view must have hint text explaining the ✕ button');

// R39-4: Persistent error center — toast supports persistent mode
assert(toast.includes('persistent'),
  'R39: toast.js must support persistent option');
assert(toast.includes('criticalCommands'),
  'R39: toast.js must have criticalCommands list for persistent errors');
assert(toast.includes("timeout: persistent ? 0"),
  'R39: persistent errors must have timeout=0 (no auto-dismiss)');
assert(toast.includes('closeBtn'),
  'R39: persistent errors must have a close button');

console.log('tauri-r39-ux-accessibility-smoke: ok (4 fixes: R39-1 animation:none, R39-2 panel responsive 420px, R39-3 diag hint text, R39-4 persistent error center)');
