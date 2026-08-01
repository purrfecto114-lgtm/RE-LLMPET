#!/usr/bin/env node
'use strict';

// R40 (2026-08-01) — 0.5.19 runtime regression closure smoke.
//
// Locks the 4 fixes from the user-reported runtime regressions:
//
//   R40-1  OpenCode plugin: drop `session.status -> UserPromptSubmit`
//          mapping (caused "收到新任务" on every tool call).
//   R40-2  OpenCode plugin: bump marker to v3, accept legacy v2 markers
//          on overwrite, fix is_octopus_marker path so install detection
//          reports installed plugins correctly.
//   R40-3  OpenCode diagnostic: probe `providers list` (v0.9.x renamed
//          from `auth list`); fall back to `auth list` for older builds.
//   R40-4  CodeWhale install: strip legacy pre-R22 `message_submit` hooks
//          that survive the v2 marker-block replacement. Diagnostic now
//          reports `stalePreR22Hooks` so the user can see WHY CodeWhale
//          reports "hook failed and blocked".
//   R40-5  Panel fullscreen border: 500ms poller + near-fullscreen CSS
//          class as a Windows 11 timing safety net so the orange #card
//          border doesn't persist when the panel is maximized.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const hookInstall = read('src-tauri/src/hook_install.rs');
const commands = read('src-tauri/src/commands.rs');
const panelJs = read('frontend/renderer/panel.js');
const panelCss = read('frontend/renderer/panel.css');
const packageJson = JSON.parse(read('package.json'));

// ──────────────────────────────────────────────────────────────────────────
// Version bump
// ──────────────────────────────────────────────────────────────────────────

assert.strictEqual(packageJson.version, '0.5.23',
  'R40: package.json version must be 0.5.23');

// ──────────────────────────────────────────────────────────────────────────
// R40-1: OpenCode plugin — `session.status` must NOT map to UserPromptSubmit
// ──────────────────────────────────────────────────────────────────────────

// The plugin source is a raw string in hook_install.rs.
assert(hookInstall.includes('octopus-opencode-plugin-v3'),
  'R40-1: opencode plugin marker must be bumped to v3');
assert(!hookInstall.includes('"session.status": ["UserPromptSubmit", "thinking"]'),
  'R40-1: session.status MUST NOT map to UserPromptSubmit (causes "收到新任务" on every tool call)');
// R40.1: session.status now uses a dynamic handler that reads the actual
// status from event.properties.status, not a hardcoded fixedMap entry.
assert(hookInstall.includes('SessionStatus'),
  'R40-1: session.status should map to a SessionStatus event name');
assert(hookInstall.includes('event?.properties?.status'),
  'R40-1/R40.1: plugin must read actual status from event.properties.status');
// The Rust http_server maps UserPromptSubmit to kind=user-turn; ensure
// the plugin no longer raises that event for session.status transitions.
assert(hookInstall.includes('sidFromToolInput'),
  'R40-1: plugin must use sidFromToolInput helper for tool hooks');
assert(hookInstall.includes('input?.metadata?.sessionID'),
  'R40-1: plugin must read session ID from input.metadata.sessionID (OpenCode v0.9.x)');

// ──────────────────────────────────────────────────────────────────────────
// R40-2: OpenCode plugin — legacy v2 marker accepted on overwrite + install
//        detection probes the actual plugin file (not ~/.opencode/config.json)
// ──────────────────────────────────────────────────────────────────────────

assert(hookInstall.includes('OPENCODE_MARKER_LEGACY'),
  'R40-2: hook_install must declare OPENCODE_MARKER_LEGACY for v2 -> v3 migration');
assert(hookInstall.includes('octopus-opencode-plugin-v2'),
  'R40-2: legacy v2 marker must be listed in OPENCODE_MARKER_LEGACY');
assert(hookInstall.includes('owns_legacy'),
  'R40-2: install_opencode must accept legacy markers when deciding to overwrite');
// is_octopus_marker for opencode must check the actual plugin file path,
// not the wrong ~/.opencode/config.json path.
assert(!hookInstall.includes('home_dir().join(".opencode").join("config.json")'),
  'R40-2: opencode install detection must NOT check ~/.opencode/config.json (wrong path)');
assert(hookInstall.includes('plugins").join("llmpet-octopus.js")'),
  'R40-2: opencode install detection must check $OPENCODE_CONFIG_DIR/plugins/llmpet-octopus.js');

// ──────────────────────────────────────────────────────────────────────────
// R40-3/R40.1-P1-1: OpenCode diagnostic — `auth list` is the official
// command (0.5.19's `providers list` experiment was reverted in 0.5.20)
// ──────────────────────────────────────────────────────────────────────────

assert(commands.includes('"auth", "list"'),
  'R40.1-P1-1: OpenCode auth probe must use `auth list` (official command, verified via opencode.ai docs)');
// R40.1: the 0.5.19 `providers list` experiment was REVERTED. Ensure it's gone.
assert(!commands.includes('"providers", "list"'),
  'R40.1-P1-1: OpenCode diagnostic must NOT use `providers list` (0.5.19 mistake, reverted per carpet audit P1-1)');

// ──────────────────────────────────────────────────────────────────────────
// R40-4/R40.1-P0-2: CodeWhale install — legacy cleanup DISABLED in R40.1;
// diagnostic still detects; backup-before-write added
// ──────────────────────────────────────────────────────────────────────────

// R40.1: strip_legacy_codewhale_hooks is still DEFINED (as dead code for
// R41 reference) but must NOT be CALLED from install_codewhale.
assert(hookInstall.includes('fn strip_legacy_codewhale_hooks'),
  'R40-4: hook_install must still define strip_legacy_codewhale_hooks (dead code, R41 will revisit)');
assert(!hookInstall.includes('strip_legacy_codewhale_hooks(&path, &mut messages)'),
  'R40.1-P0-2: install_codewhale must NOT call strip_legacy_codewhale_hooks (data corruption risk)');
assert(hookInstall.includes('fn backup_codewhale_config'),
  'R40.1-P0-2: hook_install must have backup_codewhale_config function');
assert(hookInstall.includes('backup_codewhale_config(&path, runtime)'),
  'R40.1-P0-2: install_codewhale must call backup_codewhale_config before writing');

// Diagnostic must surface `stalePreR22Hooks` field and an issue string.
assert(commands.includes('stalePreR22Hooks'),
  'R40-4: diagnostic JSON must include stalePreR22Hooks field');
assert(commands.includes('pre-R22 残留 hook'),
  'R40-4: diagnostic must push an issue string mentioning pre-R22 stale hooks');
assert(commands.includes('fn parse_codewhale_toml_string'),
  'R40-4: commands.rs must have parse_codewhale_toml_string helper');

// ──────────────────────────────────────────────────────────────────────────
// R40-5: Panel fullscreen border — 500ms poller + near-fullscreen CSS class
// ──────────────────────────────────────────────────────────────────────────

assert(panelJs.includes('startWindowModePoller'),
  'R40-5: panel.js must start a window mode poller (Windows timing safety net)');
assert(panelJs.includes('stopWindowModePoller'),
  'R40-5: panel.js must stop the poller on teardown');
assert(panelJs.includes('applyNearFullscreenClass'),
  'R40-5: panel.js must compute a near-fullscreen CSS class fallback');
assert(panelJs.includes('window.screen.availWidth'),
  'R40-5: near-fullscreen check must read screen.availWidth');
assert(panelJs.includes('window.screen.availHeight'),
  'R40-5: near-fullscreen check must read screen.availHeight');
assert(panelJs.includes('0.96'),
  'R40-5: near-fullscreen threshold must be 96% (0.96) of available screen');

assert(panelCss.includes('body.near-fullscreen'),
  'R40-5: panel.css must define body.near-fullscreen rule');
assert(panelCss.includes('body.near-fullscreen #card'),
  'R40-5: panel.css must zero out #card border/radius/shadow when near-fullscreen');

console.log('✓ R40 (0.5.19) runtime regression closure smoke: all assertions passed');
