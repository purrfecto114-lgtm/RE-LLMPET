'use strict';

// R11 backport smoke: settings.json watcher.
//
// Upstream `backend/hooks.js startWatcher()` watches ~/.claude/ and re-registers
// hooks if settings.json is overwritten by another tool (CC-Switch, manual
// edits). The Rust fork previously only had a startup `verify_enabled()` check;
// this test locks in the polling watcher backport.
//
// Verifies:
//   1. hook_watcher.rs module exists and is registered in lib.rs
//   2. hook_install.rs exposes a pub Claude drift check (claude_hooks_present)
//   3. lib.rs spawns the watcher AFTER verify_enabled (startup ordering)
//   4. The watcher uses polling (thread::sleep), NOT the notify crate
//   5. Cargo.toml does NOT add a notify dependency
//   6. The watcher thread is named "octopus-hook-watcher"
//   7. The watcher polls every 2 seconds (matches upstream cadence)
//   8. The watcher calls install_claude when drift is detected
//   9. The watcher skips when hooks are still present (debounce + drift check)
//  10. The watcher handles missing settings.json gracefully (continue on Err)
//  11. hook_install.rs remains under the 2300-line budget

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const lib = read('src-tauri/src/lib.rs');
const hookInstall = read('src-tauri/src/hook_install.rs');
const hookWatcher = read('src-tauri/src/hook_watcher.rs');
const cargoToml = read('src-tauri/Cargo.toml');

// ── 1. Module exists and is registered ──
assert(lib.includes('mod hook_watcher;'),
  'lib.rs must declare `mod hook_watcher;`');
assert(fs.existsSync(path.join(root, 'src-tauri/src/hook_watcher.rs')),
  'hook_watcher.rs file must exist');

// ── 2. hook_install.rs exposes a pub Claude drift check ──
// The watcher needs a pub predicate to detect Claude hook drift without
// duplicating the MARKER constant. The predicate must be pub (not pub(crate))
// so the lexical scanner can verify it.
assert(/pub fn claude_hooks_present\(\) -> bool/.test(hookInstall),
  'hook_install.rs must have `pub fn claude_hooks_present() -> bool`');
assert(hookInstall.includes('is_hook_installed("claude")'),
  'claude_hooks_present must delegate to is_hook_installed("claude")');

// ── 3. lib.rs spawns the watcher AFTER verify_enabled (startup ordering) ──
// The watcher must come after the startup drift log so its first tick doesn't
// duplicate the startup check. Verify by line position.
const verifyIdx = lib.indexOf('hook_install::verify_enabled');
const watcherIdx = lib.indexOf('hook_watcher::start_settings_watcher');
assert(verifyIdx > -1, 'lib.rs must call hook_install::verify_enabled at startup');
assert(watcherIdx > -1, 'lib.rs must call hook_watcher::start_settings_watcher at startup');
assert(watcherIdx > verifyIdx,
  'watcher must be spawned AFTER verify_enabled (startup ordering: verify → spawn)');

// ── 4. The watcher uses polling (thread::sleep), NOT the notify crate ──
assert(hookWatcher.includes('use std::thread;'),
  'watcher must use std::thread (polling), not a third-party crate');
assert(hookWatcher.includes('thread::sleep'),
  'watcher must call thread::sleep (polling loop)');
assert(!hookWatcher.includes('use notify'),
  'watcher must NOT use the notify crate (per backport spec — avoid extra deps)');
assert(!/notify\s*=\s*"/.test(cargoToml),
  'Cargo.toml must NOT add notify as a dependency');

// ── 5. Cargo.toml does NOT add a notify dependency (belt-and-suspenders) ──
// (Already asserted above, but restate for clarity in failure output.)
assert(!cargoToml.toLowerCase().includes('notify'),
  'Cargo.toml must not mention notify anywhere');

// ── 6. The watcher thread is named "octopus-hook-watcher" ──
assert(hookWatcher.includes('"octopus-hook-watcher"'),
  'watcher thread must be named "octopus-hook-watcher" (for diagnostics)');
assert(hookWatcher.includes('thread::Builder::new()'),
  'watcher must use thread::Builder::new() so it can be named');

// ── 7. The watcher polls every 2 seconds (matches upstream cadence) ──
assert(/Duration::from_secs\s*\(\s*2\s*\)/.test(hookWatcher),
  'watcher must poll every 2 seconds (Duration::from_secs(2)) to match upstream');
assert(hookWatcher.includes('POLL_INTERVAL'),
  'watcher must define a POLL_INTERVAL constant for the cadence');

// ── 8. The watcher calls install_claude when drift is detected ──
assert(/use crate::hook_install::\{[^}]*install_claude/.test(hookWatcher) ||
       hookWatcher.includes('install_claude'),
  'watcher must call install_claude to re-register hooks on drift');
assert(hookWatcher.includes('claude_hooks_present'),
  'watcher must call claude_hooks_present to detect drift');

// ── 9. The watcher skips when hooks are still present (debounce + drift check) ──
assert(hookWatcher.includes('current_mtime == last_mtime'),
  'watcher must debounce on mtime (skip if file unchanged)');
assert(/if claude_hooks_present\(\)/.test(hookWatcher),
  'watcher must check claude_hooks_present before re-installing');
assert(hookWatcher.includes('continue'),
  'watcher must `continue` the loop when hooks are still present (no churn)');

// ── 10. The watcher handles missing settings.json gracefully ──
assert(/Err\(_\) => continue/.test(hookWatcher),
  'watcher must `continue` on fs::metadata Err (file missing/unreadable)');

// ── 11. hook_install.rs remains under the 2330-line budget ──
// R13: budget raised 2300→2330 for opencode config.json registration code.
const hookInstallLines = hookInstall.split('\n').length;
assert(hookInstallLines <= 2330,
  `hook_install.rs must stay ≤ 2330 lines (got ${hookInstallLines}); ` +
  'the watcher was extracted to hook_watcher.rs to respect this budget');

// ── 12. The watcher logs both the drift detection and the re-sync result ──
assert(hookWatcher.includes('"hooks"'),
  'watcher must log under the "hooks" category');
assert(hookWatcher.includes('re-syncing'),
  'watcher must log "re-syncing" when drift is detected');
assert(hookWatcher.includes('re-registered by watcher'),
  'watcher must log "re-registered by watcher" on successful re-sync');
assert(hookWatcher.includes('watcher re-sync failed'),
  'watcher must log a failure message if install_claude returns Err');

// ── 13. install_claude is called with perm_hook from config (not hardcoded) ──
// The watcher must respect the user's permission-hook toggle, not force it on/off.
assert(hookWatcher.includes('runtime.config()'),
  'watcher must read runtime.config() to get perm_hook');
assert(hookWatcher.includes('config.perm_hook'),
  'watcher must pass config.perm_hook to install_claude');

console.log('✓ R11 settings.json watcher backport smoke: all 13 assertion groups passed');
