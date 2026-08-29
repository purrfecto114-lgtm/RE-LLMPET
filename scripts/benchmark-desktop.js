#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : fallback;
}
function fail(message) { console.error(`benchmark-desktop: ${message}`); process.exit(2); }
const pid = Number(arg('--pid', process.env.OCTOPUS_BENCHMARK_PID || ''));
const durationSeconds = Math.max(5, Number(arg('--duration', '300')) || 300);
const intervalMs = Math.max(1000, Number(arg('--interval', '5000')) || 5000);
const output = path.resolve(arg('--output', `reports/performance-${process.platform}-${Date.now()}.json`));
if (!Number.isInteger(pid) || pid <= 0) fail('pass a live process id with --pid <number>');

function parseClock(value) {
  const parts = String(value || '').trim().split(/[-:]/).map(Number);
  if (parts.some(Number.isNaN)) return null;
  if (parts.length === 4) return (((parts[0] * 24 + parts[1]) * 60 + parts[2]) * 60 + parts[3]);
  if (parts.length === 3) return (parts[0] * 60 + parts[1]) * 60 + parts[2];
  return null;
}
function sampleUnix() {
  const text = execFileSync('ps', ['-p', String(pid), '-o', 'rss=,%cpu=,time=,comm='], { encoding: 'utf8' }).trim();
  if (!text) throw new Error('process not found');
  const match = text.match(/^\s*(\d+)\s+([\d.]+)\s+(\S+)\s+(.+)$/);
  if (!match) throw new Error(`unexpected ps output: ${text}`);
  return { rssBytes: Number(match[1]) * 1024, cpuPercent: Number(match[2]), cpuSeconds: parseClock(match[3]), command: match[4] };
}
function sampleWindows() {
  const script = `$p=Get-Process -Id ${pid} -ErrorAction Stop; [pscustomobject]@{rssBytes=[int64]$p.WorkingSet64;cpuSeconds=[double]$p.CPU;command=$p.ProcessName}|ConvertTo-Json -Compress`;
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }));
}
function sample() { return process.platform === 'win32' ? sampleWindows() : sampleUnix(); }
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}
const samples = [];
const startedAt = Date.now();
const endsAt = startedAt + durationSeconds * 1000;
function finish(error) {
  const rss = samples.map(s => s.rssBytes).filter(Number.isFinite);
  const cpu = samples.map(s => s.cpuPercent).filter(Number.isFinite);
  const report = {
    schemaVersion: 1,
    platform: process.platform,
    arch: process.arch,
    pid,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    requestedDurationSeconds: durationSeconds,
    intervalMs,
    status: error ? 'failed' : 'complete',
    error: error ? String(error.message || error) : null,
    conditions: {
      note: 'Record OS version, hardware, display server, power mode and foreground/background state beside this report before accepting a performance gate.'
    },
    summary: {
      sampleCount: samples.length,
      rssMinBytes: rss.length ? Math.min(...rss) : null,
      rssP50Bytes: percentile(rss, 0.50),
      rssP95Bytes: percentile(rss, 0.95),
      rssMaxBytes: rss.length ? Math.max(...rss) : null,
      cpuP50Percent: percentile(cpu, 0.50),
      cpuP95Percent: percentile(cpu, 0.95),
      cpuMaxPercent: cpu.length ? Math.max(...cpu) : null,
      rssGrowthBytes: rss.length > 1 ? rss[rss.length - 1] - rss[0] : null
    },
    samples
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`benchmark-desktop: ${report.status}; ${samples.length} samples -> ${output}`);
  process.exit(error ? 1 : 0);
}
function tick() {
  try {
    samples.push({ timestamp: new Date().toISOString(), ...sample() });
  } catch (error) {
    return finish(error);
  }
  if (Date.now() >= endsAt) return finish(null);
  setTimeout(tick, Math.min(intervalMs, Math.max(1, endsAt - Date.now())));
}
tick();
