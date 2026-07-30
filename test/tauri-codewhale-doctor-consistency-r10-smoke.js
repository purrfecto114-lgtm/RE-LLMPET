#!/usr/bin/env node
'use strict';

// R10 (2026-07-30) — CodeWhale doctor ordering cross-source consistency gate.
//
// Background: docs/CODEWHALE.md, the R5 autonomous deep-dive report and the
// R5 TODO all say "doctor belongs to codewhale-tui; run codewhale-tui doctor
// --json directly, do not depend on the dispatcher compatibility alias".
// Earlier rounds shipped Rust + PowerShell + 3 smoke tests that were
// dispatcher-first, contradicting the docs and producing one meaningless
// first failure per diagnostic. R10 reversed the order to companion-first
// with dispatcher fallback. This test locks the docs/impl/PowerShell/test
// quadruple together so the divergence cannot silently come back.
//
// See docs/MIGRATION_R10_CODEWHALE_DOCTOR_ORDER_2026-07-30.md for the full
// decision record, including the web cross-validation caveat that
// CodeWhale's own RUNTIME_API.md labels `codewhale doctor --json` the
// canonical Capability endpoint.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const commands = read('src-tauri/src/commands.rs');
const ps = read('scripts/windows-cli-diagnostics.ps1');
const codewhaleDoc = read('docs/CODEWHALE.md');
const r5Report = read('docs/MIGRATION_R5_AUTONOMOUS_DEEP_DIVE_2026-07-29.md');
const r5Todo = read('docs/MIGRATION_R5_TODOLIST.md');
const r10Record = read('docs/MIGRATION_R10_CODEWHALE_DOCTOR_ORDER_2026-07-30.md');

const checks = [
  // ── Rust implementation ──────────────────────────────────────────────────
  ['Rust codewhale_doctor_probe is defined', commands.includes('fn codewhale_doctor_probe(')],
  ['Rust probes companion before dispatcher (companion_capture is the first capture built)',
   commands.includes('let mut companion_capture = companion.map(') &&
   commands.includes('let should_try_dispatcher = !companion_is_definitive')],
  ['Rust still records dispatcher attempts for auditability', commands.includes('"surface": "dispatcher"')],
  ['Rust still records companion attempts for auditability', commands.includes('"surface": "companion"')],
  ['Rust returns companion surface on success', commands.includes('surface: Some("companion")')],
  ['Rust falls back to dispatcher surface when companion is unknown command', commands.includes('surface: Some("dispatcher")')],
  ['Rust keeps the unknown-command detector used by the fallback decision', commands.includes('probe_indicates_unknown_command')],
  ['Rust keeps MISSING_COMPANION_BINARY hard error for incomplete installs', commands.includes('MISSING_COMPANION_BINARY')],

  // ── PowerShell mirror ────────────────────────────────────────────────────
  ['PowerShell probes codewhale-tui before codewhale (companion block first)',
   ps.indexOf("if ($agents['codewhale-tui'].found)") < ps.indexOf("if ($needsDispatcherDoctor -and $agents['codewhale'].found)")],
  ['PowerShell records both surfaces', ps.includes("surface = 'companion'") && ps.includes("surface = 'dispatcher'")],
  ['PowerShell keeps Test-UnknownCommandProbe + Test-ParseableJsonProbe', ps.includes('Test-UnknownCommandProbe') && ps.includes('Test-ParseableJsonProbe')],
  ['PowerShell mentions R10 decision record so maintainers find the rationale', ps.includes('R10 (2026-07-30): probe the matched codewhale-tui companion FIRST')],

  // ── Documentation alignment ──────────────────────────────────────────────
  ['CODEWHALE.md still describes the canonical companion-first ordering',
   codewhaleDoc.includes('codewhale-tui doctor --json')],
  ['R5 autonomous deep-dive still describes doctor as a TUI subcommand',
   r5Report.includes('CodeWhale doctor 的真实命令边界') && r5Report.includes('codewhale-tui doctor --json')],
  ['R5 TODO still records the companion-first fix as completed',
   r5Todo.includes('按当前 CodeWhale 命令边界修正 doctor')],
  ['R10 decision record exists and cites the web cross-validation caveat',
   r10Record.includes('companion-first') &&
   r10Record.includes('RUNTIME_API.md') &&
   r10Record.includes('dispatcher fallback')],

  // ── Smoke-test suite alignment (other tests must agree) ──────────────────
  ['r3 smoke now asserts companion-first', read('test/tauri-cli-hardening-r3-smoke.js').includes('companion-first fallback chain')],
  ['r5 smoke now asserts companion-first', read('test/tauri-cli-diagnostics-r5-smoke.js').includes('companion-first dispatcher fallback')],
  ['r7 smoke now asserts companion-first in both Rust and PowerShell',
   read('test/tauri-cli-resilience-r7-smoke.js').includes('matched companion surface') &&
   read('test/tauri-cli-resilience-r7-smoke.js').includes('companion-first fallback')],
];

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) {
    console.error(`FAIL: ${name}`);
    failed++;
  }
}
if (failed) {
  console.error(`tauri-codewhale-doctor-consistency-r10-smoke: FAIL ${failed}/${checks.length}`);
  process.exit(1);
}
console.log(`tauri-codewhale-doctor-consistency-r10-smoke: ok (${checks.length} checks)`);
