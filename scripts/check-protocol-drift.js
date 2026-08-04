'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const baselinePath = path.join(root, 'protocol-baseline.json');
const reportFlag = process.argv.indexOf('--report');
const reportPath = reportFlag >= 0
  ? path.resolve(root, process.argv[reportFlag + 1] || '')
  : path.join(root, 'reports', 'protocol-drift.json');
if (reportFlag >= 0 && !process.argv[reportFlag + 1]) throw new Error('--report requires a path');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const remoteEnabled = process.argv.includes('--remote');
const strictNetwork = process.argv.includes('--strict-network');

function parseRustStringArray(source, name) {
  const re = new RegExp(`const\\s+${name}\\s*:\\s*\\[&str;\\s*\\d+\\]\\s*=\\s*\\[([\\s\\S]*?)\\];`);
  const match = source.match(re);
  if (!match) throw new Error(`Rust array not found: ${name}`);
  return [...match[1].matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map((entry) => JSON.parse(`"${entry[1]}"`));
}

function parseNodeEvents(source) {
  const match = source.match(/const EVENTS = \[([\s\S]*?)\];/);
  if (!match) throw new Error('Node EVENTS array not found');
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

function compareArray(id, actual, expected) {
  const missing = expected.filter((item) => !actual.includes(item));
  const unexpected = actual.filter((item) => !expected.includes(item));
  const orderChanged = missing.length === 0 && unexpected.length === 0 && actual.join('\0') !== expected.join('\0');
  return { id, ok: missing.length === 0 && unexpected.length === 0 && !orderChanged, actual, expected, missing, unexpected, orderChanged };
}

function checkNeedles(id, source, needles) {
  const missing = needles.filter((needle) => !source.includes(needle));
  return { id, ok: missing.length === 0, missing };
}

function cliVersion(spec) {
  const result = spawnSync(spec.command, spec.args || [], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  if (result.error) return { id: spec.id, installed: false, error: result.error.code || result.error.message };
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim().split(/\r?\n/)[0] || '';
  return { id: spec.id, installed: result.status === 0, status: result.status, version: output.slice(0, 300) };
}

async function readBoundedResponse(response, maxBytes = 20 * 1024 * 1024) {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`response-too-large:${declaredLength}`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`response-too-large:${total}`);
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function fetchContract(contract) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(contract.url, {
      redirect: 'follow',
      headers: { 'user-agent': 'Octopus-protocol-drift-check/0.5.41', accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.1' },
      signal: controller.signal,
    });
    const text = await readBoundedResponse(response);
    const missing = contract.required.filter((needle) => !text.includes(needle));
    return {
      id: contract.id,
      url: contract.url,
      finalUrl: response.url,
      reachable: true,
      status: response.status,
      bytes: Buffer.byteLength(text),
      ok: response.ok && missing.length === 0,
      missing,
    };
  } catch (error) {
    return { id: contract.id, url: contract.url, reachable: false, ok: false, error: error.name === 'AbortError' ? 'timeout' : error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const installer = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'hook_install.rs'), 'utf8');
  const nodeInstaller = fs.readFileSync(path.join(root, 'scripts', 'install-native-hooks.js'), 'utf8');
  const local = [
    compareArray('claude-rust-events', parseRustStringArray(installer, 'CLAUDE_EVENTS'), baseline.localContracts.claudeEvents),
    compareArray('claude-node-events', parseNodeEvents(nodeInstaller), baseline.localContracts.claudeEvents),
    compareArray('codewhale-events', parseRustStringArray(installer, 'CODEWHALE_EVENTS'), baseline.localContracts.codewhaleEvents),
    compareArray('codex-events', parseRustStringArray(installer, 'CODEX_EVENTS'), baseline.localContracts.codexEvents),
    checkNeedles('opencode-contract', installer, baseline.localContracts.opencodeNeedles),
    checkNeedles('aider-contract', installer, baseline.localContracts.aiderNeedles),
  ];
  const cliVersions = baseline.cliVersionCommands.map(cliVersion);
  const remote = remoteEnabled ? await Promise.all(baseline.remoteContracts.map(fetchContract)) : [];
  const localDrift = local.some((entry) => !entry.ok);
  const remoteDrift = remote.some((entry) => entry.reachable && !entry.ok);
  const networkInconclusive = remote.some((entry) => !entry.reachable);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baselineUpdatedAt: baseline.updatedAt,
    sourceFork: baseline.sourceFork,
    local,
    cliVersions,
    remote,
    verdict: localDrift || remoteDrift ? 'review-required' : remote.length === 0 ? 'local-contract-ok' : networkInconclusive ? 'inconclusive-network' : 'remote-contract-ok',
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`protocol-drift: ${report.verdict}; report=${path.relative(root, reportPath)}`);
  if (localDrift || remoteDrift || (strictNetwork && networkInconclusive)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`protocol-drift: ${error.stack || error.message}`);
  process.exitCode = 1;
});
