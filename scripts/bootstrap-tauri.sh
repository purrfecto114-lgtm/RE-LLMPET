#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_SYSTEM=0
[[ "${1:-}" == "--install-system" ]] && INSTALL_SYSTEM=1

if [[ "$OSTYPE" == linux* && "$INSTALL_SYSTEM" == 1 ]]; then
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
      libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf xdg-utils
  else
    echo "Unsupported Linux package manager; install Tauri 2 system dependencies manually." >&2
    exit 2
  fi
elif [[ "$OSTYPE" == darwin* ]] && ! xcode-select -p >/dev/null 2>&1; then
  echo "Xcode Command Line Tools are required. Run: xcode-select --install" >&2
  exit 2
fi

if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh -s -- -y
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
fi

if ! cargo tauri --version >/dev/null 2>&1; then
  cargo install tauri-cli --version '^2.0.0' --locked
fi

cd "$ROOT"
npm test
cargo check --manifest-path src-tauri/Cargo.toml --all-targets
printf '\nToolchain ready. Start development with: npm start\n'
