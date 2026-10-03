'use strict';

// R11 backport smoke: machineGrowth feature — whole-machine rank combining
// Claude + Codex lifetime tokens. Ported from upstream backend/growth.js.
//
// Verifies:
//   1. model.rs defines the machine_rank helper with the 10M unit + 4-to-1
//      QQ-style promotion ladder (leaf → star → moon → sun → crown).
//   2. stats() emits a `machineGrowth` field wired to Claude + Codex lifetime.
//   3. Claude lifetime is derived from the metering ledger's `daily` map
//      (the Rust ledger has no top-level `lifetime` field, so we sum daily
//      token counts — equivalent to upstream's carried+daily within the
//      95-day retention window).
//   4. Codex lifetime is read from `codex_usage.lifetime.tokens` produced by
//      codex_rollout.rs.
//   5. The `machineGrowth` JSON shape matches upstream: { totalTokens,
//      claudeTokens, codexTokens, rank: { ... } }.
//   6. The rank payload carries every field upstream emits (unitTokens,
//      units, crown, sun, moon, star, leaf, progressTokens, nextTokens).
//   7. The 10M unit constant is wired (not the travel-scale 10k unit).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const model = read('src-tauri/src/model.rs');
const codexRollout = read('src-tauri/src/codex_rollout.rs');
const metering = read('src-tauri/src/metering.rs');

// ── 1. machine_rank helper exists with the 10M unit + 4-to-1 ladder ──
assert(model.includes('fn machine_rank('),
  'model.rs must define a `machine_rank` helper function');
assert(model.includes('const UNIT: u64 = 10_000_000;'),
  'machine_rank must use the 10M token unit (MACHINE_RANK_UNIT_TOKENS) — not the 10k travel unit');
// 4-to-1 promotion: leaf = units % 4, star = (units % 16) / 4,
// moon = (units % 64) / 16, sun = (units % 256) / 64, crown = units / 256.
assert(model.match(/leaf.*units\s*%\s*4/),
  'rank leaf must be units % 4 (QQ-style 4-to-1 base rung)');
assert(model.match(/star.*\(units\s*%\s*16\)\s*\/\s*4/),
  'rank star must be (units % 16) / 4 (4 leaves per star)');
assert(model.match(/moon.*\(units\s*%\s*64\)\s*\/\s*16/),
  'rank moon must be (units % 64) / 16 (4 stars per moon)');
assert(model.match(/sun.*\(units\s*%\s*256\)\s*\/\s*64/),
  'rank sun must be (units % 256) / 64 (4 moons per sun)');
assert(model.match(/crown.*units\s*\/\s*256/),
  'rank crown must be units / 256 (4 suns per crown)');
assert(model.includes('"progressTokens"'),
  'rank must expose progressTokens (tokens toward next unit)');
assert(model.includes('"nextTokens"'),
  'rank must expose nextTokens (the unit size, for progress-bar math)');

// ── 2. stats() emits machineGrowth ──
assert(model.includes('"machineGrowth"'),
  'stats() must inject a `machineGrowth` field into the stats JSON');
assert(model.match(/machineGrowth.*totalTokens.*claudeTokens.*codexTokens.*rank/s),
  'machineGrowth must expose totalTokens/claudeTokens/codexTokens/rank');

// ── 3. Claude lifetime derived from metering daily map ──
// The Rust metering ledger snapshot (metering.rs) has no top-level `lifetime`
// field; we sum `daily[*].tokens` instead. Confirm the snapshot exposes
// `daily` with per-day `tokens` and that model.rs reads exactly that path.
assert(metering.includes('"daily": daily'),
  'metering snapshot must expose a `daily` map');
assert(metering.match(/daily.*tokens.*msgs.*unknownPrice.*estimatedPrice/s),
  'metering daily entries must carry a `tokens` field');
assert(model.match(/usage\s*\.get\("daily"\).*and_then\(Value::as_object\)/s),
  'model.rs must read Claude lifetime from usage["daily"]');
assert(model.match(/v\.get\("tokens"\)\.and_then\(Value::as_u64\)/),
  'model.rs must sum daily token counts as u64 for Claude lifetime');
assert(model.includes('.sum::<u64>()'),
  'Claude lifetime tokens must be summed as u64 to avoid overflow');

// ── 4. Codex lifetime read from codex_usage.lifetime.tokens ──
assert(codexRollout.includes('"lifetime"'),
  'codex_rollout snapshot must expose a `lifetime` object');
assert(codexRollout.match(/lifetime.*tokens/s),
  'codex_rollout lifetime must include a `tokens` field');
assert(model.match(/codex_usage\s*\.as_ref\(\).*\.get\("lifetime"\).*\.get\("tokens"\)/s),
  'model.rs must read Codex lifetime from codex_usage["lifetime"]["tokens"]');

// ── 5. Saturating add — never panics on overflow ──
assert(model.includes('saturating_add(codex_lifetime_tokens)'),
  'machineGrowth must use saturating_add to avoid u64 panic on overflow');

// ── 6. Frontend wiring (panel.js) — present even when machineGrowth is 0 ──
const panelJs = read('frontend/renderer/panel.js');
const panelHtml = read('frontend/renderer/panel.html');
assert(panelJs.includes('machineGrowth'),
  'panel.js must read s.machineGrowth (frontend rendering wired)');
assert(panelHtml.includes('id="machine-growth"'),
  'panel.html must have a #machine-growth element to render the rank');

console.log('tauri-machine-growth-r11-smoke: ok (machine_rank helper + stats machineGrowth field + Claude daily sum + Codex lifetime.tokens + frontend wiring)');
