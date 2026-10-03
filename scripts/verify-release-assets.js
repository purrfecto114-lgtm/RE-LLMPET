#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DISTRIBUTABLE = /\.(?:deb|appimage|rpm|exe|msi|dmg|pkg)$/i;
const CHECKSUM_NAME = /^SHA256SUMS-(.+)$/;

function parseChecksumManifest(text, sourceName) {
  const entries = [];
  for (const [index, rawLine] of String(text).split(/\r?\n/).entries()) {
    if (!rawLine.trim()) continue;
    const match = rawLine.match(/^([a-f0-9]{64})  (.+)$/i);
    if (!match) {
      throw new Error(`${sourceName}:${index + 1}: invalid SHA-256 manifest line`);
    }
    const relative = match[2].replaceAll('\\', '/');
    const name = path.posix.basename(relative);
    if (!name || name === '.' || name === '..') {
      throw new Error(`${sourceName}:${index + 1}: invalid artifact path`);
    }
    if (!DISTRIBUTABLE.test(name)) {
      throw new Error(`${sourceName}:${index + 1}: non-distributable artifact ${name}`);
    }
    entries.push({ digest: match[1].toLowerCase(), name, sourceName });
  }
  if (!entries.length) throw new Error(`${sourceName}: no distributable artifacts listed`);
  return entries;
}

function verifyReleaseAssets(release, checksumFiles, expectedManifests = 4) {
  if (!release || !Array.isArray(release.assets)) {
    throw new Error('release JSON must contain an assets array');
  }
  if (release.isDraft !== true) {
    throw new Error('release must still be a private draft during verification');
  }
  if (release.isPrerelease !== true) {
    throw new Error('0.5.x release must remain marked as prerelease');
  }
  if (!Number.isInteger(expectedManifests) || expectedManifests < 1) {
    throw new Error('expected manifest count must be a positive integer');
  }

  const assetNames = new Set();
  for (const asset of release.assets) {
    const name = asset && typeof asset.name === 'string' ? asset.name : '';
    if (!name) throw new Error('release contains an asset without a name');
    if (assetNames.has(name)) throw new Error(`duplicate release asset name: ${name}`);
    assetNames.add(name);
  }

  if (checksumFiles.length !== expectedManifests) {
    throw new Error(`expected ${expectedManifests} checksum manifests, found ${checksumFiles.length}`);
  }

  const expectedArtifacts = new Map();
  const manifestIds = new Set();
  for (const manifest of checksumFiles) {
    const manifestName = path.basename(manifest.name);
    const match = manifestName.match(CHECKSUM_NAME);
    if (!match) throw new Error(`unexpected checksum filename: ${manifestName}`);
    const id = match[1];
    if (manifestIds.has(id)) throw new Error(`duplicate checksum platform id: ${id}`);
    manifestIds.add(id);

    if (!assetNames.has(manifestName)) {
      throw new Error(`release is missing checksum asset ${manifestName}`);
    }
    const sbomName = `octopus-${id}.spdx.json`;
    if (!assetNames.has(sbomName)) {
      throw new Error(`release is missing SBOM asset ${sbomName}`);
    }

    for (const entry of parseChecksumManifest(manifest.text, manifestName)) {
      const previous = expectedArtifacts.get(entry.name);
      if (previous && previous.digest !== entry.digest) {
        throw new Error(
          `artifact basename collision: ${entry.name} has different hashes in ${previous.sourceName} and ${entry.sourceName}`,
        );
      }
      if (previous) {
        throw new Error(`artifact ${entry.name} is listed by more than one checksum manifest`);
      }
      expectedArtifacts.set(entry.name, entry);
    }
  }

  const actualDistributables = [...assetNames].filter((name) => DISTRIBUTABLE.test(name)).sort();
  const expectedDistributables = [...expectedArtifacts.keys()].sort();
  for (const name of expectedDistributables) {
    if (!assetNames.has(name)) throw new Error(`checksummed artifact was not uploaded: ${name}`);
  }
  for (const name of actualDistributables) {
    if (!expectedArtifacts.has(name)) throw new Error(`uploaded artifact is missing from checksums: ${name}`);
  }
  if (actualDistributables.length !== expectedDistributables.length) {
    throw new Error('release artifact/checksum cardinality mismatch');
  }

  return {
    manifests: checksumFiles.length,
    distributables: expectedDistributables.length,
    platforms: [...manifestIds].sort(),
  };
}

function readChecksumFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && CHECKSUM_NAME.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      text: fs.readFileSync(path.join(directory, entry.name), 'utf8'),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function main(argv) {
  const releasePath = path.resolve(argv[0] || 'release-audit/release.json');
  const evidenceDir = path.resolve(argv[1] || path.dirname(releasePath));
  const expected = Number(argv[2] || 4);
  const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
  const result = verifyReleaseAssets(release, readChecksumFiles(evidenceDir), expected);
  process.stdout.write(
    `verify-release-assets: ${result.manifests} manifests, ${result.distributables} artifacts, platforms=${result.platforms.join(',')}\n`,
  );
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`verify-release-assets: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

module.exports = { parseChecksumManifest, verifyReleaseAssets };
