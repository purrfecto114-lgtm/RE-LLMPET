'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
// Collapse whitespace so assertions survive `cargo fmt` reflow (which wraps long
// match arms / if-blocks across lines). Matches on token sequence, not layout.
const compact = (s) => s.replace(/\s+/g, ' ');
const baseline = JSON.parse(read('protocol-baseline.json'));
const installer = read('src-tauri/src/hook_install.rs');
const model = read('src-tauri/src/model.rs');
const server = read('src-tauri/src/http_server.rs');
const workflow = read('.github/workflows/protocol-drift.yml');
const driftScript = read('scripts/check-protocol-drift.js');

assert.strictEqual(baseline.sourceFork.repository, 'https://github.com/purrfecto114-lgtm/LLMPET');
assert.strictEqual(baseline.sourceFork.publishedTag, 'v0.1.2-pre');
assert.strictEqual(baseline.sourceFork.tagCommit, '1a6617a');
assert.strictEqual(baseline.sourceFork.observedMainCommit, '86cbd9e');
assert.strictEqual(baseline.upstream.observedMainCommit, '4637a20cef1ae6207d3773f75edcfe3d231120d9');

for (const event of ['PermissionDenied', 'TaskCreated', 'TaskCompleted', 'TeammateIdle', 'ElicitationResult']) {
  assert(installer.includes(`"${event}"`), `current Claude observer event missing: ${event}`);
}
for (const intentionallyExcluded of ['MessageDisplay', 'PostToolBatch', 'WorktreeCreate', 'UserPromptExpansion']) {
  assert(installer.includes(intentionallyExcluded), `privacy/policy exclusion must be documented: ${intentionallyExcluded}`);
  const array = installer.match(/const CLAUDE_EVENTS:[\s\S]*?\];/)[0];
  assert(!array.includes(`"${intentionallyExcluded}"`), `unsafe/high-volume event installed: ${intentionallyExcluded}`);
}
assert(compact(model).includes('"PermissionDenied" | "Elicitation" => "needsinput"'));
assert(compact(model).includes('"TeammateIdle" => "loafing"'));
assert(compact(server).includes('"TaskCreated" =>'));
assert(compact(server).includes('"TaskCompleted" =>'));

assert(workflow.includes("cron: '17 5 * * 1'"));
assert(workflow.includes('check-protocol-drift.js --remote'));
assert(workflow.match(/actions\/upload-artifact@[0-9a-f]{12,40}/));
assert(driftScript.includes('readBoundedResponse'));
assert(driftScript.includes('20 * 1024 * 1024'));
assert(driftScript.includes('response-too-large'));
assert(driftScript.includes('AbortController'));

const result = spawnSync(process.execPath, ['scripts/check-protocol-drift.js'], {
  cwd: ROOT,
  encoding: 'utf8',
});
assert.strictEqual(result.status, 0, result.stderr || result.stdout);
const report = JSON.parse(read('reports/protocol-drift.json'));
assert.notStrictEqual(report.verdict, 'review-required', 'verdict must not be review-required when local contracts match');
assert(report.local.every((entry) => entry.ok));
assert(Array.isArray(report.cliVersions) && report.cliVersions.length === 5);

console.log('tauri-protocol-drift-smoke: ok');
