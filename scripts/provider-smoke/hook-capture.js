#!/usr/bin/env node
// Octopus provider-smoke hook capture shim (2026-08-30).
// Stands in for the octopus-hook binary when the release build is not yet
// available: records the raw stdin payload a provider pipes into a hook
// command, plus argv. Always exits 0 and prints nothing so observer hook
// contracts (claude/codex treat empty stdout + exit 0 as "no decision")
// behave the same as with the real binary.
'use strict';
const fs = require('fs');

const file = process.env.OCTOPUS_SMOKE_CAPTURE_FILE;
const event = process.argv[2] || 'unknown';

const chunks = [];
let done = false;
const timer = setTimeout(() => {
  if (!done) { done = true; finish('{}'); }
}, 10000);

function finish(raw) {
  clearTimeout(timer);
  let payload;
  try { payload = JSON.parse(raw); } catch { payload = { unparsable: String(raw).slice(0, 4000) }; }
  if (file) {
    try {
      fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), event, argv: process.argv.slice(2), payload }) + '\n');
    } catch { /* evidence dir gone — exit quietly */ }
  }
  process.exit(0);
}

process.stdin.on('data', (c) => {
  if (chunks.reduce((n, b) => n + b.length, 0) + c.length <= 1024 * 1024) chunks.push(c);
});
process.stdin.on('end', () => { if (!done) { done = true; finish(Buffer.concat(chunks).toString('utf8') || '{}'); } });
