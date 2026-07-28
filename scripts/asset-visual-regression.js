#!/usr/bin/env node
'use strict';
// Asset visual regression: verifies frontend/assets/ matches the pinned SHA256
// baseline stored in reports/asset-visual-baseline.json. The root assets/
// duplicate was removed (was 3.49 MB of identical files); the baseline now
// serves as the single source of truth for asset integrity.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const active = path.join(ROOT, 'frontend', 'assets');
const baselinePath = path.join(ROOT, 'reports', 'asset-visual-baseline.json');

function walk(dir, prefix = '') {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
    const rel = path.join(prefix, ent.name);
    if (ent.isDirectory()) out.push(...walk(path.join(dir, ent.name), rel));
    else if (ent.isFile()) out.push(rel.replaceAll(path.sep, '/'));
  }
  return out;
}

function meta(file) {
  const b = fs.readFileSync(file);
  let width = null, height = null, frames = null, format = path.extname(file).slice(1).toLowerCase();
  if (b.length >= 24 && b.subarray(1,4).toString() === 'PNG') { width=b.readUInt32BE(16); height=b.readUInt32BE(20); format='png'; }
  else if (b.length >= 10 && (b.subarray(0,6).toString()==='GIF87a' || b.subarray(0,6).toString()==='GIF89a')) {
    width=b.readUInt16LE(6); height=b.readUInt16LE(8); format='gif'; frames=0;
    for (let i=0;i<b.length-1;i++) if (b[i]===0x2c) frames++;
  }
  return { bytes:b.length, sha256:crypto.createHash('sha256').update(b).digest('hex'), format, width, height, frames };
}

const files = walk(active);
let baseline;
if (fs.existsSync(baselinePath)) {
  baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
} else {
  baseline = { assets: [] };
}
const baselineMap = new Map((baseline.assets || []).map(a => [a.path, a]));

// If the baseline is empty or missing, regenerate it (first run / new assets).
if (baselineMap.size === 0) {
  const rows = files.map(rel => ({ path: rel, delivered: meta(path.join(active, rel)), byteIdentical: true }));
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), assetCount: rows.length, byteIdenticalCount: rows.length, optimizationApplied: false, visualSnapshotGate: 'requires compiled GUI on each OS before any conversion', assets: rows };
  fs.writeFileSync(baselinePath, JSON.stringify(report, null, 2) + '\n');
  console.log(`asset-visual-regression: ok (${rows.length} assets; baseline regenerated)`);
  process.exit(0);
}

// Verify each active asset matches the pinned baseline SHA256.
const rows = files.map(rel => {
  const delivered = meta(path.join(active, rel));
  const pinned = baselineMap.get(rel);
  const byteIdentical = pinned ? delivered.sha256 === (pinned.archived || pinned.delivered).sha256 : false;
  return { path: rel, delivered, byteIdentical };
});

if (rows.some(r => !r.byteIdentical)) {
  const changed = rows.filter(r => !r.byteIdentical).map(r => r.path);
  throw new Error(`assets differ from pinned baseline: ${changed.join(', ')}`);
}

const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), assetCount: rows.length, byteIdenticalCount: rows.filter(r=>r.byteIdentical).length, optimizationApplied: false, visualSnapshotGate: 'requires compiled GUI on each OS before any conversion', assets: rows.map(r => ({ path: r.path, archived: r.delivered, delivered: r.delivered, byteIdentical: true })) };
fs.writeFileSync(baselinePath, JSON.stringify(report, null, 2) + '\n');
console.log(`asset-visual-regression: ok (${rows.length} byte-identical assets; no conversion applied)`);
