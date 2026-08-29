#!/usr/bin/env node
'use strict';

/**
 * R40.4 (2026-08-01): Verify CHANGELOG claims against actual git diff.
 *
 * Fixes the 0.5.22 audit P0-3 issue: CHANGELOG listed files that either
 * don't exist or weren't actually changed in the release commit.
 *
 * This script:
 *   1. Parses the top CHANGELOG section for the current version.
 *   2. Extracts claimed "changed/new/removed" paths.
 *   3. Runs `git diff <prev_tag>..HEAD --name-status` to get actual changes.
 *   4. Reports any CHANGELOG claim that has no corresponding git change.
 *
 * Usage: node scripts/verify-changelog-diff.js
 * Exit: 0 if all claims verified, 1 if any mismatch.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

function readChangelog() {
  return fs.readFileSync(CHANGELOG, 'utf8');
}

function getCurrentVersionSection(content) {
  // Get the top ## section
  const lines = content.split('\n');
  const sections = [];
  let current = [];
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current.length > 0) sections.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current.join('\n'));
  return sections[0] || '';
}

function extractVersion(section) {
  const m = section.match(/^## (\d+\.\d+\.\d+)/m);
  return m ? m[1] : null;
}

function extractPrevVersion(content) {
  const lines = content.split('\n');
  const versions = [];
  for (const line of lines) {
    const m = line.match(/^## (\d+\.\d+\.\d+)/);
    if (m) versions.push(m[1]);
  }
  return versions[1] || null; // second one is previous
}

function extractClaimedPaths(section) {
  // Look for paths in backticks or code blocks that look like file paths
  const paths = new Set();
  // Match `path/to/file.ext` patterns
  const pathRegex = /`([a-zA-Z0-9_./-]+\.(rs|js|ts|json|toml|yml|yaml|md|html|css|py|sh|conf))`/g;
  let m;
  while ((m = pathRegex.exec(section)) !== null) {
    paths.add(m[1]);
  }
  // Match paths in code blocks (indented or ``` blocks)
  const codeBlockRegex = /```[\s\S]*?```/g;
  let codeMatch;
  while ((codeMatch = codeBlockRegex.exec(section)) !== null) {
    const block = codeMatch[0];
    const linePathRegex = /^\s*[-*]?\s*`?([a-zA-Z0-9_./-]+\.(rs|js|ts|json|toml|yml|yaml|md|html|css|py|sh|conf))`?/gm;
    let lm;
    while ((lm = linePathRegex.exec(block)) !== null) {
      paths.add(lm[1]);
    }
  }
  return [...paths];
}

function getActualChanges(prevTag, currentHead) {
  try {
    const out = execSync(
      `git diff ${prevTag}..${currentHead} --name-status`,
      { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    if (!out) return { changed: [], added: [], removed: [] };
    const changed = [], added = [], removed = [];
    for (const line of out.split('\n')) {
      const [status, ...pathParts] = line.split('\t');
      const filePath = pathParts.join('\t');
      if (status.startsWith('A')) added.push(filePath);
      else if (status.startsWith('D')) removed.push(filePath);
      else changed.push(filePath); // M, R, C, etc.
    }
    return { changed, added, removed };
  } catch (e) {
    return { changed: [], added: [], removed: [], error: e.message };
  }
}

function main() {
  if (!fs.existsSync(CHANGELOG)) {
    console.error('ERROR: CHANGELOG.md not found');
    process.exit(1);
  }

  const content = readChangelog();
  const section = getCurrentVersionSection(content);
  const version = extractVersion(section);
  const prevVersion = extractPrevVersion(content);

  if (!version) {
    console.error('ERROR: could not extract current version from CHANGELOG');
    process.exit(1);
  }

  console.log(`Current version: ${version}`);
  console.log(`Previous version: ${prevVersion || '(none)'}`);

  const claimedPaths = extractClaimedPaths(section);
  console.log(`Claimed paths in CHANGELOG section: ${claimedPaths.length}`);

  if (!prevVersion) {
    console.log('No previous version found — skipping diff verification');
    process.exit(0);
  }

  // Get actual git changes
  const prevTag = `v${prevVersion}`;
  const actual = getActualChanges(prevTag, 'HEAD');

  if (actual.error) {
    console.error(`ERROR: git diff failed: ${actual.error}`);
    process.exit(1);
  }

  const allActual = new Set([...actual.changed, ...actual.added, ...actual.removed]);
  console.log(`Actual git changes (${prevTag}..HEAD): ${allActual.size} files`);
  console.log(`  changed: ${actual.changed.length}, added: ${actual.added.length}, removed: ${actual.removed.length}`);

  // Check each claimed path
  let mismatches = 0;
  console.log('\n--- Verifying claimed paths ---');
  for (const claimed of claimedPaths.sort()) {
    // Check if the claimed path (or a parent dir) is in actual changes
    const found = [...allActual].some(actualPath =>
      actualPath === claimed ||
      actualPath.startsWith(claimed + '/') ||
      claimed.startsWith(actualPath + '/')
    );
    if (found) {
      console.log(`  ✅ ${claimed}`);
    } else {
      console.log(`  ❌ ${claimed} — NOT in git diff`);
      mismatches++;
    }
  }

  if (mismatches > 0) {
    console.error(`\n❌ CHANGELOG verification FAILED: ${mismatches} claimed path(s) not in git diff`);
    process.exit(1);
  }
  console.log(`\n✅ CHANGELOG verification OK: all ${claimedPaths.length} claimed paths verified`);
}

main();
