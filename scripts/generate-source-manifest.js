#!/usr/bin/env node
'use strict';

/**
 * Canonical, deterministic SOURCE_MANIFEST generator.
 *
 * The manifest excludes only itself and generated reports. Provenance inputs
 * (SOURCE_REVISION and SOURCE_DATE_EPOCH) are hashed like every other source
 * file, so verification detects tampering instead of trusting metadata that is
 * outside the digest set.
 *
 * Usage:
 *   node scripts/generate-source-manifest.js [--generate|--verify]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'SOURCE_MANIFEST.json');
const REVISION_PATH = path.join(ROOT, 'SOURCE_REVISION');
const EPOCH_PATH = path.join(ROOT, 'SOURCE_DATE_EPOCH');

const EXCLUDE_FILES = new Set([
  'SOURCE_MANIFEST.json',
  // protocol-drift.json contains a generatedAt timestamp and is evidence,
  // not source input.
  'reports/protocol-drift.json',
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
  'skills',
  'work',
  'workspace',
  'upload',
  'tool-results',
  'download',
]);

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function walk(dir, prefix = '') {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries.sort((a, b) => compareUtf8(a.name, b.name))) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isSymbolicLink()) {
      throw new Error(`symbolic link is not allowed in the release source tree: ${JSON.stringify(rel)}`);
    }
    if (ent.isDirectory()) {
      if (EXCLUDE_DIRS.has(rel) || EXCLUDE_DIRS.has(ent.name)) continue;
      out.push(...walk(path.join(dir, ent.name), rel));
    } else if (ent.isFile()) {
      if (EXCLUDE_FILES.has(rel) || EXCLUDE_FILES.has(ent.name)) continue;
      out.push(rel);
    } else {
      throw new Error(`unsupported filesystem entry in release source tree: ${JSON.stringify(rel)}`);
    }
  }
  return out;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function hashEntries(entries) {
  const ordered = {};
  for (const key of Object.keys(entries).sort(compareUtf8)) ordered[key] = entries[key];
  return crypto.createHash('sha256').update(JSON.stringify(ordered, null, 2)).digest('hex');
}

function readRevision() {
  const raw = fs.readFileSync(REVISION_PATH, 'utf8').trim();
  return raw || null;
}

function readSourceEpoch() {
  const raw = fs.readFileSync(EPOCH_PATH, 'utf8').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`SOURCE_DATE_EPOCH must be a non-negative integer (got ${JSON.stringify(raw)})`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('SOURCE_DATE_EPOCH is outside the JavaScript safe integer range');
  return value;
}

function displayRevision(revision) {
  if (!revision) return '(none)';
  return /^[0-9a-f]{40}$/.test(revision) ? revision.slice(0, 12) : revision;
}

function generate() {
  const files = walk(ROOT);
  const entries = {};
  for (const rel of files) entries[rel] = sha256(path.join(ROOT, rel));

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const sourceCommit = readRevision();
  const manifest = {
    version: pkg.version,
    generated: readSourceEpoch(),
    root: `Octopus-${pkg.version}`,
    file_count: files.length,
    files: entries,
    sha256_of_manifest: hashEntries(entries),
  };
  if (sourceCommit) manifest.source_commit = sourceCommit;

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`generate-source-manifest: wrote ${files.length} files, version=${pkg.version}, commit=${displayRevision(sourceCommit)}`);
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

  const report = (message) => {
    process.stderr.write(`ERROR: ${message}\n`);
    errors += 1;
  };

  if (manifest.file_count !== actualFiles.length) {
    report(`file_count mismatch — manifest=${manifest.file_count}, actual=${actualFiles.length}`);
  }

  const actualSet = new Set(actualFiles);
  for (const file of manifestFiles) if (!actualSet.has(file)) report(`manifest lists ${JSON.stringify(file)} but file does not exist`);
  const manifestSet = new Set(manifestFiles);
  for (const file of actualFiles) if (!manifestSet.has(file)) report(`file ${JSON.stringify(file)} exists but is not in manifest`);

  for (const file of actualFiles) {
    if (!manifest.files[file]) continue;
    if (sha256(path.join(ROOT, file)) !== manifest.files[file]) report(`hash mismatch for ${JSON.stringify(file)}`);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (manifest.version !== pkg.version) report(`manifest.version (${manifest.version}) != package.json version (${pkg.version})`);
  if (manifest.root !== `Octopus-${pkg.version}`) report(`manifest.root (${manifest.root}) != Octopus-${pkg.version}`);

  const expectedRevision = readRevision();
  if ((manifest.source_commit || null) !== expectedRevision) {
    report(`manifest.source_commit (${manifest.source_commit || '(none)'}) != SOURCE_REVISION (${expectedRevision || '(none)'})`);
  }
  if (manifest.source_commit) {
    const valid = /^[0-9a-f]{40}$/.test(manifest.source_commit)
      || /^(?:octopus|re-llmpet)-/.test(manifest.source_commit);
    if (!valid) report(`manifest.source_commit has unsupported format: ${JSON.stringify(manifest.source_commit)}`);
  }

  const expectedEpoch = readSourceEpoch();
  if (manifest.generated !== expectedEpoch) {
    report(`manifest.generated (${manifest.generated}) != SOURCE_DATE_EPOCH (${expectedEpoch})`);
  }

  const expectedEntriesHash = hashEntries(manifest.files || {});
  if (manifest.sha256_of_manifest !== expectedEntriesHash) {
    report('sha256_of_manifest does not match the canonical file-hash map');
  }

  if (errors > 0) {
    process.stderr.write(`\nmanifest verification FAILED with ${errors} error(s)\n`);
    process.exit(1);
  }
  console.log(`manifest verification OK: ${actualFiles.length} files, version=${pkg.version}, commit=${displayRevision(manifest.source_commit)}`);
}

const mode = process.argv[2] || '--generate';
try {
  if (mode === '--verify') verify();
  else if (mode === '--generate') generate();
  else {
    process.stderr.write('Usage: generate-source-manifest.js [--generate|--verify]\n');
    process.exit(1);
  }
} catch (error) {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
