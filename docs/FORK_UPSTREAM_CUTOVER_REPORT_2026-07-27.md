# LLMPET Tauri 0.5.0-phase4 Fork/Upstream Reliability Review and Runtime Cutover

Date: 2026-07-27

## Scope

This review compares:

1. The user-provided `LLMPET-Tauri-v0.4.0-phase3-source.zip`.
2. Fork `purrfecto114-lgtm/LLMPET` at observed `main` commit `86cbd9e` (2026-07-26), with published tag lineage recorded separately.
3. Upstream `myunwang/LLMPET` at observed commit `4637a20cef1ae6207d3773f75edcfe3d231120d9` (2026-07-27).

The goal was not to copy every upstream file. It was to determine which behaviors form a reliable migration contract, close any material semantic gaps, then remove the archived Electron/Node runtime completely.

## Reliability judgment

### What is reliable

- Static source migration coverage is broad: provider status/capabilities, native hook installation, state ordering, metering, transcript scanning, local HTTP hardening, approval durability, structured Claude interactions, platform focus/recovery abstractions, and release gates have source-level implementations and smoke/static checks.
- The active package has no Electron dependency and bundles only the migrated frontend.
- All 35 shipped image assets remain byte-identical.
- The renderer-to-Rust command surface is checked for parity.
- The old runtime is no longer needed as executable code because the retained reference contract is data-only and hash-pinned.

### What was not reliable before this cutover

The phase3 source treated a session as if it could expose only one permission card. Upstream fixed this on 2026-07-27 because parallel/background agents can share a `session_id`. Distinct tool inputs must remain distinct cards; only identical session/tool/input retries may be coalesced; ordinary lifecycle events must not sweep another agent's live card.

The phase3 protocol baseline also mixed a published tag commit with a later observed fork head. Phase4 records these separately to avoid falsely presenting one revision as both the release tag and current branch truth.

### What is still unverified

The source is not production-certified. This environment has no Cargo/Rust toolchain, desktop session, provider CLI installations, code-signing certificates, or macOS notarization credentials. Consequently:

- `cargo check/test/build --locked` has not run here.
- A resolved `src-tauri/Cargo.lock` is still absent.
- Three-platform GUI behavior is not proven.
- Real Claude/CodeWhale/Codex/OpenCode/Aider command contracts are not proven end-to-end.
- Performance targets and signed package gates are not proven.

Reliability classification:

- Source architecture and cutover integrity: **medium-high**.
- Behavioral compatibility with the fork's supported provider contracts: **medium**, pending real CLI and compiled tests.
- Production release readiness: **blocked**, not passed.

## Upstream/fork relationship

The fork is a divergent product line rather than a simple mirror. It adds first-class CodeWhale and other provider-oriented behavior, while upstream continues evolving its Claude-focused runtime and has its own recent fixes and feature direction. Therefore, “upstream parity” must be selective and behavior-based. Blindly merging upstream runtime files into the Rust adapter would be unsafe.

The migration now pins:

- Fork published tag and tag commit independently.
- Fork observed branch head independently.
- Upstream observed review commit independently.
- Provider protocol documents independently.

## Material fix imported before deleting the old runtime

Phase4 adds a native concurrent-permission model:

- A canonical signature includes provider, session, tool, and normalized tool input.
- Exact retry connections share one pending permission object and receive the same decision.
- Distinct inputs remain separate cards even under the same session.
- Renderer keys include the permission ID.
- Resolving one card does not mark the session idle while another is pending.
- Only `SessionEnd` closes all still-pending cards for that session.
- `PostToolUse`, `Stop`, and `UserPromptSubmit` do not sweep parallel cards.

Regression coverage: `test/tauri-permission-concurrency-smoke.js`.

## Complete runtime cutover

Removed from the source tree:

- `legacy-reference/`
- root `main.js`
- root `preload.js`
- root `backend/`
- root `providers/`
- root `renderer/`
- root `hook/`
- root `shared/`
- legacy runtime test entry points and archived runtime reports

Retained only as data contract fixtures:

- anonymized Claude transcript JSONL
- CodeWhale turn-end JSON fixture
- model catalog API sample

These three files are SHA-256 pinned by `test/reference-contract-smoke.js`; they contain no executable archived runtime.

Rollback should use the immutable fork/tag archive or the previous signed release artifact, not an executable duplicate hidden inside the active source tree.

## Verification results

- `npm test`: passed.
- Migration task graph: 34 tasks valid — done 4, implemented-uncompiled 25, blocked 4, todo 0, deferred 1.
- Static checks: 21 passed, 0 failed.
- JavaScript syntax: all 31 files passed.
- Workflow YAML parsing: all 5 workflows passed.
- Asset preservation: 35/35 byte-identical.
- Source release gate: 14 OK, 1 BLOCKED, 0 FAILED.
- Sole source-gate blocker: missing resolved `src-tauri/Cargo.lock`.
- Cargo compilation: blocked because Cargo is unavailable in the execution environment.

## Recommended next gate order

1. Resolve dependencies on a supported runner and commit `src-tauri/Cargo.lock`.
2. Run `cargo check --all-targets --locked` and Rust tests on Linux, Windows, and macOS.
3. Execute real-provider isolated-HOME CLI matrix, including concurrent and duplicate permission requests.
4. Run signed real-desktop GUI and suspend/display-change checks.
5. Run performance sampling and signed/notarized package release gates.

Do not restore the deleted runtime to satisfy failures. Fix the Rust/Tauri implementation or strengthen data-only fixtures instead.
