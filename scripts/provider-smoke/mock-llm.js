#!/usr/bin/env node
// Octopus provider-smoke mock LLM (2026-08-30).
// OpenAI-compatible chat/completions server used ONLY to stand in for the
// model backend while the REAL provider CLI drives its own genuine hook/plugin
// pipeline. Behavior is phase-based:
//   phase "tool"  (first turn, when MOCK_TOOL_TURN=1): returns a tool_call
//                 so the CLI actually executes a tool and fires tool hooks
//   phase "final" (any request containing a tool result / role:"tool"):
//                 returns MOCK_FINAL_TEXT so the turn completes
// Supports streaming (SSE) and non-streaming responses.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.MOCK_LLM_PORT || 4599);
const TOOL_TURN = process.env.MOCK_TOOL_TURN === '1';
const TOOL_NAME = process.env.MOCK_TOOL_NAME || 'read';
const TOOL_FILE = process.env.MOCK_TOOL_FILE || '/tmp/octopus-smoke-hello.txt';
const TOOL_FILE_ALT = process.env.MOCK_TOOL_FILE_ALT || '';
const TOOL_ARGS_ALT = process.env.MOCK_TOOL_ARGS_ALT || '';
const TOOL_ALT_MARK = process.env.MOCK_TOOL_ALT_MARK || 'outside';
const TOOL_ARGS = process.env.MOCK_TOOL_ARGS || JSON.stringify({ filePath: TOOL_FILE });
const FINAL_TEXT = process.env.MOCK_FINAL_TEXT || 'SMOKE-DONE';
const LOG = process.env.MOCK_LLM_LOG || path.join('/tmp', 'octopus-mock-llm.jsonl');
const log = fs.createWriteStream(LOG, { flags: 'a' });

const id = () => 'chatcmpl-smoke-' + Math.random().toString(36).slice(2, 10);

function summarize(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const hasToolResult = msgs.some((m) => m.role === 'tool'
    || (Array.isArray(m.content) && m.content.some((p) => p && (p.type === 'tool_result' || p.type === 'tool-result'))));
  const hasToolCall = msgs.some((m) => Array.isArray(m.tool_calls) && m.tool_calls.length);
  const phase = hasToolResult ? 'final' : (TOOL_TURN && !hasToolCall ? 'tool' : 'final');
  // If the newest user prompt carries the alt marker, aim the tool at the
  // alt file so drivers can steer permission-ask scenarios per run.
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  const lastText = typeof lastUser?.content === 'string' ? lastUser.content
    : JSON.stringify(lastUser?.content || '');
  const useAlt = phase === 'tool' && TOOL_FILE_ALT && lastText.includes(TOOL_ALT_MARK);
  return { n: msgs.length, hasToolResult, hasToolCall, phase, stream: !!body.stream, model: body.model, useAlt };
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-mini', object: 'model' }] }));
    return;
  }
  // --- OpenAI Responses API (codex >= 0.15x dropped wire_api="chat") -------
  if (req.method === 'POST' && /\/(v1\/)?responses\/?$/.test(req.url.split('?')[0])) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      const input = Array.isArray(body.input) ? body.input : [];
      const hasToolResult = input.some((i) => i && (i.type === 'function_call_output' || i.type === 'tool_result'));
      let lastUserText = '';
      for (const i of [...input].reverse()) {
        if (i && i.role === 'user') {
          lastUserText = typeof i.content === 'string' ? i.content : JSON.stringify(i.content || '');
          break;
        }
      }
      const useAlt = TOOL_FILE_ALT && lastUserText.includes(TOOL_ALT_MARK);
      const phase = hasToolResult ? 'final' : (TOOL_TURN ? 'tool' : 'final');
      log.write(JSON.stringify({ ts: new Date().toISOString(), api: 'responses', phase, n: input.length, stream: !!body.stream, model: body.model, toolNames: (body.tools || []).map((t) => t.name || t.function?.name).slice(0, 12) }) + '\n');
      const rid = 'resp_smoke_' + Math.random().toString(36).slice(2, 10);
      const model = String(body.model || 'mock-mini');
      const usage = { input_tokens: 15, output_tokens: 5, total_tokens: 20 };

      const toolItem = () => {
        const args = useAlt ? (TOOL_ARGS_ALT || JSON.stringify({ command: ['bash', '-lc', 'cat ' + TOOL_FILE_ALT] })) : TOOL_ARGS;
        return { type: 'function_call', id: 'fc_smoke_1', call_id: 'call_smoke_1', name: TOOL_NAME, arguments: args, status: 'completed' };
      };
      const msgItem = () => ({ type: 'message', id: 'msg_smoke_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: FINAL_TEXT }] });

      if (!body.stream) {
        const item = phase === 'tool' ? toolItem() : msgItem();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: rid, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model, output: [item], usage }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const sse = (obj) => res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
      sse({ type: 'response.created', response: { id: rid, object: 'response', status: 'in_progress', model, output: [] } });
      const item = phase === 'tool' ? toolItem() : msgItem();
      sse({ type: 'response.output_item.added', output_index: 0, item: { ...item, [phase === 'tool' ? 'arguments' : 'content']: phase === 'tool' ? '' : [] } });
      if (phase === 'tool') {
        sse({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments });
      } else {
        sse({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } });
        sse({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: FINAL_TEXT });
      }
      sse({ type: 'response.output_item.done', output_index: 0, item });
      sse({ type: 'response.completed', response: { id: rid, object: 'response', status: 'completed', model, output: [item], usage } });
      res.end();
    });
    return;
  }
  if (req.method !== 'POST' || !/chat\/completions\/?$/.test(req.url)) {
    res.writeHead(404); res.end('{}'); return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
    const info = summarize(body);
    log.write(JSON.stringify({ ts: new Date().toISOString(), url: req.url, ...info }) + '\n');

    const rid = id();
    const created = Math.floor(Date.now() / 1000);
    const model = String(body.model || 'mock-mini');

    if (info.phase === 'tool') {
      const args = info.useAlt ? JSON.stringify({ filePath: TOOL_FILE_ALT }) : TOOL_ARGS;
      const call = { id: 'call-smoke-1', type: 'function', function: { name: TOOL_NAME, arguments: args } };
      if (info.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const parts = [
          { id: rid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }] }, finish_reason: null }] },
          { id: rid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: call.function.arguments } }] }, finish_reason: null }] },
          { id: rid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          { id: rid, object: 'chat.completion.chunk', created, model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } },
        ];
        for (const p of parts) res.write(`data: ${JSON.stringify(p)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: rid, object: 'chat.completion', created, model,
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        }));
      }
      return;
    }

    if (info.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const parts = [
        { id: rid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
        { id: rid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: FINAL_TEXT }, finish_reason: null }] },
        { id: rid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { id: rid, object: 'chat.completion.chunk', created, model, choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
      ];
      for (const p of parts) res.write(`data: ${JSON.stringify(p)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: rid, object: 'chat.completion', created, model,
      choices: [{ index: 0, message: { role: 'assistant', content: FINAL_TEXT }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    }));
  });
});
server.listen(PORT, '127.0.0.1', () => process.stdout.write(`mock-llm on 127.0.0.1:${PORT}\n`));
const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
