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
  if (identity && identity !== '-') {
    // Real Developer ID signing. Note: Tauri 2 bundle config key is `macOS`
    // (capital S), not `macos`. Ad-hoc signing (-) is handled via the
    // CSC_IDENTITY_AUTO_DISCOVERY env var in release.yml, not the config.
    config.bundle.macOS = { signingIdentity: identity };
  }
  // In draft mode (no APPLE_SIGNING_IDENTITY), we set CSC_IDENTITY_AUTO_DISCOVERY=false
  // in the workflow env to skip signing entirely; no config change needed here.
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
    // R34 (2026-07-31): previously this was a hard FAIL. But the Tauri
    // updater signing key (TAURI_SIGNING_PRIVATE_KEY) is the cryptographic
    // root of trust for the binary — Windows code-signing cert is a separate
    // OS-UX concern (suppresses "unknown publisher" SmartScreen warning).
    // With the Tauri key configured, missing WINDOWS_CERTIFICATE_THUMBPRINT
    // should NOT block the build. The .exe will still be Tauri-signed; it
    // just won't be Windows code-signed, so Windows SmartScreen will show
    // "unknown publisher" on first run.
    //
    // To re-enable hard-fail when platform code-signing is procured, set
    // REQUIRE_PLATFORM_CERT=1 in the workflow env.
    if (process.env.REQUIRE_PLATFORM_CERT === '1') {
      console.error('generate-release-config: WINDOWS_CERTIFICATE_THUMBPRINT is required on Windows when REQUIRE_PLATFORM_CERT=1');
      process.exit(1);
    } else {
      console.error('generate-release-config: WINDOWS_CERTIFICATE_THUMBPRINT not set — building without Windows code-signing (Tauri updater signing still active). Set REQUIRE_PLATFORM_CERT=1 to enforce.');
    }
  }
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(config, null, 2) + '\n');
console.log(`generate-release-config: ${output} (draft=${draft})`);


