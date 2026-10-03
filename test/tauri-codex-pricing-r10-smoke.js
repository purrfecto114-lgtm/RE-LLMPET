'use strict';

// R10 backport smoke: codex_pricing.rs module — Codex (OpenAI) cost computation.
// Ported from upstream backend/codex-pricing.js.
//
// Verifies:
//   1. codex_pricing.rs module exists and is registered in lib.rs
//   2. norm_codex_model_name strips dated suffixes and provider prefixes
//   3. price_for_codex resolves exact prices for known models
//   4. Pro models have cachedInput = input (no discount) — the 769f3c0 fix
//   5. codex_rollout.rs snapshot includes todayCost/lifetime.cost fields
//   6. Internal profile ids (codex-auto-review) are estimates, not exact

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const lib = read('src-tauri/src/lib.rs');
const codexPricing = read('src-tauri/src/codex_pricing.rs');
const codexRollout = read('src-tauri/src/codex_rollout.rs');

// ── 1. Module exists and is registered ──
assert(lib.includes('mod codex_pricing;'), 'lib.rs must declare mod codex_pricing');
assert(fs.existsSync(path.join(root, 'src-tauri/src/codex_pricing.rs')),
  'codex_pricing.rs file must exist');

// ── 2. norm_codex_model_name ──
assert(codexPricing.includes('pub fn norm_codex_model_name'),
  'codex_pricing.rs must have pub fn norm_codex_model_name');
assert(codexPricing.includes('rsplit(\'/\')'),
  'norm_codex_model_name must strip provider prefix via rsplit("/")');
assert(codexPricing.includes('"-20"'),
  'norm_codex_model_name must strip -YYYY-MM-DD dated suffix');

// ── 3. price_for_codex with exact prices ──
assert(codexPricing.includes('pub fn price_for_codex'),
  'codex_pricing.rs must have pub fn price_for_codex');
assert(codexPricing.includes('gpt-5.3-codex'),
  'built-in models must include gpt-5.3-codex');
assert(codexPricing.includes('gpt-5.5-pro'),
  'built-in models must include gpt-5.5-pro (Pro cache rate fix)');

// ── 4. Pro models: cachedInput = input (no discount) — the 769f3c0 fix ──
// The Pro tier must have cachedInput == input (30.0 == 30.0)
assert(codexPricing.includes('30.0,\n            cached_input: 30.0'),
  'Pro models must have cachedInput = input (no 10% discount) — OpenAI Pro cache rate fix');
assert(codexPricing.match(/gpt-5\.5-pro.*?30\.0.*?30\.0.*?180\.0/s),
  'gpt-5.5-pro must have input=30, cachedInput=30, output=180');

// ── 5. codex_rollout.rs snapshot includes cost fields ──
assert(codexRollout.includes('crate::codex_pricing::price_for_codex'),
  'codex_rollout.rs must call codex_pricing::price_for_codex');
assert(codexRollout.includes('crate::codex_pricing::codex_usage_cost'),
  'codex_rollout.rs must call codex_pricing::codex_usage_cost');
assert(codexRollout.includes('"todayCost"'),
  'codex_rollout snapshot must include todayCost field');
assert(codexRollout.includes('"cost"'),
  'codex_rollout lifetime must include cost field');

// ── 6. Internal profile ids are estimates ──
assert(codexPricing.includes('codex-auto-review'),
  'codex_pricing must treat codex-auto-review as internal profile (estimate, not exact)');

// ── 7. Tier fallback logic ──
assert(codexPricing.includes('"pro"'),
  'tier fallback must include "pro"');
assert(codexPricing.includes('"codex"'),
  'tier fallback must include "codex"');
assert(codexPricing.includes('"default"'),
  'tier fallback must include "default"');

// ── 8. codex_usage_cost formula ──
assert(codexPricing.includes('saturating_sub'),
  'codex_usage_cost must subtract cached from input (fresh = input - cached)');
assert(codexPricing.includes('1_000_000.0'),
  'codex_usage_cost must divide by 1e6 (per-million pricing)');

console.log('tauri-codex-pricing-r10-smoke: ok (codex_pricing.rs module + Pro cache rate fix + cost wiring verified)');
