#!/usr/bin/env node
'use strict';

// R18 (2026-07-30) — Metering cache-write 5m/1h split + panel dual row.
//
// Background: upstream metering.js splits cache writes into 5-minute and
// 1-hour ephemeral TTLs via usage.cache_creation.ephemeral_5m_input_tokens
// / ephemeral_1h_input_tokens. R8 only had the aggregate cache_create.
// R18 adds the split to UsageEvent + Aggregate + parse_claude_assistant +
// panel HTML/JS/i18n.
//
// This smoke locks:
//   1. UsageEvent struct has cache_write_5m + cache_write_1h fields.
//   2. Aggregate struct has cache_write_5m + cache_write_1h, add() accumulates, to_json outputs cacheWrite5m/cacheWrite1h.
//   3. parse_claude_assistant extracts ephemeral_5m/1h from cache_creation sub-object, falls back to 5m for the remainder.
//   4. panel.html has t-cw5 + t-cw1 dual rows (not single t-cw).
//   5. panel.js reads s.today.cacheWrite5m/cacheWrite1h.
//   6. i18n.js has tokCacheWrite5m/tokCacheWrite1h + modelDetail uses {cw5}/{cw1} in 3 langs.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const metering = read('src-tauri/src/metering.rs');
const panelHtml = read('frontend/renderer/panel.html');
const panelJs = read('frontend/renderer/panel.js');
const i18nJs = read('frontend/shared/i18n.js');

// ── UsageEvent struct ──────────────────────────────────────────────────────
assert(metering.includes('pub cache_write_5m: u64,'), 'UsageEvent must have cache_write_5m field');
assert(metering.includes('pub cache_write_1h: u64,'), 'UsageEvent must have cache_write_1h field');
// serde(default) for backward compat with older ledger JSON
assert(/#\[serde\(default\)\]\s*\n\s*pub cache_write_5m/.test(metering),
  'cache_write_5m must have #[serde(default)] for backward compat');
assert(/#\[serde\(default\)\]\s*\n\s*pub cache_write_1h/.test(metering),
  'cache_write_1h must have #[serde(default)] for backward compat');

// ── Aggregate struct + add() + to_json() ───────────────────────────────────
assert(metering.includes('cache_write_5m: u64,'), 'Aggregate must have cache_write_5m');
assert(metering.includes('cache_write_1h: u64,'), 'Aggregate must have cache_write_1h');
assert(metering.includes('self.cache_write_5m = self.cache_write_5m.saturating_add(event.cache_write_5m)'),
  'Aggregate::add must accumulate cache_write_5m');
assert(metering.includes('self.cache_write_1h = self.cache_write_1h.saturating_add(event.cache_write_1h)'),
  'Aggregate::add must accumulate cache_write_1h');
assert(metering.includes('"cacheWrite5m": self.cache_write_5m'),
  'Aggregate::to_json must output cacheWrite5m');
assert(metering.includes('"cacheWrite1h": self.cache_write_1h'),
  'Aggregate::to_json must output cacheWrite1h');

// ── parse_claude_assistant extracts 5m/1h ──────────────────────────────────
assert(metering.includes('cache_creation'),
  'parse_claude_assistant must read usage.cache_creation sub-object');
assert(metering.includes('ephemeral_5m_input_tokens'),
  'parse_claude_assistant must read ephemeral_5m_input_tokens');
assert(metering.includes('ephemeral_1h_input_tokens'),
  'parse_claude_assistant must read ephemeral_1h_input_tokens');
// Verify the fallback math: five_minute = explicit_5m + max(0, total - explicit_5m - one_hour)
// The expression spans two lines in the source; tolerate whitespace.
assert(/explicit_5m\s*\n?\s*\.saturating_add\(cache_create\.saturating_sub\(explicit_5m\.saturating_add\(one_hour\)\)\)/.test(metering),
  'parse_claude_assistant must attribute the unclassified remainder to 5m');
// Both UsageEvent literals must set the new fields
assert(metering.includes('cache_write_5m,'), 'transcript UsageEvent literal must set cache_write_5m');
assert(metering.includes('cache_write_1h,'), 'transcript UsageEvent literal must set cache_write_1h');
// CodeWhale hook path sets them to 0 (no TTL split available)
assert(metering.includes('cache_write_5m: 0,'), 'hook UsageEvent literal must default cache_write_5m to 0');
assert(metering.includes('cache_write_1h: 0,'), 'hook UsageEvent literal must default cache_write_1h to 0');

// ── panel.html: dual row ───────────────────────────────────────────────────
assert(panelHtml.includes('id="t-cw5"'), 'panel.html must have #t-cw5 (5m cache write)');
assert(panelHtml.includes('id="t-cw1"'), 'panel.html must have #t-cw1 (1h cache write)');
assert(!panelHtml.includes('id="t-cw"'), 'panel.html must NOT have the old single #t-cw id');
assert(panelHtml.includes('data-i18n="panel.tokCacheWrite5m"'),
  't-cw5 label must have data-i18n="panel.tokCacheWrite5m"');
assert(panelHtml.includes('data-i18n="panel.tokCacheWrite1h"'),
  't-cw1 label must have data-i18n="panel.tokCacheWrite1h"');

// ── panel.js: reads 5m/1h ──────────────────────────────────────────────────
assert(panelJs.includes("$('t-cw5').textContent = fmt(s.today.cacheWrite5m"),
  'panel.js must read s.today.cacheWrite5m for #t-cw5');
assert(panelJs.includes("$('t-cw1').textContent = fmt(s.today.cacheWrite1h"),
  'panel.js must read s.today.cacheWrite1h for #t-cw1');
assert(!panelJs.includes("$('t-cw').textContent"),
  'panel.js must NOT reference the old #t-cw id');
// renderByModel detail uses cw5/cw1
assert(panelJs.includes("v.cacheWrite5m"), 'renderByModel must read v.cacheWrite5m');
assert(panelJs.includes("v.cacheWrite1h"), 'renderByModel must read v.cacheWrite1h');

// ── i18n.js: new keys + modelDetail upgrade ────────────────────────────────
function parseLangBlock(src, lang) {
  const start = src.indexOf(`const ${lang} = {`);
  if (start < 0) throw new Error(`lang block ${lang} not found`);
  let depth = 0, end = -1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const block = src.slice(start, end);
  const out = new Map();
  const re = /^\s*'([^']+)':\s*'((?:[^'\\]|\\.)*)',?\s*$/gm;
  let mm;
  while ((mm = re.exec(block)) !== null) {
    out.set(mm[1], mm[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
  }
  return out;
}

const zhJs = parseLangBlock(i18nJs, 'zh');
const enJs = parseLangBlock(i18nJs, 'en');
const jaJs = parseLangBlock(i18nJs, 'ja');

const requiredKeys = ['panel.tokCacheWrite5m', 'panel.tokCacheWrite1h', 'panel.modelDetail'];
for (const key of requiredKeys) {
  assert(zhJs.has(key), `i18n.js zh missing key: ${key}`);
  assert(enJs.has(key), `i18n.js en missing key: ${key}`);
  assert(jaJs.has(key), `i18n.js ja missing key: ${key}`);
}

// modelDetail must use {cw5}/{cw1} placeholders (upgraded in R18)
assert(zhJs.get('panel.modelDetail').includes('{cw5}'), 'modelDetail zh must use {cw5}');
assert(zhJs.get('panel.modelDetail').includes('{cw1}'), 'modelDetail zh must use {cw1}');
assert(enJs.get('panel.modelDetail').includes('{cw5}'), 'modelDetail en must use {cw5}');
assert(enJs.get('panel.modelDetail').includes('{cw1}'), 'modelDetail en must use {cw1}');
assert(jaJs.get('panel.modelDetail').includes('{cw5}'), 'modelDetail ja must use {cw5}');
assert(jaJs.get('panel.modelDetail').includes('{cw1}'), 'modelDetail ja must use {cw1}');

console.log('tauri-metering-cw-split-r18-smoke: ok (UsageEvent + Aggregate + parse_claude_assistant + panel dual row + i18n parity verified)');
