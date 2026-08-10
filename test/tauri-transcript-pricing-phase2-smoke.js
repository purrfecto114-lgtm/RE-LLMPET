'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
const cargo = read('src-tauri/Cargo.toml');
const lib = read('src-tauri/src/lib.rs');
const model = read('src-tauri/src/model.rs');
const transcript = read('src-tauri/src/transcript.rs');
const pricing = read('src-tauri/src/pricing_sync.rs');
const metering = read('src-tauri/src/metering.rs');
const server = read('src-tauri/src/http_server.rs');
const panel = read('frontend/renderer/panel.js');
const panelHtml = read('frontend/renderer/panel.html');
const claudeFixture = JSON.parse(read('test/fixtures/claude-transcript-assistant.jsonl').trim());

assert.strictEqual(pkg.version, '0.5.51');
assert.strictEqual(tauri.version, '0.5.51');
assert.match(cargo, /version = "0.5.51"/);

// Modules must be part of the active Tauri build and runtime, not dead drafts.
assert.match(lib, /mod pricing_sync;/);
assert.match(lib, /mod transcript;/);
// R44 0.5.51: use cloned runtime Arc instead of state.runtime (borrow fix)
assert.match(lib, /pricing_sync::start\(runtime\.clone\(\), app\.handle\(\)\.clone\(\)\)/);
assert.match(model, /pub transcripts: Mutex<TranscriptScanner>/);
assert.match(model, /scan_from_hook\([\s\S]*?body,[\s\S]*?&id,[\s\S]*?&mut usage,[\s\S]*?now,/);
assert.match(model, /"transcriptDiagnostics"/);
assert.match(model, /reply_bubbles: bool/);
assert.match(model, /reply_bubble_chars: usize/);
assert.match(model, /crate::transcript::safe_reply/);

// Transcript scanner: allow-listed path, bounded reads, resumable cursor, and privacy guard.
for (const needle of [
  'transcript-cursors.json', 'MAX_SCAN_BYTES', 'MAX_LINE_BYTES', 'MAX_CURSORS',
  'fs::canonicalize(root)', 'path.starts_with(&root)', 'offset > metadata.len()',
  'cursor = line_start', 'isApiErrorMessage', 'isSidechain', 'isSubagent',
  'output_text', 'looks_sensitive', 'Authorization: Bearer', 'pub fn safe_reply',
]) assert(transcript.includes(needle), `transcript migration missing: ${needle}`);
assert.match(transcript, /incremental_scan_deduplicates_streaming_rows_and_keeps_reply_in_memory_only/);
assert.match(transcript, /path_escape_and_sensitive_reply_are_rejected/);
assert.doesNotMatch(transcript, /fs::read_to_string\(requested\)/, 'scanner must not reread whole transcript');

// Claude and CodeWhale have different cache accounting semantics.
assert.match(metering, /input_includes_cache: bool/);
assert.match(metering, /input_includes_cache: true/);
assert.match(metering, /input_includes_cache: false/);
assert.match(metering, /Claude transcript usage exposes non-cached input and cache buckets/);
assert.match(metering, /claude_transcript_usage_counts_separate_cache_buckets_and_marks_estimate/);
assert.strictEqual(claudeFixture.message.usage.input_tokens + claudeFixture.message.usage.output_tokens + claudeFixture.message.usage.cache_read_input_tokens + claudeFixture.message.usage.cache_creation_input_tokens, 180);
assert.strictEqual(claudeFixture.message.content[0].type, 'text');
assert.match(metering, /old_usage_event_without_cache_semantics_defaults_to_codewhale_compatible_mode/);

// Pricing: fixed HTTPS endpoint, bounded download, atomic normalized cache, layered overrides.
assert.match(pricing, /https:\/\/models\.dev\/api\.json/);
assert.match(pricing, /MAX_DOWNLOAD_BYTES/);
assert.match(pricing, /Command::new\(&binary\)/);
assert.match(pricing, /trusted_curl_path/);
assert.match(pricing, /System32/);
assert.doesNotMatch(pricing, /sh -c|cmd \/C/, 'pricing refresh must not invoke a shell');
assert.match(pricing, /atomic_replace\(&normalized_path, &final_path\)/);
assert.match(pricing, /candidate_rank/);
assert.match(metering, /pricing-cache\.models-dev\.json/);
assert.match(metering, /PRICE_OVERRIDE_FILE_NAME/);
assert.match(metering, /layered_price_catalog_prefers_user_override_and_qualified_provider/);
assert.match(metering, /struct CostQuote/);
assert.match(metering, /source: price\.source\.clone\(\)/);
assert.match(metering, /"count": self\.catalog\.entries\.len\(\)/, 'compatible price payload field must stay compatible');



// Automatic pricing: conditional requests, bounded scheduling, explicit state, and UI controls.
for (const needle of [
  'PRICE_SYNC_STATE_FILE_NAME', 'If-None-Match', 'If-Modified-Since',
  'RefreshOutcome::NotModified', 'failure_backoff_ms', 'consecutive_failures',
  'price_auto_update', 'price_refresh_hours', 'OCTOPUS_DISABLE_MODELS_DEV_FETCH',
  'MAX_FAILURE_BACKOFF_SECS', 'next_check_ms', 'pricing-sync-state.json',
]) assert(pricing.includes(needle), `automatic price update missing: ${needle}`);
assert.match(pricing, /--proto[\s\S]*?=https/);
assert.match(pricing, /--proto-redir[\s\S]*?=https/);
assert.match(pricing, /status_code == 304/);
assert.match(pricing, /safe_header_value/);
assert.match(model, /price_auto_update: bool/);
assert.match(model, /price_refresh_hours: u64/);
assert.match(model, /install_price_refresh_sender/);
assert.match(model, /request_price_refresh/);
assert.match(lib, /\bget_price_info\b/);
assert.match(lib, /\brefresh_model_prices\b/);
assert.match(lib, /\bset_price_auto_update\b/);
assert.match(panelHtml, /id="price-refresh"/);
assert.match(panelHtml, /id="price-auto"/);
assert.match(panelHtml, /id="price-interval"/);
assert.match(panel, /renderPriceInfo/);
assert.match(panel, /refreshModelPrices/);
assert.match(panel, /setPriceAutoUpdate/);

// Session ordering: stale/duplicate lifecycle events cannot overwrite newer terminal states.
for (const needle of [
  'incoming_event_sequence', 'incoming_event_time', 'incoming_event_key',
  'event_rank', 'should_accept_event', 'EVENT_CLOCK_SKEW_MS', 'ENDED_SESSION_TTL_MS',
  'Usage/context is monotonic data and remains eligible even when a stale',
]) assert(model.includes(needle), `session ordering missing: ${needle}`);
assert.match(model, /lower_sequence_is_rejected_even_if_delivered_later/);
assert.match(model, /terminal_event_wins_same_sequence_and_time/);
assert.match(model, /duplicate_event_key_is_rejected/);
assert.match(model, /ended_session_expires_after_ttl/);


// Multi-provider sessions: deterministic priority and provider/session filtering.
assert.match(model, /fn session_state_priority/);
assert.match(model, /aggregate_state_priority_is_deterministic/);
assert.match(model, /"providerId":session\.provider/);
assert.match(panelHtml, /id="sess-provider-filter"/);
assert.match(panelHtml, /id="sess-query"/);
assert.match(panel, /function sessionProviderId/);
assert.match(panel, /sessionProviderFilter/);
// R19 (2026-07-30): renderSessList now uses `const sid = String(s.sessionId || ''); sid.slice(0, 8)`
// instead of the inline `String(s.sessionId || '').slice(0, 8)`. Both forms are equivalent;
// the assertion accepts either so the smoke does not break on the refactor.
assert(
  /String\(s\.sessionId \|\| ''\)\.slice\(0, 8\)/.test(panel)
  || (/const sid = String\(s\.sessionId \|\| ''\)/.test(panel) && /sid\.slice\(0, 8\)/.test(panel)),
  'renderSessList must shorten sessionId to 8 chars (either inline or via sid variable)'
);


// Permission semantics and queue recovery: provider contracts stay explicit; only metadata persists.
assert.match(server, /fn permission_payload\(provider: &str/);
assert.match(server, /"claude" =>/);
assert.match(server, /"codex" =>/);
// cargo fmt may wrap map.insert() across lines; match the key on its own.
assert.match(server, /map\.insert\([\s\S]*?"updatedInput"/);
assert.match(server, /map\.insert\([\s\S]*?"updatedPermissions"/);
const codexPayload = server.slice(server.indexOf('"codex" =>'), server.indexOf('_ => json!'));
assert.doesNotMatch(codexPayload, /map\.insert\([\s\S]*?"(?:updatedInput|updatedPermissions)"/, 'Codex PermissionRequest must remain minimal/fail-closed');
assert.match(server, /"codewhale" =>/);
assert.match(model, /pending-permissions\.json/);
assert.match(model, /pub fn cancel_all_pending/);
assert.match(model, /pub fn close_session_pending/);
assert.match(model, /discarded .* stale pending metadata entries after restart/);
assert.match(model, /"toolName":entry\.tool_name/);
assert.doesNotMatch(model.slice(model.indexOf('fn persist_pending_metadata'), model.indexOf('pub fn matching_batch_rule')), /tool_input|toolInput/, 'persisted permission metadata must exclude tool input');
assert.match(lib, /cancel_all_pending\("Octopus is shutting down; permission denied"\)/);
assert.match(panel, /capabilities\.bypassWarning/);

// Estimate/unknown semantics are visible and Stop emits the safe reply before completion.
// R17 (2026-07-30): hardcoded Chinese '按 API 等价估算' was replaced with
// t('panel.estimatedRounds', {n:...}). Assert the i18n key usage instead.
assert.match(panel, /t\('panel\.estimatedRounds'/);
assert.match(panel, /estimatedPrice/);
// R17: 'models.dev 缓存' was also i18n-ized; just assert the pricing source reference exists.
assert.match(panel, /models\.dev/);
const stopBlock = server.slice(server.indexOf('if event == "Stop"'), server.indexOf('let payload = match event'));
assert.ok(stopBlock.indexOf('"kind":"say"') >= 0 && stopBlock.indexOf('"kind":"turn-done"') > stopBlock.indexOf('"kind":"say"'));

console.log('tauri-transcript-pricing-phase2-smoke: ok');
