# Migration status — 0.5.44 upstream feature closure

The active source tree is Tauri 2 / Rust only. The retired Electron/Node runtime is not retained as an in-tree rollback path. Three anonymized provider/pricing fixtures remain under `test/fixtures` and are pinned by SHA-256.

## Completed at source level

- Provider-specific hook/install adapters and explicit capability boundaries for Claude Code, CodeWhale, Codex, OpenCode and Aider.
- Claude structured question/plan flows, parallel permission cards, exact retry deduplication, metering, transcript tailing, pricing, terminal focus, and display/suspend recovery.
- Native tray and renderer localization for simplified Chinese, English and Japanese.
- Three skins, Codex quota/rollout usage, provider diagnostics, session focus, and the panel metrics/calendar/detail surfaces.
- Pet HUD session search, Claude/Codex/attention/archive filters, pin/archive operations, and persistent session preferences.
- **Dual-pet mode**: independent Claude and Codex Tauri windows, skin and saved position, provider-filtered events/stats, and per-window click-through/visual-bound state.
- **Todo real data**: legacy `TodoWrite` input snapshots plus current `TaskList` / `TaskGet` responses and `TaskCreate` / `TaskUpdate` lifecycle data are normalized into ID-aware session Todo items and exposed in pet/panel stats.
- **Travel / wander / growth**: single-flight read-only Claude/Codex project trips plus provider-native wandering (Claude WebSearch/WebFetch; Codex hosted `web_search` via the global `--search` flag), cancellation, a 30-minute timeout, private bounded output capture, persisted active-trip crash recovery and postcards, token-derived leaf/star/moon/day growth, and completion counters.
- **Territory on macOS**: automatic patrol discovers configured rival application windows through System Events and pushes them to the nearest screen edge. Other platforms return an explicit unsupported result.
- **Official data migration**: idempotent incremental, non-destructive import from `~/.octopus` into `~/.re-llmpet`; every startup rechecks later-arriving files without overwriting existing targets, source/target symlinks and oversized files are rejected, imported files use private permissions, Claude usage is converted into the native deduplicated ledger, Codex aggregates are fallback-only, official travel history/growth is converted to the Tauri postcard model, and transient PID caches are deliberately excluded.
- Restrictive Tauri capabilities, CSP, loopback HTTP hardening, config quarantine/recovery, unknown-field preservation, release receipts, source manifest verification, and package supply-chain gates.
- Transparent-pet input recovery with native desktop-cursor hit testing, DPI-aware bounds, bottom-centre resize anchoring, and drag movement separated from final persistence.
- Windows Terminal launch with deterministic `cmd.exe /D /K` fallback and Windows-safe atomic config replacement.
- Upstream-style ask toolbar and provider identity tags. The meme selector/media-preview feature remains intentionally excluded while the cat skin assets are retained.

## Deliberate product exclusions

- Meme selector, preview window, and media dispatch are intentionally excluded from this fork.
- The Tauri Territory implementation uses direct accessibility window repositioning rather than upstream's separate Swift animated drag helper/software cursor.

## Still externally blocked or unverified

- Linux, Windows and macOS `cargo fmt/check/test/build --locked` evidence. This review environment has no Rust toolchain, so native compilation could not be executed.
- Real Claude/CodeWhale/Codex/OpenCode/Aider CLI evidence, including end-to-end travel/wander output and cancellation.
- Real GUI evidence for two-pet click-through/drag/position persistence, mixed-DPI recovery, tray rendering, Todo events, travel postcards, and macOS Accessibility/Territory behavior.
- Windows code signing, macOS signing/notarization, Linux baseline packages, and updater signature verification.

This is therefore a **source-reconciled release candidate**, not a production-certified binary. The repository's Node/static/protocol/resource suites pass; native builds and real-machine behavior remain release requirements.

See `docs/UPSTREAM_PARITY_MATRIX.json` for itemized parity evidence and `CHANGELOG.md` for the historical migration rounds.
