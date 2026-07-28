# Tauri release procedure

1. Generate and commit `src-tauri/Cargo.lock` from a successful supported-platform build.
2. Run `npm ci --ignore-scripts`, `npm test`, `npm run gate:assets`, and `node scripts/check-release-gates.js --ci`.
3. Pass the Linux/Windows/macOS matrix in `.github/workflows/ci.yml` with `--locked`.
4. Pass the real Provider CLI workflow with isolated HOME directories and recorded CLI versions.
5. Pass the self-hosted desktop workflow, including GUI interaction, focus, suspend/display recovery, and the release-duration performance benchmark.
6. Configure Tauri updater private key, Windows signing certificate, and Apple signing/notarization secrets.
7. Tag `v<package.version>` and run `.github/workflows/release.yml`.
8. Verify signed bundles, updater signatures, SHA-256 manifests, SPDX SBOM, GitHub artifact attestations, and installation on documented baseline systems.

No gate may be replaced by a screenshot or by a source-only smoke test.
