#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const draft = args.includes('--draft');
const requirePlatformSigning = String(process.env.REQUIRE_PLATFORM_SIGNING || '').toLowerCase() === 'true';
const output = path.resolve(args.find((a) => !a.startsWith('-')) || 'src-tauri/tauri.release.generated.json');
// We don't ship the tauri updater plugin, so createUpdaterArtifacts stays
// false in all modes (the action's updater JSON/signature upload is also
// disabled in release.yml). Add the updater plugin + signing key to enable.
const config = { bundle: { createUpdaterArtifacts: false } };
if (process.platform === 'darwin') {
  const identity = String(process.env.APPLE_SIGNING_IDENTITY || '').trim();
  if (identity && identity !== '-') {
    // Real Developer ID signing. Note: Tauri 2 bundle config key is `macOS`
    // (capital S), not `macos`. Ad-hoc signing (-) is handled via the
    // CSC_IDENTITY_AUTO_DISCOVERY env var in release.yml, not the config.
    config.bundle.macOS = { signingIdentity: identity };
  }
  if (!identity && !draft && requirePlatformSigning) {
    console.error('generate-release-config: APPLE_SIGNING_IDENTITY is required when REQUIRE_PLATFORM_SIGNING=true');
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
    if (requirePlatformSigning) {
      console.error('generate-release-config: WINDOWS_CERTIFICATE_THUMBPRINT is required when REQUIRE_PLATFORM_SIGNING=true');
      process.exit(1);
    }
    console.error('generate-release-config: WINDOWS_CERTIFICATE_THUMBPRINT not set — building without Authenticode publisher signing.');
  }
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(config, null, 2) + '\n');
console.log(`generate-release-config: ${output} (draft=${draft})`);


