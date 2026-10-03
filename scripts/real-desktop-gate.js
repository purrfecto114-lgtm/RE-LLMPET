#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function arg(name, fallback = null) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; }
function die(message) { console.error(`real-desktop-gate: ${message}`); process.exit(1); }
const platform = arg('--platform', process.platform);
const command = process.env.OCTOPUS_GUI_GATE_COMMAND;
if (!command) die('OCTOPUS_GUI_GATE_COMMAND is required; a real desktop result cannot be inferred from a headless runner');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportDir = path.resolve('reports');
const rawPath = path.join(reportDir, `desktop-real-raw-${platform}-${stamp}.json`);
const finalPath = path.join(reportDir, `desktop-real-${platform}-${stamp}.json`);
const performancePath = path.join(reportDir, `desktop-real-performance-${platform}-${stamp}.json`);
fs.mkdirSync(reportDir, { recursive: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), `octopus-desktop-${platform}-`));
const env = {
  ...process.env,
  OCTOPUS_GUI_EVIDENCE: rawPath,
  OCTOPUS_GUI_ISOLATED_HOME: home,
  OCTOPUS_APP_BINARY: path.resolve('src-tauri/target/release/octopus' + (process.platform === 'win32' ? '.exe' : ''))
};
const run = spawnSync(command, { cwd: process.cwd(), env, shell: true, encoding: 'utf8', timeout: 45 * 60 * 1000 });
if (run.error) die(run.error.message);
if (run.status !== 0) die(`GUI automation exited ${run.status}: ${(run.stderr || run.stdout || '').slice(-4000)}`);
if (!fs.existsSync(rawPath)) die(`GUI automation did not write ${rawPath}`);
let raw;
try { raw = JSON.parse(fs.readFileSync(rawPath, 'utf8')); } catch (error) { die(`invalid GUI evidence: ${error.message}`); }
const required = ['transparentPetVisible', 'trayMenuOpened', 'detailsPanelOpened', 'cleanExit', 'noOrphanProcesses', 'resumeRecovered', 'displayTopologyRecovered'];
const errors = required.filter((field) => raw[field] !== true).map((field) => `${field} was not verified`);
if (!Array.isArray(raw.screenshots) || raw.screenshots.length === 0) errors.push('at least one screenshot path is required');
if (!raw.conditions || typeof raw.conditions !== 'object') errors.push('hardware/OS/display/power test conditions are required');
const benchmarkPid = Number(raw.benchmarkPid || 0);
if (Number.isInteger(benchmarkPid) && benchmarkPid > 0) {
  const duration = String(process.env.OCTOPUS_BENCHMARK_DURATION || '300');
  const bench = spawnSync(process.execPath, ['scripts/benchmark-desktop.js', '--pid', String(benchmarkPid), '--duration', duration, '--output', performancePath], { encoding: 'utf8', timeout: (Number(duration) + 60) * 1000 });
  if (bench.status !== 0) errors.push(`performance sampler failed: ${(bench.stderr || bench.stdout || '').slice(-2000)}`);
} else {
  errors.push('benchmarkPid was not supplied by the GUI automation');
}
const output = {
  schemaVersion: 1,
  status: errors.length ? 'failed' : 'passed',
  platform,
  completedAt: new Date().toISOString(),
  checks: Object.fromEntries(required.map((field) => [field, raw[field] === true])),
  conditions: raw.conditions || null,
  screenshots: raw.screenshots || [],
  performanceReport: fs.existsSync(performancePath) ? path.relative(process.cwd(), performancePath) : null,
  errors,
  automationStdoutTail: String(run.stdout || '').slice(-4000),
  automationStderrTail: String(run.stderr || '').slice(-4000)
};
fs.writeFileSync(finalPath, JSON.stringify(output, null, 2) + '\n');
if (errors.length) die(errors.join('; '));
console.log(`real-desktop-gate: passed ${platform} -> ${finalPath}`);
