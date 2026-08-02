'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const pkg = JSON.parse(read('package.json'));
assert(!pkg.dependencies.electron && !pkg.devDependencies.electron, 'Electron must not be a runtime/dev dependency of the rewrite');
assert(pkg.scripts.start.includes('cargo tauri dev'));
assert(pkg.scripts.build.includes('cargo tauri build'));

const config = JSON.parse(read('src-tauri/tauri.conf.json'));
assert.strictEqual(config.app.withGlobalTauri, false);
assert.strictEqual(config.build.frontendDist, '../frontend');
assert(config.app.windows.some((window) => window.label === 'pet' && window.transparent && window.decorations === false));
assert(config.app.windows.some((window) => window.label === 'panel' && window.visible === false));

// R43: CSP is defined in tauri.conf.json (not duplicated in HTML meta tags)
assert(config.app.security.csp.includes("connect-src ipc: http://ipc.localhost"),
  'tauri.conf.json CSP must include connect-src ipc: http://ipc.localhost');
// R43: unsafe-inline removed from style-src (was needed for transparent panel, now opaque)
assert(!config.app.security.csp.includes("'unsafe-inline'"),
  'tauri.conf.json CSP must NOT contain unsafe-inline');

for (const htmlFile of ['frontend/renderer/pet.html', 'frontend/renderer/panel.html']) {
  const html = read(htmlFile);
  const bridge = html.indexOf('tauri-bridge.js');
  const appScript = htmlFile.endsWith('pet.html') ? html.indexOf('pet.js') : html.indexOf('panel.js');
  assert(bridge >= 0 && bridge < appScript, `${htmlFile}: bridge must load before renderer application`);
  // R43: CSP meta tags removed from HTML (defined in tauri.conf.json only)
  assert(!html.includes('Content-Security-Policy'),
    `${htmlFile}: must NOT have CSP meta tag (defined in tauri.conf.json)`);
}

function walk(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(full));
    else result.push(full);
  }
  return result;
}
// Asset integrity: verify frontend/assets/ files exist and are non-empty.
// (Root assets/ duplicate was removed; asset-visual-regression.js checks
// SHA256 against the pinned baseline for byte-identity.)
const copiedAssets = walk(path.join(ROOT, 'frontend', 'assets'));
assert(copiedAssets.length >= 30, `expected ≥30 frontend assets, got ${copiedAssets.length}`);
for (const asset of copiedAssets) {
  assert(fs.statSync(asset).size > 0, `empty asset: ${path.relative(ROOT, asset)}`);
}

const bridge = read('frontend/renderer/tauri-bridge.js');
const commands = new Set([...bridge.matchAll(/(?:call|send)\('([a-z0-9_]+)'/g)].map((match) => match[1]));
const lib = read('src-tauri/src/lib.rs');
const handlerBody = lib.match(/generate_handler!\[([\s\S]*?)\]\)/);
assert(handlerBody, 'Rust invoke handler list missing');
for (const command of commands) {
  assert(new RegExp(`\\b${command}\\b`).test(handlerBody[1]), `bridge command not registered in Rust: ${command}`);
}

const cargo = read('src-tauri/Cargo.toml');
assert(/\btauri\s*=\s*\{\s*version\s*=\s*"=?2(?:\.[0-9]+)*"/.test(cargo));
assert(!/electron/i.test(cargo));
assert(fs.existsSync(path.join(ROOT, 'src-tauri', 'icons', 'icon.ico')));
assert(fs.existsSync(path.join(ROOT, 'src-tauri', 'icons', 'icon.icns')));

// R10 (2026-07-30): TrayIconBuilder API contract for Tauri 2.11.5.
// `.new()` takes no args; `.with_id(I)` assigns the id. The earlier
// `.new("main-tray")` form was an E0061 compile error.
assert(lib.includes('TrayIconBuilder::with_id("main-tray")'),
  'TrayIconBuilder must use with_id("main-tray") in Tauri 2.11.5');
assert(!lib.includes('TrayIconBuilder::new("main-tray")'),
  'TrayIconBuilder::new("main-tray") is an E0061 compile error in Tauri 2.11.5');
assert(lib.includes('tray_by_id("main-tray")'),
  'shutdown path must look up tray by id via tray_by_id("main-tray")');
// app.manage(tray) is redundant when with_id is used; would create ambiguous ownership.
assert(!/app\.manage\(\s*tray\s*\)/.test(lib),
  'app.manage(tray) is redundant after with_id; remove to avoid ambiguous ownership on shutdown');

console.log(`tauri-static-smoke: ok (${copiedAssets.length} assets verified, ${commands.size} bridge commands registered)`);
