'use strict';

// R53 (2026-09-13) regression smoke — locks in the fixes shipped for the
// 0.6.3 user reports:
//   1. wander with codewhale failing (codex-only flags passed to a CLI that
//      rejects them) + raw clap stderr/GBK mojibake leaking into the bubble
//   2. "Cannot focus terminal: session did not report a source process" for
//      OpenCode sessions (HTTP plugin events carried no pid) + English error
//      inside a Chinese UI
//   3. mascot expression gaps — shared-image states indistinguishable,
//      roam/loafing had no producer
//   4. upstream CodeWhale contract grew 10 -> 15 lifecycle events; the four
//      new state observers must be installed, normalized and expressed
//   5. interaction feedback completion (localized focus fallback, sanitized
//      travel failure postcards, travel log excerpt)
// Run: node test/pet-r53-codewhale-wander-focus-smoke.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// ── 1. codewhale wander: real exec surface, no codex flags, argv prompt ──────
const travel = read('src-tauri/src/travel.rs');
assert(travel.includes('enum PromptDelivery'), 'prompt delivery mode enum missing');
assert(travel.includes('PromptDelivery::Argv'), 'argv delivery variant missing');
// The codex-style flag block must be gated to the codex/else branch only.
const codewhaleBranch = travel.slice(
  travel.indexOf('trip.provider == "codewhale"'),
  travel.indexOf('} else {', travel.indexOf('trip.provider == "codewhale"')),
);
assert(codewhaleBranch.includes('"exec".to_string()') && codewhaleBranch.includes('"--json".to_string()'),
  'codewhale branch must invoke `exec --json`');
for (const codexOnly of ['--search', '--ephemeral', '--sandbox', '--ask-for-approval']) {
  assert(!codewhaleBranch.includes(`"${codexOnly}"`),
    `codewhale args must not contain the codex-only flag ${codexOnly}`);
}
// Prompt rides argv (stdin is ignored by codewhale exec).
assert(travel.includes('args.push(prompt.replace'), 'argv prompt append with newline flattening missing');
assert(travel.includes('drop(child.stdin.take());'), 'argv delivery must drop the stdin handle');
// Honest prompt: no tool/web claims for the tool-less one-shot exec mode.
const codewhalePrompt = travel.slice(
  travel.indexOf('fn build_prompt'),
  travel.indexOf('fn project_name'),
);
assert(codewhalePrompt.includes('trip.provider == "codewhale"'), 'codewhale prompt branch missing');
assert(codewhalePrompt.includes('from your own knowledge'), 'codewhale prompt must claim knowledge-only');

// ── 2. failure sanitization: raw stderr never becomes the bubble text ────────
assert(travel.includes('fn friendly_cli_error'), 'sanitized failure helper missing');
assert(travel.includes('fn log_excerpt'), 'log excerpt helper missing');
assert(travel.includes('fn strip_ansi'), 'ANSI strip helper missing');
assert(travel.includes('log_excerpt(&errors, 2000)'), 'raw stderr must go to the app log');
assert(!/clean_text\(&errors, 2000\)/.test(travel),
  'the old raw-stderr-into-postcard path must be gone');
assert(travel.includes('\\u{fffd}'), 'mojibake (U+FFFD) guard missing');
// Whole-output JSON parse (codewhale --json is one pretty-printed object).
assert(travel.includes('fn json_postcard_text'), 'shared postcard extractor missing');
assert(travel.includes('value.get("output")'), 'codewhale `output` key must be read');

// ── 3. OpenCode plugin reports its pid → focus works for those sessions ─────
// R54: the plugin source moved to plugin_sources.rs (hook_install.rs growth
// budget); the send() contract is unchanged.
const pluginSources = read('src-tauri/src/plugin_sources.rs');
const pluginSend = pluginSources.slice(
  pluginSources.indexOf('async function send(payload)'),
  pluginSources.indexOf('function sidFromEvent'),
);
assert(pluginSend.includes('source_pid: process.pid'),
  'the OpenCode plugin must report its own process pid with every event');

// ── 4. localized focus fallback (no English error in a Chinese UI) ──────────
const commands = read('src-tauri/src/commands.rs');
const focusFn = commands.slice(
  commands.indexOf('pub fn focus_session'),
  commands.indexOf('pub fn primary_action'),
);
// R54: focus now falls back to RESUMING the conversation through the
// provider CLI (session_resume module) before surfacing any error, so the
// localized bubble says "cannot reopen" instead of "cannot focus".
assert(focusFn.includes('无法重新打开会话'), 'focus fallback bubble must be localized');
assert(focusFn.includes('已为你打开详情面板'), 'focus fallback must name the dashboard fallback');
assert(!focusFn.includes('Cannot focus terminal'),
  'the English focus error must be gone');
assert(focusFn.includes('.chars().take(80)'), 'focus error excerpt must be bounded to 80 chars');
assert(focusFn.includes('crate::session_resume::resume_session_inner'),
  'focus fallback must try the provider resume path before erroring');
const sessionResume = read('src-tauri/src/session_resume.rs');
assert(sessionResume.includes('已为你重新打开这个会话。'),
  'resume feedback bubble must be localized');

// ── 5. CodeWhale 15-event contract ───────────────────────────────────────────
// Installer: 14 managed events (shell_env excluded as a steering contract).
const hookInstall = read('src-tauri/src/hook_install.rs');
const eventsBlock = hookInstall.slice(
  hookInstall.indexOf('const CODEWHALE_EVENTS'),
  hookInstall.indexOf('];', hookInstall.indexOf('const CODEWHALE_EVENTS')),
);
assert(eventsBlock.includes('[&str; 14]'), 'CODEWHALE_EVENTS must declare 14 events');
for (const event of ['session_idle', 'session_error', 'waiting_for_user', 'session_busy']) {
  assert(eventsBlock.includes(`"${event}"`), `CODEWHALE_EVENTS must install ${event}`);
}
assert(!eventsBlock.includes('"shell_env"'), 'shell_env must stay excluded');
// Marker bumped v4 -> v5 with v4/v3 kept as legacy migration targets.
assert(hookInstall.includes('# >>> octopus:codewhale-hooks:v5 >>>'), 'current marker must be v5');
assert(hookInstall.includes('# >>> octopus:codewhale-hooks:v4 >>>'), 'retired v4 marker must live in the legacy list');
assert(hookInstall.includes('# >>> re-llmpet:codewhale-hooks:v3 >>>'), 'legacy v3 marker must be retained');

// Client: the four new events normalize onto pet states.
const hookClient = read('src-tauri/src/hook_client.rs');
const codewhaleMap = hookClient.slice(
  hookClient.indexOf('if provider == "codewhale" {'),
  hookClient.indexOf('} else if provider == "aider"'),
);
assert(codewhaleMap.includes('"session_idle" => ("SessionIdle".into(), "loafing")'),
  'session_idle must map to loafing');
assert(codewhaleMap.includes('"session_error" => ("StopFailure".into(), "error")'),
  'session_error must map to error');
assert(codewhaleMap.includes('"waiting_for_user" => {')
  && codewhaleMap.includes('("WaitingForUser".into(), state)'),
  'waiting_for_user must map to a canonical waiting event');
assert(codewhaleMap.includes('"user_input" => "needsinput"'),
  'waiting_for_user reason=user_input must select needsinput');
assert(codewhaleMap.includes('"session_busy" => ("SessionBusy".into(), "working")'),
  'session_busy must map to working');
// Tolerant stdin for the new observers: a stuck pipe degrades to env-only.
assert(hookClient.includes('let codewhale_observer'), 'codewhale observer tolerance flag missing');
assert(hookClient.includes('reader_stuck'), 'the stuck-reader path must skip the join');
// Env fallback carries the waiting reason.
assert(hookClient.includes('"DEEPSEEK_REASON", "CODEWHALE_REASON"'),
  'reason env fallback missing');

// Protocol baseline agrees with the installer.
const baseline = JSON.parse(read('protocol-baseline.json'));
for (const event of ['session_idle', 'session_error', 'waiting_for_user', 'session_busy']) {
  assert(baseline.localContracts.codewhaleEvents.includes(event),
    `protocol baseline must include ${event}`);
}

// ── 6. expressions: roam producer + mascot badges/animations ─────────────────
const pet = read('frontend/renderer/pet.js');
const mascotEyes = pet.slice(pet.indexOf('const MASCOT_EYES'), pet.indexOf('// B3: smooth fade'));
assert(mascotEyes.includes("roam: 'mascot.png'"), 'mascot roam mapping missing');
// Wander-active override: only over idle/sleeping (roam ties with idle per STATES.md).
assert(pet.includes("ownTrip.mode === 'wander'"), 'wander-active detection missing');
assert(pet.includes("next === 'idle' || next === 'sleeping'"),
  'roam must only override idle/sleeping, never waiting/error/busy states');
// states.js vocabulary covers roam for class cleanup.
const states = read('frontend/shared/states.js');
assert(states.includes('roam: 1,'), 'roam must keep its priority entry');

const css = read('frontend/renderer/pet.css');
// Every shared-image state gets a badge.
for (const [state, badge] of [
  ['juggling', '🤹'], ['sweeping', '🧹'], ['loafing', '😌'], ['needsinput', '❓'],
  ['talking', '💬'], ['roam', '🐾'], ['sad', '💧'], ['sorry', '🙇'],
  ['loved', '❤️'], ['excited', '✨'], ['puzzled', '⁉️'], ['error', '❌'],
  ['waiting', '⏳'], ['attention', '❗'],
]) {
  assert(css.includes(`#mascot.${state}::after { content: '${badge}'; }`),
    `mascot ${state} badge missing`);
}
// Every previously-unanimated state gets a body animation on the inner img
// (R35: the outer #mascot must stay geometrically invariant).
for (const [state, keyframes] of [
  ['juggling', 'juggleToss'], ['sweeping', 'sweepSway'], ['loafing', 'lazySway'],
  ['needsinput', 'askBounce'], ['talking', 'chatPulse'], ['roam', 'waddle'],
  ['sad', 'droop'], ['sorry', 'sorryBow'], ['loved', 'heartPulse'],
  ['excited', 'excitedBounce'], ['puzzled', 'puzzledTilt'],
]) {
  assert(css.includes(`@keyframes ${keyframes}`), `mascot ${state} keyframes missing`);
  const rule = css.slice(
    css.indexOf(`#mascot.${state} #mascot-img`),
    css.indexOf('}', css.indexOf(`#mascot.${state} #mascot-img`)),
  );
  assert(rule.includes(`animation: ${keyframes}`),
    `mascot ${state} animation must target the inner img`);
}

// ── 7. wander start bubble names the degraded provider (interaction feedback) ─
const travelViewSrc = read('frontend/renderer/pet-travel-view.js');
assert(travelViewSrc.includes('出门闲逛啦（'),
  'wander start bubble must name the provider actually running the trip');

console.log('pet-r53-codewhale-wander-focus-smoke: ok');
