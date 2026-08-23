#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/renderer/pet/manifest.json'), 'utf8'));
const out = manifest.files.map(f => fs.readFileSync(path.join(ROOT, 'src/renderer/pet', f))).join('');
fs.writeFileSync(path.join(ROOT, 'renderer/pet.js'), out.endsWith('\n') ? out : out + '\n');
console.log('built renderer/pet.js from', manifest.files.length, 'chunks');
