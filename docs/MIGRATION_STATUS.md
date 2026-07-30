# Migration status — 0.5.5 reconciliation candidate

The active source tree is Tauri 2 / Rust only. The retired Electron/Node runtime is not retained as an in-tree rollback path. Three anonymized provider/pricing fixtures remain under `test/fixtures` and are pinned by SHA-256.

## Completed at source level

- Provider-specific hook/install adapters and explicit capability boundaries for Claude Code, CodeWhale, Codex, OpenCode and Aider.
- Claude structured question/plan flows and Claude-only persistent permission suggestions.
- Parallel permission-card preservation with exact retry deduplication.
- State ordering, metering, transcript tailing, pricing cache, focus adapters, and display/suspend recovery.
- Split `pet` and `panel` Tauri capabilities, restrictive CSP, loopback HTTP hardening and release/source gates.
- A committed `src-tauri/Cargo.lock`; package, Cargo and Tauri versions are aligned at `0.5.5`.
- Core renderer language switching for simplified Chinese, English and Japanese. Native tray translation remains partial.
- Byte-identical import of two official upstream GIF/MP3 action sets plus a backend-only exact catalog and presentation-safe generated manifest.
- Five-provider launch correctness, fixed command allowlists, validated native busy/bounds state and Windows atomic-write rollback.
- Transparent-pet input recovery implemented with native desktop-cursor hit testing and DPI-aware validated bounds; manual drag preserves short-click behavior instead of relying on native title-bar dragging. Popup resizing converts logical CSS size exactly once, preserves the visible pet bottom-centre anchor and clamps to the monitor work area.
- Drag movement separated from persistence: renderer moves are animation-frame throttled and serialized, while Rust saves and emits the final position once.
- Windows agent launch passes the fixed provider executable directly to Windows Terminal and falls back to `cmd.exe /D /K` only when `wt.exe` cannot be spawned.
- Upstream-style ask toolbar, provider identity tags, the meme selector's second-page session HUD and skin-aware side-media preview are integrated without changing imported GIF/audio bytes.

## Deliberately deferred

- Full agent-side meme prompt dispatch. The current feature is a clearly labelled local preview; backend-only prompt ownership and exact provider/session delivery must be designed and tested first.
- Complete dynamic translation of native tray/menu surfaces.
- Production-grade territory/collision behavior and proof across mixed-DPI/multi-monitor desktops.

## Still externally blocked or unverified

- Linux, Windows and macOS `cargo fmt/check/test/build --locked` evidence. This review environment has no Rust toolchain and cannot resolve package/GitHub hosts.
- Real Claude/CodeWhale/Codex/OpenCode/Aider CLI evidence.
- Real GUI evidence for drag/click-through, Windows Terminal fallback, terminal focus, suspend/display, mixed-DPI and performance behavior.
- Windows code signing, macOS signing/notarization, Linux baseline packages and updater signature verification.
- Redistribution-rights review for newly preserved third-party GIF/audio assets.

Therefore this remains a **source-reconciled migration candidate**, not a stable production release. Static, protocol and resource gates pass, but native builds and real-machine behavior remain release requirements.

See `docs/UPSTREAM_RECONCILIATION_2026-07-28.md` for the comparison and decision record.
