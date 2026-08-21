#!/usr/bin/env node
'use strict';

// B5 AUDIT (v0.5.64→v0.5.65, 2026-08-21) — i18n completeness smoke.
//
// v0.5.64 fixed the HIGH-severity `currentLang` undefined-variable bug in
// panel.js + migrated BG_META labels, render() scattered strings, session-list
// counts/empties, and price rebuild/refresh error messages to the i18n t()
// system. v0.5.65 completed the migration by i18n-izing the renderPriceInfo()
// body (price.stateError, price.stateNotModified, price.stateUpdated, etc.).
//
// This smoke verifies the FULL B5 i18n state so regressions cannot come back:
//   1. panel.js does NOT reference the undefined `currentLang` variable.
//   2. formatPriceTime uses LOCALES[config.lang], not hardcoded 'zh-CN'.
//   3. BG_META uses the { key: 'bg.*' } shape, not { label: '中文' }.
//   4. panel.js calls t() at every fixed location (v0.5.64 + v0.5.65).
//   5. renderPriceInfo() body uses t('price.state.*') not hardcoded Chinese.
//   6. i18n.js has all v0.5.64+v0.5.65 keys in zh/en/ja (175+ keys × 3 langs).
//   7. No duplicate keys remain for the previously-duplicated panel.noTodo/noData/bgClean.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const panelJs = read('frontend/renderer/panel.js');
const i18nJs = read('frontend/shared/i18n.js');

// ── 1. currentLang bug fix (HIGH, v0.5.64) ───────────────────────────────
assert(!/\bcurrentLang\b/.test(panelJs), 'panel.js must not reference undefined `currentLang`');

// ── 2. formatPriceTime locale fix (MEDIUM, v0.5.64) ──────────────────────
assert(panelJs.includes("LOCALES[config.lang] || 'zh-CN'"),
  'formatPriceTime + timeStr must use LOCALES[config.lang] || zh-CN');

// ── 3. BG_META key-shape fix (MEDIUM, v0.5.64) ───────────────────────────
for (const k of ['bg.running', 'bg.suspect', 'bg.unregistered', 'bg.ended']) {
  assert(new RegExp(`key:\\s*'${k.replace(/\./g, '\\.')}'`).test(panelJs),
    `BG_META must use { key: '${k}' } shape`);
}
assert(!/label:\s*'该跑'/.test(panelJs), 'BG_META must not hardcode Chinese label');

// ── 4. panel.js: t() calls present (v0.5.64 + v0.5.65) ───────────────────
const requiredTCalls = [
  // v0.5.64 fixes
  ['panel.noGrowth', 'render growth state'],
  ['panel.wanderMode', 'wander mode label'],
  ['panel.travelMode', 'travel mode label'],
  ['panel.noTravel', 'no-travel empty state'],
  ['panel.allProviders', 'provider dropdown'],
  ['panel.sessCountFull', 'session count full'],
  ['panel.sessCountFiltered', 'session count filtered'],
  ['panel.noMatch', 'no-match empty state'],
  ['panel.noActive', 'no-active empty state'],
  ['panel.noTodo', 'todo empty state'],
  ['diag.cancelHint', 'diagnostic cancel hint'],
  ['price.everyNHours', 'price refresh interval'],
  ['price.refreshFailed', 'price refresh failed'],
  ['price.rebuildDone', 'price rebuild done'],
  ['price.rebuildFailed', 'price rebuild failed'],
  ['price.unknownError', 'price unknown error'],
  // v0.5.65 renderPriceInfo completion
  ['price.justNow', 'just now timestamp fallback'],
  ['price.stateError', 'price error state'],
  ['price.stateNotModified', 'price 304 not-modified state'],
  ['price.stateUpdated', 'price updated state'],
  ['price.stateRefreshing', 'price refreshing state'],
  ['price.consecutiveFails', 'consecutive failures count'],
  ['price.retryAt', 'retry-at time'],
];
for (const [key, where] of requiredTCalls) {
  assert(panelJs.includes(`t('${key}'`), `panel.js must call t('${key}') for ${where}`);
}

// ── 5. renderPriceInfo() uses t() not hardcoded Chinese (v0.5.65) ────────
// These were the hardcoded Chinese strings before v0.5.65 migration.
assert(!panelJs.includes('价格更新失败'), 'renderPriceInfo must not hardcode 价格更新失败 (use t(price.stateError))');
assert(!panelJs.includes('无变化'), 'renderPriceInfo must not hardcode 无变化 (use t(price.stateNotModified))');
assert(!panelJs.includes('已更新'), 'renderPriceInfo must not hardcode 已更新 (use t(price.stateUpdated))');
assert(!panelJs.includes('刷新中'), 'renderPriceInfo must not hardcode 刷新中 (use t(price.stateRefreshing))');
assert(!panelJs.includes('当前没有待办'), 'renderTodos must not hardcode 当前没有待办 (use t(panel.noTodo))');
assert(!panelJs.includes("errors.join('；')"), 'errors.join must use ASCII semicolon not fullwidth ；');

// ── 6. i18n.js: all keys present in 3 languages ────────────────────────
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
  // v0.5.64 keys
  'panel.noGrowth', 'panel.wanderMode', 'panel.travelMode', 'panel.noTravel',
  'panel.allProviders', 'panel.sessCountFull', 'panel.sessCountFiltered',
  'panel.noMatch', 'panel.noActive', 'panel.noTodo', 'panel.noData', 'panel.bgClean',
  'diag.cancelHint', 'diag.phase.starting', 'diag.phase.version', 'diag.phase.doctor',
  'diag.phase.auth', 'diag.phase.checking',
  'price.refreshFailed', 'price.rebuildDone', 'price.rebuildFailed',
  'price.unknownError', 'price.everyNHours', 'price.justNow',
  'price.enabled', 'price.disabled',
  'bg.running', 'bg.suspect', 'bg.unregistered', 'bg.ended',
  // v0.5.65 renderPriceInfo keys
  'price.stateError', 'price.stateNotModified', 'price.stateUpdated',
  'price.stateRefreshing', 'price.stateNetworkDisabled', 'price.stateAutoDisabled',
  'price.stateNextCheck', 'price.stateAutoCheck',
  'price.consecutiveFails', 'price.retryAt', 'price.keepOld',
  'price.onlineModelsDev', 'price.onlineUserOverride',
  'price.fallbackSrcCount', 'price.fallbackSrcEmpty', 'price.tooltipDefault',
];
let missing = [];
for (const key of requiredKeys) {
  if (!zhJs.has(key)) missing.push(`zh.${key}`);
  if (!enJs.has(key)) missing.push(`en.${key}`);
  if (!jaJs.has(key)) missing.push(`ja.${key}`);
}
assert(missing.length === 0, `i18n.js missing keys: ${missing.join(', ')}`);

// ── 7. No duplicate keys (regression guard) ──────────────────────────────
function langBlockSrc(src, lang) {
  const start = src.indexOf(`const ${lang} = {`);
  let depth = 0, end = -1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return src.slice(start, end);
}

const dupCheckKeys = ['panel.noTodo', 'panel.noData', 'panel.bgClean', 'panel.noGrowth', 'price.stateError'];
for (const langName of ['zh', 'en', 'ja']) {
  const blockSrc = langBlockSrc(i18nJs, langName);
  for (const key of dupCheckKeys) {
    const count = (blockSrc.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || []).length;
    assert(count === 1, `${langName} has ${count} occurrences of ${key} (expected 1 — no duplicates)`);
  }
}

// ── 8. Placeholder syntax for parameterized keys ────────────────────────
assert(zhJs.get('panel.sessCountFull').includes('{total}'), 'sessCountFull zh must use {total}');
assert(zhJs.get('panel.sessCountFiltered').includes('{filtered}'), 'sessCountFiltered zh must use {filtered}');
assert(zhJs.get('price.everyNHours').includes('{hours}'), 'everyNHours zh must use {hours}');
assert(zhJs.get('price.consecutiveFails').includes('{n}'), 'consecutiveFails zh must use {n}');

console.log('tauri-panel-i18n-b5-v0565-smoke: ok (currentLang absent, formatPriceTime locale-fixed, BG_META key-shape, 23 t() calls present, renderPriceInfo fully i18n, 45 keys × 3 langs verified, 5 keys dedupe-guarded)');
