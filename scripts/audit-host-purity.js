#!/usr/bin/env node
'use strict';
// R4-A 宿主纯净审计：业务层不得 import electron（Electron 可整体替换的前提）
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const DIRS = ['backend', 'shared', 'hook'];
let bad = 0, scanned = 0;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'vendor') walk(p); continue; }
    if (!e.name.endsWith('.js')) continue;
    scanned++;
    const src = fs.readFileSync(p, 'utf8');
    if (/require\(\s*['"]electron['"]\s*\)/.test(src)) { bad++; console.log('ELECTRON LEAK:', path.relative(ROOT, p)); }
  }
}
for (const d of DIRS) walk(path.join(ROOT, d));
console.log(`purity: scanned=${scanned} leaks=${bad}`);
process.exit(bad ? 1 : 0);
