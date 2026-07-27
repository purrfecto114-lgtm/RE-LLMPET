#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const source = path.join(ROOT, 'assets');
const active = path.join(ROOT, 'frontend', 'assets');
const output = path.join(ROOT, 'reports', 'asset-visual-baseline.json');
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
const a=walk(source), b=walk(active);
if (JSON.stringify(a)!==JSON.stringify(b)) throw new Error('asset file lists differ between archive and active frontend');
const rows=a.map(rel=>{ const archived=meta(path.join(source,rel)); const delivered=meta(path.join(active,rel)); return {path:rel, archived, delivered, byteIdentical:archived.sha256===delivered.sha256}; });
if (rows.some(r=>!r.byteIdentical)) throw new Error('one or more active assets differ from the preserved originals');
const report={schemaVersion:1,generatedAt:new Date().toISOString(),assetCount:rows.length,byteIdenticalCount:rows.filter(r=>r.byteIdentical).length,optimizationApplied:false,visualSnapshotGate:'requires compiled GUI on each OS before any conversion',assets:rows};
fs.mkdirSync(path.dirname(output),{recursive:true}); fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(`asset-visual-regression: ok (${rows.length} byte-identical assets; no conversion applied)`);
