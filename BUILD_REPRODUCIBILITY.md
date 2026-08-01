# Build Reproducibility — RE-LLMPET 0.5.23

## Source Provenance

| Field | Value |
|---|---|
| Version | 0.5.23 |
| Release name | R40.4 package provenance rebuild |
| Source revision | 40-hex git commit SHA (see SOURCE_REVISION) |
| Source date epoch | See `SOURCE_DATE_EPOCH` |
| Upstream base | `purrfecto114-lgtm/RE-LLMPET` commit `dbd1409` (0.5.21 / R40.2) |
| Audit input | `RE-LLMPET-0.5.22-package-regression-audit-roadmap.md` |
| Build date | 2026-08-01 |

## How to Build

### Prerequisites

- Rust toolchain (stable, with `cargo fmt`, `cargo clippy`)
- Node.js 20+ (for running smoke tests only — no npm dependencies)
- Tauri 2 CLI (`cargo install tauri-cli --version "^2.0"`)

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
- `SOURCE_DATE_EPOCH` can be used to set build timestamps.
- The `SOURCE_MANIFEST.json` file lists every source file with its
  SHA-256 hash, allowing bit-for-bit verification of the source tree.

## Known Limitations

- This package was NOT built with a Rust toolchain (the build/CI
  environment lacks `cargo`). The Rust compile checks above MUST be
  run by the user/maintainer before publishing any binary release.
- The JS smoke tests are source-string contracts, not behavior tests.
  They verify "the code contains the expected fix strings" but do not
  execute the Rust runtime. A full L0+L1+L2 test pyramid (per the
  carpet audit §13) is planned for R41.
- Platform binaries (Windows `.exe`, macOS `.app`, Linux `.deb`) are
  NOT included in this source package. They must be built on the
  target platform with the steps above.

## Verification Checklist

Before publishing a binary release from this source:

- [ ] `cargo check` passes (verifies P0-1 format string fix)
- [ ] `cargo clippy` passes with no warnings
- [ ] `cargo test` passes
- [ ] `npm test` passes (48+ smoke suites including R40.1)
- [ ] `npm run check:static` passes (22/22)
- [ ] CodeWhale config backup is created before any write
- [ ] CodeWhale legacy cleanup is NOT automatically run
- [ ] OpenCode diagnostic uses `auth list` (not `providers list`)
- [ ] OpenCode plugin reads actual `session.status` payload
- [ ] Frontend rejects stale `__revision` stats
- [ ] StatsCoalescer uses single consolidated mutex
- [ ] Package root, version files, CHANGELOG, manifest all agree
