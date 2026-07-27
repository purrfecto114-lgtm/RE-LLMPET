#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const draft = args.includes('--draft');
const output = path.resolve(args.find((a) => !a.startsWith('-')) || 'src-tauri/tauri.release.generated.json');
const config = { bundle: { createUpdaterArtifacts: !draft } };
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

