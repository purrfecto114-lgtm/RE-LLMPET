#!/usr/bin/env node
'use strict';

// R35 (2026-07-31) — 0.5.11 correctness hotfix smoke.
//
// Locks the 6 P0 fixes from the deep-audit roadmap
// (RE-LLMPET-0.5.10-deep-audit-roadmap.md §3 + §4):
//
//   P0-1  pet geometry: stable #pet-anchor, animations moved to inner
//        visual, geometryBusy guard, dedupe identical set_pet_size calls
//   P0-2  panel: transparent gutter / radius / shadow removed when
//        maximized or fullscreen; set_panel_height clamped to monitor
//        work area; userSized flag stops auto-fit after manual resize
//   P0-3  diagnostics: generation counter, cancel button on loading,
//        stale-result suppression, fitPanelHeight() after close
//   P0-4  Windows cmd quoting: raw_arg replaces .arg(cmd_probe_call(...))
//        so cmd.exe /S /C receives an unescaped tail
//   P0-4  Windows encoding: decode_subprocess_output fallback chain
//        (UTF-16 BOM → UTF-8 → OEM → ACP → lossy) replaces the previous
//        String::from_utf8_lossy in the probe path
//   P0-6  config: config_write_lock serializes snapshot→mutate→save→commit;
//        temp file names include UUID (PID+UUID) so concurrent writers
//        cannot collide
//
// Background: the 0.5.10 release exposed 4 real-machine regressions that
// the source-level smoke suite could not catch (CSS transform on hit-test
// anchor, Windows .cmd double-escape, CP936 → U+FFFD, panel transparent
// border on maximize). This smoke locks the R35 structural fixes so the
// same anti-patterns cannot silently return.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const model = read('src-tauri/src/model.rs');
const commands = read('src-tauri/src/commands.rs');
const cargo = read('src-tauri/Cargo.toml');
const petHtml = read('frontend/renderer/pet.html');
const petCss = read('frontend/renderer/pet.css');
const petJs = read('frontend/renderer/pet.js');
const panelCss = read('frontend/renderer/panel.css');
const panelJs = read('frontend/renderer/panel.js');

// ──────────────────────────────────────────────────────────────────────────
// P0-1: stable pet-anchor + geometry transaction
// ──────────────────────────────────────────────────────────────────────────

// pet.html wraps the three skin elements in #pet-anchor
assert(petHtml.includes('id="pet-anchor"'),
  'pet.html must wrap the three skin elements in a stable #pet-anchor');
// All three skins live INSIDE the anchor. We check by finding the anchor
// open tag and confirming all three skin ids appear within the next 2000
// characters (the anchor block is ~900 chars in the current HTML).
const anchorOpenIdx = petHtml.indexOf('id="pet-anchor"');
assert(anchorOpenIdx > 0, 'pet.html must contain an id="pet-anchor" element');
const anchorBlock = petHtml.slice(anchorOpenIdx, anchorOpenIdx + 2000);
assert(anchorBlock.includes('id="pixel"'),
  '#pixel must live inside #pet-anchor');
assert(anchorBlock.includes('id="mascot"'),
  '#mascot must live inside #pet-anchor');
assert(anchorBlock.includes('id="cat"'),
  '#cat must live inside #pet-anchor');

// pet.css: #pet-anchor is declared and never receives a transform
assert(petCss.includes('#pet-anchor {'),
  'pet.css must declare #pet-anchor as a stable layout box');
// The previous state-class animations on #mascot.<state> have been moved
// to #mascot.<state> #mascot-img. Assert at least the three named in the
// audit (happy, waiting, working) — the others follow the same pattern.
assert(petCss.match(/#mascot\.happy\s+#mascot-img\s*\{/),
  '#mascot.happy animation must target inner #mascot-img, not #mascot root');
assert(petCss.match(/#mascot\.waiting\s+#mascot-img\s*\{/),
  '#mascot.waiting animation must target inner #mascot-img, not #mascot root');
assert(petCss.match(/#mascot\.working\s+#mascot-img\s*\{/),
  '#mascot.working animation must target inner #mascot-img, not #mascot root');
// #pixel.waiting also moved to inner .pixel-sprite
assert(petCss.match(/#pixel\.waiting\s+\.pixel-sprite\s*\{/),
  '#pixel.waiting animation must target inner .pixel-sprite, not #pixel root');
// The bare `#mascot.happy { animation: ... }` (without the #mascot-img
// descendant) must be gone — that was the bug.
assert(!petCss.match(/#mascot\.happy\s*\{\s*animation:/),
  '#mascot.happy must NOT animate the outer #mascot element (was the P0-1 bug)');

// pet.js: buildRadial reads #pet-anchor rect, not the skin element rect
assert(petJs.includes("getElementById('pet-anchor')"),
  'buildRadial must read #pet-anchor bounding rect for the HUD center');
// R35.1 (2026-07-31): INTERACTIVE_HIT_SEL was narrowed to ANCHOR-ONLY.
// The 0.5.11 deep-recheck (P0-1 #3) flagged that including the animated
// skin elements (#pixel/#mascot/#cat) in the hit-test union still caused
// the click-through boundary to shift during state animations. R35.1
// removed them. R35.2 added #provider-chooser (0.5.12 carpet audit
// P0-1 证据B). Assert the current selector and the absence of the
// animated skins in it.
assert(petJs.includes("'#pet-anchor,#radial,#notepad,#todopop,#ask,#sesslist,#meme-player,#provider-chooser'"),
  'R35.2: INTERACTIVE_HIT_SEL must be anchor-only + #provider-chooser');
assert(!petJs.includes("'#pet-anchor,#pixel,#mascot,#cat,#radial,"),
  'R35.1: the old union selector (with animated skins) must be gone');
// geometryBusy guard exists and is checked in openRadial
assert(petJs.includes('let geometryBusy = false'),
  'pet.js must declare geometryBusy flag');
assert(petJs.includes('if (geometryBusy)'),
  'openRadial must check geometryBusy before anchoring');
// dedupe of identical set_pet_size calls
assert(petJs.includes('lastSentPetSize'),
  'pet.js must track lastSentPetSize to dedupe identical set_pet_size calls');
assert(petJs.includes('markGeometryBusy()'),
  'pet.js must call markGeometryBusy() when issuing a set_pet_size');

// ──────────────────────────────────────────────────────────────────────────
// P0-2: panel transparent gutter + work area clamp
// ──────────────────────────────────────────────────────────────────────────

// panel.css has body.window-maximized / body.window-fullscreen rules that
// drop the 20px padding, border, radius, and box-shadow.
assert(panelCss.includes('body.window-maximized'),
  'panel.css must define body.window-maximized class');
assert(panelCss.includes('body.window-fullscreen'),
  'panel.css must define body.window-fullscreen class');
// R40.7: panel is opaque now, no padding to zero. Border-radius check below suffices.
assert(panelCss.match(/body\.window-maximized\s+#card[^{]*\{[^}]*border-radius:\s*0/m),
  '#card must lose border-radius when window is maximized');
assert(panelCss.match(/body\.window-maximized\s+#card[^{]*\{[^}]*box-shadow:\s*none/m),
  '#card must lose box-shadow when window is maximized');

// panel.js: syncWindowMode + installWindowModeListeners + userSized flag
assert(panelJs.includes('function syncWindowMode'),
  'panel.js must define syncWindowMode() to detect maximize/fullscreen');
assert(panelJs.includes('function installWindowModeListeners'),
  'panel.js must install window mode event listeners');
assert(panelJs.includes('let userSized = false'),
  'panel.js must declare userSized flag');
assert(panelJs.includes('if (userSized) return'),
  'fitPanelHeight must skip when userSized is true');
assert(panelJs.includes('if (windowMaximized || windowFullscreen) return'),
  'fitPanelHeight must skip when window is maximized/fullscreen');
assert(panelJs.includes("classList.toggle('window-maximized'"),
  'panel.js must toggle the window-maximized body class');
// dedupe identical consecutive setPanelHeight calls
assert(panelJs.includes('lastFitHeight'),
  'panel.js must dedupe identical consecutive setPanelHeight calls');
// DOMContentLoaded must call syncWindowMode + installWindowModeListeners
const domBlock = panelJs.slice(panelJs.indexOf("document.addEventListener('DOMContentLoaded'"));
assert(domBlock.includes('syncWindowMode()') && domBlock.includes('installWindowModeListeners()'),
  'panel.js DOMContentLoaded must call syncWindowMode() and installWindowModeListeners()');

// commands.rs: set_panel_height clamps to monitor work area
assert(commands.includes('work_area_max_logical'),
  'set_panel_height must compute work_area_max_logical from current_monitor');
assert(commands.includes('monitor.work_area()'),
  'set_panel_height must use monitor.work_area() to clamp height');
assert(commands.includes('height.clamp(480.0, work_area_max_logical)'),
  'set_panel_height must clamp height to [480, work_area_max_logical]');

// ──────────────────────────────────────────────────────────────────────────
// P0-3: diagnostics cancel + generation + stale-result suppression
// ──────────────────────────────────────────────────────────────────────────

// panel.js: diagnostic generation counter
assert(panelJs.includes('let diagnosticGeneration = 0'),
  'panel.js must declare diagnosticGeneration counter');
assert(panelJs.includes('const gen = ++diagnosticGeneration'),
  'diagnoseProvider must capture a generation counter before the IPC call');
assert(panelJs.includes('if (gen !== diagnosticGeneration) return'),
  'diagnoseProvider must drop stale results when generation mismatches');
// clearDiagnostic helper that bumps generation and re-fits panel height
assert(panelJs.includes('function clearDiagnostic'),
  'panel.js must define clearDiagnostic() helper');
assert(panelJs.includes('diagnosticGeneration += 1'),
  'clearDiagnostic must bump the generation counter');
assert(panelJs.includes('fitPanelHeight()'),
  'clearDiagnostic must call fitPanelHeight() to close the empty gap');
// Cancel button in the loading view
assert(panelJs.includes("data-diag-action=\"cancel\""),
  'loading view must include a cancel button (data-diag-action="cancel")');
// Click handler routes both close and cancel through clearDiagnostic
assert(panelJs.includes("action === 'close' || action === 'cancel'"),
  'click handler must route close + cancel through clearDiagnostic');

// ──────────────────────────────────────────────────────────────────────────
// P0-4a: Windows cmd quoting via raw_arg (no more double-escape)
// ──────────────────────────────────────────────────────────────────────────

// commands.rs defines append_cmd_tail helper that uses raw_arg
assert(commands.includes('fn append_cmd_tail'),
  'commands.rs must define append_cmd_tail helper');
assert(commands.includes('use std::os::windows::process::CommandExt'),
  'append_cmd_tail must bring CommandExt into scope for raw_arg');
assert(commands.includes('.raw_arg(tail)'),
  'append_cmd_tail must call .raw_arg(tail) (not .arg(tail))');
// The probe path uses append_cmd_tail instead of .arg(cmd_probe_call(...))
assert(commands.includes('append_cmd_tail(&mut command, cmd_probe_call(executable, args))'),
  'run_probe_capture must use append_cmd_tail for the cmd probe tail');
// The launch path uses raw_arg for /K too
assert(commands.includes('.raw_arg(cmd_launch_call(executable, launch_args))'),
  'launch_terminal Windows Terminal path must use raw_arg for /K tail');
assert(commands.includes('.raw_arg(command_line)'),
  'launch_terminal fallback path must use raw_arg for /K tail');
// The old double-escape pattern (`.arg(cmd_probe_call(...))` or
// `.arg(cmd_launch_call(...))` or `.arg(cmd_call(...))` after /S /C or /S /K)
// must be GONE. This is the literal pattern the audit's screenshot showed.
assert(!commands.match(/\.args\(\["\/D", "\/S", "\/C"\]\)\s*\n?\s*\.arg\(cmd_probe_call/),
  'run_probe_capture must NOT chain .arg(cmd_probe_call(...)) after /S /C (was the double-escape bug)');
assert(!commands.match(/\.args\(\["\/D", "\/S", "\/K"\]\)\s*\n?\s*\.arg\(cmd_launch_call/),
  'launch_terminal must NOT chain .arg(cmd_launch_call(...)) after /S /K (was the double-escape bug)');
assert(!commands.match(/\.args\(\["\/D", "\/S", "\/C"\]\)\s*\n?\s*\.arg\(cmd_call\(/),
  'open_gui_application must NOT chain .arg(cmd_call(...)) after /S /C (was the double-escape bug)');
// The existing helper function names are preserved (smoke compatibility)
assert(commands.includes('fn cmd_probe_call'),
  'cmd_probe_call helper must still exist (existing smoke compatibility)');
assert(commands.includes('fn cmd_launch_call'),
  'cmd_launch_call helper must still exist (existing smoke compatibility)');
assert(commands.includes('fn cmd_call'),
  'cmd_call helper must still exist (existing smoke compatibility)');
assert(commands.includes('fn cmd_quote_arg'),
  'cmd_quote_arg helper must still exist (existing smoke compatibility)');

// ──────────────────────────────────────────────────────────────────────────
// P0-4b: Windows encoding fallback chain
// ──────────────────────────────────────────────────────────────────────────

// commands.rs defines decode_subprocess_output with the audit's chain
assert(commands.includes('fn decode_subprocess_output'),
  'commands.rs must define decode_subprocess_output');
// UTF-16 BOM detection (both LE and BE)
assert(commands.includes('0xFF, 0xFE'),
  'decode_subprocess_output must detect UTF-16 LE BOM (FF FE)');
assert(commands.includes('0xFE, 0xFF'),
  'decode_subprocess_output must detect UTF-16 BE BOM (FE FF)');
// Strict UTF-8 fast path
assert(commands.includes('std::str::from_utf8(bytes)'),
  'decode_subprocess_output must try strict UTF-8 before falling back');
// Windows-only OEM/ACP decode via MultiByteToWideChar
assert(commands.includes('fn decode_windows_codepage'),
  'commands.rs must define decode_windows_codepage for Windows OEM/ACP fallback');
assert(commands.includes('MultiByteToWideChar'),
  'decode_windows_codepage must call MultiByteToWideChar');
assert(commands.includes('GetOEMCP'),
  'decode_windows_codepage must call GetOEMCP for the OEM code page');
assert(commands.includes('GetACP'),
  'decode_windows_codepage must call GetACP for the ANSI code page');
assert(commands.includes('MB_ERR_INVALID_CHARS'),
  'decode_windows_codepage must use MB_ERR_INVALID_CHARS so wrong code pages fail rather than silently substitute');
// Cargo.toml enables Win32_Globalization feature
assert(cargo.includes('"Win32_Globalization"'),
  'Cargo.toml must enable Win32_Globalization feature on windows-sys');
// The probe path no longer uses String::from_utf8_lossy directly — it
// routes through decode_subprocess_output which itself falls back to
// from_utf8_lossy as the last resort.
assert(commands.includes('let text = decode_subprocess_output(bytes)'),
  'sanitized_probe_json must route through decode_subprocess_output');
assert(commands.includes('let filtered: String = decode_subprocess_output(bytes)'),
  'bounded_probe_text must route through decode_subprocess_output');

// ──────────────────────────────────────────────────────────────────────────
// P0-6: config write serialization + unique temp names
// ──────────────────────────────────────────────────────────────────────────

// model.rs: Runtime struct has config_write_lock: Mutex<()>
assert(model.includes('pub config_write_lock: Mutex<()>'),
  'Runtime struct must have config_write_lock: Mutex<()>');
assert(model.includes('config_write_lock: Mutex::new(())'),
  'AppState::new must initialize config_write_lock');
// update_config acquires the writer-side lock for the whole transaction
assert(model.includes('let _write_guard = self'),
  'update_config must acquire the writer-side lock at the start of the transaction');
// The lock call may be split across lines by rustfmt; check that both
// `config_write_lock` and `.lock()` appear within the update_config body.
const updateConfigBody = model.slice(
  model.indexOf('pub fn update_config'),
  model.indexOf('pub fn ingest')
);
assert(updateConfigBody.includes('config_write_lock'),
  'update_config body must reference config_write_lock');
assert(updateConfigBody.includes('.lock()'),
  'update_config body must call .lock() on config_write_lock');
// The R35 rationale comment is present (so future maintainers know why)
assert(model.includes('R35 (2026-07-31): serialize the entire snapshot'),
  'update_config must document the R35 serialization rationale');

// Unique temp file names: PID + UUID
assert(model.includes('fn unique_tmp_path'),
  'model.rs must define unique_tmp_path helper');
assert(model.includes('uuid::Uuid::new_v4()'),
  'unique_tmp_path must use uuid::Uuid::new_v4() for uniqueness');
assert(model.includes('let tmp = unique_tmp_path(path)'),
  'save_config must use unique_tmp_path for the temp file name');
// The old `format!("{}.tmp", std::process::id())` pattern (which collided
// for concurrent writers in the same process) must be GONE from both
// save_config and write_private_json_atomic.
assert(!model.match(/with_extension\(format!\("\{\}\.tmp", std::process::id\(\)\)\)/),
  'save_config / write_private_json_atomic must NOT use PID-only temp names (was the collision bug)');

console.log('tauri-r35-correctness-hotfix-smoke: ok (6 P0 fixes locked: P0-1 pet-anchor + geometry, P0-2 panel gutter + work-area, P0-3 diagnostics cancel + generation, P0-4a cmd raw_arg, P0-4b encoding fallback chain, P0-6 config serialization + unique temp)');
