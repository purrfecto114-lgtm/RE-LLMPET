#!/usr/bin/env node
'use strict';

// Asset visual regression: pins every shipped frontend asset by SHA256 and
// lightweight image metadata. Updating the baseline is always explicit:
//   node scripts/asset-visual-regression.js --update-baseline
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const active = path.join(ROOT, 'frontend', 'assets');
const baselinePath = path.join(ROOT, 'reports', 'asset-visual-baseline.json');
const update = process.argv.includes('--update-baseline');

function sourceTimestamp() {
  const raw = fs.readFileSync(path.join(ROOT, 'SOURCE_DATE_EPOCH'), 'utf8').trim();
  if (!/^\d+$/.test(raw)) throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer');
  const epoch = Number(raw);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('SOURCE_DATE_EPOCH is invalid');
  return new Date(epoch * 1000).toISOString();
}

function walk(dir, prefix = '') {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = path.join(prefix, ent.name);
    if (ent.isDirectory()) out.push(...walk(path.join(dir, ent.name), rel));
    else if (ent.isFile()) out.push(rel.replaceAll(path.sep, '/'));
  }
  return out;
}

function meta(file) {
  const b = fs.readFileSync(file);
  let width = null;
  let height = null;
  let frames = null;
  let format = path.extname(file).slice(1).toLowerCase();
  if (b.length >= 24 && b.subarray(1, 4).toString() === 'PNG') {
    width = b.readUInt32BE(16);
    height = b.readUInt32BE(20);
    format = 'png';
  } else if (b.length >= 10 && (b.subarray(0, 6).toString() === 'GIF87a' || b.subarray(0, 6).toString() === 'GIF89a')) {
    width = b.readUInt16LE(6);
    height = b.readUInt16LE(8);
    format = 'gif';
    frames = 0;
    for (let i = 0; i < b.length - 1; i += 1) if (b[i] === 0x2c) frames += 1;
  }
  return {
    bytes: b.length,
    sha256: crypto.createHash('sha256').update(b).digest('hex'),
    format,
    width,
    height,
    frames,
  };
}

function writeBaseline(files) {
  const rows = files.map((rel) => {
    const delivered = meta(path.join(active, rel));
    return { path: rel, archived: delivered, delivered, byteIdentical: true };
  });
  const report = {
    schemaVersion: 1,
    generatedAt: sourceTimestamp(),
    assetCount: rows.length,
    byteIdenticalCount: rows.length,
    optimizationApplied: false,
    visualSnapshotGate: 'requires compiled GUI on each OS before any conversion',
    assets: rows,
  };
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, JSON.stringify(report, null, 2) + '\n');
  console.log(`asset-visual-regression: ok (${rows.length} assets; baseline updated explicitly)`);
}

const files = walk(active);
if (update) {
  writeBaseline(files);
  process.exit(0);
}
if (!fs.existsSync(baselinePath)) {
  throw new Error('asset baseline missing; run with --update-baseline after reviewing imported resources');
}
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const baselineMap = new Map((baseline.assets || []).map((asset) => [asset.path, asset]));
const activeSet = new Set(files);
const added = files.filter((rel) => !baselineMap.has(rel));
const removed = [...baselineMap.keys()].filter((rel) => !activeSet.has(rel));
const changed = [];
for (const rel of files) {
  const pinned = baselineMap.get(rel);
  if (!pinned) continue;
  const delivered = meta(path.join(active, rel));
  const expected = (pinned.archived || pinned.delivered || {}).sha256;
  if (delivered.sha256 !== expected) changed.push(rel);
}
if (added.length || removed.length || changed.length) {
  const parts = [];
  if (added.length) parts.push(`added: ${added.join(', ')}`);
  if (removed.length) parts.push(`removed: ${removed.join(', ')}`);
  if (changed.length) parts.push(`changed: ${changed.join(', ')}`);
  throw new Error(`assets differ from pinned baseline (${parts.join('; ')})`);
}
console.log(`asset-visual-regression: ok (${files.length} byte-identical assets; no conversion applied)`);
