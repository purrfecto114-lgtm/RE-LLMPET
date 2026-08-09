'use strict';

// R8 forward-compat smoke: CodeWhale v0.9.5+ consolidates codewhale-tui into codewhale
// (single runtime). The MISSING_COMPANION_BINARY guard must NOT hard-fail — it should
// warn and let the doctor probe fall back to the dispatcher.
//
// This test locks:
//   1. resolve_agent does NOT return Err for missing companion (no `return Err` in the
//      companion check block).
//   2. The companion check emits a warning (eprintln) instead of an error.
//   3. diagnose_agent_sync pushes MISSING_COMPANION_BINARY to warnings (not issues).
//   4. The doctor probe handles None companion via should_try_dispatcher fallback.
//   5. The MISSING_COMPANION_BINARY string is preserved (for audit trail).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const commands = read('src-tauri/src/commands.rs');

// ── 1. resolve_agent: no hard-fail on missing companion ──
const resolveAgent = commands.slice(
  commands.indexOf('fn resolve_agent'),
  commands.indexOf('fn redact_sensitive_line')
);
assert.ok(resolveAgent.length > 0, 'resolve_agent function must exist');

// Must NOT contain `return Err` in the companion check
const companionCheck = resolveAgent.slice(
  resolveAgent.indexOf('if spec.id == "codewhale" && companion_for'),
  resolveAgent.indexOf('Ok(executable)')
);
assert.ok(companionCheck.length > 0, 'companion check block must exist');
assert(!companionCheck.includes('return Err'),
  'resolve_agent must NOT return Err for missing companion (v0.9.5+ forward-compat)');

// Must contain a warning (eprintln)
assert(companionCheck.includes('eprintln'),
  'resolve_agent must emit eprintln warning for missing companion (not silent)');

// ── 2. diagnose_agent_sync: MISSING_COMPANION_BINARY is a warning, not an issue ──
const diagSection = commands.slice(
  commands.indexOf('if spec.id == "codewhale" && executable.is_some() && companion.is_none()'),
  commands.indexOf('let version = executable')
);
assert.ok(diagSection.length > 0, 'diagnose_agent_sync companion check must exist');
assert(diagSection.includes('warnings.push') && diagSection.includes('MISSING_COMPANION_BINARY'),
  'MISSING_COMPANION_BINARY must be pushed to warnings (not issues) for v0.9.5+ forward-compat');
assert(!diagSection.includes('issues.push'),
  'MISSING_COMPANION_BINARY must NOT be pushed to issues (was blocking, now advisory)');

// ── 3. Doctor probe handles None companion ──
assert(commands.includes('should_try_dispatcher'),
  'codewhale_doctor_probe must have should_try_dispatcher fallback for None companion');
assert(commands.includes('companion_is_definitive'),
  'codewhale_doctor_probe must check companion_is_definitive before fallback');

// ── 4. MISSING_COMPANION_BINARY string preserved for audit trail ──
assert(commands.includes('MISSING_COMPANION_BINARY'),
  'MISSING_COMPANION_BINARY string must be preserved in source for audit trail');

// ── 5. Forward-compat comment references v0.9.5 ──
assert(commands.includes('v0.9.5'),
  'source must reference v0.9.5 in forward-compat comment for maintainer discoverability');

console.log('tauri-codewhale-v095-forward-compat-r8-smoke: ok (MISSING_COMPANION_BINARY softened to warning + dispatcher fallback verified)');
