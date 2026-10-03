# R10 CodeWhale doctor ordering — 2026-07-30

## Problem

The R8 source tree shipped an internal contradiction:

- `docs/CODEWHALE.md`, `docs/MIGRATION_R5_AUTONOMOUS_DEEP_DIVE_2026-07-29.md`
  (§"CodeWhale doctor 的真实命令边界") and `docs/MIGRATION_R5_TODOLIST.md`
  (item L17) all define `doctor` as a `codewhale-tui` subcommand and forbid
  depending on the `codewhale doctor` dispatcher alias.
- `src-tauri/src/commands.rs` `codewhale_doctor_probe` probed the dispatcher
  **first** and only fell back to the companion when the dispatcher produced
  no parseable JSON.
- `scripts/windows-cli-diagnostics.ps1` mirrored the dispatcher-first order.
- Three smoke tests (`tauri-cli-hardening-r3-smoke.js`,
  `tauri-cli-diagnostics-r5-smoke.js`, `tauri-cli-resilience-r7-smoke.js`)
  locked dispatcher-first in as the contract.

Result: tests were green but protected a known drift. Every diagnostic on an
install where the dispatcher had not yet grown the `doctor` alias paid one
meaningless bounded 15 s failure before the companion answered.

## Web cross-validation

`docs/RUNTIME_API.md` upstream (https://github.com/Hmbown/CodeWhale/blob/main/docs/RUNTIME_API.md)
labels `codewhale doctor --json` the canonical Capability endpoint "suitable
for health-check polling from a macOS workbench". `docs/MCP.md` mentions both
`codewhale doctor` and `codewhale-tui doctor`. v0.9.1 (2026-07-24) ships three
binaries — `codewhale` (facade), `codew` (shim), `codewhale-tui` (TUI runtime).

So CodeWhale itself considers dispatcher-first acceptable. The project's R5
docs were a stricter interpretation ("doctor belongs to TUI; do not depend on
the alias"). Both positions are defensible; the bug was that the project's
own docs, implementation, PowerShell mirror and smoke tests disagreed.

## Decision

Follow the user's literal request: **companion-first with dispatcher fallback.**

Rationale:

1. Project-internal docs/tests/impl consistency is the maintenance hazard
   being fixed. Diverging from one's own docs is what causes future
   maintainers to "fix" the wrong side again.
2. On any matched bundle the companion is guaranteed to exist — we already
   enforce `MISSING_COMPANION_BINARY` as a hard issue for incomplete installs.
   So companion-first cannot regress on healthy installs.
3. The dispatcher remains the fallback for installs where the companion
   explicitly rejects `doctor` (older companion version, future surface
   drift). Both attempts stay visible in `doctorAttempts`.
4. The cost is one bounded 15 s probe in the rare case where the companion
   rejects `doctor` and the dispatcher would have answered — acceptable.
5. If CodeWhale ever drops `codewhale-tui doctor`, the dispatcher fallback
   keeps diagnostics working and this decision record tells the next
   maintainer to flip the order.

## Changes

| File | Change |
|---|---|
| `src-tauri/src/commands.rs` | `codewhale_doctor_probe` reordered: companion capture built first; dispatcher tried only when `companion_is_definitive` is false AND `should_try_dispatcher` is true (unknown command / not started / no companion). Inline comment updated. |
| `scripts/windows-cli-diagnostics.ps1` | Mirror: `$agents['codewhale-tui']` probed first; `$agents['codewhale']` is the fallback when `$companionIsDefinitive` is false. |
| `test/tauri-cli-hardening-r3-smoke.js` | Assertion renamed to "companion-first fallback chain". |
| `test/tauri-cli-diagnostics-r5-smoke.js` | Assertion renamed to "companion-first dispatcher fallback"; both surfaces still required. |
| `test/tauri-cli-resilience-r7-smoke.js` | Four assertions retargeted: "starts from the matched companion surface", "falls back to dispatcher only for command/schema drift", "config-validation JSON remains usable without fallback" (now checks `should_try_dispatcher` + `companion_capture.take()`), "Windows diagnostics mirror the companion-first fallback". |
| `test/tauri-codewhale-doctor-consistency-r10-smoke.js` | NEW. 19 checks locking docs/impl/PowerShell/smoke-tests together. |
| `docs/CODEWHALE.md` | Made companion-first ordering explicit; linked this decision record; added the RUNTIME_API.md web-caveat NOTE. |
| `package.json` | Wired the new smoke into `npm test`. |

## Verification

- `npm test` — 36/36 PASS (was 35/35).
- `npm run check:static` — 22/22 PASS.
- `python3 scripts/rust-structure-smoke.py` — 3/3 PASS.

## Not verified in this environment

- `cargo check --locked` (no Rust toolchain in sandbox).
- Real CodeWhale CLI execution (no provider CLI in sandbox).
- Windows PowerShell execution of `windows-cli-diagnostics.ps1`.
- Companion vs dispatcher behaviour on a real v0.9.1 install.

These remain release-gate requirements per `docs/MIGRATION_STATUS.md`.
