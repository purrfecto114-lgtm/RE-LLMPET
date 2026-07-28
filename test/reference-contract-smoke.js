'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const expected = {
  'test/fixtures/claude-transcript-assistant.jsonl': '03a018f1e6df1e28a056a128e2fddb8471e70e3af731a8af046ba9f8a7a21a30',
  'test/fixtures/codewhale-turn-end.json': '0ffbc01d8c0ea617f7b7e8ffc1d3d77c200eff2f301c4afc21d784b188428e5d',
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
