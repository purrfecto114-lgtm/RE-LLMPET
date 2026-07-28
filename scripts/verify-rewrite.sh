#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
npm test
if command -v cargo >/dev/null 2>&1; then
  cargo check --manifest-path src-tauri/Cargo.toml --all-targets
else
  echo 'cargo unavailable: Rust compile verification deferred to GitHub Actions' >&2
fi
