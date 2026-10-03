# RE-LLMPET Global Audit — 2026-08-04

## Scope

This audit reviewed the completed feature-parity branch end to end rather than
treating the original status table as authoritative. It covered runtime data
flow, persistence and migration, child-process safety, dual-window isolation,
provider protocol semantics, platform degradation, tests, and release inputs.

## High-impact findings fixed

### 1. Codex usage could be multiplied

Codex `token_count` records often carry cumulative session totals. Adding every
record as a fresh usage sample over-counted active sessions and rescanning all
history on every panel poll amplified the cost. The watcher now caches files,
prefers `last_token_usage`, falls back to reset-safe cumulative deltas, and
removes deleted entries. Traversal depth, file count, and file size are bounded.

### 2. Travel cancellation did not guarantee descendant termination

Prompts are now sent through stdin. Unix trips run in a dedicated process group;
cancel, timeout, and output overflow terminate the process tree. Windows uses a
fixed-argument shell wrapper only for `.cmd`/`.bat` executables and tree-kill
semantics. Output remains bounded to 2 MiB and one trip is active at a time.
Claude wandering exposes only WebSearch/WebFetch. Codex wandering places the
global `--search` flag before `exec`, exposes the hosted `web_search` tool, and
keeps the local sandbox read-only with approvals disabled.

### 3. Official migration copied data without guaranteeing consumption

Official Claude usage is converted into the native idempotent ledger, and the
chosen event identity prevents a later transcript scan from charging the same
assistant response again. Official Codex aggregates are fallback data rather
than additions to local rollout totals. Travel history/growth is converted to
the current persisted model. Runtime PID caches are deliberately not migrated.

The v3 marker is now an informational receipt rather than a global lockout.
Every startup performs the same bounded no-clobber scan, so an early
`config.json` cannot suppress usage/travel files created by the official app
later. Empty official directories still do not create a receipt.

### 4. Pin/archive writes could lose concurrent updates

Pet and panel surfaces previously sent whole arrays, so two windows could
overwrite one another with stale snapshots. New pin/archive actions update one
session atomically in the backend and roll the optimistic UI back on failure.
The bulk command is retained for compatibility. Loaded configuration is
deduplicated, bounded, and resolves archive-vs-pin conflicts consistently.

### 5. Territory movement was not monitor-local

Rival windows are now associated with their own monitor/work area before the
nearest edge is calculated. A rival on a secondary display is no longer pulled
onto the pet display. Oversized windows are clamped, built-ins retain variant
matching, custom rivals require an exact process name, and hidden-pet mode
remains hidden.

### 6. Persistent state reads were not uniformly race-safe

Config, travel state, Codex rollouts, and official aggregate files now reject
symlinks/non-regular files, enforce hard read limits, and verify that the file
opened is the same file that was inspected. Unknown travel JSON is no longer
misclassified as an official document and rewritten as an empty native file.
Atomic session preference failures remain persistent in the visible error UI.
The local `runtime.json` credential is read through one shared bounded helper
by duplicate-instance activation, provider hooks, and hook resynchronization,
preventing those three security-sensitive paths from drifting apart.

### 7. Top-level status contracts were inconsistent

`lastOps` is now a bounded real operation ring. `context` and top-level Todo
follow the effective sorted rows after pending-permission reconciliation, so
panel and HUD select the same session. Provider identifiers are normalized
before anonymous session IDs are generated. Background task values remain
explicitly empty because the
current upstream adapter also has no real reconciliation feed; fabricating
process state would be less correct than preserving the honest placeholder.

## Verification model

The repository's existing suite is mostly source-contract/static regression
testing. The audit adds focused pure-JavaScript behavioral tests where possible
and strengthens static contracts for the Rust paths. In this workspace the
complete historical `npm test` suite passed, `check:static` passed 22/22,
protocol drift passed, 35 retained assets were byte-identical, release source
gates passed 43/43, and the deterministic source manifest verified 322 files.

This execution environment does not include a Rust/Tauri toolchain or platform
SDKs. Therefore `cargo fmt`, `cargo check`, Rust unit tests, Tauri packaging,
macOS Accessibility behavior, and real Claude/Codex CLI trips are not claimed as
executed here. Those remain required CI/real-machine release gates.
