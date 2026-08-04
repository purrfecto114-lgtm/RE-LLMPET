#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { verifyReleaseAssets } = require('../scripts/verify-release-assets');

const hash = (character) => character.repeat(64);
const manifests = [
  { name: 'SHA256SUMS-linux-x64', text: `${hash('a')}  release/bundle/deb/octopus.deb\n${hash('b')}  release/bundle/appimage/octopus.AppImage\n` },
  { name: 'SHA256SUMS-windows-x64', text: `${hash('c')}  release/bundle/nsis/octopus.exe\n` },
  { name: 'SHA256SUMS-macos-arm64', text: `${hash('d')}  release/bundle/dmg/octopus-arm64.dmg\n` },
  { name: 'SHA256SUMS-macos-x64', text: `${hash('e')}  release/bundle/dmg/octopus-x64.dmg\n` },
];
const evidenceAssets = manifests.flatMap((manifest) => {
  const id = manifest.name.replace('SHA256SUMS-', '');
  return [{ name: manifest.name }, { name: `octopus-${id}.spdx.json` }];
});
const release = {
  isDraft: true,
  isPrerelease: true,
  assets: [
    ...evidenceAssets,
    { name: 'octopus.deb' },
    { name: 'octopus.AppImage' },
    { name: 'octopus.exe' },
    { name: 'octopus-arm64.dmg' },
    { name: 'octopus-x64.dmg' },
  ],
};

assert.deepStrictEqual(verifyReleaseAssets(release, manifests, 4), {
  manifests: 4,
  distributables: 5,
  platforms: ['linux-x64', 'macos-arm64', 'macos-x64', 'windows-x64'],
});

assert.throws(
  () => verifyReleaseAssets({ ...release, isDraft: false }, manifests, 4),
  /private draft/,
);
assert.throws(
  () => verifyReleaseAssets({ ...release, assets: release.assets.filter((asset) => asset.name !== 'octopus.exe') }, manifests, 4),
  /not uploaded/,
);
assert.throws(
  () => verifyReleaseAssets({ ...release, assets: [...release.assets, { name: 'unchecked.msi' }] }, manifests, 4),
  /missing from checksums/,
);
assert.throws(
  () => verifyReleaseAssets(release, [
    ...manifests.slice(0, 3),
    { name: 'SHA256SUMS-macos-x64', text: `${hash('f')}  release/bundle/dmg/octopus-arm64.dmg\n` },
  ], 4),
  /basename collision/,
);
assert.throws(
  () => verifyReleaseAssets(release, manifests.slice(0, 3), 4),
  /expected 4 checksum manifests/,
);

console.log('release-asset-verifier: ok');
