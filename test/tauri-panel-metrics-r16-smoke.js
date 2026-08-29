#!/usr/bin/env node
'use strict';

// R16 (2026-07-30) — Panel Token/Cost metric switching + usage diagnostics.
//
// Background: R8 removed the upstream Electron panel's metric-tabs (Token/
// Cost toggle) and usage-diagnostics line. R9 §4.2 flagged both as
// regressions. R16 restores them so users can switch the 24h chart and
// calendar between Token and Cost views, and see transcript scan info +
// pricing staleness.
//
// This smoke locks:
//   1. panel.html has .metric-tabs (Token/Cost buttons) + #usage-diagnostics.
//   2. panel.css has .metric-tabs/.mt/.trend-controls/.usage-diagnostics.
//   3. panel.js has usageMetric/lastStats state, renderChart accepts two
//      arrays, renderCal respects usageMetric, renderDiagnostics function
//      exists, metric-tab click handler re-renders from lastStats.
//   4. i18n.js has all 11 metric/diag keys in zh/en/ja with correct
//      placeholder syntax.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const panelHtml = read('frontend/renderer/panel.html');
const panelCss = read('frontend/renderer/panel.css');
const panelJs = read('frontend/renderer/panel.js');
const i18nJs = read('frontend/shared/i18n.js');

// ── panel.html: metric-tabs + usage-diagnostics ───────────────────────────
assert(panelHtml.includes('class="metric-tabs"'), 'panel.html must have .metric-tabs container');
assert(panelHtml.includes('data-metric="tokens"'), 'panel.html must have a Token metric button');
assert(panelHtml.includes('data-metric="cost"'), 'panel.html must have a Cost metric button');
assert(panelHtml.includes('data-i18n="panel.metricTokens"'), 'Token button must have data-i18n="panel.metricTokens"');
assert(panelHtml.includes('data-i18n="panel.metricCost"'), 'Cost button must have data-i18n="panel.metricCost"');
assert(panelHtml.includes('class="trend-controls"'), 'panel.html must wrap metric+view tabs in .trend-controls');
assert(panelHtml.includes('id="usage-diagnostics"'), 'panel.html must have #usage-diagnostics div');
assert(panelHtml.includes('class="usage-diagnostics"'), '#usage-diagnostics must have class usage-diagnostics');

// ── panel.css: metric-tabs + diagnostics styles ───────────────────────────
assert(panelCss.includes('.metric-tabs'), 'panel.css must style .metric-tabs');
assert(panelCss.includes('.metric-tabs .mt'), 'panel.css must style .metric-tabs .mt buttons');
assert(panelCss.includes('.metric-tabs .mt.active'), 'panel.css must style .metric-tabs .mt.active');
assert(panelCss.includes('.trend-controls'), 'panel.css must style .trend-controls');
assert(panelCss.includes('.usage-diagnostics'), 'panel.css must style .usage-diagnostics');

// ── panel.js: state vars ───────────────────────────────────────────────────
assert(panelJs.includes("let usageMetric = 'tokens'"), "panel.js must declare usageMetric state (default 'tokens')");
assert(panelJs.includes('let lastStats = null'), 'panel.js must declare lastStats state');
assert(panelJs.includes('lastStats = s'), 'render() must store lastStats for metric-switch re-render');

// ── panel.js: renderChart accepts two arrays ──────────────────────────────
assert(/function renderChart\(hourlyCost, hourlyTokens\)/.test(panelJs),
  'renderChart must accept (hourlyCost, hourlyTokens)');
assert(panelJs.includes("usageMetric === 'cost' ? hourlyCost : (hourlyTokens || hourlyCost)"),
  'renderChart must pick array based on usageMetric');
assert(panelJs.includes("usageMetric === 'cost' ? fmtCost(value) : fmt(value) + ' tok'"),
  'renderChart must format display based on usageMetric');
assert(panelJs.includes("t('panel.hoursSummaryCost'"),
  'renderChart must use panel.hoursSummaryCost for cost metric');
assert(panelJs.includes("t('panel.hoursSummaryTokens'"),
  'renderChart must use panel.hoursSummaryTokens for tokens metric');

// ── panel.js: renderCal respects usageMetric ──────────────────────────────
assert(panelJs.includes("usageMetric === 'cost' ? v.cost : (v.tokens || 0)"),
  'renderCal must pick metric value for max/total');
assert(panelJs.includes("usageMetric === 'cost' ? c.cost : (c.tokens || 0)"),
  'renderCal must pick metric value for cell level');
assert(panelJs.includes("t('panel.calSummaryCost'"),
  'renderCal must use panel.calSummaryCost');
assert(panelJs.includes("t('panel.calSummaryTokens'"),
  'renderCal must use panel.calSummaryTokens');

// ── panel.js: renderDiagnostics function ──────────────────────────────────
assert(panelJs.includes('function renderDiagnostics('), 'panel.js must define renderDiagnostics');
assert(panelJs.includes("$('usage-diagnostics')"), 'renderDiagnostics must target #usage-diagnostics');
assert(panelJs.includes('diag.lastScanTs'), 'renderDiagnostics must read diag.lastScanTs');
assert(panelJs.includes("t('panel.diagScan'"), 'renderDiagnostics must use panel.diagScan');
assert(panelJs.includes("t('panel.diagCorrections'"), 'renderDiagnostics must use panel.diagCorrections');
assert(panelJs.includes("t('panel.diagEstimated'"), 'renderDiagnostics must use panel.diagEstimated');
assert(panelJs.includes("t('panel.diagStale'"), 'renderDiagnostics must use panel.diagStale');
assert(panelJs.includes("t('panel.diagNever'"), 'renderDiagnostics must use panel.diagNever');
assert(panelJs.includes('renderDiagnostics(s.transcriptDiagnostics)'),
  'render() must call renderDiagnostics(s.transcriptDiagnostics)');

// ── panel.js: metric-tab click handler ────────────────────────────────────
assert(panelJs.includes("document.querySelectorAll('.metric-tabs .mt')"),
  'panel.js must bind metric-tab click handlers');
assert(panelJs.includes("usageMetric = b.dataset.metric === 'cost' ? 'cost' : 'tokens'"),
  'metric-tab handler must set usageMetric from data-metric');
assert(panelJs.includes('renderChart(lastStats.hourly || [], lastStats.hourlyTok || [])'),
  'metric-tab handler must re-render chart from lastStats');

// ── panel.js: chart hover uses data-v ─────────────────────────────────────
assert(panelJs.includes('bar.dataset.v'),
  'chart hover handler must read bar.dataset.v (display string) instead of bar.dataset.c');

// ── i18n.js: all 11 metric/diag keys in 3 languages ───────────────────────
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
  'panel.metricTokens',
  'panel.metricCost',
  'panel.hoursSummaryCost',
  'panel.hoursSummaryTokens',
  'panel.calSummaryCost',
  'panel.calSummaryTokens',
  'panel.diagNever',
  'panel.diagScan',
  'panel.diagCorrections',
  'panel.diagEstimated',
  'panel.diagStale',
];
for (const key of requiredKeys) {
  assert(zhJs.has(key), `i18n.js zh missing key: ${key}`);
  assert(enJs.has(key), `i18n.js en missing key: ${key}`);
  assert(jaJs.has(key), `i18n.js ja missing key: ${key}`);
}

// Placeholder syntax checks
assert(zhJs.get('panel.hoursSummaryCost').includes('{peakH}'), 'hoursSummaryCost zh must use {peakH}');
assert(zhJs.get('panel.hoursSummaryTokens').includes('{total}'), 'hoursSummaryTokens zh must use {total}');
assert(zhJs.get('panel.calSummaryCost').includes('{n}'), 'calSummaryCost zh must use {n}');
assert(zhJs.get('panel.diagScan').includes('{when}'), 'diagScan zh must use {when}');
assert(zhJs.get('panel.diagScan').includes('{files}'), 'diagScan zh must use {files}');
assert(zhJs.get('panel.diagScan').includes('{records}'), 'diagScan zh must use {records}');
assert(zhJs.get('panel.diagCorrections').includes('{n}'), 'diagCorrections zh must use {n}');

console.log('tauri-panel-metrics-r16-smoke: ok (HTML + CSS + JS state/renderChart/renderCal/renderDiagnostics + click handler + i18n parity verified)');
