#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || 'reports/octopus.spdx.json');
const read = (relative) => fs.readFileSync(path.join(root, relative));
const readText = (relative) => read(relative).toString('utf8');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function sourceEpoch() {
  const raw = readText('SOURCE_DATE_EPOCH').trim();
  if (!/^\d+$/.test(raw)) throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer');
  const epoch = Number(raw);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('SOURCE_DATE_EPOCH is outside the JavaScript safe integer range');
  const created = new Date(epoch * 1000);
  if (!Number.isFinite(created.getTime())) throw new Error('SOURCE_DATE_EPOCH cannot be represented as an ISO timestamp');
  return created.toISOString();
}

function repositorySlug(pkg) {
  const repositoryUrl = typeof pkg.repository === 'string'
    ? pkg.repository
    : (pkg.repository && pkg.repository.url) || '';
  return process.env.GITHUB_REPOSITORY
    || (repositoryUrl.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i) || [])[1]
    || 'purrfecto114-lgtm/RE-LLMPET';
}

function cargoPackages(lockText) {
  const packages = [];
  let index = 0;
  for (const block of lockText.split(/\n\[\[package\]\]\n/).slice(1)) {
    const name = (block.match(/^name = "([^"]+)"/m) || [])[1];
    const version = (block.match(/^version = "([^"]+)"/m) || [])[1];
    if (!name || !version) continue;
    packages.push({
      SPDXID: `SPDXRef-Cargo-${++index}`,
      name,
      versionInfo: version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: 'NOASSERTION',
      copyrightText: 'NOASSERTION',
    });
  }
  return packages;
}

try {
  const pkg = JSON.parse(readText('package.json'));
  const lockPath = path.join(root, 'src-tauri', 'Cargo.lock');
  const cargoLock = fs.existsSync(lockPath) ? fs.readFileSync(lockPath) : Buffer.alloc(0);
  const npmLock = fs.existsSync(path.join(root, 'package-lock.json')) ? read('package-lock.json') : Buffer.alloc(0);
  const revision = readText('SOURCE_REVISION').trim();
  const slug = repositorySlug(pkg);

  const rootPackage = {
    SPDXID: 'SPDXRef-Package-Octopus',
    name: pkg.name,
    versionInfo: pkg.version,
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: pkg.license || 'NOASSERTION',
    licenseDeclared: pkg.license || 'NOASSERTION',
    copyrightText: 'NOASSERTION',
  };
  const dependencies = cargoPackages(cargoLock.toString('utf8').replace(/\r\n/g, '\n'));
  const packages = [rootPackage, ...dependencies];

  // Stable namespace for one exact source/dependency set. Re-running the
  // generator over identical release inputs produces byte-identical output.
  const identity = JSON.stringify({
    slug,
    version: pkg.version,
    revision,
    cargoLock: sha256(cargoLock),
    npmLock: sha256(npmLock),
  });
  const documentNamespace = `https://github.com/${slug}/spdx/${pkg.version}/${sha256(identity).slice(0, 32)}`;

  const relationships = [
    {
      spdxElementId: 'SPDXRef-DOCUMENT',
      relationshipType: 'DESCRIBES',
      relatedSpdxElement: 'SPDXRef-Package-Octopus',
    },
    ...dependencies.map((item) => ({
      spdxElementId: 'SPDXRef-Package-Octopus',
      relationshipType: 'DEPENDS_ON',
      relatedSpdxElement: item.SPDXID,
    })),
  ];

  const document = {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `Octopus-${pkg.version}`,
    documentNamespace,
    creationInfo: {
      created: sourceEpoch(),
      creators: ['Tool: scripts/generate-sbom.js'],
    },
    packages,
    relationships,
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(document, null, 2) + '\n');
  console.log(`generate-sbom: ${packages.length} packages -> ${out}${cargoLock.length ? '' : ' (Cargo.lock absent: Rust dependency list incomplete)'}`);
} catch (error) {
  process.stderr.write(`generate-sbom: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
