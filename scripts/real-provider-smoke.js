#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function value(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
function fail(message, report) {
  if (report) fs.writeFileSync(report, JSON.stringify({ schemaVersion: 1, status: 'failed', error: message }, null, 2) + '\n');
  console.error(`real-provider-smoke: ${message}`);
  process.exit(1);
}
const provider = String(value('--provider') || '').toLowerCase();
const contracts = {
  claude: { events: ['session-start', 'tool', 'turn-end'], decisions: ['allow', 'deny', 'ask'] },
  codewhale: { events: ['session-start', 'tool', 'turn-end'], decisions: ['allow', 'deny', 'ask'] },
  codex: { events: ['session-start', 'tool', 'turn-end'], decisions: ['allow', 'deny'], trustReview: true },
  opencode: { events: ['session-start', 'tool', 'turn-end'], permissionMode: 'native-only' },
  aider: { events: ['turn-end'], permissionMode: 'native-only' }
};
if (!contracts[provider]) fail(`unsupported provider ${provider || '(missing)'}`);
const command = process.env.OCTOPUS_PROVIDER_SMOKE_COMMAND;
if (!command) fail('OCTOPUS_PROVIDER_SMOKE_COMMAND is required; no real CLI result will be inferred from fixtures');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const report = path.resolve(`reports/provider-real-${provider}-${stamp}.json`);
const home = fs.mkdtempSync(path.join(os.tmpdir(), `octopus-${provider}-`));
const evidence = path.join(home, 'provider-evidence.json');
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local', 'share'),
  OCTOPUS_PROVIDER: provider,
  OCTOPUS_PROVIDER_EVIDENCE: evidence,
  RE_LLMPET_HOOK_BINARY: path.resolve('src-tauri/target/release/octopus-hook' + (process.platform === 'win32' ? '.exe' : '')),
  OCTOPUS_APP_BINARY: path.resolve('src-tauri/target/release/octopus' + (process.platform === 'win32' ? '.exe' : ''))
};
fs.mkdirSync(path.dirname(report), { recursive: true });
const run = spawnSync(command, { cwd: process.cwd(), env, shell: true, encoding: 'utf8', timeout: 30 * 60 * 1000 });
if (run.error) fail(`contract command could not start: ${run.error.message}`, report);
if (run.status !== 0) fail(`contract command exited ${run.status}: ${(run.stderr || run.stdout || '').slice(-4000)}`, report);
if (!fs.existsSync(evidence)) fail(`contract command did not write ${evidence}`, report);
let raw;
try { raw = JSON.parse(fs.readFileSync(evidence, 'utf8')); }
catch (error) { fail(`invalid provider evidence JSON: ${error.message}`, report); }

const contract = contracts[provider];
const normalizedEvents = new Set((raw.events || []).map((event) => String(event).toLowerCase()));
const missingEvents = contract.events.filter((event) => !normalizedEvents.has(event));
const normalizedDecisions = new Set((raw.permissionDecisions || []).map((decision) => String(decision).toLowerCase()));
const missingDecisions = (contract.decisions || []).filter((decision) => !normalizedDecisions.has(decision));
const errors = [];
if (raw.provider !== provider) errors.push(`provider must be ${provider}`);
if (!String(raw.cliVersion || '').trim()) errors.push('cliVersion is required');
if (missingEvents.length) errors.push(`missing events: ${missingEvents.join(', ')}`);
if (missingDecisions.length) errors.push(`missing permission decisions: ${missingDecisions.join(', ')}`);
if (contract.trustReview && raw.trustReviewed !== true) errors.push('Codex /hooks trust review was not recorded');
if (contract.permissionMode && raw.permissionMode !== contract.permissionMode) errors.push(`permissionMode must be ${contract.permissionMode}`);
if (!Array.isArray(raw.commandTranscripts) || raw.commandTranscripts.length === 0) errors.push('at least one redacted command transcript is required');

const output = {
  schemaVersion: 1,
  status: errors.length ? 'failed' : 'passed',
  provider,
  platform: process.platform,
  arch: process.arch,
  isolatedHome: true,
  cliVersion: raw.cliVersion || null,
  events: [...normalizedEvents],
  permissionDecisions: [...normalizedDecisions],
  permissionMode: raw.permissionMode || null,
  trustReviewed: raw.trustReviewed === true,
  commandTranscripts: raw.commandTranscripts || [],
  errors,
  stdoutTail: String(run.stdout || '').slice(-4000),
  stderrTail: String(run.stderr || '').slice(-4000),
  completedAt: new Date().toISOString()
};
fs.writeFileSync(report, JSON.stringify(output, null, 2) + '\n');
if (errors.length) fail(errors.join('; '));
console.log(`real-provider-smoke: passed ${provider} ${output.cliVersion} -> ${report}`);
