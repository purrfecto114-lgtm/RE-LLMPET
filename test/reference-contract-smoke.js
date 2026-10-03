'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const expected = {
  'test/fixtures/claude-transcript-assistant.jsonl': '03a018f1e6df1e28a056a128e2fddb8471e70e3af731a8af046ba9f8a7a21a30',
  // R8 fix: billing_surface deepseek-payg → first-party-payg, turn_id turn_* → UUID (real 0.9.4 shape)
  'test/fixtures/codewhale-turn-end.json': 'd15b9488c022fe62497034b59817ed6a8b40f88c62fe04e0822973f0fe83d538',
  // R8 fix: real CodeWhale 0.9.4 failed-turn payload (raw, pre-normalization) for drop-on-zero-usage tests
  'test/fixtures/codewhale-turn-end-failed-real-0.9.4.json': '015f9a7da7fb9c2c1e480660387803f01ebeb5641b94a5340de5d2bbf43fdcd2',
  'test/fixtures/models-dev-api-sample.json': 'dcd80f0e1c22221738abe4c2ad0cd6ad0bd621264773213a030e983101b82e38'
};

for (const [relative, digest] of Object.entries(expected)) {
  const full = path.join(ROOT, relative);
  assert(fs.existsSync(full), `missing reference fixture: ${relative}`);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  assert.strictEqual(actual, digest, `reference fixture changed without an explicit contract review: ${relative}`);
}

assert(!fs.existsSync(path.join(ROOT, ['legacy', 'reference'].join('-'))), 'archived runtime must not be shipped in the active source tree');
console.log('reference-contract-smoke: ok');
