'use strict';

// R8 fix smoke: real CodeWhale 0.9.4 failed-turn payload (captured live)
// must be DROPPED by parse_hook (all-zero usage → return None).
//
// The fixture at test/fixtures/codewhale-turn-end-failed-real-0.9.4.json
// is the raw pre-normalization payload captured from a real codewhale-tui
// 0.9.4 session with a fake API key. It exercises:
//   1. The normalize_provider_body path: provider="deepseek" → billing_provider,
//      event="turn_end" → native_event, usage nulls → turn_usage zeros.
//   2. The parse_hook all-zero guard: input=0 && output=0 && cache_read=0 &&
//      cache_create=0 → return None (not recorded as a zero-cost event).
//
// This test verifies the GUARD exists in the Rust source (lexical check) and
// the fixture has the expected real-0.9.4 shape.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const metering = read('src-tauri/src/metering.rs');
const hookClient = read('src-tauri/src/hook_client.rs');
const commands = read('src-tauri/src/commands.rs');
const fixture = JSON.parse(read('test/fixtures/codewhale-turn-end-failed-real-0.9.4.json'));

// ── Fixture shape: real CodeWhale 0.9.4 raw turn_end (pre-normalization) ──
assert.strictEqual(fixture.event, 'turn_end', 'fixture must use event= (raw 0.9.4 shape, not native_event=');
assert.strictEqual(fixture.provider, 'deepseek', 'raw provider must be deepseek (billing route)');
assert.strictEqual(fixture.billing_surface, 'first-party-payg', 'billing_surface must match real 0.9.4 output');
assert.strictEqual(fixture.status, 'failed', 'fixture must be a failed turn');
assert.ok(fixture.turn_id.includes('-'), 'turn_id must be UUID format (real 0.9.4)');

// usage must have null token values (failed turn → no tokens consumed)
assert.strictEqual(fixture.usage.input_tokens, 0);
assert.strictEqual(fixture.usage.output_tokens, 0);
assert.strictEqual(fixture.usage.prompt_cache_hit_tokens, null);
assert.strictEqual(fixture.usage.prompt_cache_miss_tokens, null);

// ── normalize_provider_body handles raw 0.9.4 shape ──
// The normalization layer must:
//   1. Read native_event from eventArg (CLI) OR event field (fallback)
assert.match(hookClient, /\.or_else\(\|\| object\.get\("event"\)\.and_then\(Value::as_str\)\)/,
  'normalize_provider_body must fall back to "event" field for native_event');
//   2. Preserve billing_provider from raw provider before overwriting
assert.match(hookClient, /native_billing_provider/,
  'normalize_provider_body must preserve native billing_provider');
//   3. Normalize usage nulls to 0 via json_u64 → unwrap_or(0)
assert.match(hookClient, /let read = \|name: &str\| usage\.get\(name\)\.and_then\(json_u64\)\.unwrap_or\(0\)/,
  'normalize_codewhale_turn_end must coerce null usage to 0');

// ── parse_hook all-zero guard drops failed turns ──
assert.match(metering, /if input == 0 && output == 0 && cache_read == 0 && cache_create == 0/,
  'parse_hook must drop all-zero-usage events (failed turns)');
assert.match(metering, /return None/,
  'parse_hook must return None for all-zero events');

// ── token_priced_surface recognizes first-party-payg ──
assert.match(metering, /lower\.ends_with\("-payg"\)/,
  'token_priced_surface must recognize *-payg suffix (including first-party-payg)');

// ── R8 de-idealized: doctor no-key warning uses secret_backend.presence, NOT api_key.source ──
// Real CodeWhale 0.9.4 doctor never probes the secret store, so api_key.source is ALWAYS
// "secret_store_unprobed" whether or not a key is saved. Matching on it would fire false
// positives on every install with a valid key. The correct signal is secret_backend.presence.
assert.match(commands, /secretBackendPresence/,
  'codewhale_doctor_summary must extract secret_backend.presence for no-key detection');
assert.match(commands, /secret_backend.*presence.*absent|absent.*secret_backend/,
  'no-key warning must check secret_backend.presence == "absent" (not api_key.source)');
// The code must NOT have a match arm matching "secret_store_unprobed" (would always fire).
// Check the no_key expression specifically — it should only match "missing" from apiKeySource.
const noKeyExpr = commands.match(/let no_key = doctor_summary[\s\S]*?eq_ignore_ascii_case\("absent"\)/);
assert.ok(noKeyExpr, 'no_key expression must exist');
assert.doesNotMatch(noKeyExpr[0], /secret_store_unprobed|not_probed|unset/,
  'no_key expression must NOT match on secret_store_unprobed/not_probed/unset (always fires in 0.9.4)');

console.log('tauri-codewhale-failed-turn-r8-smoke: ok (real 0.9.4 failed-turn fixture + normalize + drop-on-zero + de-idealized no-key signal verified)');
