#!/usr/bin/env node
// R51 (2026-08-30) — provider hooks real-CLI smoke regression guard.
//
// Locks in the conclusions of the 0.6.1 provider hooks smoke round:
//   1. the provider-smoke harness exists and drives REAL CLIs (no fixture
//      inference — real-provider-smoke.js contracts stay strict);
//   2. codex CODEX_EVENTS carries Interrupt and still carries the live
//      Stop/UserPromptSubmit events (both re-verified against codex 0.151);
//   3. hook_client maps codex Interrupt -> Stop/attention and carries the
//      three CodeWhale env vars added from the verified HOOKS.md contract;
//   4. the drift checker classifies transport blocks (401/403/429/5xx) as
//      blocked, not content drift, while strict-network still fails on
//      unreachable hosts;
//   5. the curated evidence reports for this round are committed with the
//      honest codex outcome preserved (failed, not faked).
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  r51-smoke: ${name}`);
  if (!ok) failures += 1;
};
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// --- 1. smoke harness files ---------------------------------------------
const smokeDir = path.join(root, 'scripts', 'provider-smoke');
for (const f of ['collector.js', 'mock-llm.js', 'mock-anthropic.js', 'hook-capture.js', 'claude-decide-shim.js', 'run-claude.sh', 'run-opencode.sh', 'run-codex.sh']) {
  check(`scripts/provider-smoke/${f} exists`, fs.existsSync(path.join(smokeDir, f)));
}
if (process.platform !== 'win32') {
  for (const f of ['run-claude.sh', 'run-opencode.sh', 'run-codex.sh']) {
    try { fs.accessSync(path.join(smokeDir, f), fs.constants.X_OK); check(`${f} executable`, true); }
    catch { check(`${f} executable`, false); }
  }
}
const opencodeDriver = read('scripts/provider-smoke/run-opencode.sh');
check('run-opencode.sh extracts the exact shipped plugin source at runtime', /opencode_plugin_source[\s\S]*hook_install\.rs/.test(opencodeDriver));
check('run-opencode.sh bridges through the /state collector contract', opencodeDriver.includes('41330') && opencodeDriver.includes('.re-llmpet/runtime.json'));
check('run-claude.sh drives the real claude binary with decisions', /claude -p/.test(read('scripts/provider-smoke/run-claude.sh')) && fs.readFileSync(path.join(smokeDir, 'claude-decide-shim.js'), 'utf8').includes('permissionDecision'));

// --- 2. CODEX_EVENTS carries the verified set ---------------------------
const installer = read('src-tauri/src/hook_install.rs');
const codexMatch = installer.match(/const CODEX_EVENTS:\s*\[&str;\s*\d+\]\s*=\s*\[([\s\S]*?)\];/);
check('CODEX_EVENTS array present', Boolean(codexMatch));
if (codexMatch) {
  const events = [...codexMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  check('CODEX_EVENTS includes Interrupt (R51)', events.includes('Interrupt'));
  check('CODEX_EVENTS keeps Stop and UserPromptSubmit (live-verified on 0.151)', events.includes('Stop') && events.includes('UserPromptSubmit'));
  check('CODEX_EVENTS keeps PermissionRequest', events.includes('PermissionRequest'));
}

// --- 3. hook_client mappings --------------------------------------------
const hookClient = read('src-tauri/src/hook_client.rs');
check('codex Interrupt normalized to Stop/attention', /native_event == "Interrupt"[\s\S]*?"Stop"[\s\S]*?"attention"/.test(hookClient));
for (const envName of ['DEEPSEEK_TOOL_EXIT_CODE', 'DEEPSEEK_TOTAL_TOKENS', 'DEEPSEEK_SESSION_COST']) {
  check(`CodeWhale env fallback carries ${envName}`, hookClient.includes(envName));
}

// --- 4. drift checker blocked classification ---------------------------
const drift = read('scripts/check-protocol-drift.js');
check('drift checker classifies 401/403/429/5xx as blocked', drift.includes('[401, 403, 429]') && drift.includes('>= 500'));
check('drift checker keeps strict-network failure for unreachable hosts', /strictNetwork && networkInconclusive/.test(drift));
const baseline = JSON.parse(read('protocol-baseline.json'));
check('baseline codexEvents include Interrupt', baseline.localContracts.codexEvents.includes('Interrupt'));
check('baseline codex-hooks entry documents the 403 block', /codex-hooks/.test(JSON.stringify(baseline)) && (baseline.remoteContracts.find((c) => c.id === 'codex-hooks') || {}).note != null);
check('baseline tracks the 2026-08-30 upstream head', baseline.sourceFork.observedAt === '2026-08-30' && baseline.sourceFork.observedMainCommit.startsWith('11ff1ba'));

// --- 5. curated evidence with the honest codex outcome -------------------
const claudeReport = JSON.parse(read('reports/provider-smoke/0.6.1/claude-pass.json'));
check('claude smoke report committed and passed', claudeReport.status === 'passed' && claudeReport.cliVersion.includes('2.1.251'));
check('claude smoke report shows allow/deny/ask decisions', ['allow', 'deny', 'ask'].every((d) => claudeReport.permissionDecisions.includes(d)));
const opencodeReport = JSON.parse(read('reports/provider-smoke/0.6.1/opencode-pass.json'));
check('opencode smoke report committed and passed (native-only permission)', opencodeReport.status === 'passed' && opencodeReport.permissionMode === 'native-only');
const codexReport = JSON.parse(read('reports/provider-smoke/0.6.1/codex-fail-honest.json'));
check('codex smoke report preserves the honest failed status', codexReport.status === 'failed' && codexReport.errors.some((e) => /permission decisions/.test(e)));
check('codex smoke report still captured lifecycle events', ['session-start', 'tool', 'turn-end'].every((e) => codexReport.events.includes(e)));

// --- 6. version coherence ----------------------------------------------
const pkg = JSON.parse(read('package.json'));
check('package.json at 0.6.1', pkg.version === '0.6.1');
check('tauri.conf.json at 0.6.1', JSON.parse(read('src-tauri/tauri.conf.json')).version === '0.6.1');
check('Cargo.toml at 0.6.1', /^version = "0\.6\.1"$/m.test(read('src-tauri/Cargo.toml')));
check('migration-todo release at 0.6.1', JSON.parse(read('migration-todo.json')).release === '0.6.1');

// --- 7. aider dash-form emission (live-verified breakage fix) -------------
check('install_aider emits notifications-command (dash form)', /notifications: true\\nnotifications-command: /.test(installer));
check('run-aider.sh documents the underscore exit(2) evidence', read('scripts/provider-smoke/run-aider.sh').includes('unrecognized arguments'));

if (failures) {
  console.error(`r51-smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log('r51-smoke: all checks passed');
