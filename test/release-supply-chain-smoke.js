'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const release = read('.github/workflows/release.yml');
const ci = read('.github/workflows/ci.yml');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

assert.strictEqual(lock.version, pkg.version, 'package-lock top-level version must match package.json');
assert.strictEqual(lock.packages[''].version, pkg.version, 'package-lock root package version must match package.json');
assert.match(ci, /cargo install cargo-audit --version 0\.22\.2/);
assert.match(ci, /working-directory: src-tauri[\s\S]*?run: cargo audit/);

assert.match(release, /GITHUB_REF_TYPE" = "tag"/);
assert.match(release, /GITHUB_REF_NAME" != "\$EXPECTED_TAG"/);
assert.match(release, /does not match package version/);
// R34 (2026-07-31): tag pushes MUST fail-closed when signing key is missing.
// The previous behavior published unsigned public prereleases on every tag
// push, contradicting README.md's promise. Now the workflow exits 1 with an
// ::error:: annotation instead of a ::warning:: + unsigned prerelease path.
assert.match(release, /Tag release v\$VERSION requires TAURI_SIGNING_PRIVATE_KEY/);
assert.match(release, /Use workflow_dispatch for unsigned draft builds instead/);
// The fail-closed branch must `exit 1`, not just warn.
assert.match(release, /if \[ -z "\$\{\{ env\.TAURI_SIGNING_PRIVATE_KEY \}\}" \]; then[\s\S]*?exit 1/);
// Signed tag path still publishes (prerelease=false, releaseDraft=false).
assert.match(release, /prerelease=false/);
assert.match(release, /releaseDraft: \$\{\{ steps\.mode\.outputs\.releaseDraft \}\}/);
assert.match(release, /tagName: \$\{\{ steps\.mode\.outputs\.tagName \}\}/);
assert.match(release, /v\$VERSION-draft-\$GITHUB_RUN_NUMBER/);
assert.doesNotMatch(release, /subject-path:[\s\S]*?\*\*\/\*\.app/);
for (const workflow of fs.readdirSync(path.join(ROOT, '.github/workflows')).filter((name) => name.endsWith('.yml'))) {
  const source = read(path.join('.github/workflows', workflow));
  assert(!source.includes('actions/upload-artifact@v5'), `${workflow} still uses upload-artifact v5`);
}

const out = path.join(os.tmpdir(), `octopus-sbom-${process.pid}.json`);
const generated = spawnSync(process.execPath, ['scripts/generate-sbom.js', out], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, GITHUB_REPOSITORY: 'purrfecto114-lgtm/RE-LLMPET' },
});
assert.strictEqual(generated.status, 0, generated.stderr || generated.stdout);
const sbom = JSON.parse(fs.readFileSync(out, 'utf8'));
fs.rmSync(out, { force: true });
assert.match(sbom.documentNamespace, /^https:\/\/github\.com\/purrfecto114-lgtm\/RE-LLMPET\/spdx\//);
assert(sbom.relationships.some((item) =>
  item.spdxElementId === 'SPDXRef-DOCUMENT'
  && item.relationshipType === 'DESCRIBES'
  && item.relatedSpdxElement === 'SPDXRef-Package-RE-LLMPET'
), 'SPDX document must describe the root package');

console.log('release-supply-chain-smoke: ok');
