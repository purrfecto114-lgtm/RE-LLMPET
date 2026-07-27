#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const output = path.resolve(process.argv[2] || 'src-tauri/tauri.release.generated.json');
const config = { bundle: { createUpdaterArtifacts: true } };
if (process.platform === 'win32') {
  const thumbprint = String(process.env.WINDOWS_CERTIFICATE_THUMBPRINT || '').replace(/\s/g, '');
  if (!thumbprint) {
    console.error('generate-release-config: WINDOWS_CERTIFICATE_THUMBPRINT is required on Windows');
    process.exit(1);
  }
  config.bundle.windows = {
    certificateThumbprint: thumbprint,
    digestAlgorithm: 'sha256',
    timestampUrl: process.env.WINDOWS_TIMESTAMP_URL || 'http://timestamp.digicert.com'
  };
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(config, null, 2) + '\n');
console.log(`generate-release-config: ${output}`);
