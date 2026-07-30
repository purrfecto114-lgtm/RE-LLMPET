'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const pet = read('frontend/renderer/pet.js');
const html = read('frontend/renderer/pet.html');
const css = read('frontend/renderer/pet.css');
const commands = read('src-tauri/src/commands.rs');
const platform = read('src-tauri/src/platform.rs');

// Drag regression: strict Tauri click-through cannot depend on renderer mousemove.
assert(platform.includes('start_cursor_hit_test'), 'native cursor hit-test worker missing');
assert(platform.includes('window.cursor_position()'), 'native desktop cursor position must drive recovery');
assert(platform.includes('self.visual_bounds()'), 'native hit-test must use renderer-reported visual bounds');
assert(!platform.includes('mouse_ignore_requested.load(Ordering::Acquire) || self.is_ui_busy()'), 'open HUDs must not disable click-through for the entire transparent window');
assert(platform.includes('CURSOR_HIT_TEST_MS'), 'cursor hit-test cadence must be bounded');
assert(pet.includes('setMouseIgnore(false);'), 'pointerdown must disable click-through intent');
assert(pet.includes('queueWindowMove('), 'drag should retain upstream manual movement semantics');
assert(pet.includes('requestAnimationFrame(() =>'), 'drag movement must be frame-throttled');
assert(pet.includes('window.pet.commitWinPos()'), 'drag must persist only after completion');
assert(/setMouseIgnore\(true\);[\s\S]{0,240}if \(gesture\.moved\) commitWindowMove\(\)/.test(pet), 'drag end must return cursor-ignore ownership to the native hit guard');
assert(commands.includes('pub fn commit_win_pos'), 'native final-position commit command missing');

// DPI/window geometry parity: renderer reports logical pixels; Rust converts
// once, preserves the visible pet's bottom-centre anchor, and clamps to the
// monitor work area so HUD expansion does not jump or clip under 150/200% DPI.
assert(commands.includes('fn resize_pet_anchored'), 'DPI-aware anchored resize helper missing');
assert(commands.includes('.scale_factor()'), 'logical sizes must use the current window scale factor');
assert(commands.includes('monitor.work_area()'), 'resized windows must clamp to the monitor work area');
assert(commands.includes('let center_x ='), 'resize must preserve the pet bottom-centre anchor');
assert(commands.includes('let bottom ='), 'resize must preserve the pet bottom edge');
assert(pet.includes('const MEME_WINDOW_W = 760'), 'upstream side-media viewport width missing');
assert(pet.includes('function alignMemePlayer()'), 'skin-aware side-media alignment missing');
assert(pet.includes('let petSizeChain = Promise.resolve()'), 'Tauri resize requests must be serialized');
assert(pet.includes("rlog('resize', 'set size failed:"), 'resize failures should remain diagnosable');
assert(pet.includes("memeImage.addEventListener('load', alignMemePlayer)"), 'meme media should realign after intrinsic dimensions load');
assert(css.includes('当前皮肤真实 DOMRect'), 'side-media CSS should document skin-aware placement');
assert(!css.includes('.sesslist, .ask, .todopop, .meme-player'), 'side media must not inherit HUD bottom anchoring');

// Windows terminal policy: modern host first, deterministic legacy fallback.
const terminalStart = commands.indexOf('fn launch_terminal');
const fallbackMarker = commands.indexOf('// Windows Terminal is optional.', terminalStart);
assert(terminalStart >= 0 && fallbackMarker > terminalStart, 'Windows Terminal must be attempted before cmd.exe fallback');
const wtBlock = commands.slice(terminalStart, fallbackMarker);
assert(wtBlock.includes('which("wt.exe")'), 'Windows Terminal should be resolved before use');
// R22 (2026-07-30): cargo fmt splits .args(["-w", "-1", "new-tab", ...]) across
// lines. Accept either inline or multiline form.
assert(
  wtBlock.includes('"-w", "-1", "new-tab"')
  || (wtBlock.includes('"-w",') && wtBlock.includes('"-1",') && wtBlock.includes('"new-tab",')),
  'Windows Terminal should open a separate tab/window'
);
assert(wtBlock.includes('"--startingDirectory"'), 'Windows Terminal should receive a validated working directory');
assert(wtBlock.includes('command.arg(executable)'), 'native agent binaries must be passed directly');
assert(wtBlock.includes('if is_windows_script(executable)'), 'npm cmd/bat shims must use the explicit compatibility branch');
const cmdBlock = commands.slice(fallbackMarker, commands.indexOf('#[cfg(target_os = "macos")]', fallbackMarker));
assert(cmdBlock.includes('Command::new("cmd.exe")'), 'cmd.exe fallback should remain available');
assert(cmdBlock.includes('.args(["/D", "/S", "/K"])'), 'cmd.exe fallback should keep the session open');

// Upstream visual parity: bounded content region, fixed toolbar, provider identity.
assert(html.includes('id="ask-scroll"'), 'scrollable ask body missing');
assert(html.includes('class="ask-toolbar"'), 'fixed ask toolbar missing');
assert(html.includes('id="agent-tag"'), 'multi-provider identity tag missing');
assert(html.includes('id="sl-meme-view"'), 'upstream-style in-HUD meme page missing');
assert(css.includes('.ask-scroll'), 'ask scroll visuals missing');
assert(css.includes('.ask-toolbar'), 'ask toolbar visuals missing');
assert(css.includes('.agent-tag.provider-codex'), 'provider-specific visual identity missing');
assert(css.includes('.sl-meme-grid'), 'upstream-style meme grid visuals missing');
assert(pet.includes('function preloadCatAssets()'), 'cat GIFs should preload to preserve smooth visual transitions');

console.log('tauri-drag-terminal-phase3-smoke: ok');
