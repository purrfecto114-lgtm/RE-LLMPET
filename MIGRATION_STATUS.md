# Migration status — 0.5.0-phase4

The active source tree is now Tauri 2 / Rust only. The retired Electron/Node runtime has been removed rather than retained as an in-tree rollback path. Three anonymized provider/pricing fixtures remain under `test/fixtures` and are pinned by SHA-256.

## Completed at source level

- Provider-specific hook/install adapters and honest capability boundaries.
- Claude structured question/plan flows and Claude-only persistent permission suggestions.
- Parallel permission-card preservation with exact retry deduplication.
- State ordering, metering, transcript tailing, pricing cache, focus adapters, and display/suspend recovery.
- Source/test/release gates that reject retired runtime paths and require locked builds, signing, checksums, SBOM, and attestations.

## Still externally blocked

- A genuine `src-tauri/Cargo.lock` from successful dependency resolution.
- Linux, Windows, and macOS compiled Rust/Tauri evidence.
- Real Claude/CodeWhale/Codex/OpenCode/Aider CLI evidence.
- Real GUI, terminal focus, suspend/display, mixed-DPI, and performance evidence.
- Windows code signing, macOS signing/notarization, Linux baseline packages, and updater signature verification.

Therefore this remains a **source-complete migration candidate**, not a stable production release.
