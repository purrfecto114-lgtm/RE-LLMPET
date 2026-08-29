# Tauri release procedure

## Current 0.5.x prerelease policy

1. Run `npm ci --ignore-scripts`, `npm test`, `npm run gate:assets`, and `node scripts/check-release-gates.js --ci`.
2. Pass the Linux/Windows/macOS matrix in `.github/workflows/ci.yml` with the committed Cargo lock.
3. Pass real-provider and real-desktop workflows; source-string smoke tests do not substitute for these gates.
4. Use `workflow_dispatch` for isolated draft inspection. A tag must exactly match `v<package.version>` and remains a prerelease before 0.6.0.
5. The updater plugin and `createUpdaterArtifacts` are disabled. Do not require or advertise `TAURI_SIGNING_PRIVATE_KEY` until updater support is deliberately added with public-key rotation and recovery documentation.
6. Windows Authenticode and macOS Developer ID/notarization are independent native publisher-signing controls. When `REQUIRE_PLATFORM_SIGNING=true`, missing platform credentials fail the relevant build.
7. Keep the release private until `scripts/verify-release-assets.js` confirms that all four checksum manifests and matching SPDX files are attached, every checksummed installer exists, every uploaded installer is checksummed, and no two platforms produced the same asset basename.
8. Verify SHA-256 manifests, the deterministic SPDX SBOM, GitHub artifact attestations, artifact-specific native signatures, installation, uninstall and upgrade behavior. `SOURCE_DATE_EPOCH` and `SOURCE_REVISION` must match the values hashed by `SOURCE_MANIFEST.json`.

## Stable-release exit gate

A stable release additionally requires successful installer E2E, real-provider state and permission parity, release-duration performance results, and native signing on supported platforms. No gate may be replaced by a screenshot or source-only smoke test.
