#!/usr/bin/env node
// Claude smoke decision shim (2026-08-30): records the hook payload AND, when
// CLAUDE_SMOKE_DECISION is set (allow|deny|ask) and the event is PreToolUse,
// emits the current hookSpecificOutput decision schema on stdout so we can
// verify Claude Code 2.1.251 genuinely honors the documented protocol.
'use strict';
const fs = require('fs');

const file = process.env.OCTOPUS_SMOKE_CAPTURE_FILE;
const event = process.argv[2] || 'unknown';
const decision = process.env.CLAUDE_SMOKE_DECISION || '';

const chunks = [];
let done = false;
const timer = setTimeout(() => { if (!done) { done = true; finish('{}'); } }, 12000);
function finish(raw) {
  clearTimeout(timer);
  let payload;
  try { payload = JSON.parse(raw); } catch { payload = { unparsable: String(raw).slice(0, 4000) }; }
  let stdout = '';
  if ((event === 'PreToolUse' || event === 'PermissionRequest') && ['allow', 'deny', 'ask'].includes(decision)) {
    stdout = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: decision,
        permissionDecisionReason: `octopus-smoke-${decision}`,
      },
    });
  }
  if (file) {
    try {
      fs.appendFileSync(file, JSON.stringify({
        ts: new Date().toISOString(), event, decision: decision || null,
        emitted: stdout || null, payload,
      }) + '\n');
    } catch { /* gone */ }
  }
  process.stdout.write(stdout);
  process.exit(0);
}
process.stdin.on('data', (c) => { if (chunks.reduce((n, b) => n + b.length, 0) + c.length <= 1024 * 1024) chunks.push(c); });
process.stdin.on('end', () => { if (!done) { done = true; finish(Buffer.concat(chunks).toString('utf8') || '{}'); } });
