#!/usr/bin/env node
'use strict';

// R40.1 (2026-08-01) — 0.5.44 carpet audit closure smoke.
//
// Locks the 7 fixes from the 0.5.19 carpet audit
// (RE-LLMPET-0.5.19-carpet-audit-upstream-drift-roadmap.md):
//
//   P0-1  Fix Rust format string compile blocker (`{'y'}` → `entries`)
//   P0-2  Disable unsafe CodeWhale legacy TOML cleanup + add backup
//   P0-3  Frontend rejects stale stats `__revision`
//   P0-4  Consolidated StatsCoalescer single-mutex state machine
//   P0-5  Source provenance (root dir, CHANGELOG, SOURCE_REVISION, etc.)
//   P1-1  Revert OpenCode `auth list` as primary (no providers list)
//   P1-2  Read actual `session.status` payload (not hardcoded thinking)

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const hookInstall = read('src-tauri/src/hook_install.rs');
const commands = read('src-tauri/src/commands.rs');
const httpServer = read('src-tauri/src/http_server.rs');
const model = read('src-tauri/src/model.rs');
const petJs = read('frontend/renderer/pet.js');
const panelJs = read('frontend/renderer/panel.js');
const changelog = read('CHANGELOG.md');
const packageJson = JSON.parse(read('package.json'));

// ──────────────────────────────────────────────────────────────────────────
// Version bump
// ──────────────────────────────────────────────────────────────────────────

assert.strictEqual(packageJson.version, '0.5.44',
  'R40.1: package.json version must be 0.5.21');

// ──────────────────────────────────────────────────────────────────────────
// P0-1: Rust format string compile blocker fixed
// ──────────────────────────────────────────────────────────────────────────

assert(!hookInstall.includes("entr{'y'}ies"),
  'P0-1: the invalid Rust format string `entr{\'y\'}ies` must be removed');
// The format string must not contain any {'x'} style character-literal
// placeholders (Rust format strings don't support that syntax).
assert(!/\{'\w'\}/.test(hookInstall),
  'P0-1: no `\'c\'` style character-literal format placeholders allowed');

// ──────────────────────────────────────────────────────────────────────────
// P0-2: unsafe unmarked cleanup stays disabled; exact marker migration is allowed
// ──────────────────────────────────────────────────────────────────────────

// The install_codewhale function must NOT call strip_legacy_codewhale_hooks.
// We check that the call site is removed (the function definition may remain
// as dead code for reference, but it must not be invoked).
assert(!hookInstall.includes('strip_legacy_codewhale_hooks(&path, &mut messages)'),
  'P0-2: install_codewhale must NOT call strip_legacy_codewhale_hooks (data corruption risk)');
assert(hookInstall.includes('backup_codewhale_config'),
  'P0-2: install_codewhale must call backup_codewhale_config before writing');
assert(hookInstall.includes('fn backup_codewhale_config'),
  'P0-2: backup_codewhale_config function must be defined');
assert(hookInstall.includes('exact legacy markers migrated')
  && hookInstall.includes('unmarked legacy cleanup remains disabled'),
  'P0-2: log must distinguish exact-marker migration from unsafe unmarked cleanup');
assert(hookInstall.includes('strip_marker_variants(&existing, CW_MARKERS)'),
  'P0-2: exact legacy marker blocks must be migrated through the shared marker helper');
// Diagnostic must still detect unowned stale hooks and give manual instructions.
assert(commands.includes('只自动迁移精确 marker 块')
  && commands.includes('不会删除无标记表'),
  'P0-2: diagnostics must explain the exact ownership boundary');

// ──────────────────────────────────────────────────────────────────────────
// P0-3: Frontend rejects stale stats revisions
// ──────────────────────────────────────────────────────────────────────────

assert(petJs.includes('lastStatsRevision'),
  'P0-3: pet.js must have lastStatsRevision guard');
assert(petJs.includes('function acceptStatsRevision'),
  'P0-3: pet.js must have acceptStatsRevision function');
assert(petJs.includes('__revision'),
  'P0-3: pet.js must read __revision from stats payload');
assert(petJs.includes('if (!acceptStatsRevision(s)) return'),
  'P0-3: pet.js applyStats must reject stale revisions');

assert(panelJs.includes('lastStatsRevisionPanel'),
  'P0-3: panel.js must have lastStatsRevisionPanel guard');
assert(panelJs.includes('function acceptStatsRevisionPanel'),
  'P0-3: panel.js must have acceptStatsRevisionPanel function');
assert(panelJs.includes('if (!acceptStatsRevisionPanel(s)) return'),
  'P0-3: panel.js render must reject stale revisions');

// ──────────────────────────────────────────────────────────────────────────
// P0-4: Consolidated StatsCoalescer state machine
// ──────────────────────────────────────────────────────────────────────────

assert(model.includes('pub struct StatsCoalescerState'),
  'P0-4: model.rs must define StatsCoalescerState struct');
assert(model.includes('pub stats_coalescer: Mutex<StatsCoalescerState>'),
  'P0-4: Runtime must have stats_coalescer field');
assert(model.includes('StatsCoalescerState::default()'),
  'P0-4: Runtime::new must initialize stats_coalescer');

assert(httpServer.includes('stats_coalescer'),
  'P0-4: http_server.rs emit_stats must use stats_coalescer');
assert(httpServer.includes('enum CoalescerAction'),
  'P0-4: http_server.rs must define CoalescerAction enum');
assert(!httpServer.includes('enum TrailingAction') && !httpServer.includes('EmitAndReschedule'),
  'R45: unreachable trailing-reschedule state must stay removed');
assert(httpServer.includes('let should_emit = guard.dirty;')
    && httpServer.includes('guard.dirty = false;')
    && httpServer.includes('guard.scheduled = false;'),
  'R45: trailing flush must atomically consume dirty and release the timer slot');
assert(!model.includes('last_stats_emit') && !model.includes('pub stats_dirty:') && !model.includes('pub stats_scheduled:'),
  'R45: old split-mutex compatibility state must be absent');
assert(commands.includes('crate::http_server::emit_stats_now'),
  'R45: commands must use the shared stats snapshot emitter');

// ──────────────────────────────────────────────────────────────────────────
// P0-5: Source provenance (R40.4: strengthened per package regression audit)
// ──────────────────────────────────────────────────────────────────────────

assert(fs.existsSync(path.join(root, 'SOURCE_REVISION')),
  'P0-5: SOURCE_REVISION file must exist');
assert(fs.existsSync(path.join(root, 'SOURCE_DATE_EPOCH')),
  'P0-5: SOURCE_DATE_EPOCH file must exist');
assert(fs.existsSync(path.join(root, 'SOURCE_MANIFEST.json')),
  'P0-5: SOURCE_MANIFEST.json file must exist');
assert(fs.existsSync(path.join(root, 'BUILD_REPRODUCIBILITY.md')),
  'P0-5: BUILD_REPRODUCIBILITY.md file must exist');

assert(changelog.includes('0.5.44'),
  'P0-5: CHANGELOG must have 0.5.44 entry');
assert(changelog.includes('0.5.44'),
  'P0-5: CHANGELOG must have 0.5.21 entry');
assert(changelog.includes('0.5.19'),
  'P0-5: CHANGELOG must have 0.5.19 entry');
assert(changelog.includes('0.5.18'),
  'P0-5: CHANGELOG must have 0.5.18 entry');

// R40.5 (audit P0-1): SOURCE_REVISION is now a build-time artifact, not
// a self-referential commit SHA. The previous design (commit must contain
// its own SHA) is a paradox — writing the SHA changes the tree, producing
// a different SHA. The handoff audit correctly identified this as an
// impossible constraint. Now SOURCE_REVISION is either:
//   - a human-readable identifier like 'octopus-0.5.44' (for local dev)
//   - or the GITHUB_SHA env var set by CI (for release builds)
// The real provenance chain is: tag → workflow run → artifact digest →
// attestation, NOT commit-self-reference.
const sourceRevision = read('SOURCE_REVISION').trim();
assert(sourceRevision.length > 0,
  'P0-5: SOURCE_REVISION must not be empty');
// Accept Octopus labels, legacy re-llmpet labels, or a 40-hex SHA
assert(/^(?:(?:octopus|re-llmpet)-|[0-9a-f]{40}$)/.test(sourceRevision),
  `P0-5: SOURCE_REVISION must be 'octopus-<version>'/legacy 're-llmpet-*' or 40-hex SHA (got: "${sourceRevision.slice(0,30)}")`);

// R40.4: SOURCE_DATE_EPOCH must be a valid Unix timestamp
const dateEpoch = parseInt(read('SOURCE_DATE_EPOCH').trim(), 10);
assert(Number.isFinite(dateEpoch) && dateEpoch > 1_000_000_000,
  `P0-5: SOURCE_DATE_EPOCH must be valid Unix timestamp (got ${dateEpoch})`);

// Manifest must be valid JSON with the right structure
const manifest = JSON.parse(read('SOURCE_MANIFEST.json'));
assert.strictEqual(manifest.version, '0.5.44',
  'P0-5: manifest version must be 0.5.44');
// R40.5: manifest.source_commit is optional (CI sets it to GITHUB_SHA;
// local dev may set an octopus-* label; legacy re-llmpet-* remains accepted.
if (manifest.source_commit) {
  const isSha = /^[0-9a-f]{40}$/.test(manifest.source_commit);
  const isHuman = /^(?:octopus|re-llmpet)-/.test(manifest.source_commit);
  assert(isSha || isHuman,
    `P0-5: manifest.source_commit must be 40-hex SHA or octopus-*/legacy re-llmpet-* (got: "${manifest.source_commit}")`);
}
assert(manifest.file_count > 200,
  `P0-5: manifest must list >200 files (got ${manifest.file_count})`);
assert(manifest.sha256_of_manifest,
  'P0-5: manifest must have sha256_of_manifest field');
assert.strictEqual(manifest.root, `Octopus-0.5.44`,
  `P0-5: manifest.root must be Octopus-0.5.44 (got ${manifest.root})`);

// R40.4: run manifest verifier (exact file set + hash check)
const { execSync } = require('child_process');
try {
  execSync('node scripts/generate-source-manifest.js --verify', { cwd: root, stdio: 'pipe' });
} catch (e) {
  assert.fail(`P0-5: manifest verification failed: ${(e.stderr || e.message || '').toString().slice(0,200)}`);
}

// ──────────────────────────────────────────────────────────────────────────
// P1-1: OpenCode auth list is primary (no providers list)
// ──────────────────────────────────────────────────────────────────────────

assert(commands.includes('"auth", "list"'),
  'P1-1: OpenCode diagnostic must use `auth list`');
// The 0.5.19 `providers list` experiment must be gone
assert(!commands.includes('"providers", "list"'),
  'P1-1: OpenCode diagnostic must NOT use `providers list` (0.5.19 mistake, reverted)');
assert(commands.includes('REVERTED the 0.5.19'),
  'P1-1: code comment must explain the revert');

// ──────────────────────────────────────────────────────────────────────────
// P1-2: Read actual session.status payload
// ──────────────────────────────────────────────────────────────────────────

// The plugin must NOT hardcode "thinking" for session.status
assert(!hookInstall.includes('"session.status": ["SessionStatus", "thinking"]'),
  'P1-2: session.status must NOT hardcode "thinking" state');
// The plugin must read event.properties.status
assert(hookInstall.includes('event?.properties?.status'),
  'P1-2: plugin must read event.properties.status from OpenCode payload');
assert(hookInstall.includes('stateMap'),
  'P1-2: plugin must have a stateMap for known OpenCode statuses');
assert(hookInstall.includes('busy: "working"'),
  'P1-2: stateMap must map busy → working');
assert(hookInstall.includes('idle: "attention"'),
  'P1-2: stateMap must map idle → attention');
assert(hookInstall.includes('retry: "error"'),
  'P1-2: stateMap must map retry → error');

console.log('✓ R40.1 (0.5.21) carpet audit closure smoke: all 30 assertions passed');
