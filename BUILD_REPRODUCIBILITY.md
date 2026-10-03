# Build Reproducibility — Octopus 0.5.41

## Source Provenance

| Field | Value |
|---|---|
| Version | 0.5.41 |
| Release name | Octopus 0.5.41 deep-audit source |
| Source revision | `octopus-<version>` for local source drops; CI may replace it with a 40-hex Git SHA (see `SOURCE_REVISION`) |
| Source date epoch | See `SOURCE_DATE_EPOCH` |
| Upstream base | `purrfecto114-lgtm/RE-LLMPET` commit `dbd1409` (0.5.21 / R40.2) |
| Audit input | `RE-LLMPET-0.5.22-package-regression-audit-roadmap.md` |
| Source audit date | 2026-08-04 |

## How to Build

### Prerequisites

- Rust toolchain (stable, with `cargo fmt`, `cargo clippy`)
- Node.js 20+ (for running smoke tests only — no npm dependencies)
- Tauri 2 CLI pinned for the build environment (current desktop gate uses `^2.11.0 --locked`)

### Build Steps

```bash
# 1. Verify source integrity
sha256sum SOURCE_MANIFEST.json  # compare with published hash

# 2. Run Rust checks (MUST pass before release)
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo check --workspace --all-targets --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --workspace --all-targets --locked --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --workspace --all-targets --locked --manifest-path src-tauri/Cargo.toml

# 3. Run JS smoke tests
npm test

# 4. Run static checks
npm run check:static

# 5. Build platform bundle
cargo tauri build
```

### Reproducibility

- The source tree has zero npm runtime/dev dependencies.
- All Rust dependencies are pinned in `src-tauri/Cargo.lock`.
- `SOURCE_DATE_EPOCH` is the canonical timestamp for the source manifest and SPDX SBOM; identical inputs produce byte-identical metadata.
- `SOURCE_REVISION` and `SOURCE_DATE_EPOCH` are included in `SOURCE_MANIFEST.json`'s per-file SHA-256 set, so provenance-label tampering is detected.
- `SOURCE_MANIFEST.json` verifies the exact file set, root/version metadata and the canonical digest of the file-hash map.

## Known Limitations

- This package was NOT built with a Rust toolchain (the build/CI
  environment lacks `cargo`). The Rust compile checks above MUST be
  run by the user/maintainer before publishing any binary release.
- Most JS smoke suites are source-contract checks; focused controller tests execute JavaScript behavior, but none replace Rust compilation or real desktop tests.
- Platform binaries (Windows `.exe`, macOS `.app`, Linux `.deb`) are
  NOT included in this source package. They must be built on the
  target platform with the steps above.

## Verification Checklist

Before publishing a binary release from this source:

- [ ] `cargo check` passes (verifies P0-1 format string fix)
- [ ] `cargo clippy` passes with no warnings
- [ ] `cargo test` passes
- [ ] `npm test` passes, including R45 release/lifecycle integrity gates
- [ ] `npm run check:static` passes (22/22)
- [ ] CodeWhale config backup is created before any write
- [ ] CodeWhale legacy cleanup is NOT automatically run
- [ ] OpenCode diagnostic uses `auth list` (not `providers list`)
- [ ] OpenCode plugin reads actual `session.status` payload
- [ ] Frontend rejects stale `__revision` stats
- [ ] StatsCoalescer uses single consolidated mutex
- [ ] Package root, version files, migration metadata, CHANGELOG and manifest all agree
- [ ] Updater artifacts remain disabled unless the updater plugin and key lifecycle are deliberately introduced
- [ ] Windows/macOS artifacts are labeled according to their actual native publisher-signing state
