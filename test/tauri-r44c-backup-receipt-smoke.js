#!/usr/bin/env node
'use strict';

// R44 Phase 0C (2026-08-03) — 0.5.39 unified backup + install receipt smoke.
//
// Locks the Phase 0C deliverables:
//
//   P0C-1  Generic `backup_config_file()` helper exists and is called
//          by install_claude / install_codex / install_aider (in addition
//          to the existing CodeWhale path).
//
//   P0C-2  Backup naming is `.<stem>.re-llmpet-bak-<unix_ms>.<ext>` and
//          the `BACKUP_RETENTION` constant is 5 (count-based, not age-based).
//
//   P0C-3  `backup_config_file` returns `Result<Option<PathBuf>, String>`:
//          Ok(None) for first-install (file doesn't exist), Ok(Some(path))
//          on successful backup, Err on failure (fail-closed).
//
//   P0C-4  `backup_codewhale_config` delegates to `backup_config_file`
//          (no longer has its own copy-and-prune implementation), but
//          still sweeps legacy `-re-llmpet-backup-` files for backward
//          compat with 0.5.34–0.5.37.
//
//   P0C-5  `write_install_receipt()` exists and is called by all 5 install_*
//          functions (claude, codex, codewhale, opencode, aider).
//
//   P0C-6  Receipts go to `~/.re-llmpet/receipts/<provider>-<unix_ms>.json`
//          with fields: provider, version, installed_at, path, backup_path,
//          events, drift_signature.
//
//   P0C-7  `RECEIPT_RETENTION` is 20 (count-based cap per provider).
//
//   P0C-8  `read_install_receipts()` is a `pub fn` returning the latest
//          receipt per provider (for Phase 0D uninstall confirmation).
//
//   P0C-9  Fail-closed contract: install_codewhale still aborts on backup
//          failure with the existing "aborting install to protect existing
//          config" message; the same pattern is now applied to the other
//          providers via `?` on the `backup_config_file()` call.
//
// User requirement: "不要破坏原本 hooks（创建备份，注意备份的数量）" —
// do not break existing hooks; create backups; mind the backup count.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const hookInstall = read('src-tauri/src/hook_install.rs');
const changelog = read('CHANGELOG.md');
const packageJson = JSON.parse(read('package.json'));
const cargoToml = read('src-tauri/Cargo.toml');
const tauriConf = JSON.parse(read('src-tauri/tauri.conf.json'));

// ──────────────────────────────────────────────────────────────────────────
// Version bump
// ──────────────────────────────────────────────────────────────────────────

assert.strictEqual(packageJson.version, '0.5.39',
  'P0C: package.json version must be 0.5.39');
assert.ok(cargoToml.includes('version = "0.5.39"'),
  'P0C: Cargo.toml version must be 0.5.39');
assert.strictEqual(tauriConf.version, '0.5.39',
  'P0C: tauri.conf.json version must be 0.5.39');
assert.ok(changelog.includes('0.5.39'),
  'P0C: CHANGELOG must have 0.5.39 entry');

// ──────────────────────────────────────────────────────────────────────────
// P0C-1: Generic backup_config_file helper exists + is called everywhere
// ──────────────────────────────────────────────────────────────────────────

assert.ok(hookInstall.includes('fn backup_config_file('),
  'P0C-1: backup_config_file function must be defined');
assert.ok(hookInstall.includes('fn prune_backups('),
  'P0C-1: prune_backups helper must be defined');

// Claude, Codex, Aider must all call backup_config_file (CodeWhale still
// uses backup_codewhale_config which delegates to the generic helper).
const claudeSection = hookInstall.slice(
  hookInstall.indexOf('pub fn install_claude('),
  hookInstall.indexOf('fn uninstall_claude(')
);
assert.ok(claudeSection.includes('backup_config_file(&settings_path, runtime)?'),
  'P0C-1: install_claude must call backup_config_file (fail-closed via ?)');

const codexSection = hookInstall.slice(
  hookInstall.indexOf('fn install_codex('),
  hookInstall.indexOf('fn uninstall_codex(')
);
assert.ok(codexSection.includes('backup_config_file(&path, runtime)?'),
  'P0C-1: install_codex must call backup_config_file (fail-closed via ?)');

const aiderSection = hookInstall.slice(
  hookInstall.indexOf('fn install_aider('),
  hookInstall.indexOf('fn codewhale_config_path(')
);
assert.ok(aiderSection.includes('backup_config_file(&path, runtime)?'),
  'P0C-1: install_aider must call backup_config_file (fail-closed via ?)');

// OpenCode also calls backup_config_file (its file is owned by us, but
// a backup protects against partial writes).
const opencodeSection = hookInstall.slice(
  hookInstall.indexOf('fn install_opencode('),
  hookInstall.indexOf('fn uninstall_opencode(')
);
assert.ok(opencodeSection.includes('backup_config_file(&path, runtime)?'),
  'P0C-1: install_opencode must call backup_config_file (fail-closed via ?)');

// ──────────────────────────────────────────────────────────────────────────
// P0C-2: Backup naming + retention constant
// ──────────────────────────────────────────────────────────────────────────

assert.ok(hookInstall.includes('const BACKUP_RETENTION: usize = 5;'),
  'P0C-2: BACKUP_RETENTION must be 5 (count-based cap)');
// New naming pattern
assert.ok(hookInstall.includes('.re-llmpet-bak-'),
  'P0C-2: backup filename must use .re-llmpet-bak-<ts> pattern');
// The leading dot keeps backups hidden on Unix
assert.ok(hookInstall.includes('format!(".{stem}.re-llmpet-bak-{ts}'),
  'P0C-2: backup filename must start with . (hidden on Unix)');

// ──────────────────────────────────────────────────────────────────────────
// P0C-3: Fail-closed contract — returns Result<Option<PathBuf>, String>
// ──────────────────────────────────────────────────────────────────────────

assert.ok(
  hookInstall.includes(
    'fn backup_config_file(path: &Path, runtime: &Runtime) -> Result<Option<PathBuf>, String>'
  ),
  'P0C-3: backup_config_file signature must be Result<Option<PathBuf>, String>'
);
// Ok(None) when file doesn't exist (first install)
assert.ok(
  hookInstall.includes('if !path.exists() {\n        return Ok(None);\n    }'),
  'P0C-3: backup_config_file must return Ok(None) for non-existent file'
);
// The fail-closed error message must mention "aborted"
assert.ok(
  hookInstall.includes('Install aborted to protect existing config'),
  'P0C-3: backup failure message must mention install aborted'
);

// ──────────────────────────────────────────────────────────────────────────
// P0C-4: CodeWhale delegates to generic helper + legacy sweep
// ──────────────────────────────────────────────────────────────────────────

const cwBackupSection = hookInstall.slice(
  hookInstall.indexOf('fn backup_codewhale_config('),
  hookInstall.indexOf('fn strip_legacy_codewhale_hooks(')
);
assert.ok(cwBackupSection.includes('backup_config_file(path, runtime)?'),
  'P0C-4: backup_codewhale_config must delegate to backup_config_file');
// Legacy sweep must still be present (backward compat with 0.5.34–0.5.37)
assert.ok(cwBackupSection.includes('-re-llmpet-backup-'),
  'P0C-4: backup_codewhale_config must sweep legacy -re-llmpet-backup- files');
assert.ok(cwBackupSection.includes('BACKUP_RETENTION'),
  'P0C-4: legacy sweep must use BACKUP_RETENTION constant (not hardcoded 5)');
// Phase 0D audit fix Minor #1: backup_codewhale_config must return
// Result<Option<PathBuf>, String> so install_codewhale can propagate
// the backup path into the receipt (previously the receipt's backup_path
// was always None for CodeWhale).
assert.ok(
  cwBackupSection.includes('fn backup_codewhale_config(path: &Path, runtime: &Runtime) -> Result<Option<PathBuf>, String>'),
  'P0C-4 (audit fix): backup_codewhale_config must return Result<Option<PathBuf>, String> so receipt can record backup_path'
);
// install_codewhale must propagate the backup path (not discard it)
const codewhaleInstallSection = hookInstall.slice(
  hookInstall.indexOf('fn install_codewhale('),
  hookInstall.indexOf('fn install_codex(')
);
assert.ok(codewhaleInstallSection.includes('Ok(p) => p'),
  'P0C-4 (audit fix): install_codewhale must propagate backup path via Ok(p) => p (not Ok(()) => None)');

// ──────────────────────────────────────────────────────────────────────────
// P0C-5: write_install_receipt exists + called by all 5 install_*
// ──────────────────────────────────────────────────────────────────────────

assert.ok(hookInstall.includes('fn write_install_receipt('),
  'P0C-5: write_install_receipt function must be defined');
assert.ok(claudeSection.includes('write_install_receipt('),
  'P0C-5: install_claude must call write_install_receipt');
assert.ok(codexSection.includes('write_install_receipt('),
  'P0C-5: install_codex must call write_install_receipt');
assert.ok(opencodeSection.includes('write_install_receipt('),
  'P0C-5: install_opencode must call write_install_receipt');
assert.ok(aiderSection.includes('write_install_receipt('),
  'P0C-5: install_aider must call write_install_receipt');

const codewhaleSection = hookInstall.slice(
  hookInstall.indexOf('fn install_codewhale('),
  hookInstall.indexOf('fn install_codex(')
);
assert.ok(codewhaleSection.includes('write_install_receipt('),
  'P0C-5: install_codewhale must call write_install_receipt');

// ──────────────────────────────────────────────────────────────────────────
// P0C-6: Receipt schema — required JSON fields
// ──────────────────────────────────────────────────────────────────────────

// The receipt JSON must include these fields
const requiredFields = [
  '"provider"',
  '"version"',
  '"installed_at"',
  '"path"',
  '"backup_path"',
  '"events"',
  '"drift_signature"',
];
for (const field of requiredFields) {
  assert.ok(hookInstall.includes(field),
    `P0C-6: receipt JSON must include ${field} field`);
}

// Receipt path pattern: <provider>-<unix_ms>.json
assert.ok(
  hookInstall.includes('format!("{provider}-{ts}.json")'),
  'P0C-6: receipt filename must be <provider>-<ts>.json'
);

// ──────────────────────────────────────────────────────────────────────────
// P0C-7: RECEIPT_RETENTION constant = 20
// ──────────────────────────────────────────────────────────────────────────

assert.ok(hookInstall.includes('const RECEIPT_RETENTION: usize = 20;'),
  'P0C-7: RECEIPT_RETENTION must be 20 (per-provider count cap)');
assert.ok(hookInstall.includes('fn prune_receipts('),
  'P0C-7: prune_receipts helper must exist');
assert.ok(hookInstall.includes('found.iter().skip(RECEIPT_RETENTION)'),
  'P0C-7: prune_receipts must skip newest RECEIPT_RETENTION and remove rest');

// ──────────────────────────────────────────────────────────────────────────
// P0C-8: read_install_receipts is pub
// ──────────────────────────────────────────────────────────────────────────

assert.ok(
  hookInstall.includes('pub fn read_install_receipts() -> Map<String, Value>'),
  'P0C-8: read_install_receipts must be pub fn returning Map<String, Value>'
);

// ──────────────────────────────────────────────────────────────────────────
// P0C-9: Fail-closed contract — CodeWhale abort path preserved
// ──────────────────────────────────────────────────────────────────────────

assert.ok(
  codewhaleSection.includes('CodeWhale pre-write backup failed — aborting install to protect existing config'),
  'P0C-9: install_codewhale must retain the abort-on-backup-failure message'
);

// ──────────────────────────────────────────────────────────────────────────
// P0C-10: User-requirement traceability — comment block must exist
// ──────────────────────────────────────────────────────────────────────────

// The hook_install.rs header must reference the user requirement so future
// maintainers can trace WHY every install path now backs up.
assert.ok(
  hookInstall.includes('不要破坏原本 hooks'),
  'P0C-10: hook_install.rs must quote the user requirement 不要破坏原本 hooks'
);
assert.ok(
  hookInstall.includes('创建备份') && hookInstall.includes('备份的数量'),
  'P0C-10: hook_install.rs must reference 创建备份 and 备份的数量'
);

// ──────────────────────────────────────────────────────────────────────────
// P0C-11: Backward compat — legacy markers still detected
// ──────────────────────────────────────────────────────────────────────────

// OPENCODE_MARKER_LEGACY must still exist for old plugin cleanup
assert.ok(hookInstall.includes('OPENCODE_MARKER_LEGACY'),
  'P0C-11: OPENCODE_MARKER_LEGACY must still exist for backward compat');
// HOOK_OWNER tag must still exist (R41 ownership check)
assert.ok(hookInstall.includes('const HOOK_OWNER: &str = "--owner re-llmpet";'),
  'P0C-11: HOOK_OWNER constant must still exist');

console.log('✓ R44 Phase 0C (0.5.39) backup + receipt smoke: all assertions passed');
