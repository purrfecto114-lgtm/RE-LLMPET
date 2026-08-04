#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const migration = JSON.parse(read('migration-todo.json'));
const workflow = read('.github/workflows/release.yml');
const panel = read('frontend/renderer/panel.js');
const model = read('src-tauri/src/model.rs');
const commands = read('src-tauri/src/commands.rs');
const http = read('src-tauri/src/http_server.rs');
const lib = read('src-tauri/src/lib.rs');
const pricing = read('src-tauri/src/pricing_sync.rs');
const hookClient = read('src-tauri/src/hook_client.rs');

// Updater artifacts are disabled at their producers; no matrix job may race
// another job by deleting assets after upload.
assert(!/gh release delete-asset/.test(workflow));
assert(workflow.includes('name: Verify draft asset closure'));
assert(workflow.includes('node scripts/verify-release-assets.js release-audit/release.json release-audit 4'));
assert(workflow.indexOf('Verify draft asset closure') < workflow.indexOf('Make the fully assembled tag release visible'));

assert(!workflow.includes('TAURI_SIGNING_PRIVATE_KEY'),
  'updater signing key must not be required while updater artifacts are disabled');
assert(workflow.includes('REQUIRE_PLATFORM_SIGNING: ${{ vars.REQUIRE_PLATFORM_SIGNING }}'));
assert(workflow.includes('createUpdaterArtifacts=false'));
assert(workflow.includes('uploadUpdaterJson: false'));
assert(workflow.includes('uploadUpdaterSignatures: false'));
assert(!workflow.includes('updaterJsonPreferNsis:'));
assert(!workflow.includes('platformSigned='), 'unused workflow outputs must not accumulate');
assert(!workflow.includes('make_latest='), 'unused workflow outputs must not accumulate');

assert(workflow.includes('name: Validate release source'));
assert(/validate:[\s\S]*?permissions:\s*\n\s*contents: read/.test(workflow));
assert(/prepare:[\s\S]*?needs: validate/.test(workflow));
assert(workflow.includes('name: Prepare private release draft'));
assert.strictEqual((workflow.match(/npm test/g) || []).length, 1,
  'release source tests must be centralized in prepare');
assert(workflow.indexOf('npm test') < workflow.indexOf('prepare:'),
  'release source tests must run before the write-enabled prepare job');
assert(workflow.includes('releaseId: ${{ needs.prepare.outputs.release_id }}'));
assert(workflow.includes('releaseDraft: true'));
assert(workflow.includes('needs: [prepare, build]'));
assert(workflow.includes('--draft=false --prerelease'));
assert(workflow.includes('PRERELEASE=true') && !workflow.includes('PRERELEASE=false'),
  'manual 0.5.x drafts must stay prerelease even if published outside the workflow');
assert(hookClient.includes('"decision":"deny"'));
assert(!hookClient.includes('"decision":"ask"'),
  'CodeWhale service failure must not use ask because Full Access ignores approval prompts');
assert(hookClient.includes('std::process::exit(1)'),
  'unexpected hook failures must not exit successfully with empty stdout');
assert(model.includes('if behavior == "allow" { "allow" } else { "deny" }'),
  'unknown renderer permission values must fail closed');
assert(http.includes('if decision.behavior == "allow"') && http.includes('Unknown or future values'),
  'unknown native permission values must fail closed');

// Recovery paths hide the persistent panel and render local paths as text.
assert(panel.includes('async function requestPanelHide()'));
assert.strictEqual((panel.match(/window\.close\s*\(/g) || []).length, 0,
  'persistent panel must never be destroyed by renderer recovery paths');
assert(panel.includes("closeBtn.addEventListener('click', requestPanelHide)"));
assert(panel.includes('await requestPanelHide();'));
assert(panel.includes('backupPathEl.replaceChildren(label, lineBreak, pathText)'));
assert(!/backupPathEl\.innerHTML\s*=/.test(panel));
assert(lib.includes('WindowEvent::CloseRequested { api, .. }')
    && lib.includes('api.prevent_close();')
    && lib.includes('match window.hide()')
    && lib.includes('window.app_handle().emit("panel:hidden", ())')
    && lib.includes('native close hide failed'),
  'native panel close requests must emit hidden only after a successful hide');

// Stats have one runtime state owner and one immediate broadcast implementation.
assert(model.includes('pub stats_coalescer: Mutex<StatsCoalescerState>'));
for (const legacy of ['last_stats_emit', 'pub stats_dirty:', 'pub stats_scheduled:']) {
  assert(!model.includes(legacy), `obsolete stats field returned: ${legacy}`);
}
assert(http.includes('pub(crate) fn emit_stats_now'));
assert(!http.includes('enum TrailingAction') && !http.includes('EmitAndReschedule'));
assert(commands.includes('crate::http_server::emit_stats_now(app, &state.runtime)'));
assert.strictEqual((commands.match(/__revision/g) || []).length, 0,
  'commands.rs must not duplicate stats revision payload construction');
assert(/pub\(crate\) fn emit_stats_now[\s\S]*?guard\.dirty = false;/.test(http),
  'immediate snapshots must consume already-covered dirty work');
assert(pricing.includes('env!("CARGO_PKG_VERSION")'));
assert(!/Octopus\/0\.5\.\d+ pricing-sync/.test(pricing),
  'pricing user-agent version must not drift from Cargo package metadata');
assert(model.includes('Constructed when a config declares a schema newer than this build.'));
assert(!/Never constructed by the current loader[\s\S]*?SchemaTooNew/.test(model));

// Evidence metadata must describe the source being shipped, not another host.
assert.strictEqual(migration.release, pkg.version,
  'migration release must match package.json');
const absoluteEvidence = [];
for (const task of migration.tasks || []) {
  for (const item of task.evidence || []) {
    if (typeof item === 'string' && (/^\//.test(item) || /^[A-Za-z]:[\\/]/.test(item))) {
      absoluteEvidence.push(`${task.id}: ${item}`);
    }
  }
}
assert.deepStrictEqual(absoluteEvidence, [],
  'migration evidence must not point to another machine');
const r20 = (migration.tasks || []).find((task) => task.id === 'R20-001');
assert(r20 && r20.status === 'blocked' && Array.isArray(r20.blockedBy),
  'unretained Windows compile claim must remain blocked');

console.log('tauri-r45-release-lifecycle-smoke: ok');
