#!/usr/bin/env node
'use strict';

// R17 AUDIT (2026-07-30) — i18n-ize hardcoded Chinese in panel.js.
//
// Background: a holistic audit of R10-R16 found several pre-existing R8
// bugs where panel.js used hardcoded Chinese strings instead of the i18n
// keys that already existed in frontend/shared/i18n.js. This smoke locks
// the fixes so the hardcoded Chinese cannot come back.
//
// Fixed locations:
//   1. today-tokens: ' 轮' → t('panel.rounds')
//   2. win-reset: ' 重置' → t('panel.reset')
//   3. cal mouseover: hardcoded template → t('panel.calReadout', ...)
//   4. renderByModel: '入/出/缓写/缓读/轮/按API等价估算/价格未知' → t('panel.modelDetail'/'modelRounds'/'estimatedRounds'/'unknownRounds')
//   5. renderProviderCost: '轮/按API等价估算/价格未知' → t('panel.rounds'/'estimatedRounds'/'unknownRounds')
//   6. renderByModel total: '合计' → t('panel.total')
//
// This smoke verifies:
//   - panel.js uses the i18n t() calls at the fixed locations.
//   - panel.js no longer contains the hardcoded Chinese strings.
//   - i18n.js has all required keys (panel.rounds, panel.reset,
//     panel.calReadout, panel.modelDetail, panel.modelRounds,
//     panel.estimatedRounds, panel.unknownRounds, panel.total) in 3 langs.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const panelJs = read('frontend/renderer/panel.js');
const i18nJs = read('frontend/shared/i18n.js');

// ── panel.js: i18n calls present ───────────────────────────────────────────
assert(panelJs.includes("t('panel.rounds')"), 'today-tokens + provider-cost must use t(panel.rounds)');
assert(panelJs.includes("t('panel.reset')"), 'win-reset must use t(panel.reset)');
assert(panelJs.includes("t('panel.calReadout'"), 'cal mouseover must use t(panel.calReadout)');
assert(panelJs.includes("t('panel.modelDetail'"), 'renderByModel must use t(panel.modelDetail)');
assert(panelJs.includes("t('panel.modelRounds'"), 'renderByModel must use t(panel.modelRounds)');
assert(panelJs.includes("t('panel.estimatedRounds'"), 'renderByModel + provider-cost must use t(panel.estimatedRounds)');
assert(panelJs.includes("t('panel.unknownRounds'"), 'renderByModel + provider-cost must use t(panel.unknownRounds)');
assert(panelJs.includes("t('panel.total')"), 'renderByModel total must use t(panel.total)');

// ── panel.js: hardcoded Chinese removed ───────────────────────────────────
// These are the exact strings that were hardcoded before the audit fix.
assert(!panelJs.includes("+ ' 轮'"), 'today-tokens must not hardcode 轮');
assert(!panelJs.includes("+ ' 重置'"), 'win-reset must not hardcode 重置');
assert(!panelJs.includes("入 ${fmt(v.input)}"), 'renderByModel must not hardcode 入/出/缓写/缓读');
assert(!panelJs.includes('轮按 API 等价估算'), 'must not hardcode 轮按API等价估算 (use t(panel.estimatedRounds))');
assert(!panelJs.includes('轮价格未知'), 'must not hardcode 轮价格未知 (use t(panel.unknownRounds))');
assert(!panelJs.includes(">合计<"), 'renderByModel total must not hardcode 合计 (use t(panel.total))');
// cal mouseover: the old hardcoded template had this exact pattern
assert(!panelJs.includes("fmtCost(Number(cell.dataset.c))"), 'cal mouseover must not hardcode fmtCost(Number(cell.dataset.c))');

// ── i18n.js: all required keys in 3 languages ─────────────────────────────
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

const requiredKeys = [
  'panel.rounds',
  'panel.reset',
  'panel.calReadout',
  'panel.modelDetail',
  'panel.modelRounds',
  'panel.estimatedRounds',
  'panel.unknownRounds',
  'panel.total',
];
for (const key of requiredKeys) {
  assert(zhJs.has(key), `i18n.js zh missing key: ${key}`);
  assert(enJs.has(key), `i18n.js en missing key: ${key}`);
  assert(jaJs.has(key), `i18n.js ja missing key: ${key}`);
}

// Verify no duplicate keys in any language block (JS allows but it's messy).
// Re-parse each block with explicit end boundary so we don't count across
// language blocks.
function langBlockSrc(src, lang) {
  const start = src.indexOf(`const ${lang} = {`);
  if (start < 0) throw new Error(`lang block ${lang} not found`);
  let depth = 0, end = -1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return src.slice(start, end);
}

for (const langName of ['zh', 'en', 'ja']) {
  const blockSrc = langBlockSrc(i18nJs, langName);
  for (const key of ['panel.total', 'panel.estimatedRounds', 'panel.unknownRounds']) {
    const count = (blockSrc.match(new RegExp(`'${key}':`, 'g')) || []).length;
    assert(count === 1, `${langName} has ${count} occurrences of ${key} (expected 1)`);
  }
}

// Placeholder syntax checks for new keys
assert(zhJs.get('panel.estimatedRounds').includes('{n}'), 'estimatedRounds zh must use {n}');
assert(zhJs.get('panel.unknownRounds').includes('{n}'), 'unknownRounds zh must use {n}');

console.log('tauri-panel-i18n-audit-r17-smoke: ok (8 i18n calls present, 7 hardcoded Chinese removed, 8 keys × 3 langs verified, no duplicates)');
