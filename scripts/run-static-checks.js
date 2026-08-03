#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const candidates = process.platform === 'win32'
  ? [['py', ['-3']], ['python', []], ['python3', []]]
  : [['python3', []], ['python', []], ['py', ['-3']]];

function findPython3() {
  for (const [command, prefixArgs] of candidates) {
    const probe = spawnSync(command, [...prefixArgs, '--version'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const version = `${probe.stdout || ''}${probe.stderr || ''}`.trim();
    if (probe.status === 0 && /^Python 3(?:\.|$)/.test(version)) {
      return { command, prefixArgs };
    }
  }
  return null;
}

const python = findPython3();
if (!python) {
  console.error('check:static requires Python 3 (tried platform Python command aliases).');
  process.exit(1);
}

for (const script of ['scripts/static-check.py', 'scripts/rust-structure-smoke.py']) {
  const result = spawnSync(
    python.command,
    [...python.prefixArgs, script],
    { cwd: root, stdio: 'inherit', windowsHide: true }
  );
  if (result.error) {
    console.error(`Failed to run ${script}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}
