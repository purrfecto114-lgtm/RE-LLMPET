'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const pkg = JSON.parse(read('package.json'));
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
const cargo = read('src-tauri/Cargo.toml');
const model = read('src-tauri/src/model.rs');
const hookClient = read('src-tauri/src/hook_client.rs');
const hookInstall = read('src-tauri/src/hook_install.rs');
const server = read('src-tauri/src/http_server.rs');
const commands = read('src-tauri/src/commands.rs');
const platform = read('src-tauri/src/platform.rs');
const lib = read('src-tauri/src/lib.rs');
const pet = read('frontend/renderer/pet.js');
const ci = read('.github/workflows/ci.yml');
const release = read('.github/workflows/release.yml');
const providerGate = read('.github/workflows/provider-real-cli.yml');
const desktopGate = read('.github/workflows/desktop-real-machine.yml');
const realDesktopScript = read('scripts/real-desktop-gate.js');

assert.strictEqual(pkg.version, '0.5.62');
assert.strictEqual(tauri.version, '0.5.62');
assert.match(cargo, /^version = "0.5.62"/m);
assert.strictEqual(tauri.bundle.createUpdaterArtifacts, false);

for (const retired of ['main.js', 'preload.js', 'backend', 'providers', 'renderer', 'hook', 'shared']) {
  assert(!fs.existsSync(path.join(ROOT, retired)), `active Electron path remains: ${retired}`);
}
assert(!fs.existsSync(path.join(ROOT, ['legacy', 'reference'].join('-'))));
assert(fs.existsSync(path.join(ROOT, 'test/reference-contract-smoke.js')));
assert(fs.existsSync(path.join(ROOT, 'resources/model-catalog.bundled.json')));

// Claude structured interactions are PreToolUse decisions with updatedInput;
// PermissionRequest suggestions remain Claude-only and Codex remains minimal.
assert.match(hookInstall, /command_hook\(pretool, 600\)/);
assert.match(hookClient, /matches!\(tool, "AskUserQuestion" \| "ExitPlanMode"\)/);
assert.match(hookClient, /translate_claude_permission_to_pretool/);
assert.match(hookClient, /"permissionDecision"/);
assert.match(hookClient, /"updatedInput"/);
assert.match(model, /"elicitation-submit"/);
assert.match(model, /"plan-feedback"/);
assert.match(model, /permission_suggestions/);
assert.match(model, /Some\(entry\.tool_input\.clone\(\)\)/);
assert.match(pet, /elicitation-submit/);
assert.match(pet, /plan-feedback/);
const claudePayload = server.slice(server.indexOf('"claude" =>'), server.indexOf('"codex" =>'));
const codexPayload = server.slice(server.indexOf('"codex" =>'), server.indexOf('_ => json!'));
assert.match(claudePayload, /updatedInput/);
assert.match(claudePayload, /updatedPermissions/);
assert.doesNotMatch(codexPayload, /map\.insert\("(?:updatedInput|updatedPermissions)"/);

// Focus is tied to source PID ancestry; Wayland degradation is explicit.
assert.match(commands, /platform::focus_session/);
assert.match(platform, /MAX_PARENT_DEPTH/);
assert.match(platform, /process_chain\(source_pid\)/);
assert.match(platform, /SetForegroundWindow/);
assert.match(platform, /application process whose unix id/);
assert.match(platform, /xdotool/);
assert.match(platform, /unsupported on pure Wayland/);
assert.match(platform, /HEALTH_CHECK_SECS: u64 = 30/);
assert.match(lib, /RunEvent::Resumed/);
assert.match(lib, /recover_windows/);

// Current action generations, locked Rust gates and explicit signing/provenance.
for (const workflow of [ci, release, providerGate, desktopGate]) {
  assert.match(workflow, /actions\/checkout@(v7|[0-9a-f]{12})/);
  assert.match(workflow, /actions\/setup-node@(v7|[0-9a-f]{12})/);
}
assert.match(ci, /cargo check[^\n]*--locked/);
assert.match(ci, /cargo test[^\n]*--locked/);
assert.match(ci, /cargo build[^\n]*--locked/);
assert.match(release, /cargo fetch[^\n]*--locked/);
assert.match(release, /CARGO_NET_OFFLINE/);
assert.match(desktopGate, /cargo fetch[^\n]*--locked/);
assert.match(desktopGate, /CARGO_NET_OFFLINE/);
assert.match(ci, /actions\/upload-artifact@(v7|[0-9a-f]{12})/);
assert.match(release, /tauri-apps\/tauri-action@(v1|[0-9a-f]{12})/);
assert.doesNotMatch(release, /TAURI_SIGNING_PRIVATE_KEY/);
assert.match(release, /REQUIRE_PLATFORM_SIGNING/);
assert.match(release, /createUpdaterArtifacts=false/);
assert.match(release, /APPLE_CERTIFICATE/);
assert.match(release, /WINDOWS_CERTIFICATE/);
assert.match(release, /actions\/attest@(v4|[0-9a-f]{12})/g);
assert.match(providerGate, /self-hosted, provider-cli/);
assert.match(desktopGate, /-\s+self-hosted[\s\S]*-\s+desktop/);
assert.match(desktopGate, /real-desktop-gate\.js/);
assert.match(realDesktopScript, /benchmark-desktop\.js/);

for (const script of [
  'scripts/check-release-gates.js',
  'scripts/asset-visual-regression.js',
  'scripts/benchmark-desktop.js',
  'scripts/generate-checksums.js',
  'scripts/generate-sbom.js',
  'scripts/real-provider-smoke.js',
  'scripts/real-desktop-gate.js',
  'test/tauri-permission-concurrency-smoke.js'
]) assert(fs.existsSync(path.join(ROOT, script)), `missing phase4 gate: ${script}`);

const sourceGate = spawnSync(process.execPath, ['scripts/check-release-gates.js'], { cwd: ROOT, encoding: 'utf8' });
assert.strictEqual(sourceGate.status, 0, sourceGate.stderr || sourceGate.stdout);
assert.match(sourceGate.stdout, /BLOCKED resolved src-tauri\/Cargo\.lock committed|OK      resolved src-tauri\/Cargo\.lock committed/);

assert.match(model, /\"pendingChoices\":pending_choices/);
assert.match(pet, /stats && stats\.pendingChoices/);
console.log('tauri-phase4-cutover-smoke: ok');
