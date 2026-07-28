#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const draft = args.includes('--draft');
const output = path.resolve(args.find((a) => !a.startsWith('-')) || 'src-tauri/tauri.release.generated.json');
// We don't ship the tauri updater plugin, so createUpdaterArtifacts stays
// false in all modes (the action's updater JSON/signature upload is also
// disabled in release.yml). Add the updater plugin + signing key to enable.
const config = { bundle: { createUpdaterArtifacts: false } };
if (process.platform === 'darwin') {
  const identity = String(process.env.APPLE_SIGNING_IDENTITY || '').trim();
  if (identity) {
    // Note: Tauri 2 bundle config key is `macOS` (capital S), not `macos`.
    config.bundle.macOS = { signingIdentity: identity };
  } else if (draft) {
    // No Apple cert in draft mode: use ad-hoc signing (-) so the .app bundles
    // without a real Developer ID. The DMG/app will run locally but won't be
    // notarized — fine for pre-release testing. Production uses APPLE_SIGNING_IDENTITY.
    config.bundle.macOS = { signingIdentity: '-' };
  } else {
    console.error('generate-release-config: APPLE_SIGNING_IDENTITY is required on macOS (or pass --draft for ad-hoc signed builds)');
    process.exit(1);
  }
}
if (process.platform === 'win32') {
  const thumbprint = String(process.env.WINDOWS_CERTIFICATE_THUMBPRINT || '').replace(/\s/g, '');
  if (thumbprint) {
    config.bundle.windows = {
      certificateThumbprint: thumbprint,
      digestAlgorithm: 'sha256',
      timestampUrl: process.env.WINDOWS_TIMESTAMP_URL || 'http://timestamp.digicert.com'
    };
  } else if (!draft) {
    console.error('generate-release-config: WINDOWS_CERTIFICATE_THUMBPRINT is required on Windows (or pass --draft for unsigned builds)');
    process.exit(1);
  }
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(config, null, 2) + '\n');
console.log(`generate-release-config: ${output} (draft=${draft})`);


