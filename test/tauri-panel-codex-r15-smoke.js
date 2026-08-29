#!/usr/bin/env node
'use strict';

// R15 (2026-07-30) — Panel Codex quota + usage rendering.
//
// Background: R8 removed the upstream Electron panel's Codex 5h quota bar
// (#codex-wrap) and Codex today/lifetime token grid (#codex-usage). R9 §4.2
// flagged this as a regression for Codex users. R15 restores the HTML
// structure, CSS, rendering JS, and i18n keys so the panel is ready to
// display Codex data the moment a Rust-side codex-watch equivalent populates
// s.codexLimits and s.codexUsage.
//
// This smoke locks:
//   1. panel.html contains #codex-wrap + #codex-usage with the upstream
//      element ids (so panel.js can find them via $()).
//   2. panel.css has .bar-fill.codex (distinct from the 5h budget bar) and
//      .stat.compact (smaller font for the Codex grid).
//   3. panel.js render() reads s.codexLimits and s.codexUsage, hides the
//      blocks when absent, and populates all sub-elements when present.
//   4. renderCodexUsage is a standalone function (mirrors upstream).
//   5. i18n.js has panel.codexQuota / codexToday / codexLifetime /
//      codexBreakdown / codexLocalHistory in all three languages.
//   6. panel.reset / panel.weekWindow / panel.plan (used by codex-foot)
//      still exist in all three languages.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const panelHtml = read('frontend/renderer/panel.html');
const panelCss = read('frontend/renderer/panel.css');
const panelJs = read('frontend/renderer/panel.js');
const i18nJs = read('frontend/shared/i18n.js');

// ── panel.html: Codex blocks ───────────────────────────────────────────────
assert(panelHtml.includes('id="codex-wrap"'), 'panel.html must have #codex-wrap section');
assert(panelHtml.includes('id="codex-pct"'), 'panel.html must have #codex-pct span');
assert(panelHtml.includes('id="codex-fill"'), 'panel.html must have #codex-fill bar');
assert(panelHtml.includes('id="codex-foot"'), 'panel.html must have #codex-foot detail');
assert(panelHtml.includes('id="codex-usage"'), 'panel.html must have #codex-usage section');
assert(panelHtml.includes('id="codex-today"'), 'panel.html must have #codex-today value');
assert(panelHtml.includes('id="codex-today-detail"'), 'panel.html must have #codex-today-detail foot');
assert(panelHtml.includes('id="codex-lifetime"'), 'panel.html must have #codex-lifetime value');
assert(panelHtml.includes('id="codex-lifetime-detail"'), 'panel.html must have #codex-lifetime-detail foot');
// codex-fill must use the .codex class for the distinct cool tone
assert(panelHtml.includes('class="bar-fill codex"'), 'codex-fill must have class "bar-fill codex"');
// Both sections start hidden (no Codex activity by default)
assert(/id="codex-wrap"\s+class="budget hidden"/.test(panelHtml), 'codex-wrap must start with hidden class');
assert(/id="codex-usage"\s+class="grid hidden"/.test(panelHtml), 'codex-usage must start with hidden class');
// data-i18n attributes for the labels
assert(panelHtml.includes('data-i18n="panel.codexQuota"'), 'codex-wrap label must have data-i18n="panel.codexQuota"');
assert(panelHtml.includes('data-i18n="panel.codexToday"'), 'codex-today label must have data-i18n="panel.codexToday"');
assert(panelHtml.includes('data-i18n="panel.codexLifetime"'), 'codex-lifetime label must have data-i18n="panel.codexLifetime"');

// ── panel.css: Codex styles ────────────────────────────────────────────────
assert(panelCss.includes('.bar-fill.codex'), 'panel.css must have .bar-fill.codex for the distinct Codex bar color');
assert(panelCss.includes('.bar-fill.codex.warn'), 'panel.css must have .bar-fill.codex.warn for the warning state');
assert(panelCss.includes('.stat.compact'), 'panel.css must have .stat.compact for the Codex grid');
assert(panelCss.includes('.stat.compact .stat-value'), 'panel.css must size .stat.compact .stat-value smaller than hero stats');

// ── panel.js: render() Codex logic ─────────────────────────────────────────
assert(panelJs.includes("s.codexLimits"), 'panel.js render() must read s.codexLimits');
assert(panelJs.includes("cl.usedPercent != null"), 'panel.js must check codexLimits.usedPercent before showing #codex-wrap');
assert(panelJs.includes("$('codex-wrap').classList.remove('hidden')"), 'panel.js must unhide #codex-wrap when codexLimits is present');
assert(panelJs.includes("$('codex-wrap').classList.add('hidden')"), 'panel.js must hide #codex-wrap when codexLimits is absent');
assert(panelJs.includes("cl.resetsAt"), 'panel.js must read codexLimits.resetsAt for the foot');
assert(panelJs.includes("cl.secondaryUsedPercent"), 'panel.js must read codexLimits.secondaryUsedPercent');
assert(panelJs.includes("cl.planType"), 'panel.js must read codexLimits.planType');
assert(panelJs.includes("renderCodexUsage(s.codexUsage)"), 'panel.js render() must call renderCodexUsage(s.codexUsage)');

// ── panel.js: renderCodexUsage function ────────────────────────────────────
assert(panelJs.includes('function renderCodexUsage('), 'panel.js must define renderCodexUsage function');
assert(panelJs.includes('!codexUsage.today || !codexUsage.lifetime'), 'renderCodexUsage must guard on today+lifetime presence');
assert(panelJs.includes("$('codex-today').textContent = fmt(today.tokens)"), 'renderCodexUsage must set codex-today');
assert(panelJs.includes("$('codex-lifetime').textContent = fmt(lifetime.tokens)"), 'renderCodexUsage must set codex-lifetime');
assert(panelJs.includes("t('panel.codexBreakdown'"), 'renderCodexUsage must use panel.codexBreakdown i18n key');
assert(panelJs.includes("t('panel.codexLocalHistory'"), 'renderCodexUsage must use panel.codexLocalHistory i18n key');

// ── i18n.js: Codex keys in all three languages ─────────────────────────────
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
  'panel.codexQuota',
  'panel.codexToday',
  'panel.codexLifetime',
  'panel.codexBreakdown',
  'panel.codexLocalHistory',
  // Used by codex-foot
  'panel.reset',
  'panel.weekWindow',
  'panel.plan',
];
for (const key of requiredKeys) {
  assert(zhJs.has(key), `i18n.js zh missing key: ${key}`);
  assert(enJs.has(key), `i18n.js en missing key: ${key}`);
  assert(jaJs.has(key), `i18n.js ja missing key: ${key}`);
}

// codexBreakdown and codexLocalHistory must use placeholder syntax
assert(zhJs.get('panel.codexBreakdown').includes('{in}'), 'panel.codexBreakdown zh must use {in} placeholder');
assert(zhJs.get('panel.codexBreakdown').includes('{out}'), 'panel.codexBreakdown zh must use {out} placeholder');
assert(zhJs.get('panel.codexLocalHistory').includes('{sessions}'), 'panel.codexLocalHistory zh must use {sessions} placeholder');
assert(zhJs.get('panel.codexLocalHistory').includes('{events}'), 'panel.codexLocalHistory zh must use {events} placeholder');

console.log('tauri-panel-codex-r15-smoke: ok (HTML + CSS + render logic + renderCodexUsage + i18n parity verified)');
