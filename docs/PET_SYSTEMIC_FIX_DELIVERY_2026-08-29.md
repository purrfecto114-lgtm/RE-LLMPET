# Pet systemic-fix delivery — 2026-08-29

## Closed causes

- Replaced the fabricated pre-config `claude` identity with an `aggregate` window bucket. In dual-pet mode the non-Codex pet now labels and routes wander using the most recently active real provider.
- Kept dual-pet partitioning and wander as separate concepts: one controls which sessions a window owns; the other resolves a provider only when the user starts a trip.
- Fixed OpenCode identity drift by reading `session.created.properties.info.id`, preferring the current top-level tool-hook `sessionID`, retaining old fallbacks, and marking explicit `parentID` sessions headless.
- Made headless status sticky in Rust. Later events that omit OpenCode parent metadata can no longer promote a child session into a top-level session.
- Removed headless children from aggregate counters and defensively deduplicated pet HUD rows/dots.
- Added a 45-second error visual lease. A fresh error is visible, but an abandoned error no longer permanently masks newer working/waiting sessions.
- Made tool lookup case/separator insensitive. OpenCode `task` and agent delegation select the summon/subagent expression; unknown tools still degrade to generic work.
- Replaced hide-before-load raster/GIF swaps with preload/decode-before-swap, and replaced full session-dot DOM rebuilds with keyed patching.
- Changed radial opening to resize/settle/layout/build order and fully claims the context-menu event. Added a larger coarse-pointer drag threshold and tap-highlight suppression.
- Verified the bundled Windows ICO contains 16, 24, 32, 48, 64, 128, and 256 pixel entries and remains explicitly assigned to every native window; no lossy asset conversion was introduced.

## Preserved product surface

Claude, CodeWhale, Codex, OpenCode, Aider, DSH, custom-provider handling, dual pets, travel/wander ownership, growth, territory, session preferences, and native/legacy hook compatibility remain present.

## Verification

Passed:

- `test/pet-systemic-regression.test.js`
- `test/maintainability-boundary-smoke.js`
- `test/phase1-pet-interaction-regression.test.js`
- `test/pet-runtime-startup-smoke.js`
- `test/tauri-r40-runtime-regressions-smoke.js`
- `test/root-regression.test.js`
- `scripts/asset-visual-regression.js` (35 assets byte-identical)
- JavaScript syntax checks and `git diff --check`

Environment limitations:

- This runner has no Rust toolchain, so the Rust changes could not be compiled or formatted here.
- Several pre-existing repository tests require `/tmp`, `jsdom`, workflow files excluded from this clean source archive, or assume package dependency objects that are absent; those failures are unrelated to this patch and were not hidden.
