'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CARGO_TOML = path.join(ROOT, 'src-tauri', 'Cargo.toml');
const LEGACY_BIN = path.join(ROOT, 'src-tauri', 'src', 'bin', 're-llmpet-hook.rs');
const NSIS_HOOKS = path.join(ROOT, 'src-tauri', 'windows', 'installer-hooks.nsh');

// 1. Cargo.toml must disable auto-discovery
const cargoToml = fs.readFileSync(CARGO_TOML, 'utf8');
assert.ok(/autobins\s*=\s*false/.test(cargoToml), 'Cargo.toml must set package autobins=false');

// 2. Legacy source must be removed (no separate binary)
assert.ok(!fs.existsSync(LEGACY_BIN), 'src-tauri/src/bin/re-llmpet-hook.rs must not exist; only canonical octopus-hook should compile');

// 3. cargo metadata must list exactly octopus and octopus-hook bins (no re-llmpet-hook)
const metaResult = spawnSync('cargo', ['metadata', '--manifest-path', path.join(ROOT, 'src-tauri', 'Cargo.toml'), '--format-version=1', '--no-deps'], { encoding: 'utf8' });
assert.strictEqual(metaResult.status, 0, `cargo metadata failed: ${metaResult.stderr}`);
const meta = JSON.parse(metaResult.stdout);
const pkg = (meta.packages || []).find(p => p.name === 'octopus');
assert.ok(pkg, 'package octopus not found in cargo metadata');
const binTargets = (pkg.targets || []).filter(t => t.kind.includes('bin')).map(t => t.name).sort();
assert.deepStrictEqual(binTargets, ['octopus', 'octopus-hook'], `cargo metadata bins must be exactly [octopus, octopus-hook], got ${JSON.stringify(binTargets)}`);

// 4. NSIS hooks must create byte-identical alias on install
const nsh = fs.readFileSync(NSIS_HOOKS, 'utf8');
assert.ok(nsh.includes('!macro NSIS_HOOK_POSTINSTALL'), 'installer-hooks.nsh must define NSIS_HOOK_POSTINSTALL');
assert.ok(nsh.includes('CopyFiles'), 'installer-hooks.nsh POSTINSTALL must use CopyFiles');
assert.ok(nsh.includes('octopus-hook.exe'), 'installer-hooks.nsh POSTINSTALL must reference octopus-hook.exe');
assert.ok(nsh.includes('re-llmpet-hook.exe'), 'installer-hooks.nsh must reference re-llmpet-hook.exe alias');

// Verify CopyFiles line maps octopus-hook -> re-llmpet-hook
const copyFilesMatch = /CopyFiles\s+.*octopus-hook\.exe.*re-llmpet-hook\.exe/s.test(nsh);
assert.ok(copyFilesMatch, 'installer-hooks.nsh POSTINSTALL must CopyFiles $INSTDIR\\octopus-hook.exe -> $INSTDIR\\re-llmpet-hook.exe');

// 5. NSIS hooks must delete alias on uninstall
assert.ok(nsh.includes('!macro NSIS_HOOK_PREUNINSTALL'), 'installer-hooks.nsh must define NSIS_HOOK_PREUNINSTALL');
assert.ok(/Delete\s+.*re-llmpet-hook\.exe/.test(nsh), 'installer-hooks.nsh PREUNINSTALL must Delete alias re-llmpet-hook.exe');

// 6. Preserve LEGACY_MARKER / LEGACY_HOOK_OWNER and main.rs legacy arg support (no regression)
const hookInstall = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'hook_install.rs'), 'utf8');
assert.ok(hookInstall.includes('LEGACY_MARKER'), 'hook_install.rs must preserve LEGACY_MARKER');
assert.ok(hookInstall.includes('LEGACY_HOOK_OWNER'), 'hook_install.rs must preserve LEGACY_HOOK_OWNER');
const mainRs = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'main.rs'), 'utf8');
assert.ok(mainRs.includes('--re-llmpet-hook'), 'src-tauri/src/main.rs must preserve legacy --re-llmpet-hook argument support');

console.log('tauri-hook-consolidation-smoke: ok');
