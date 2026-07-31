# RE-LLMPET / Octopus — Tauri 2 desktop pet

`0.5.7` is a Tauri 2 / Rust migration candidate reconciled against the current official LLMPET upstream and the earlier five-provider fork. The active runtime contains the Tauri frontend, Rust core, resources, tests and release gates; Electron main/preload/Node runtime code is not part of the execution path.

It supports provider-specific adapters for Claude Code, CodeWhale, Codex, OpenCode and Aider; structured Claude interactions; parallel permission cards; metering; source-PID terminal focus; and display/suspend recovery. The core pet and panel UI can switch between simplified Chinese, English and Japanese. Transparent click-through now recovers through native cursor hit testing, manual drag preserves short-click behavior, and logical popup sizes are DPI-converted with a bottom-centre anchor. On Windows, allow-listed agents are passed directly to a new Windows Terminal window, with `cmd.exe /D /K` used only when `wt.exe` cannot be spawned. Two official upstream GIF/audio actions are retained byte-for-byte as an explicitly local, skin-aware side preview; full prompt dispatch is intentionally deferred until provider/session ownership can be enforced in Rust.

Security-sensitive launches are fixed allowlists, `pet` and `panel` have separate Tauri capabilities, the CSP is restrictive, and the local HTTP surface is loopback-only. Windows replacement paths use backup-and-rollback semantics.

Run offline checks with:

```bash
npm ci --ignore-scripts
npm test
npm run gate:assets
npm run gate:memes
npm run gate:source
```

`src-tauri/Cargo.lock` is committed. Native Rust/Tauri builds, real-provider CLI tests, real desktop tests, performance evidence, signing/notarization and third-party media-rights review are still required before public release.

See [`docs/FOLLOWUP_DRAG_TERMINAL_UI_2026-07-28.md`](docs/FOLLOWUP_DRAG_TERMINAL_UI_2026-07-28.md), [`docs/UPSTREAM_RECONCILIATION_2026-07-28.md`](docs/UPSTREAM_RECONCILIATION_2026-07-28.md), and [`docs/MIGRATION_STATUS.md`](docs/MIGRATION_STATUS.md).
