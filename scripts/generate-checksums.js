#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.resolve(process.argv[2] || 'src-tauri/target');
const out = path.resolve(process.argv[3] || 'reports/SHA256SUMS');
if (!fs.existsSync(root)) { console.error(`generate-checksums: missing ${root}`); process.exit(2); }
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
  );
}
// Only match distributable installer artifacts — NOT internal .deb parts
// (control.tar.gz, data.tar.gz) or updater sidecars (.app.tar.gz, .sig).
// We don't ship the tauri updater, so .app.tar.gz / .sig are not distributed.
const packageExt = /\.(?:deb|appimage|rpm|exe|msi|dmg|pkg)$/i;
const files = walk(root)
  .filter((file) => fs.statSync(file).isFile())
  .filter((file) => file.split(path.sep).includes('bundle'))
  .filter((file) => packageExt.test(file) || file.endsWith('.AppImage'))
  // Exclude updater artifacts and internal deb parts
  .filter((file) => !file.endsWith('.tar.gz') && !file.endsWith('.sig'))
  .sort();
if (!files.length) { console.error(`generate-checksums: no bundle artifacts below ${root}`); process.exit(3); }
const lines = files.map((file) => {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return `${digest}  ${path.relative(root, file).replaceAll(path.sep, '/')}`;
});
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`generate-checksums: ${files.length} files -> ${out}`);
