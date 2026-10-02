'use strict';

// R58-1d smoke: metering.rs 分层价格匹配（兼容 :free / 前缀 / 日期 / 大小写）。
// 结构断言 + 存量契约锚点（不破坏 r10/transcript-pricing/metering-phase2）。
// 有 cargo 时实跑 `cargo test --lib metering::`（GTK pkgconfig 缺失则跳过，
// 与 tauri-hook-consolidation-smoke.js 的探测跳过模式一致）。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const metering = read('src-tauri/src/metering.rs');
const catalog = JSON.parse(read('resources/model-catalog.bundled.json'));

// ── 1. 规范化函数与分层查找存在 ──
assert(metering.includes('fn split_model_modifier'),
  'metering.rs must define split_model_modifier');
assert(metering.includes('fn strip_dated_suffix'),
  'metering.rs must define strip_dated_suffix');
assert(metering.includes('fn find_price_tiered'),
  'metering.rs must define find_price_tiered');
assert(metering.includes('enum PriceMatchKind'),
  'metering.rs must define PriceMatchKind');

// ── 2. 免费变体零计费而非价格未知 ──
assert(metering.includes('PriceMatchKind::FreeVariant'));
assert(metering.includes('token-priced-free'));
assert(metering.includes(':free-variant'));
assert(metering.includes('free_variant_models_price_at_zero_not_unknown'),
  'free variant regression test must exist');

// ── 3. 估算置信标注：normalized / approx 计入 estimated_price ──
assert(metering.includes('normalized-priced') && metering.includes('approx-priced'));
assert.match(metering, /Some\("normalized-priced"\)\s*\|\s*Some\("approx-priced"\)/,
  'Aggregate::add must count normalized/approx as estimates');
assert(metering.includes('prefixed_and_dated_model_ids_match_with_estimate_flag'));

// ── 4. 存量契约锚点（不可破坏）──
assert(metering.includes('layered_price_catalog_prefers_user_override_and_qualified_provider'),
  'transcript-pricing-phase2 anchor');
assert(metering.includes('unknown_price_is_explicit_not_fabricated'),
  'honest-unknown contract');
assert.match(metering, /"count": self\.catalog\.entries\.len\(\)/,
  'price_info payload field must stay compatible');
assert(metering.includes('token_priced_surface'),
  'quota/plan surfaces must stay explicitly unpriced');

// ── 5. fixture 与 bundled 目录对齐 ──
const fixture = JSON.parse(read('test/fixtures/codewhale-turn-end.json'));
assert(catalog.entries[fixture.model], 'fixture model stays priced');
assert(catalog.entries['gpt-5.3-codex'], 'prefix/date tests need this key');

// ── 6. cargo 实跑（可跳过）──
const probe = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
if (probe.status === 0) {
  const run = spawnSync('cargo', ['test', '--lib', 'metering::'], {
    cwd: path.join(root, 'src-tauri'),
    encoding: 'utf8',
    timeout: 600000,
  });
  if (run.status !== 0 && /pkg-config|gtk/i.test(String(run.stderr))) {
    console.log('skip: cargo test needs GTK dev libs; structural checks passed');
  } else {
    assert.strictEqual(run.status, 0, `cargo test --lib metering:: failed\n${run.stderr}`);
  }
} else {
  console.log('skip: cargo unavailable; structural checks passed');
}

console.log('tauri-price-match-r58-smoke: OK');
