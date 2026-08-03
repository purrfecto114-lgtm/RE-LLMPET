# Migration status — 0.5.33 R44 Phase 0A + R32/R34 correctness hotfixes

The active source tree is Tauri 2 / Rust only. The retired Electron/Node runtime is not retained as an in-tree rollback path. Three anonymized provider/pricing fixtures remain under `test/fixtures` and are pinned by SHA-256.

## Completed at source level

- Provider-specific hook/install adapters and explicit capability boundaries for Claude Code, CodeWhale, Codex, OpenCode and Aider.
- Claude structured question/plan flows and Claude-only persistent permission suggestions.
- Parallel permission-card preservation with exact retry deduplication.
- State ordering, metering, transcript tailing, pricing cache, focus adapters, and display/suspend recovery.
- Split `pet` and `panel` Tauri capabilities, restrictive CSP, loopback HTTP hardening and release/source gates.
- A committed `src-tauri/Cargo.lock`; package, Cargo and Tauri versions are aligned at `0.5.33`.
- Core renderer language switching for simplified Chinese, English and Japanese.
- **Native tray fully localized** (R11-R13): `i18n.rs` 29-key table, `refresh_tray_menu` rebuilds menu + tooltip on language switch.
- **Tray visual elements 18/18 complete** (R10-R14): showPet, panel, language submenu, skin submenu, 5h budget submenu, mute toggle, settings placeholder, launch submenu (5 providers), openLog, uninstall hooks, shape submenu (pet/panel/hidePet), tooltip, left-click show, refreshTrayMenu. Duo-pet explicitly rejected (R8 unified panel); territory patrol deferred (1700 LOC).
- **Panel visual elements 10/10 complete** (R15-R19): Codex 5h quota bar, Codex today/lifetime token grid, Token/Cost metric switching, usage-diagnostics line, price auto-update controls, todo block, session list (search + provider filter + attention filter + pin + archive), cache-write 5m/1h dual row, three skins.
- Byte-identical import of two official upstream GIF/MP3 action sets plus a backend-only exact catalog and presentation-safe generated manifest.
- Five-provider launch correctness, fixed command allowlists, validated native busy/bounds state and Windows atomic-write rollback.
- Transparent-pet input recovery implemented with native desktop-cursor hit testing and DPI-aware validated bounds; manual drag preserves short-click behavior instead of relying on native title-bar dragging. Popup resizing converts logical CSS size exactly once, preserves the visible pet bottom-centre anchor and clamps to the monitor work area.
- Drag movement separated from persistence: renderer moves are animation-frame throttled and serialized, while Rust saves and emits the final position once.
- Windows agent launch passes the fixed provider executable directly to Windows Terminal and falls back to `cmd.exe /D /K` only when `wt.exe` cannot be spawned.
- Upstream-style ask toolbar, provider identity tags, the meme selector's second-page session HUD and skin-aware side-media preview are integrated without changing imported GIF/audio bytes.
- **R10 fix**: `TrayIconBuilder::with_id` (was `.new("id")` compile blocker) + removed redundant `app.manage(tray)`.
- **R10 fix**: CodeWhale doctor probe reversed to companion-first with dispatcher fallback (was contradicting project docs).
- **R17 audit**: 5 pre-existing i18n hardcoded Chinese bugs fixed (today-tokens, win-reset, cal mouseover, renderByModel, renderProviderCost).
- **R18**: metering `cache_write_5m`/`cache_write_1h` split (UsageEvent + Aggregate + parse_claude_assistant extracts `ephemeral_5m/1h_input_tokens`).
- **R19**: session list pin/archive + attention filter + `set_session_prefs` IPC (sanitize + dedup + pin-wins).

## Deliberately deferred

- Full agent-side meme prompt dispatch. The current feature is a clearly labelled local preview; backend-only prompt ownership and exact provider/session delivery must be designed and tested first.
- Territory/collision behavior (1700 LOC `territory.js` + `drag-window.swift`); tray stubs remain but patrol is not exposed.
- Rust-side codex-watch equivalent (parses Codex rollout `rate_limits` to populate `s.codexLimits`/`s.codexUsage`); panel rendering is ready for when it lands.

## Still externally blocked or unverified

- Linux, Windows and macOS `cargo fmt/check/test/build --locked` evidence. This review environment has no Rust toolchain and cannot resolve package/GitHub hosts.
- Real Claude/CodeWhale/Codex/OpenCode/Aider CLI evidence.
- Real GUI evidence for drag/click-through, Windows Terminal fallback, terminal focus, suspend/display, mixed-DPI, tray submenu rendering, panel dual rows, pin/archive persistence.
- Windows code signing, macOS signing/notarization, Linux baseline packages and updater signature verification.
- Redistribution-rights review for newly preserved third-party GIF/audio assets.

Therefore this remains a **source-reconciled release candidate**, not a stable production release. Static, protocol and resource gates pass (45/45 smoke suites, 22/22 static checks, 3/3 rust-structure), but native builds and real-machine behavior remain release requirements.

See `docs/UPSTREAM_RECONCILIATION_2026-07-28.md` for the comparison and decision record, and `CHANGELOG.md` for the full R10-R19 change history.
