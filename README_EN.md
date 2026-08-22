# Octopus — Tauri 2 desktop pet

`0.5.44` is a Tauri 2 / Rust migration candidate reconciled against the current official LLMPET upstream and the earlier five-provider fork. The active runtime contains the Tauri frontend, Rust core, resources, tests and release gates; Electron main/preload/Node runtime code is not part of the execution path.


Security-sensitive launches are fixed allowlists, `pet` and `panel` have separate Tauri capabilities, the CSP is restrictive, and the local HTTP surface is loopback-only. Windows replacement paths use backup-and-rollback semantics.

Run offline checks with:

```bash
npm ci --ignore-scripts
npm test
npm run gate:assets
npm run gate:source
```

`src-tauri/Cargo.lock` is committed. Native Rust/Tauri builds, real-provider CLI tests, real desktop tests, performance evidence, signing/notarization and third-party media-rights review are still required before public release.

See [`docs/FOLLOWUP_DRAG_TERMINAL_UI_2026-07-28.md`](docs/FOLLOWUP_DRAG_TERMINAL_UI_2026-07-28.md), [`docs/UPSTREAM_RECONCILIATION_2026-07-28.md`](docs/UPSTREAM_RECONCILIATION_2026-07-28.md), and [`docs/MIGRATION_STATUS.md`](docs/MIGRATION_STATUS.md).
