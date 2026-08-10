#!/usr/bin/env node
'use strict';

// R35.1 (2026-07-31) — 0.5.11.1 correctness patch smoke.
//
// Locks the 6 fixes from the 0.5.11 deep-recheck roadmap:
//
//   P0-1  hit-test anchor-only (no animated skin in union) + single
//         pending radial intent (no recursive setTimeout)
//   P0-2  panel window-scoped listeners (getCurrentWindow().onResized)
//         + reset userSized/lastFitHeight on panel:shown
//   P0-3  diagnose_agent is now async + spawn_blocking (unblocks IPC)
//   P0-5  provider chooser modal + removal of「名称 +N」agent-tag;
//         primary_action emits choose-provider event instead of silent
//         first-item launch
//   P0-6  release.yml distinguishes Tauri updater key from platform
//         code-signing; REQUIRE_PLATFORM_SIGNING var for fail-closed
//
// Background: the 0.5.11 deep-recheck found that many R35 "fixes" were
// simulated by fixed timers, frontend result-dropping, or source-string
// gates rather than real OS/process/window state confirmation. R35.1
// closes the most actionable gaps without requiring real Windows
// machines or platform certs (those remain R36/R37).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const petJs = read('frontend/renderer/pet.js');
const petHtml = read('frontend/renderer/pet.html');
const petCss = read('frontend/renderer/pet.css');
const panelJs = read('frontend/renderer/panel.js');
const commands = read('src-tauri/src/commands.rs');
const release = read('.github/workflows/release.yml');

// ──────────────────────────────────────────────────────────────────────────
// P0-1: hit-test anchor-only + single pending radial intent
// ──────────────────────────────────────────────────────────────────────────

// INTERACTIVE_HIT_SEL no longer includes #pixel/#mascot/#cat (animated skins)
// R35.2 (2026-07-31): the selector now ALSO includes #provider-chooser
// (0.5.12 carpet audit P0-1 证据B). The R35.1 anchor-only assertion is
// preserved but the expected string is updated to include #provider-chooser.
// R22 (2026-08-10): added #re-llmpet-toast for dismissible error toasts.
assert(petJs.includes("'#pet-anchor,#radial,#notepad,#todopop,#ask,#sesslist,#provider-chooser,#re-llmpet-toast'"),
  'R22: INTERACTIVE_HIT_SEL must include #re-llmpet-toast');
assert(!petJs.includes("'#pet-anchor,#pixel,#mascot,#cat,#radial,"),
  'R35.1: the old union selector with animated skins must be gone');

// Single pending radial intent (boolean), not recursive setTimeout
assert(petJs.includes('let pendingRadialOpen = false'),
  'R35.1: pet.js must declare pendingRadialOpen as a single boolean');
assert(petJs.includes('pendingRadialOpen = true'),
  'R35.1: openRadial must set pendingRadialOpen=true when geometryBusy (not recurse)');
// The recursive `setTimeout(openRadial, 260)` CODE must be gone.
// (Comments mentioning it are OK — we strip lines starting with // or
// containing // before the test, so the assertion only sees real code.)
const petJsCodeOnly = petJs.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
assert(!/setTimeout\(\s*openRadial/.test(petJsCodeOnly),
  'R35.1: openRadial must NOT use recursive setTimeout(openRadial, ...) in code (was the queue bug)');
// The settle callback checks pendingRadialOpen and opens once
assert(petJs.includes('if (pendingRadialOpen)'),
  'R35.1: markGeometryBusy settle callback must check pendingRadialOpen');
// closeRadial, blur, and drag-start all clear the pending intent
assert(/function closeRadial\(\)\s*{[\s\S]*?pendingRadialOpen = false/.test(petJs),
  'R35.1: closeRadial must clear pendingRadialOpen');
assert(petJs.includes("window.addEventListener('blur', () => dismissTransientUi('dom-blur'))")
  && /function dismissTransientUi[\s\S]*?pendingRadialOpen = false/.test(petJs),
  'R35.1: blur handler must delegate to a dismiss function that clears pendingRadialOpen');
assert(/pointerdown[\s\S]*?pendingRadialOpen = false/.test(petJs),
  'R35.1: drag-start (pointerdown) must clear pendingRadialOpen');

// ──────────────────────────────────────────────────────────────────────────
// P0-2: panel window-scoped listeners + reset on panel:shown
// ──────────────────────────────────────────────────────────────────────────

// R38: the accessor was renamed from getCurrent() to getCurrentTauriWindow()
// (a shared helper in tauri-bridge.js) to fix the Tauri 2 API call.
assert(panelJs.includes("getCurrentTauriWindow()") && panelJs.includes("onResized"),
  'R35.1/R38: panel.js must use getCurrentTauriWindow().onResized (window-scoped)');
assert(panelJs.includes('onScaleChanged'),
  'R35.1: panel.js must subscribe to onScaleChanged for DPI monitor changes');
assert(panelJs.includes('onMoved'),
  'R35.1: panel.js must subscribe to onMoved for monitor moves');
// The old global-listener pattern must be gone
assert(!/ev\.listen\('tauri:\/\/resize'/.test(panelJs),
  'R35.1: panel.js must NOT use global event.listen("tauri://resize") (was cross-window leak)');
// Unlisteners are collected for teardown
assert(panelJs.includes('windowModeUnlisteners'),
  'R35.1: panel.js must collect window-mode unlisteners for teardown');
assert(panelJs.includes('teardownWindowModeListeners'),
  'R35.1: panel.js must define teardownWindowModeListeners');
// resetAutoFitOnShow resets userSized and the fit controller
assert(panelJs.includes('function resetAutoFitOnShow'),
  'R35.1: panel.js must define resetAutoFitOnShow');
assert(/resetAutoFitOnShow[\s\S]{0,300}userSized = false/.test(panelJs),
  'R35.1: resetAutoFitOnShow must reset userSized=false');
assert(/resetAutoFitOnShow[\s\S]{0,300}panelFitController\.reset\(\)/.test(panelJs),
  'R35.1: resetAutoFitOnShow must reset the fit controller');
// Rust open_panel emits panel:shown event
assert(commands.includes('app.emit("panel:shown", ())'),
  'R35.1: Rust open_panel must emit panel:shown event');
// Frontend subscribes to panel:shown
assert(panelJs.includes('window.pet.onPanelShown'),
  'R35.1: panel.js must subscribe to panel:shown through the bridge');

// ──────────────────────────────────────────────────────────────────────────
// P0-3: async diagnose_agent with spawn_blocking
// ──────────────────────────────────────────────────────────────────────────

// The public command is now async
// R35.2 (2026-07-31): diagnose_agent signature now includes `state: State`
// for the cancel_diagnostic PID registry. Accept all forms (single-line
// and multi-line).
assert(commands.includes('pub async fn diagnose_agent(provider: String)')
     || commands.includes('pub async fn diagnose_agent(\n    app: AppHandle,\n    provider: String,')
     || commands.includes('pub async fn diagnose_agent(\n    provider: String,\n    state: State')
     || commands.includes('pub async fn diagnose_agent(provider: String, state: State'),
  'R35.1: diagnose_agent must be `pub async fn` (was sync, froze IPC)');
// It offloads to spawn_blocking
assert(commands.includes('tauri::async_runtime::spawn_blocking'),
  'R35.1: diagnose_agent must use tauri::async_runtime::spawn_blocking');
// The body is extracted into diagnose_agent_sync and receives the shared
// cancellation/PID owner rather than an ad-hoc callback.
assert(commands.includes('fn diagnose_agent_sync(provider: String, control: &DiagnosticControl)'),
  'the sync body must be extracted and use DiagnosticControl');
// Ownership is released before JoinError is propagated, preventing a
// permanent busy state after a blocking worker panic.
assert(/spawn_blocking\(move \|\|[\s\S]*?diagnose_agent_sync[\s\S]*?\.await;[\s\S]*?diagnostic_control\.finish\(\);[\s\S]*?Err\(join_error\)/.test(commands),
  'async wrapper must finish diagnostic ownership before propagating JoinError');

// ──────────────────────────────────────────────────────────────────────────
// P0-5: provider chooser + removal of「名称 +N」
// ──────────────────────────────────────────────────────────────────────────

// pet.html has the provider-chooser modal
assert(petHtml.includes('id="provider-chooser"'),
  'R35.1: pet.html must include #provider-chooser modal');
assert(petHtml.includes('id="pc-list"'),
  'R35.1: pet.html must include #pc-list for chooser items');
// pet.css styles the chooser
assert(petCss.includes('.provider-chooser'),
  'R35.1: pet.css must style .provider-chooser');
// pet.js has the chooser logic
assert(petJs.includes('function chooseProviderAndLaunch'),
  'R35.1: pet.js must define chooseProviderAndLaunch');
assert(petJs.includes('function openProviderChooser'),
  'R35.1: pet.js must define openProviderChooser');
assert(petJs.includes('function closeProviderChooser'),
  'R35.1: pet.js must define closeProviderChooser');
// The explicit “New Agent ▾” affordance always opens the chooser, including
// single-provider configurations. Launch only occurs after a selected item
// completes the awaited native call.
assert(/function chooseProviderAndLaunch\(\) \{\s*openProviderChooser\(\);\s*\}/.test(petJs),
  'R35.1/R35.2: new Agent must always open the provider chooser');
assert(petJs.includes("window.pet.launchAgentChecked(provider)"),
  'R35.2: provider selection must await launchAgentChecked');
// The「+N」label is gone from agent-tag
assert(!/\+ \$\{activeProviders\.length - 1\}/.test(petJs),
  'R35.1: the「+N」label must be removed from agent-tag');
// sl-new routes through chooseProviderAndLaunch
assert(petJs.includes('chooseProviderAndLaunch()'),
  'R35.1: sl-new click must call chooseProviderAndLaunch');
// Rust primary_action emits choose-provider event when multiple providers
assert(commands.includes('"kind":"choose-provider"'),
  'R35.1: Rust primary_action must emit choose-provider pet:event');
assert(commands.includes('providers.len() > 1'),
  'R35.1: Rust primary_action must check providers.len() > 1 before emitting');
// Frontend handles the choose-provider event
assert(petJs.includes("case 'choose-provider'"),
  'R35.1: pet.js onEvent must handle choose-provider case');

// ──────────────────────────────────────────────────────────────────────────
// P0-6: release.yml platform signing semantics
// ──────────────────────────────────────────────────────────────────────────

// The release workflow distinguishes updater artifacts from native platform signing.
assert(release.includes('PLATFORM_SIGNED'),
  'R35.1: release.yml must compute PLATFORM_SIGNED per platform');
assert(!release.includes('platformSigned='),
  'R45: release.yml must not retain an unused platformSigned output');
assert(release.includes('uploadUpdaterJson: false') && release.includes('uploadUpdaterSignatures: false'),
  'R45: updater outputs must be disabled at the action boundary');
// Windows cert missing → warning
assert(release.includes('WINDOWS_CERTIFICATE') && release.includes('::warning::'),
  'R35.1: release.yml must warn when WINDOWS_CERTIFICATE is missing');
// macOS cert missing → warning
assert(release.includes('APPLE_CERTIFICATE') && release.includes('::warning::'),
  'R35.1: release.yml must warn when APPLE_CERTIFICATE is missing');
// REQUIRE_PLATFORM_SIGNING var enables fail-closed
assert(release.includes('REQUIRE_PLATFORM_SIGNING'),
  'R35.1: release.yml must honor REQUIRE_PLATFORM_SIGNING repo variable');
assert(/REQUIRE_PLATFORM_SIGNING[\s\S]*?exit 1/.test(release),
  'R35.1: release.yml must exit 1 when REQUIRE_PLATFORM_SIGNING=true and platform cert missing');
// Updater signing keys are absent while native signing warnings name the
// actual Authenticode / Developer ID publisher identity.
assert(!release.includes('TAURI_SIGNING_PRIVATE_KEY'),
  'R45: updater signing key must not be presented as platform publisher signing');
assert(release.includes('Authenticode') && release.includes('Developer ID'),
  'R45: native signing warnings must name the platform-specific mechanisms');

console.log('tauri-r351-correctness-patch-smoke: ok (5 P0/P1 patches locked: P0-1 anchor-only hit-test + single radial intent, P0-2 window-scoped panel listeners + panel:shown reset, P0-3 async diagnose_agent + spawn_blocking, P0-5 provider chooser + no +N label, P0-6 release.yml platform signing semantics)');
