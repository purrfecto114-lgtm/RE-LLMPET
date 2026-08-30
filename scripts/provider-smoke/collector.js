#!/usr/bin/env node
// Octopus provider-smoke collector (2026-08-30, 0.6.1 rework).
// Accepts POST /state exactly like the desktop app's loopback ingest endpoint
// (hook_client.rs posts raw HTTP with X-Re-Llmpet-Token; the OpenCode plugin
// fetch()es the same path with lowercase headers). Records every event to a
// JSONL file so smoke drivers can build honest evidence reports.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.OCTOPUS_SMOKE_COLLECT_PORT || 41330);
const OUT = process.env.OCTOPUS_SMOKE_EVENTS_FILE
  || path.join(process.env.OCTOPUS_SMOKE_HOME || '/tmp', 'octopus-smoke-events.jsonl');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const stream = fs.createWriteStream(OUT, { flags: 'a' });

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => { if (chunks.reduce((n, b) => n + b.length, 0) + c.length <= 2 * 1024 * 1024) chunks.push(c); });
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = JSON.parse(raw); } catch { body = { unparsable: raw.slice(0, 2000) }; }
    const record = {
      ts: new Date().toISOString(),
      method: req.method,
      url: req.url,
      token: req.headers['x-re-llmpet-token'] || null,
      server: req.headers['x-re-llmpet-server'] || null,
      provider: body && body.provider,
      hook_event_name: body && (body.hook_event_name || body.event),
      body,
    };
    stream.write(JSON.stringify(record) + '\n');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});
server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`collector listening on 127.0.0.1:${PORT} -> ${OUT}\n`);
});
const shutdown = () => { stream.end(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 300); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
