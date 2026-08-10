'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const pricing = read('src-tauri/src/pricing_sync.rs');
const model = read('src-tauri/src/model.rs');
const commands = read('src-tauri/src/commands.rs');
const lib = read('src-tauri/src/lib.rs');
const bridge = read('frontend/renderer/tauri-bridge.js');
const panel = read('frontend/renderer/panel.js');
const html = read('frontend/renderer/panel.html');
const pkg = JSON.parse(read('package.json'));
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
const tauriLinux = JSON.parse(read('src-tauri/tauri.linux.conf.json'));
const pinnedFixture = JSON.parse(read('test/fixtures/models-dev-api-sample.json'));

assert.strictEqual(pkg.version, '0.5.55');
assert.strictEqual(tauri.version, '0.5.55');
assert(tauriLinux.bundle.linux.deb.depends.includes('curl'), 'Debian package must declare curl runtime dependency');
assert(pinnedFixture.anthropic.models['claude-sample'].cost.cache_read > 0);

// Fixed source, no user-controlled command construction, HTTPS-only redirect chain.
assert.match(pricing, /const MODELS_DEV_URL: &str = "https:\/\/models\.dev\/api\.json"/);
assert.match(pricing, /Command::new\(&binary\)/);
assert.match(pricing, /trusted_curl_path/);
assert.doesNotMatch(pricing, /Command::new\([^&][^)]*url|sh -c|cmd \/C/);
assert.match(pricing, /"--proto",\s*"=https"/);
assert.match(pricing, /"--proto-redir",\s*"=https"/);
assert.match(pricing, /"--max-redirs",\s*"3"/);
assert.match(pricing, /MAX_DOWNLOAD_BYTES: u64 = 16 \* 1024 \* 1024/);

assert.match(pricing, /CURL_CONNECT_TIMEOUT_SECS: u64 = 15/);
assert.match(pricing, /CURL_TOTAL_TIMEOUT_SECS: u64 = 60/);
assert.match(pricing, /CURL_ATTEMPTS_PER_SOURCE: usize = 3/);
assert.match(pricing, /PRICE_SOURCE_ENV: &str = \"RE_LLMPET_MODELS_DEV_URL\"/);
assert(pricing.includes('value.starts_with("https://")'));
assert.doesNotMatch(pricing, /MODELS_DEV_MIRROR_URL/);
assert.match(pricing, /force_ipv4 = attempt == 1/);
assert.match(pricing, /command\.arg\("--ipv4"\)/);
assert.match(pricing, /retryable_curl_exit/);
assert.match(pricing, /thread::sleep\(Duration::from_millis\(delay\)\)/);
assert.doesNotMatch(pricing, /"--connect-timeout",\s*"5"/);

// HTTP cache validators and a persisted scheduler prevent unnecessary full downloads.
assert.match(pricing, /If-None-Match/);
assert.match(pricing, /If-Modified-Since/);
assert.match(pricing, /status_code == 304/);
assert.match(pricing, /last_http_status = Some\(304\)/);
assert.match(pricing, /pricing-sync-state\.json/);
assert.match(pricing, /persist_sync_state/);
assert.match(pricing, /atomic_replace/);
assert.match(pricing, /safe_header_value/);
assert.match(pricing, /character\.is_control\(\)/);

// Automatic scheduling is configurable and failure is non-blocking with bounded backoff.
assert.match(model, /price_auto_update: bool/);
assert.match(model, /price_refresh_hours: u64/);
assert.match(model, /price_refresh_hours = self\.price_refresh_hours\.clamp\(1, 168\)/);
assert.match(pricing, /MIN_FAILURE_BACKOFF_SECS: u64 = 15 \* 60/);
assert.match(pricing, /MAX_FAILURE_BACKOFF_SECS: u64 = 12 \* 60 \* 60/);
assert.match(pricing, /failure_backoff_ms/);
assert.match(pricing, /consecutive_failures/);
assert.match(pricing, /network-disabled/);
assert.match(pricing, /auto-disabled/);
assert.match(pricing, /OCTOPUS_DISABLE_MODELS_DEV_FETCH/);
assert.match(pricing, /OCTOPUS_NO_NET/);
assert.match(pricing, /if disabled_by_env \{[\s\S]*forced = false;[\s\S]*network-disabled/);
assert.doesNotMatch(pricing, /if forced \|\| \(config\.price_auto_update && !disabled_by_env/);
assert.match(pricing, /thread::Builder::new\(\)[\s\S]*octopus-pricing-sync/);

// Manual refresh queues work; it never performs the network operation on the Tauri command thread.
assert.match(commands, /pub fn refresh_model_prices/);
const refreshBlock = commands.slice(commands.indexOf('pub fn refresh_model_prices'), commands.indexOf('pub fn set_price_auto_update'));
assert.match(refreshBlock, /request_price_refresh/);
assert.doesNotMatch(refreshBlock, /Command::new|refresh_once|download_with_curl/);
assert.match(commands, /if enabled \{[\s\S]*request_price_refresh/);
assert.match(lib, /\bget_price_info\b/);
assert.match(lib, /\brefresh_model_prices\b/);
assert.match(lib, /\bset_price_auto_update\b/);

// UI exposes status, manual refresh, enable/disable, and interval selection.
assert.match(bridge, /getPriceInfo: \(\) => call\('get_price_info'\)/);
assert.match(bridge, /refreshModelPrices: \(\) => call\('refresh_model_prices'\)/);
assert.match(bridge, /setPriceAutoUpdate/);
for (const id of ['price-refresh', 'price-auto', 'price-interval']) {
  assert(html.includes(`id="${id}"`), `missing price control ${id}`);
}
assert.match(panel, /function renderPriceInfo/);
assert.match(panel, /lastUpdatedAt/);
assert.match(panel, /nextCheckAt/);
assert.match(panel, /consecutiveFailures/);
assert.match(panel, /价格更新失败/);
assert.match(panel, /无变化/);

// Unit-test source covers validators, parser, backoff, wrapper shape and persisted state.
for (const testName of [
  'pinned_models_dev_api_fixture_matches_expected_shape',
  'models_dev_normalization_prefers_official_nonzero_price',
  'models_dev_normalization_accepts_catalog_wrapper_and_rejects_absurd_prices',
  'conditional_header_parser_uses_final_redirect_block_and_rejects_controls',
  'refresh_interval_and_failure_backoff_are_bounded',
  'sync_state_round_trip_keeps_conditional_request_metadata',
]) assert(pricing.includes(testName), `missing Rust pricing test: ${testName}`);

console.log('tauri-price-auto-update-smoke: ok');
