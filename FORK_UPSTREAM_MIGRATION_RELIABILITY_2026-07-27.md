# Fork / upstream / Tauri migration reliability review

Date: 2026-07-27  
Candidate: `0.5.0-phase4`

## Provenance compared

- Fork: `purrfecto114-lgtm/LLMPET`, itself forked from `myunwang/LLMPET`.
- Fork web HEAD observed: documentation sync assessment commit `86cbd9e` on 2026-07-26; the published `v0.1.2-pre` tag points to earlier commit `1a6617a`.
- Upstream web HEAD observed: `4637a20cef1ae6207d3773f75edcfe3d231120d9` on 2026-07-27 (`fix: preserve parallel permission cards`).
- GitHub's cross-fork comparison reported 27 fork commits and 122 changed files at review time.

The previous local `protocol-baseline.json` mixed the fork tag commit with later fork documentation state. Phase 4 records both the tagged source baseline and the observed fork/upstream heads instead of treating them as one revision.

## Reliability findings

### Stronger areas

1. The migration has a clean active architecture: Tauri 2 frontend plus Rust service, native hook binary, provider-specific installation, bounded loopback HTTP, state model, metering, pricing, terminal focus, and recovery.
2. Provider capability asymmetry is explicit. Claude, CodeWhale, Codex, OpenCode, and Aider are not forced into one fake protocol.
3. Data-only reference fixtures remain byte-pinned after runtime deletion.
4. Static tests verify version parity, updater/signing gates, workflow syntax, assets, hook ownership, HTTP hardening, metering fixtures, and provider envelopes.

### Material gaps found during comparison

1. Upstream's newest permission fix was absent: the Phase 3 Rust stats snapshot exposed only one permission per session, the renderer key omitted `permId`, and resolving one card could mark the session idle while another card remained. Phase 4 now preserves all pending cards and only merges exact provider + session + tool + input retries.
2. The fork and upstream have intentionally different product directions. The fork added CodeWhale/OpenCode/Aider and hook-based Codex work; current upstream documents read-only Codex rollout watching, multilingual UI, and newer meme/scope actions. Those upstream features are not implied by provider parity and require separate product decisions.
3. The candidate still lacks a real Cargo lockfile and compiled evidence. Static source correctness cannot establish Rust API compatibility, platform linker compatibility, WebView behavior, signing, notarization, or real CLI payload compatibility.

## Reliability judgement

- **Source migration structure:** medium-high confidence after the parallel-permission repair and complete runtime cutover.
- **Behavioral parity with the fork baseline:** medium confidence; core provider/state/metering contracts are represented, but only real CLIs and desktop sessions can close the remaining gaps.
- **Parity with current upstream:** selective rather than complete. Critical upstream permission semantics were adopted; newer upstream i18n, rollout-watcher, and product UX changes remain explicit divergences.
- **Production release readiness:** not yet reliable enough to call stable. The blocking evidence remains three-platform locked compilation, real Provider CLI tests, real GUI/performance tests, and signed/notarized packages.

## Cutover decision

Removing the archived runtime is acceptable now because:

- the old runtime was no longer executable from active paths;
- its data fixtures already existed independently under `test/fixtures` with identical hashes;
- source gates now reject the archived tree and any active import of it;
- rollback should be provided by the immutable fork/tag or a separately published source archive, not by shipping two runtimes in one candidate.

This decision does not waive the external release gates.
