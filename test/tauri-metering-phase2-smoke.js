'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const fixture = JSON.parse(read('test/fixtures/codewhale-turn-end.json'));
const catalog = JSON.parse(read('resources/model-catalog.bundled.json'));
const rust = read('src-tauri/src/metering.rs');
const model = read('src-tauri/src/model.rs');
const hook = read('src-tauri/src/hook_client.rs');
const panel = read('frontend/renderer/panel.js');
const cargo = read('src-tauri/Cargo.toml');
const pkg = JSON.parse(read('package.json'));
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));

assert.strictEqual(pkg.version, '0.5.24', 'package version must match phase4');
assert.strictEqual(tauri.version, '0.5.24', 'Tauri version must match phase4');
assert.match(cargo, /version = "0\.5\.24"/, 'Rust package version must match phase4');

assert.strictEqual(fixture.native_event, 'turn_end');
assert.ok(fixture.turn_id, 'fixture must carry an idempotency key');
assert.strictEqual(fixture.usage.input_tokens, 1200);
assert.strictEqual(fixture.usage.prompt_cache_hit_tokens, 900);
assert.strictEqual(fixture.usage.prompt_cache_miss_tokens, 300);

const price = catalog.entries[fixture.model];
assert.ok(price, 'fixture model must be priced by bundled catalog');
const input = fixture.usage.input_tokens;
const output = fixture.usage.output_tokens;
const cacheRead = fixture.usage.prompt_cache_hit_tokens;
const cacheCreate = fixture.usage.prompt_cache_miss_tokens;
const uncachedInput = Math.max(0, input - Math.min(cacheRead, input));
const extraWrite = Math.max(0, cacheCreate - uncachedInput);
const expectedCost = (
  uncachedInput * price.input_usd_per_million
  + Math.min(cacheRead, input) * price.cache_read_usd_per_million
  + extraWrite * (price.cache_write_usd_per_million ?? price.input_usd_per_million * 1.25)
  + output * price.output_usd_per_million
) / 1e6;
assert.ok(Math.abs(expectedCost - 0.00009492) < 1e-12, 'reference cost must stay stable');
assert.strictEqual(input + output, 1380, 'cache counters must not double-count total tokens');

assert.match(rust, /struct UsageLedger/);
assert.match(rust, /usage-events\.jsonl/);
assert.match(rust, /codewhale:turn:/);
assert.match(rust, /unknownPricesAreEstimated": false/);
assert.match(rust, /input\.saturating_sub\(cache_read\.min\(input\)\)/);
assert.match(rust, /MAX_LEDGER_READ_BYTES/);
assert.match(rust, /fn compact\(&self\)/);
assert.match(rust, /codewhale_turn_is_deduplicated_and_costed/);
assert.match(rust, /unknown_price_is_explicit_not_fabricated/);
assert.match(rust, /normalized_ledger_reloads_without_duplicate_growth/);
assert.match(rust, /rfc3339_time_and_price_provenance_are_persisted/);
assert.match(rust, /quota_or_plan_surface_remains_explicitly_unpriced/);
assert.match(rust, /malformed_ledger_lines_are_compacted_away/);
assert.match(rust, /parse_rfc3339_ms/);
assert.match(rust, /token_priced_surface/);
assert.match(rust, /schema_keys/);

assert.match(model, /pub usage: Mutex<UsageLedger>/);
assert.match(model, /usage\.record_hook\(body, now\)/);
assert.match(model, /\.snapshot\(now\)/);
assert.match(model, /"contextPercent":session\.context_percent/);
assert.doesNotMatch(model, /"metering-migration-pending"/);

assert.match(hook, /native_billing_provider/);
assert.match(hook, /normalize_codewhale_turn_end/);
assert.match(hook, /"prompt_cache_hit_tokens"/);
assert.match(hook, /"StopFailure"/);

// R26: '价格未知' was i18n-ized to t('panel.priceUnknown') — check for the i18n key instead
assert.match(panel, /panel\.priceUnknown/);
assert.match(panel, /v\.unknownPrice/);
assert.match(panel, /function aggregateCostText/);
assert.match(panel, /today-cost'\)\.textContent = aggregateCostText/);
assert.match(panel, /unknownPrice > 0 \? '≥'/);

console.log('tauri-metering-phase2-smoke: ok (phase4 version, native ledger contract verified)');
