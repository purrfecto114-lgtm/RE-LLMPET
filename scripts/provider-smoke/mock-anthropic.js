#!/usr/bin/env node
// Octopus provider-smoke mock Anthropic API (2026-08-30).
// Implements the Anthropic Messages API surface Claude Code needs
// (POST /v1/messages, streaming + non-streaming) so `claude -p` can run a
// REAL session against ANTHROPIC_BASE_URL, execute a tool (tool_use block)
// and finish the turn — exercising the genuine hook pipeline.
'use strict';
const http = require('http');
const fs = require('fs');

const PORT = Number(process.env.MOCK_ANTHROPIC_PORT || 4598);
const TOOL_NAME = process.env.MOCK_CLAUDE_TOOL || 'Read';
const TOOL_FILE = process.env.MOCK_TOOL_FILE || '/tmp/octopus-smoke-hello.txt';
const TOOL_FILE_ALT = process.env.MOCK_TOOL_FILE_ALT || '';
const ALT_MARK = process.env.MOCK_TOOL_ALT_MARK || 'outside';
const FINAL_TEXT = process.env.MOCK_FINAL_TEXT || 'SMOKE-DONE claude';
const LOG = process.env.MOCK_LLM_LOG || '/tmp/octopus-mock-anthropic.jsonl';
const log = fs.createWriteStream(LOG, { flags: 'a' });

function decide(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const hasToolResult = msgs.some((m) => m.role === 'user' && Array.isArray(m.content)
    && m.content.some((p) => p && p.type === 'tool_result'));
  let lastUserText = '';
  for (const m of [...msgs].reverse()) {
    if (m.role === 'user') {
      lastUserText = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      break;
    }
  }
  const useAlt = TOOL_FILE_ALT && lastUserText.includes(ALT_MARK);
  return {
    phase: hasToolResult ? 'final' : 'tool',
    useAlt,
    n: msgs.length,
    stream: !!body.stream,
    model: body.model,
    systemTools: Array.isArray(body.tools) ? body.tools.map((t) => t.name).slice(0, 12) : [],
  };
}

const server = http.createServer((req, res) => {
  log.write(JSON.stringify({ ts: new Date().toISOString(), request: req.method + ' ' + req.url }) + '\n');
  if (req.method === 'POST' && /\/v1\/messages(\?.*)?$/.test(req.url)) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      const info = decide(body);
      log.write(JSON.stringify({ ts: new Date().toISOString(), ...info }) + '\n');
      const rid = 'msg_smoke_' + Math.random().toString(36).slice(2, 10);
      const model = String(body.model || 'claude-smoke');

      const usage = { input_tokens: 17, output_tokens: 6 };
      if (info.phase === 'tool') {
        const input = info.useAlt
          ? { file_path: TOOL_FILE_ALT }
          : (TOOL_NAME === 'Bash' ? { command: 'cat ' + TOOL_FILE, description: 'smoke read' } : { file_path: TOOL_FILE });
        if (info.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          const events = [
            ['message_start', { type: 'message_start', message: { id: rid, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 17, output_tokens: 0 } } }],
            ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_smoke_1', name: TOOL_NAME, input: {} } }],
            ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
            ['content_block_stop', { type: 'content_block_stop', index: 0 }],
            ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 6 } }],
            ['message_stop', { type: 'message_stop' }],
          ];
          for (const [name, data] of events) {
            res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
          }
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: rid, type: 'message', role: 'assistant', model,
          content: [{ type: 'tool_use', id: 'toolu_smoke_1', name: TOOL_NAME, input }],
          stop_reason: 'tool_use', stop_sequence: null, usage,
        }));
        return;
      }
      if (info.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const events = [
          ['message_start', { type: 'message_start', message: { id: rid, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 17, output_tokens: 0 } } }],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: FINAL_TEXT } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } }],
          ['message_stop', { type: 'message_stop' }],
        ];
        for (const [name, data] of events) {
          res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        }
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: rid, type: 'message', role: 'assistant', model,
        content: [{ type: 'text', text: FINAL_TEXT }],
        stop_reason: 'end_turn', stop_sequence: null, usage,
      }));
    });
    return;
  }
  if (req.method === 'POST' && /count_tokens/.test(req.url)) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: 9 }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'mock: ' + req.url } }));
});
server.listen(PORT, '127.0.0.1', () => process.stdout.write(`mock-anthropic on 127.0.0.1:${PORT}\n`));
const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
