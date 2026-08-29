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
assert.match(ci, /cargo install cargo-audit --version 0\.22\.2 --locked/);
assert.match(ci, /components: rustfmt, clippy/);
assert.match(ci, /cargo clippy --manifest-path src-tauri\/Cargo\.toml --all-targets --locked -- -D warnings/);
assert.match(release, /components: rustfmt, clippy/);
assert.match(release, /cargo clippy --manifest-path src-tauri\/Cargo\.toml --all-targets --locked[\s\S]*-- -D warnings/);
assert.match(release, /cargo test --manifest-path src-tauri\/Cargo\.toml --lib --no-run --locked/);
assert.match(release, /Run Rust core unit tests on the host[\s\S]*cargo test --manifest-path src-tauri\/Cargo\.toml --lib --locked/,
  'tag releases must execute Rust unit tests instead of only compiling them');
assert.match(ci, /working-directory: src-tauri[\s\S]*?run: cargo audit/);

assert.match(release, /GITHUB_REF_TYPE" = "tag"/);
assert.match(release, /GITHUB_REF_NAME" != "\$EXPECTED_TAG"/);
assert.match(release, /does not match package version/);
// Updater artifact signing and native platform publisher signing are separate
// contracts. This project currently has no updater plugin/artifacts, while
// Authenticode / Developer ID can be made fail-closed by repository policy.
assert.doesNotMatch(release, /TAURI_SIGNING_PRIVATE_KEY/);
assert.match(release, /createUpdaterArtifacts=false/);
assert.match(release, /uploadUpdaterJson: false/);
assert.match(release, /uploadUpdaterSignatures: false/);
assert.doesNotMatch(release, /updaterJsonPreferNsis:/);
assert.match(release, /REQUIRE_PLATFORM_SIGNING: \$\{\{ vars\.REQUIRE_PLATFORM_SIGNING \}\}/);
assert.match(release, /WINDOWS_CERTIFICATE/);
assert.match(release, /APPLE_CERTIFICATE/);
assert.match(release, /name: Validate release source/);
assert.match(release, /validate:[\s\S]*?permissions:\s*\n\s*contents: read/);
assert.match(release, /prepare:[\s\S]*?needs: validate/);
assert.match(release, /name: Prepare private release draft/);
assert.strictEqual((release.match(/npm test/g) || []).length, 1,
  'source regression should run once before draft creation, not once per platform');
assert(release.indexOf('npm test') < release.indexOf('prepare:'),
  'source regression must run in the read-only validate job');
assert.match(release, /releaseId: \$\{\{ needs\.prepare\.outputs\.release_id \}\}/);
assert.match(release, /releaseDraft: true/);
assert.match(release, /needs: \[prepare, build\]/);
assert.match(release, /gh release edit .*--draft=false --prerelease/);
assert.match(release, /permissions: \{\}/);
assert.match(release, /prepare:[\s\S]*?permissions:\s*\n\s*contents: write/);
assert.match(release, /build:[\s\S]*?permissions:[\s\S]*?id-token: write[\s\S]*?attestations: write/);
assert.match(release, /publish:[\s\S]*?permissions:\s*\n\s*contents: write/);
assert.match(release, /GH_REPO: \$\{\{ github\.repository \}\}/);
assert.match(release, /v\$VERSION-draft-\$GITHUB_RUN_NUMBER/);
assert.match(release, /RELEASE_NAME="Octopus v\$VERSION manual draft #\$GITHUB_RUN_NUMBER"/);
assert.match(release, /PRERELEASE=true/);
assert.doesNotMatch(release, /PRERELEASE=false/,
  'manual inspection drafts must not become stable releases if published accidentally');
assert.doesNotMatch(release, /gh release delete-asset/,
  'release workflow must prevent updater assets at the producer instead of racing matrix cleanup');
assert.match(release, /name: Verify draft asset closure/);
assert.match(release, /gh release view[\s\S]*?--json assets,isDraft,isPrerelease,tagName/);
assert.match(release, /gh release download[\s\S]*?SHA256SUMS-\*/);
assert.match(release, /node scripts\/verify-release-assets\.js release-audit\/release\.json release-audit 4/);
assert(release.indexOf('Verify draft asset closure') < release.indexOf('Make the fully assembled tag release visible'),
  'draft assets must be reconciled before publication');
assert.doesNotMatch(release, /subject-path:[\s\S]*?\*\*\/\*\.app/);
for (const workflow of fs.readdirSync(path.join(ROOT, '.github/workflows')).filter((name) => name.endsWith('.yml'))) {
  const source = read(path.join('.github/workflows', workflow));
  assert(!source.includes('actions/upload-artifact@v5'), `${workflow} still uses upload-artifact v5`);
}

const releaseGate = spawnSync(process.execPath, ['scripts/check-release-gates.js', '--release'], {
  cwd: ROOT,
  encoding: 'utf8',
  env: {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: '',
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
    REQUIRE_PLATFORM_SIGNING: 'false',
  },
});
assert.strictEqual(releaseGate.status, 0, releaseGate.stderr || releaseGate.stdout);
assert.match(releaseGate.stdout, /Tauri updater artifacts remain disabled/);

const releaseConfigPath = path.join(os.tmpdir(), `octopus-release-config-${process.pid}.json`);
const generatedConfig = spawnSync(process.execPath, ['scripts/generate-release-config.js', '--draft', releaseConfigPath], {
  cwd: ROOT,
  encoding: 'utf8',
  env: {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: '',
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
  },
});
assert.strictEqual(generatedConfig.status, 0, generatedConfig.stderr || generatedConfig.stdout);
const releaseConfig = JSON.parse(fs.readFileSync(releaseConfigPath, 'utf8'));
fs.rmSync(releaseConfigPath, { force: true });
assert.strictEqual(releaseConfig.bundle.createUpdaterArtifacts, false);

const out = path.join(os.tmpdir(), `octopus-sbom-${process.pid}-a.json`);
const out2 = path.join(os.tmpdir(), `octopus-sbom-${process.pid}-b.json`);
const sbomEnv = { ...process.env, GITHUB_REPOSITORY: 'purrfecto114-lgtm/RE-LLMPET' };
for (const target of [out, out2]) {
  const generated = spawnSync(process.execPath, ['scripts/generate-sbom.js', target], {
    cwd: ROOT,
    encoding: 'utf8',
    env: sbomEnv,
  });
  assert.strictEqual(generated.status, 0, generated.stderr || generated.stdout);
}
assert.strictEqual(fs.readFileSync(out, 'utf8'), fs.readFileSync(out2, 'utf8'),
  'SPDX generation must be byte-identical for identical release inputs');
const sbom = JSON.parse(fs.readFileSync(out, 'utf8'));
fs.rmSync(out, { force: true });
fs.rmSync(out2, { force: true });
assert.match(sbom.documentNamespace, /^https:\/\/github\.com\/purrfecto114-lgtm\/RE-LLMPET\/spdx\//);

const assetGate = read('scripts/asset-visual-regression.js');
const assetBaseline = JSON.parse(read('reports/asset-visual-baseline.json'));
assert(assetGate.includes('SOURCE_DATE_EPOCH') && assetGate.includes('generatedAt: sourceTimestamp()'),
  'asset baseline updates must be deterministic');
assert.strictEqual(assetBaseline.generatedAt, new Date(Number(read('SOURCE_DATE_EPOCH').trim()) * 1000).toISOString());
assert(!(assetBaseline.assets || []).some((asset) => asset.path.startsWith('memes/')),
  'removed meme assets must not remain pinned by the active release gate');

const epoch = Number(read('SOURCE_DATE_EPOCH').trim());
assert.strictEqual(sbom.creationInfo.created, new Date(epoch * 1000).toISOString());
assert(sbom.relationships.some((item) =>
  item.spdxElementId === 'SPDXRef-DOCUMENT'
  && item.relationshipType === 'DESCRIBES'
  && item.relatedSpdxElement === 'SPDXRef-Package-Octopus'
), 'SPDX document must describe the root package');

// Exercise the manifest generator in an isolated source tree: provenance files
// are hashed, generation is deterministic, and tampering is rejected.
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-manifest-'));
fs.mkdirSync(path.join(fixtureRoot, 'scripts'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'scripts/generate-source-manifest.js'), path.join(fixtureRoot, 'scripts/generate-source-manifest.js'));
fs.writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({ name: 'octopus', version: '1.2.3' }) + '\n');
fs.writeFileSync(path.join(fixtureRoot, 'SOURCE_REVISION'), 'octopus-1.2.3\n');
fs.writeFileSync(path.join(fixtureRoot, 'SOURCE_DATE_EPOCH'), '1700000000\n');
fs.writeFileSync(path.join(fixtureRoot, 'app.txt'), 'stable source\n');
const manifestScript = path.join(fixtureRoot, 'scripts/generate-source-manifest.js');
const generateManifest = spawnSync(process.execPath, [manifestScript, '--generate'], { cwd: fixtureRoot, encoding: 'utf8' });
assert.strictEqual(generateManifest.status, 0, generateManifest.stderr || generateManifest.stdout);
assert.match(generateManifest.stdout, /commit=octopus-1\.2\.3/,
  'manifest generator logs must retain semantic source revisions instead of truncating them to an ambiguous prefix');
const manifestBytes = fs.readFileSync(path.join(fixtureRoot, 'SOURCE_MANIFEST.json'), 'utf8');
const generatedManifest = JSON.parse(manifestBytes);
assert.strictEqual(generatedManifest.generated, 1700000000);
assert(generatedManifest.files.SOURCE_REVISION, 'SOURCE_REVISION must be inside the manifest digest set');
assert(generatedManifest.files.SOURCE_DATE_EPOCH, 'SOURCE_DATE_EPOCH must be inside the manifest digest set');
const verifyManifest = spawnSync(process.execPath, [manifestScript, '--verify'], { cwd: fixtureRoot, encoding: 'utf8' });
assert.strictEqual(verifyManifest.status, 0, verifyManifest.stderr || verifyManifest.stdout);
const regenerateManifest = spawnSync(process.execPath, [manifestScript, '--generate'], { cwd: fixtureRoot, encoding: 'utf8' });
assert.strictEqual(regenerateManifest.status, 0, regenerateManifest.stderr || regenerateManifest.stdout);
assert.strictEqual(fs.readFileSync(path.join(fixtureRoot, 'SOURCE_MANIFEST.json'), 'utf8'), manifestBytes,
  'manifest generation must be byte-identical for identical source inputs');
fs.writeFileSync(path.join(fixtureRoot, 'SOURCE_REVISION'), 'octopus-tampered\n');
const rejectTamper = spawnSync(process.execPath, [manifestScript, '--verify'], { cwd: fixtureRoot, encoding: 'utf8' });
assert.notStrictEqual(rejectTamper.status, 0, 'manifest verification must reject provenance tampering');
fs.writeFileSync(path.join(fixtureRoot, 'SOURCE_REVISION'), 'octopus-1.2.3\n');
let symlinkCreated = false;
try {
  fs.symlinkSync('app.txt', path.join(fixtureRoot, 'linked-source.txt'), 'file');
  symlinkCreated = true;
} catch (error) {
  if (process.platform !== 'win32') throw error;
}
if (symlinkCreated) {
  const rejectSymlink = spawnSync(process.execPath, [manifestScript, '--generate'], { cwd: fixtureRoot, encoding: 'utf8' });
  assert.notStrictEqual(rejectSymlink.status, 0, 'manifest generation must reject symbolic links');
  assert.match(`${rejectSymlink.stderr}\n${rejectSymlink.stdout}`, /symbolic link is not allowed/);
}
fs.rmSync(fixtureRoot, { recursive: true, force: true });

console.log('release-supply-chain-smoke: ok');
