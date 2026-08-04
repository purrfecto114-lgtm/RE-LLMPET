#!/usr/bin/env node
'use strict';

// R35.2 (2026-07-31) — 0.5.13 correctness patch smoke.
//
// Locks the 5 fixes from the 0.5.12 carpet audit roadmap:
//
//   P0-1  provider chooser: in syncUiBusy + INTERACTIVE_HIT_SEL + status
//         from config (not stats) + await launch + mutual exclusion + focus
//   P0-2  set_providers: selected-vs-hook split (no Err after commit;
//         returns { selectedSaved, allHooksOk, hookResults, errors })
//   P0-3  panel: setPanelHeight call() + cache only on success + dedupe
//         onResized + fit immediately on panel:shown
//   P0-4  real diagnostic cancel: cancel_diagnostic command + process-tree
//         kill (taskkill /F /T on Windows, killpg on Unix) + DiagnosticControl
//   P0-5  release.yml: (already in R35.1; this smoke verifies the warning
//         text is still present)
//
// Background: the 0.5.12 carpet audit found a common pattern — "界面层已
// 经出现'完成'的外观，但后端状态、系统窗口状态或子进程生命周期没有
// 形成同一个事务". R35.2 closes these state-coherence gaps.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const petJs = read('frontend/renderer/pet.js');
const panelJs = read('frontend/renderer/panel.js');
const bridge = read('frontend/renderer/tauri-bridge.js');
const commands = read('src-tauri/src/commands.rs');
const model = read('src-tauri/src/model.rs');
const diagnosticControl = read('src-tauri/src/diagnostic_control.rs');
const lib = read('src-tauri/src/lib.rs');
const release = read('.github/workflows/release.yml');
const panelCap = read('src-tauri/capabilities/panel.json');
const build = read('src-tauri/build.rs');

// ──────────────────────────────────────────────────────────────────────────
// P0-1: provider chooser coherence
// ──────────────────────────────────────────────────────────────────────────

// chooser is in syncUiBusy
assert(petJs.includes('providerChooserOpen || isInteracting()'),
  'R35.2: syncUiBusy must include providerChooserOpen');
// chooser is in INTERACTIVE_HIT_SEL
assert(petJs.includes("'#pet-anchor,#radial,#notepad,#todopop,#ask,#sesslist,#provider-chooser'"),
  'R35.2: INTERACTIVE_HIT_SEL must include #provider-chooser');
// chooser reads status from latestProviderStatuses (config), not lastStats
assert(petJs.includes('let latestProviderStatuses = {}'),
  'R35.2: pet.js must declare latestProviderStatuses (sourced from config)');
assert(petJs.includes('latestProviderStatuses = cfg.providers.statuses'),
  'R35.2: onConfig must save cfg.providers.statuses into latestProviderStatuses');
assert(petJs.includes('const statuses = latestProviderStatuses || {};'),
  'R35.2: openProviderChooser must read from latestProviderStatuses (not lastStats)');
// launch is awaited (launchAgentChecked, not launchAgent send)
assert(petJs.includes('function launchProviderChecked'),
  'R35.2: pet.js must define launchProviderChecked (await launch)');
assert(petJs.includes('window.pet.launchAgentChecked(provider)'),
  'R35.2: launchProviderChecked must use launchAgentChecked (call, not send)');
// mutual exclusion: openProviderChooser closes other overlays
assert(/openProviderChooser[\s\S]{0,400}if \(radialOpen\) closeRadial/.test(petJs),
  'R35.2: openProviderChooser must close radial before opening');
assert(/openProviderChooser[\s\S]{0,400}if \(sessListOpen\) closeSessList/.test(petJs),
  'R35.2: openProviderChooser must close sessList before opening');
// focus management: first item gets focus
assert(petJs.includes('firstItem.focus()'),
  'R35.2: openProviderChooser must focus the first item for a11y');
// chooser launch: await before close, keep open on failure
assert(petJs.includes('btn.disabled = true;'),
  'R35.2: chooser item must disable during launch (loading state)');
assert(petJs.includes('Launching…'),
  'R35.2: chooser item must show "Launching…" during launch');
assert(/\.then\(\(\) => \{[\s\S]*?closeProviderChooser\(\)/.test(petJs),
  'R35.2: chooser must close ONLY on launch success');
assert(/\.catch\(\(err\) => \{[\s\S]*?btn\.disabled = false/.test(petJs),
  'R35.2: chooser must re-enable item on launch failure (keep open for retry)');

// ──────────────────────────────────────────────────────────────────────────
// P0-2: set_providers selected-vs-hook split
// ──────────────────────────────────────────────────────────────────────────

// set_providers no longer returns Err on partial hook failure
assert(commands.includes('"selectedSaved": true'),
  'R35.2: set_providers must return selectedSaved=true');
assert(commands.includes('"allHooksOk": all_hooks_ok'),
  'R35.2: set_providers must return allHooksOk flag');
assert(commands.includes('"hookResults": providers'),
  'R35.2: set_providers must return hookResults array');
assert(commands.includes('"retryable": retryable'),
  'R35.2: set_providers must include retryable flag per provider');
assert(!commands.includes('return Err(errors.join'),
  'R35.2: set_providers must NOT return Err on partial hook failure (was split-brain)');
// panel.js handles the new shape: keeps checkbox on hook failure, reverts only on rejection
assert(panelJs.includes('result.allHooksOk === false'),
  'R35.2: panel.js must check allHooksOk for partial hook failure');
assert(panelJs.includes('Revert checkbox to previous state') || panelJs.includes('genuine rejection'),
  'R35.2: panel.js must only revert checkbox on genuine rejection');

// ──────────────────────────────────────────────────────────────────────────
// P0-3: panel setPanelHeight coherence
// ──────────────────────────────────────────────────────────────────────────

// bridge uses call() not send()
assert(bridge.includes("setPanelHeight: (height) => call('set_panel_height'"),
  'R35.2: bridge setPanelHeight must use call() (not send)');
// panel.js caches only on IPC success
assert(panelJs.includes('OctoPanelFit.createPanelFitController'),
  'R35.2: panel.js must use the isolated fit controller');
assert(panelJs.includes('panelFitController.request(height)'),
  'R35.2: panel.js must route fit requests through the controller');
const fitController = fs.readFileSync(path.join(root, 'frontend', 'shared', 'panel-fit-controller.js'), 'utf8');
assert(fitController.includes('lastCommittedRequest = height'),
  'R35.2: fit cache must commit only in the IPC success path');
// duplicate onResized removed (only one add("onResized", ...) CODE call;
// comments mentioning it are OK). Strip comment lines before counting.
const panelJsCodeOnly = panelJs.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
const onResizedCount = (panelJsCodeOnly.match(/add\('onResized'/g) || []).length;
assert.strictEqual(onResizedCount, 1,
  'R35.2: panel.js must register onResized exactly once in code (was 2, causing double-callback)');
// resetAutoFitOnShow calls fitPanelHeight
assert(/resetAutoFitOnShow[\s\S]{0,800}fitPanelHeight\(\)/.test(panelJs),
  'R35.2: resetAutoFitOnShow must call fitPanelHeight after syncWindowMode');

// ──────────────────────────────────────────────────────────────────────────
// P0-4: real diagnostic cancel
// ──────────────────────────────────────────────────────────────────────────

// Diagnostic lifecycle is consolidated under one mutex-owned state machine.
assert(model.includes('pub diagnostic_control: crate::diagnostic_control::DiagnosticControl'),
  'Runtime must own one DiagnosticControl instead of independent PID/provider flags');
assert(diagnosticControl.includes('fn register_pid')
  && diagnosticControl.includes('fn request_cancel')
  && diagnosticControl.includes('fn claim_pid_for_termination')
  && diagnosticControl.includes('fn finish'),
  'DiagnosticControl must own register/cancel/terminate/finish transitions');
// cancel_diagnostic command exists
assert(commands.includes('pub async fn cancel_diagnostic'),
  'R35.2: commands.rs must define cancel_diagnostic async command');
assert(lib.includes('cancel_diagnostic,'),
  'R35.2: lib.rs must register cancel_diagnostic in invoke_handler');
// Windows kills the entire process tree; Unix uses an isolated process group.
assert(commands.includes('"taskkill"') && commands.includes('"/F", "/T", "/PID"'),
  'Windows diagnostics must use taskkill /F /T /PID');
assert(commands.includes('.process_group(0)')
  && commands.includes('signal_process_group(process_group, 15)')
  && commands.includes('signal_process_group(process_group, 9)'),
  'Unix diagnostics must terminate an isolated process group');
assert(commands.includes('let pid = child.id();')
  && commands.includes('control.register_pid(pid)')
  && commands.includes('control.clear_pid(pid)'),
  'each probe must register and generation-safely clear its child PID');
assert(commands.includes('control.is_cancel_requested()')
  && commands.includes('claim_pid_for_termination(pid)'),
  'probe polling must cooperate with cancellation without double-killing a PID');
assert(commands.includes('state.runtime.diagnostic_control.finish();'),
  'join failure must not leave diagnostics permanently busy');
// bridge has cancelDiagnostic
assert(bridge.includes("cancelDiagnostic: () => call('cancel_diagnostic')"),
  'R35.2: bridge must expose cancelDiagnostic');
// panel.js clearDiagnostic calls cancelDiagnostic when busy
assert(panelJs.includes('window.pet.cancelDiagnostic()'),
  'R35.2: panel.js clearDiagnostic must call cancelDiagnostic when a diagnostic is running');
assert(panelJs.includes('if (providerDiagnosticBusy && window.pet && window.pet.cancelDiagnostic)'),
  'R35.2: panel.js must guard cancelDiagnostic with providerDiagnosticBusy check');
// capability + permission
assert(panelCap.includes('allow-cancel-diagnostic'),
  'R35.2: panel capability must include allow-cancel-diagnostic');
assert(fs.existsSync(path.join(root, 'src-tauri/permissions/autogenerated/cancel_diagnostic.toml')),
  'R35.2: cancel_diagnostic permission TOML must exist');
assert(build.includes('"cancel_diagnostic"'),
  'R35.2: build.rs COMMANDS must include cancel_diagnostic');

// ──────────────────────────────────────────────────────────────────────────
// P0-5: release.yml signing semantics (carried from R35.1)
// ──────────────────────────────────────────────────────────────────────────

assert(release.includes('PLATFORM_SIGNED'),
  'R35.2: release.yml must compute PLATFORM_SIGNED');
assert(release.includes('REQUIRE_PLATFORM_SIGNING'),
  'R35.2: release.yml must honor REQUIRE_PLATFORM_SIGNING');
assert(!release.includes('TAURI_SIGNING_PRIVATE_KEY')
  && release.includes('uploadUpdaterJson: false')
  && release.includes('uploadUpdaterSignatures: false'),
  'release workflow must not confuse updater signatures with native publisher signing');
assert(release.includes('Authenticode publisher signature')
  && release.includes('Developer ID signature or notarization'),
  'release warnings must name the actual platform signing mechanisms');

console.log('tauri-r352-correctness-patch-smoke: ok (5 P0 patches locked: P0-1 chooser coherence, P0-2 set_providers selected-vs-hook split, P0-3 panel fit coherence, P0-4 real diagnostic cancel + process-tree kill, P0-5 release signing semantics)');
