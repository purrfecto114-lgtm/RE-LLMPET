#!/usr/bin/env node
'use strict';

/**
 * R40.4 (2026-08-01): Canonical SOURCE_MANIFEST generator.
 *
 * Fixes the 0.5.22 audit P0-4 issues:
 *   - Exact file set (no missing, no unlisted)
 *   - Per-file SHA-256 verified
 *   - No self-include ambiguity (manifest excludes itself)
 *   - Deterministic ordering (bytewise sorted paths)
 *   - SOURCE_REVISION must be a 40-hex git commit SHA
 *
 * Usage:
 *   node scripts/generate-source-manifest.js [--verify]
 *
 * --verify: compare existing SOURCE_MANIFEST.json against actual files;
 *           exit non-zero on any mismatch (for CI gate).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'SOURCE_MANIFEST.json');
const REVISION_PATH = path.join(ROOT, 'SOURCE_REVISION');

const EXCLUDE_FILES = new Set([
  'SOURCE_MANIFEST.json',
  'SOURCE_REVISION',
  'SOURCE_DATE_EPOCH',
  // R40.4: protocol-drift.json contains a generatedAt timestamp that
  // changes on every check-protocol-drift run. It is a build-time report,
  // not a source artifact.
  'reports/protocol-drift.json',
  // R40.4: .env is a local build input, never a source artifact.
  '.env',
]);

const EXCLUDE_DIRS = new Set([
  '.git',
  'node_modules',
  'target',
  '__pycache__',
  'src-tauri/target',
  'src-tauri/gen',
  'dist',
  '.vscode',
  '.idea',
]);

function walk(dir, prefix = '') {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      if (EXCLUDE_DIRS.has(rel) || EXCLUDE_DIRS.has(ent.name)) continue;
      out.push(...walk(path.join(dir, ent.name), rel));
    } else if (ent.isFile()) {
      if (EXCLUDE_FILES.has(rel) || EXCLUDE_FILES.has(ent.name)) continue;
      out.push(rel);
    }
  }
  return out;
}

function sha256(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function readRevision() {
  const raw = fs.readFileSync(REVISION_PATH, 'utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(raw)) {
    process.stderr.write(
      `ERROR: SOURCE_REVISION must be a 40-hex git commit SHA (got: "${raw}").\n` +
      `Run: git rev-parse HEAD > SOURCE_REVISION\n`
    );
    process.exit(1);
  }
  return raw;
}

function generate() {
  const files = walk(ROOT);
  const entries = {};
  for (const rel of files) {
    entries[rel] = sha256(path.join(ROOT, rel));
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const manifest = {
    version: pkg.version,
    generated: Math.floor(Date.now() / 1000),
    root: `RE-LLMPET-${pkg.version}`,
    source_commit: readRevision(),
    file_count: files.length,
    files: entries,
  };
  const sortedJson = JSON.stringify(entries, Object.keys(entries).sort(), 2);
  manifest.sha256_of_manifest = crypto.createHash('sha256').update(sortedJson).digest('hex');
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`generate-source-manifest: wrote ${files.length} files, version=${pkg.version}, commit=${manifest.source_commit.slice(0,7)}`);
}

function verify() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    process.stderr.write('ERROR: SOURCE_MANIFEST.json not found. Run with --generate first.\n');
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const actualFiles = walk(ROOT);
  const manifestFiles = Object.keys(manifest.files || {});

  let errors = 0;

  if (manifest.file_count !== actualFiles.length) {
    process.stderr.write(
      `ERROR: file_count mismatch — manifest=${manifest.file_count}, actual=${actualFiles.length}\n`
    );
    errors++;
  }

  const actualSet = new Set(actualFiles);
  for (const f of manifestFiles) {
    if (!actualSet.has(f)) {
      process.stderr.write(`ERROR: manifest lists "${f}" but file does not exist\n`);
      errors++;
    }
  }

  const manifestSet = new Set(manifestFiles);
  for (const f of actualFiles) {
    if (!manifestSet.has(f)) {
      process.stderr.write(`ERROR: file "${f}" exists but is not in manifest\n`);
      errors++;
    }
  }

  for (const f of actualFiles) {
    if (!manifest.files[f]) continue;
    const actualHash = sha256(path.join(ROOT, f));
    if (actualHash !== manifest.files[f]) {
      process.stderr.write(`ERROR: hash mismatch for "${f}"\n`);
      errors++;
    }
  }

  if (!manifest.source_commit || !/^[0-9a-f]{40}$/.test(manifest.source_commit)) {
    process.stderr.write(
      `ERROR: manifest.source_commit must be 40-hex SHA (got: "${manifest.source_commit}")\n`
    );
    errors++;
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (manifest.version !== pkg.version) {
    process.stderr.write(
      `ERROR: manifest.version (${manifest.version}) != package.json version (${pkg.version})\n`
    );
    errors++;
  }

  if (errors > 0) {
    process.stderr.write(`\nmanifest verification FAILED with ${errors} error(s)\n`);
    process.exit(1);
  }
  console.log(`manifest verification OK: ${actualFiles.length} files, version=${pkg.version}, commit=${manifest.source_commit.slice(0,7)}`);
}

const mode = process.argv[2] || '--generate';
if (mode === '--verify') {
  verify();
} else if (mode === '--generate') {
  generate();
} else {
  process.stderr.write('Usage: generate-source-manifest.js [--generate|--verify]\n');
  process.exit(1);
}
