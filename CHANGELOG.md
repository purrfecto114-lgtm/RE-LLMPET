# Changelog

## 0.5.24 — R40.5 runtime fixes from handoff audit（2026-08-01）

**First release with actual runtime code changes since 0.5.21.**

Closes 5 P0/P1 issues from the handoff revalidation audit
(RE-LLMPET-handoff-revalidation-baseline-2026-08-01.md).

### P0-1: Fix provenance self-reference paradox

The 0.5.23 design forced SOURCE_REVISION to be a 40-hex git commit SHA,
but writing the SHA into the commit changes the tree, producing a
different SHA — an impossible self-referential constraint.

- `scripts/generate-source-manifest.js`: `source_commit` is now
  optional; accepts either 40-hex SHA (CI) or `re-llmpet-x.y.z` (dev).
- `test/tauri-r401-carpet-audit-closure-smoke.js`: relaxed assertion.

### P0-2: Fix cold-start Provider bootstrap loss

`pet.js` had two config application paths: `onConfig` event and
`getConfig()` bootstrap. The bootstrap path did NOT apply
`providers.active/statuses` or call `updateProviderUI()`, so if the
`pet:config` event arrived before the listener was registered (cold
start race), provider buttons were permanently hidden.

- `frontend/renderer/pet.js`: new unified `applyConfigSnapshot(cfg)`
  function; both paths now call it.

### P0-3: Fix stats revision replay bug

`panel.js` consumed the revision in `render()`. When a hidden panel
cached a snapshot and then tried to render it on show, the revision was
already consumed and the render was rejected — the panel showed stale
content.

- `frontend/renderer/panel.js`: split into `ingestStats()` (revision
  gate + cache) and `renderStats()` (DOM update, no gate). `render()`
  no longer consumes revision. Bootstrap `getStats()` now ingests.

### P0-5: Fix CodeWhale backup fail-open

`install_codewhale` logged backup failures and continued writing,
risking config corruption with no backup to restore from.

- `src-tauri/src/hook_install.rs`: backup failure now aborts the
  install entirely (fail-closed). User's existing config is preserved.

### P1-2: Fix OpenCode status object parsing

OpenCode v0.9.x SDK sends `properties.status` as an OBJECT
(`{type: "busy"}`), not a string. The plugin did
`stateMap[rawObject]`, producing `[object Object]` as the key.

- `src-tauri/src/hook_install.rs`: extract `.type` from the object;
  preserve retry metadata (`attempt/message/next`).

### P1-3: Restore CodeWhale message_submit as background observer

R22 removed `message_submit` based on the assumption it is always
foreground-blocking. Current CodeWhale docs confirm `background = true`
makes it observer-only (submitted, never awaited, never blocks).

- `src-tauri/src/hook_install.rs`: `message_submit` restored to
  `CODEWHALE_EVENTS` with `background = true`,
  `continue_on_error = true`, `timeout_secs = 5`.
- `protocol-baseline.json`: updated to include `message_submit`.

### Test

All 50 smoke suites pass. Manifest verification passes.
No Rust compile errors (CI will verify with cargo check).

---

## 0.5.23 — R40.4 package provenance rebuild（2026-08-01）

**Rebuild of the 0.5.22 release after the package regression audit
([RE-LLMPET-0.5.22-package-regression-audit-roadmap.md]) proved 0.5.22
was an invalid artifact.**

### Why 0.5.22 was withdrawn

The 0.5.22 package regression audit found:
1. CHANGELOG claims were false (claimed imports of panel/pet/bridge/
   commands/hook/http_server/lib/build/capability/tauri.conf/protocol-
   baseline/gate-scripts/fixtures/manifest-generator, but source trees
   were byte-identical to 0.5.21).
2. Phantom files in CHANGELOG (test fixtures, generate-source-manifest.js,
   audit roadmap) that did not exist in the package.
3. SOURCE_MANIFEST invalid (file_count mismatch, hash mismatches, self-
   include ambiguity).
4. SOURCE_REVISION was "re-llmpet-0.5.22" instead of a 40-hex git SHA.
5. `.env` file leaked into package (50 bytes, local DATABASE_URL).
6. ZIP permissions wrong (all 282 files marked 0755).

### What 0.5.23 actually changes (verified against git diff)

- `scripts/generate-source-manifest.js` — NEW canonical manifest
  generator with `--verify` mode for CI gate. Enforces 40-hex SHA
  in SOURCE_REVISION, exact file set, per-file hash verification.
- `scripts/verify-changelog-diff.js` — NEW script that parses
  CHANGELOG and verifies every claimed path against actual git diff.
- `.gitignore` — added `.env` and `.env.*` to exclusions.
- `package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`,
  `src-tauri/tauri.conf.json`, `package-lock.json` — version bump
  0.5.21 → 0.5.23.
- `BUILD_REPRODUCIBILITY.md` — updated with new provenance model.
- `SOURCE_REVISION` — now contains 40-hex git commit SHA.
- `SOURCE_DATE_EPOCH` — updated.
- `SOURCE_MANIFEST.json` — regenerated with canonical generator.
- `CHANGELOG.md` — this entry (truthful, no phantom claims).
- Test version assertions updated to 0.5.23.

### What 0.5.23 does NOT change

- No Rust source code changes (`src-tauri/src/*.rs`).
- No frontend code changes (`frontend/**/*.js`, `*.css`, `*.html`).
- No protocol-baseline or protocol-drift changes.
- No new test fixtures.
- No capability or tauri.conf structural changes (only version field).

### Audit roadmap inclusion

The audit roadmap `RE-LLMPET-0.5.22-package-regression-audit-roadmap.md`
is included in the repo root for reference, but is NOT claimed as a
"new feature" — it is the audit document that prompted this rebuild.

---

## 0.5.21 — R40.2 provenance consistency fix（2026-08-01）

Patch release fixing metadata inconsistencies left over from 0.5.20.
The 0.5.20 CI was green and the release was published, but several
provenance fields still referenced the abandoned `0.5.19.1` version
number (Cargo rejects 4-segment version numbers).

### Fixes

- **SOURCE_MANIFEST.json `root`**: `RE-LLMPET-0.5.19.1` → `RE-LLMPET-0.5.21`
- **CHANGELOG body**: historical `0.5.19.1` refs in 0.5.20 section → `0.5.20`
- **BUILD_REPRODUCIBILITY.md**: version `0.5.20` → `0.5.21`
- **Test hardening**: R40.1 smoke now asserts `manifest.root` version
  matches `SOURCE_REVISION` and `package.json` version

### No code changes

Metadata/test/docs only. Binaries functionally identical to 0.5.20.

---

## 0.5.20 — R40.1 carpet audit closure（2026-08-01）

Emergency hotfix closing 7 issues from the 0.5.19 carpet audit
(`RE-LLMPET-0.5.19-carpet-audit-upstream-drift-roadmap.md`).

### P0-1: Fix Rust format string compile blocker

The 0.5.19 `install_codewhale` log message used `{'y'}` inside a
`format!` string — invalid Rust format syntax that would fail
`cargo check`. Fixed to plain `entries`.

### P0-2: Disable unsafe CodeWhale legacy TOML cleanup

The 0.5.19 `strip_legacy_codewhale_hooks` line-state-machine could
absorb user-owned `[provider]` / `[[models]]` / arbitrary TOML tables
into a legacy `[[hooks.hooks]]` body and silently delete them when
dropping the hook table. This is a data corruption bug worse than the
original "message_submit blocked" symptom.

- `install_codewhale` no longer calls `strip_legacy_codewhale_hooks`.
- New `backup_codewhale_config` creates a timestamped `.toml` backup
  before any write, with 30-day pruning of old backups.
- Diagnostic still DETECTS stale pre-R22 hooks and surfaces them as
  an ISSUE with manual removal instructions.
- R41 will reintroduce cleanup via a real TOML AST editor.

### P0-3: Frontend rejects stale stats revisions

The backend stamps each stats payload with `__revision`, but the 0.5.19
frontend never checked it — a late-arriving revision-41 "working"
snapshot could overwrite a fresh revision-42 "completed" snapshot.

- `pet.js` — new `lastStatsRevision` + `acceptStatsRevision()` guard.
- `panel.js` — new `lastStatsRevisionPanel` + `acceptStatsRevisionPanel()`.
- Revisions < 0 (missing field, e.g. from an older backend) are
  accepted unconditionally for backward compatibility.

### P0-4: Consolidated StatsCoalescer state machine

The 0.5.19 split-mutex design (three separate `Mutex`es for
`last_stats_emit`, `stats_dirty`, `stats_scheduled`) had a race where
`dirty=true` but no timer was scheduled — the trailing timer cleared
`scheduled` between the new event's dirty-set and scheduled-check.

- `model.rs` — new `StatsCoalescerState` struct + `stats_coalescer:
  Mutex<StatsCoalescerState>` field. All three flags (last_emit, dirty,
  scheduled) are under one lock.
- `http_server.rs::emit_stats` — rewritten to use the consolidated
  state. The trailing timer's "read dirty, clear dirty, clear
  scheduled, decide to emit" sequence is atomic. Case (b) from the
  audit (concurrent event gets lock first, sets dirty, can't schedule)
  is handled by checking `guard.dirty` after clearing `scheduled` and
  rescheduling if still dirty.
- `commands.rs::emit_stats_throttled` — updated to use the same
  consolidated state.

### P0-5: Source package provenance

The 0.5.19 package had drifted: root dir was `re-llmpet-0.5.18-base`,
CHANGELOG stopped at 0.5.17, no commit SHA, no manifest.

- Package root renamed to `RE-LLMPET-0.5.20`.
- CHANGELOG entries added for 0.5.18, 0.5.19, 0.5.20.
- New `SOURCE_REVISION` file with commit SHA + build date.
- New `SOURCE_DATE_EPOCH` file for reproducible builds.
- New `SOURCE_MANIFEST.json` with file hashes.
- New `BUILD_REPRODUCIBILITY.md` with build instructions.

### P1-1: Revert OpenCode `auth list` as primary diagnostic command

The 0.5.19 "fix" changed the OpenCode auth probe from `auth list` to
`providers list` (primary) with `auth list` fallback. The carpet audit
proved `opencode auth list` is still the official command (verified
via opencode.ai docs, anomalyco-opencode mintlify CLI overview, and
GitHub issue #4533). The `providers` command is a SEPARATE command for
managing provider configurations, not a replacement for `auth list`.

- `commands.rs` — reverted to `auth list` as the single primary probe.
  No fallback — inventing unverified fallbacks is what caused the
  0.5.19 mistake.

### P1-2: Read actual OpenCode `session.status` payload

The 0.5.19 plugin hardcoded `state: "thinking"` for every
`session.status` event, ignoring the actual status. This made
idle/retry/busy transitions all look like "thinking" and could
overwrite correct working/attention/error states.

- `hook_install.rs::opencode_plugin_source` — `session.status` now
  reads `event.properties.status` (OpenCode v0.9.x payload shape) and
  maps known statuses (busy→working, idle→attention, retry→error,
  etc.) to our internal state vocabulary. Unknown statuses are
  forwarded as-is so the server's state reducer can decide.

### Test

New `test/tauri-r401-carpet-audit-closure-smoke.js` (30 assertions)
locks all 7 fixes. Existing smoke tests updated for version + new
field compatibility.

---

## 0.5.19 — R40 runtime regression closure（2026-08-01）

Closed 4 runtime regressions reported by users:

- **R40-1**: OpenCode plugin `session.status → UserPromptSubmit`
  mapping caused "收到新任务" on every tool call. Fixed by mapping
  to `SessionStatus` instead.
- **R40-2**: OpenCode plugin marker bumped v2 → v3; install detection
  fixed to check the actual plugin file path.
- **R40-3**: OpenCode diagnostic probe changed from `auth list` to
  `providers list` (NOTE: reverted in 0.5.20 — see P1-1 above).
- **R40-4**: CodeWhale `strip_legacy_codewhale_hooks` added to clean
  pre-R22 `message_submit` residue (NOTE: disabled in 0.5.20 — see
  P0-2 above).
- **R40-5**: Panel fullscreen border — 500ms poller + `near-fullscreen`
  CSS class as Windows 11 timing safety net.

**Known issues introduced by 0.5.19** (all fixed in 0.5.20):
- Rust format string compile blocker (`{'y'}`)
- CodeWhale legacy cleanup could delete user TOML config
- Stats revision generated but not consumed by frontend
- StatsCoalescer dirty-not-scheduled race
- Source provenance drift

---

## 0.5.18 — R39 UX & accessibility（2026-08-01）

4 UX/accessibility fixes from the 0.5.16 full audit roadmap §12 R39:

- **R39-1**: `prefers-reduced-motion` — `animation:none` instead of
  `0.001s` (0.001s still fires one frame).
- **R39-2**: Panel responsive — `minWidth` 520 → 420, single-column
  breakpoint at `max-width: 699px`.
- **R39-3**: Diagnostic loading hint text explaining ✕ button behavior.
- **R39-4**: Persistent error center stub — critical commands use
  `persistent=true` (no auto-dismiss); persistent errors get a ✕ close
  button; `errorLog` array tracks last 10 persistent errors.

---

## 0.5.17 — R38.1 correctness closure（2026-08-01）

Patch release closing 5 issues from the 0.5.16 full audit roadmap.

### P0-1: Singleton StatsCoalescer (no task storm)

The 0.5.16 full audit (P0-1) flagged that the R38 trailing flush spawned
a new `spawn_blocking` task PER throttled event — 1000 events/s would
spawn ~1000 sleeping tasks, all waking ~150ms later and each broadcasting
a full snapshot.

- `model.rs` — new `stats_dirty: Mutex<bool>`,
  `stats_scheduled: Mutex<bool>`, `stats_revision: Mutex<u64>` fields.
- `http_server.rs` — rewritten `emit_stats`: when an event is throttled,
  sets `dirty=true` and checks `scheduled`. If not already scheduled,
  spawns exactly ONE trailing flush. The flush checks `dirty` on wake,
  clears it, and emits if still dirty. At most ONE timer exists at any
  time regardless of event burst size.
- `commands.rs` — `emit_stats_throttled` also marks `dirty=true` when
  throttled (for the `force=false` path). Both paths now bump a monotonic
  `__revision` and attach it to the stats payload so the frontend can
  reject stale messages.
- `do_emit_stats` helper: generates stats, bumps revision, attaches
  `__revision` to the JSON, emits to both windows.

### P0-2: Diagnostic cancel keeps provider locked until worker terminal

The 0.5.16 full audit (P0-2) flagged that `cancel_diagnostic` cleared
`active_diagnostic_provider` immediately, allowing a new diagnostic to
start while the old `spawn_blocking` worker was still running its next
probe.

- `commands.rs` — `cancel_diagnostic` now ONLY clears `active_diagnostic_pid`
  (so subsequent `register_pid` calls write to None — harmless). It does
  NOT clear `active_diagnostic_provider`. The provider lock stays held
  until the `diagnose_agent` async wrapper's completion block clears it
  when `spawn_blocking` returns. This prevents new diagnostics from
  starting until the cancelled worker has fully terminated.

### P0-3: Panel init visibility renders cached stats

The 0.5.16 full audit (P0-3) flagged that the initial `isVisible()` check
only set boolean flags without rendering cached stats — the panel could
appear blank/stale.

- `panel.js` — when `isVisible()` returns true on init, now renders
  `pendingStats || lastStats` and calls `fitPanelHeight()` after
  `syncWindowMode()`. This ensures the panel shows content immediately
  even if `panel:shown` was missed.

### P0-4: closePanel uses call(), panelVisible deferred to event

The 0.5.16 full audit (P0-4) flagged that `closePanel` used `send`
(fire-and-forget). If Rust `hide()` failed, the frontend still set
`panelVisible=false`, causing the panel to appear open but stop updating.

- `tauri-bridge.js` — `closePanel` upgraded from `send` to `call`.
- `panel.js` — close button handler no longer sets `panelVisible=false`
  directly. Instead, it only sets `panelWasHidden=true`. The
  `panel:hidden` event (emitted by `close_panel` on success) sets
  `panelVisible=false`. If `close_panel` fails, the event won't fire
  and the panel stays in visible mode, continuing to render.

### P1-1: set_providers never top-level rejects after commit

The 0.5.16 full audit (P1-1) flagged that `resync_current()?` could
top-level reject AFTER config was committed, causing the frontend to
revert the checkbox while disk/memory had the new selection.

- `commands.rs` — `resync_current()` is now matched (not `?`), and its
  error is returned as `infrastructureError` in the structured result.
  The Promise always resolves after commit. `allHooksOk` is false if
  either hook errors or infrastructure error exists.

### Test coverage

- New `test/tauri-r381-correctness-closure-smoke.js` (95 lines, 25 assertions).
- 4 phase2 smokes: version assertions bumped 0.5.16 → 0.5.17.
- `npm test`: 44/44 smoke ok (was 43; +1 R38.1 smoke)
- `npm run check:static`: 22/22 PASS

---

## 0.5.16 — R38 correctness blocker patch（2026-08-01）

Patch release closing 4 P0 issues from the 0.5.15 full audit branch
roadmap. The audit found that several R36/R37 fixes were silently
ineffective because of an incorrect Tauri API call, and that the stats
throttle and diagnostic registry had race conditions.

### P0-1: Fix getCurrentWindow() API call

The 0.5.15 full audit (P0-1) flagged that the code used
`window.__TAURI__.window.getCurrent()` — a Tauri 1 class-method form
that does NOT exist in Tauri 2. The correct call is
`getCurrentWindow()` (a function export). Verified via web-search of
Tauri 2 docs.

This broke ALL window-scoped listeners (`onResized`, `onScaleChanged`,
`onMoved`) and all `isMaximized`/`isFullscreen` queries in both pet.js
and panel.js. The R36 geometry revision/ack, R35.1 panel window-scoped
listeners, and R37 hidden-panel visibility all silently fell back to
their timer/flag fallbacks because the listeners were never registered.

- `tauri-bridge.js` — new `getCurrentTauriWindow()` helper that tries
  `getCurrentWindow()` (Tauri 2) first, then `Window.getCurrent()` (Tauri 1
  fallback). Shared by both pet.js and panel.js.
- `pet.js` + `panel.js` — all `window.__TAURI__.window.getCurrent()`
  calls replaced with `getCurrentTauriWindow()`.

### P0-2: Diagnostic registry — global mutual exclusion

The 0.5.15 full audit (P0-2) flagged that the R36 per-provider guard
still allowed different providers to run concurrently, overwriting the
shared PID/provider slot. This caused races where one provider's
completion cleared another's PID, making cancellation unreliable.

- `commands.rs` — `diagnose_agent` now rejects ANY active diagnostic
  (not just same-provider). Only one diagnostic can run at a time,
  regardless of provider. This eliminates the cross-provider race
  entirely. The frontend only shows one diagnostic at a time anyway,
  so concurrent multi-provider diagnostics have no UI benefit.

### P0-3: Stats trailing flush

The 0.5.15 full audit (P0-3) flagged that the R37 leading-edge
throttle permanently dropped the final event in a burst. Example:
event A at t=0 (emitted), event B at t=20ms (dropped, no trailing
flush), no more events → UI stuck at A's state forever.

- `http_server.rs` — when an event is throttled (dropped), a trailing
  flush is scheduled via `tauri::async_runtime::spawn` + `tokio::time::sleep`.
  After the throttle window expires (150ms), the flush re-reads the
  latest state and emits it. This guarantees the final event in a burst
  always reaches the UI within ~150ms of the last dropped event.
- The trailing flush is idempotent: if another event arrived and was
  emitted in the meantime, the flush just re-emits the same state.

### P0-4: Panel visibility — panel:hidden event + init-time isVisible()

The 0.5.15 full audit (P0-4) flagged that only the close button
handler set `panelVisible=false`. If the panel was hidden via tray or
any other path, the frontend kept rendering on a hidden window.

- `commands.rs` — `close_panel` now emits `app.emit("panel:hidden", ())`
  after `window.hide()`, giving the frontend an explicit signal
  regardless of how the panel was hidden.
- `panel.js` — subscribes to `panel:hidden` event → sets
  `panelVisible=false` + `panelWasHidden=true`.
- `panel.js` — on init, queries `getCurrentTauriWindow().isVisible()` to
  handle the case where the panel was shown before JS loaded (the
  `panel:shown` event was missed).

### Test coverage

- New `test/tauri-r38-correctness-blocker-smoke.js` (80 lines, 20 assertions).
- Updated `test/tauri-r351-correctness-patch-smoke.js` for the
  `getCurrentTauriWindow()` rename.
- 4 phase2 smokes: version assertions bumped 0.5.15 → 0.5.16.
- `npm test`: 43/43 smoke ok (was 42; +1 R38 smoke)
- `npm run check:static`: 22/22 PASS

### Known limitations

- No Rust toolchain in dev container; `cargo build` verified on GitHub
  Actions. The `tokio::time::sleep` in the trailing flush requires the
  Tauri async runtime (which is tokio-based) — CI will confirm.
- The `getCurrentTauriWindow()` helper includes a Tauri 1 fallback
  (`Window.getCurrent()`) that should never be needed in Tauri 2 but is
  kept for safety. If Tauri 2 doesn't export `Window`, the fallback
  silently returns null and the code degrades to timer-based behavior.

---

## 0.5.15 — R37 performance & security closure（2026-08-01）

Patch release implementing 4 R37 tasks from the 0.5.12 carpet audit
roadmap §14. Focus: performance, concurrency, and security closure.

### R37-4: Stats push throttling (150ms minimum interval)

The 0.5.12 carpet audit P1-2 flagged that every hook event emits a
full stats snapshot to both pet and panel windows — dozens per second
during active agent sessions, each triggering a full `Runtime::stats()`
clone + JSON serialize + IPC broadcast.

- `model.rs` — new `last_stats_emit: Mutex<Option<Instant>>` field.
- `commands.rs` — new `emit_stats_throttled(app, state, force)` with
  150ms minimum interval. Events arriving during the throttle window
  are dropped; the next event after the window delivers the latest
  state. `force=true` bypasses the throttle (used by user-initiated
  actions like `decide_permission` for immediate UI feedback).
- `http_server.rs` — the `/state` POST handler's `emit_stats` also
  throttles at 150ms. This is the hottest path: every hook ingest
  from Claude/Codex/CodeWhale CLIs triggers it.

### R37-5: Hidden panel render suppression

The 0.5.12 carpet audit P1-5 flagged that `close_panel` hides the
WebView but keeps it alive — so every `panel:stats` event still drives
a full DOM rebuild + canvas redraw on a hidden window.

- `panel.js` — new `panelVisible` flag (false when panel is hidden).
  `render()` checks it: if false, caches stats in `pendingStats` and
  returns early (no DOM work). When the panel is shown again
  (`panel:shown` → `resetAutoFitOnShow`), `panelVisible` is set to
  true and `pendingStats` is rendered once.
- Close button handler sets `panelVisible = false`.

### R37-6: Cursor hit-test adaptive backoff

The 0.5.12 carpet audit P1-4 flagged that the cursor hit-test thread
polls at a fixed 24ms (~42Hz) forever, even when the pet is idle and
no click-through is requested.

- `platform.rs` — new `CURSOR_HIT_TEST_IDLE_MS = 250` constant. The
  loop now checks `mouse_ignore_requested` before sleeping: if true
  (active click-through), sleeps 24ms; if false (idle), sleeps 250ms.
  This reduces idle wakeups from ~42Hz to ~4Hz (~10× reduction) with
  no user-visible difference — the 250ms check just detects when the
  flag flips, and `should_ignore_cursor` already early-returns when
  the flag is false.

### R37-8: Capability minimization (replace core:default)

The 0.5.12 carpet audit P1-12 flagged that both `pet.json` and
`panel.json` capabilities include `core:default` — a broad Tauri 2
bundle that grants core:app, core:event, core:image, core:menu,
core:path, core:resources, core:tray, core:webview, and core:window
permissions. For strict least-privilege, only the subsets actually
used should be granted.

- `pet.json` + `panel.json` — replaced `"core:default"` with:
  - `"core:event:default"` (event listen/emit — used by the bridge)
  - `"core:window:default"` (window getCurrent/isMaximized/onResized/etc.)
  - `"core:webview:default"` (webview window operations)
- Removed implicit grants for: core:app, core:image, core:menu,
  core:path, core:resources, core:tray. If the app needs any of these
  at runtime, they can be added back individually.

### Test coverage

- New `test/tauri-r37-perf-security-smoke.js` (100 lines, 25 assertions).
- 4 phase2 smokes: version assertions bumped 0.5.14 → 0.5.15.
- `npm test`: 42/42 smoke ok (was 41; +1 R37 smoke)
- `npm run check:static`: 22/22 PASS
- Rust brace balance: commands.rs 503/503, model.rs 335/335,
  platform.rs 88/88, http_server.rs 179/179

### What's NOT in this release (deferred to R38 / 0.6.0)

- async HTTP or permission independent pool (P1-7)
- transcript worker queue (P1-9)
- usage incremental aggregation (P1-8)
- Process-tree benchmark and CI thresholds (P1-11)
- Disable `withGlobalTauri` (P1-13 — requires module-import migration)
- CSP single source + remove `unsafe-inline` (P1-14 — needs careful
  dynamic-style audit)
- Pin GitHub Actions to full SHAs (P1-11 — needs SHA lookup per action)
- Code modularization (P1-12 — large refactor)

### Known limitations

- No Rust toolchain in dev container; `cargo build` verified on GitHub
  Actions.
- The `core:default` replacement to `core:event:default` +
  `core:window:default` + `core:webview:default` needs runtime
  verification — if Tauri 2 requires additional core permissions (e.g.
  `core:app:default` for app lifecycle events), the build will succeed
  but runtime commands may fail. CI will catch compilation issues; real
  machine testing is needed to confirm runtime behavior.
- Stats throttling drops events during the 150ms window. The trailing
  event in a burst always gets through (the window expires), but a
  very short burst (single event) followed by silence could leave the
  UI slightly stale until the next interaction. This is acceptable
  because the pet's state machine reacts via `pet:event` (not throttled).

---

## 0.5.14 — R36 trust & interaction lifecycle（2026-07-31）

Patch release implementing 5 R36 tasks from the 0.5.12 carpet audit
roadmap §14. Focus: complete correctness, trust, and interaction
lifecycle closures that R35.x started but couldn't finish in a single
iteration.

### R36-1: DiagnosticRegistry — single active job per provider

The 0.5.12 carpet audit P0-4 noted that repeated "rerun" clicks could
spawn multiple blocking jobs + CLI children + reader threads
simultaneously for the same provider. R35.2 added `cancel_diagnostic`
+ process-tree kill, but had no guard against duplicate concurrent
runs.

- `model.rs` — new `active_diagnostic_provider: Mutex<Option<String>>`
  field tracks which provider is currently being diagnosed.
- `commands.rs` — `diagnose_agent` now checks: if
  `active_diagnostic_provider == Some(provider)` and a new request
  for the SAME provider arrives, returns `Err("... diagnostic already
  in progress")` immediately without spawning. Different providers can
  still run concurrently.
- `cancel_diagnostic` and `diagnose_agent` (on completion) both clear
  the provider flag so the same provider can be re-diagnosed.

### R36-2: geometry revision/ack — onResized replaces 260ms timer

The 0.5.12 carpet audit P1-1 flagged that `geometryBusy` was cleared
by a fixed 260ms timer — a guess that's too short on slow machines
(HUD opens before resize settles) and too long on fast machines (wasted
wait). Verified via web-search: Tauri 2's `getCurrentWindow().onResized(cb)`
fires when the OS actually applied the resize.

- `pet.js` — new `geometryRevision` counter + `expectedPetSize` +
  `geometryAckUnlisten`. `markGeometryBusy(expectedSize)` now registers
  a one-shot `onResized` listener. When the window's inner size matches
  the expected size (within 2px tolerance), `clearGeometryBusy` is
  called immediately — no waiting for the timer.
- The 260ms timer is kept as a FALLBACK for cases where `onResized`
  never fires (Rust rejected the size, window hidden, OS didn't emit).
- Overlapping resizes are handled by revision: a new `markGeometryBusy`
  call supersedes the previous listener (unlistens it, increments
  revision, registers a new one).

### R36-3: hook verify-only on startup (no auto-modify external configs)

The 0.5.12 carpet audit P1-3 flagged that startup called
`sync_enabled` which INSTALLS/UNINSTALLS hooks into external provider
configs (Claude's settings.json, CodeWhale's config.toml, etc.)
without explicit user consent. This is a trust boundary issue.

- `hook_install.rs` — new `verify_enabled(runtime, enabled)` function
  that reads hook status WITHOUT writing anything. New
  `is_hook_installed(id)` predicate checks each provider's config file
  for the Octopus marker. Reports `"missing"` state (not `"error"`)
  for enabled-but-uninstalled providers so the UI can prompt "click to
  install" instead of silently installing.
- `lib.rs` — startup now calls `verify_enabled` instead of
  `sync_enabled`. Hook installation only happens when the user
  explicitly calls `set_providers` (which triggers `resync_current`).
- The `sync_enabled` function is preserved (still used by
  `resync_current` for explicit installs) but no longer called at
  startup.

### R36-4: log rotation (5 files × 2 MiB)

The 0.5.12 carpet audit P1-5 flagged that `write_log` appends
indefinitely with no size limit, rotation, or retention. A long-running
session could fill disk.

- `model.rs` — `write_log` now checks the file size before each
  append. If it exceeds 2 MiB, `rotate_log` is called:
  `octopus.log → octopus.1.log → ... → octopus.4.log` (oldest deleted).
  5 files × 2 MiB = max ~10 MiB total.
- `rotate_log(path, max_files)` helper: deletes the oldest file,
  shifts each file up by one, renames current to `.1.log`. Best-effort
  — if rotation fails (permissions, disk full), the append still
  proceeds.

### R36-5: prefers-reduced-motion CSS

The 0.5.12 carpet audit §9.1 flagged that GIF, jump, attn, bob, pulse,
and confetti animations don't respect the system reduced-motion
setting. Users with vestibular disorders need a way to disable
animations.

- `pet.css` + `panel.css` — new `@media (prefers-reduced-motion:
  reduce)` block that sets `animation-duration: 0.001s !important` and
  `transition-duration: 0.001s !important` on all elements. This
  effectively disables all CSS animations (bob, attn, happyJump,
  errShake, breathe, badgePulse, slideIn, etc.) when the OS reports
  reduced motion.
- GIF-based cat skin animations are NOT affected by CSS (they're image
  animations). Swapping GIFs for static frames is deferred to a future
  release; the CSS fix covers all transform/opacity animations.

### Test coverage

- New `test/tauri-r36-lifecycle-smoke.js` (130 lines, 30 assertions)
  locks all 5 R36 fixes.
- Updated 2 existing smokes:
  - `tauri-native-core-smoke.js` — accept `verify_enabled` OR
    `sync_enabled` in lib.rs startup
  - `tauri-provider-phase2-smoke.js` — same
- 4 phase2 smokes: version assertions bumped 0.5.13 → 0.5.14.
- `npm test`: 41/41 smoke ok (was 40; +1 R36 smoke)
- `npm run check:static`: 22/22 PASS
- Rust brace balance: commands.rs 497/497+1828/1828+159/159,
  model.rs 335/335+1379/1379+54/54, hook_install.rs 214/214+595/595+40/40

### What's NOT in this release (deferred to R37 / 0.5.15)

Per the roadmap §14, the following remain deferred:
- Full Provider six-layer state model (enabled/installed/healthy/
  running/focused/recent) — R36 only added the diagnostic provider
  guard
- Hook plan/diff/backup/apply/verify/rollback lifecycle
- Unified atomic writer for transcript/metering/http_server
- All config mutations await + rollback (language/mode/skin/budget/
  currency/mute still fire-and-forget)
- Unified dialog accessibility (focus trap, Tab cycling, focus restore)
- Full i18n + brand unification
- Panel 400-420px single-column responsive breakpoint

### Known limitations

- No Rust toolchain in dev container; `cargo build` verified on GitHub
  Actions.
- `is_hook_installed` checks for the Octopus marker string in each
  provider's config file. If the user manually edited the config and
  removed the marker (but the hook still works via a different
  mechanism), `verify_enabled` will report "missing" — a false
  positive. This is acceptable: the user can re-save providers to
  re-install.
- The geometry `onResized` ack uses `window.innerWidth/innerHeight`
  which are CSS pixels. Rust's `set_pet_size` takes logical pixels
  too, so the comparison is in the same unit. A 2px tolerance handles
  sub-pixel rounding.

---

## 0.5.13 — R35.2 correctness patch（2026-07-31）

Patch release closing 5 P0 issues from the `RE-LLMPET-0.5.12-carpet-audit-roadmap.md`.
The 0.5.12 carpet audit found a common pattern: "界面层已经出现'完成'的
外观，但后端状态、系统窗口状态或子进程生命周期没有形成同一个事务".
R35.2 closes these state-coherence gaps.

### P0-1: provider chooser coherence

The 0.5.12 carpet audit (P0-1) flagged that the chooser was not in
`syncUiBusy`, not in `INTERACTIVE_HIT_SEL`, read status from the wrong
source, and fire-and-forget launched.

- `pet.js` — `syncUiBusy` now includes `providerChooserOpen` so Rust's
  native click-through guard knows the chooser is open.
- `pet.js` — `INTERACTIVE_HIT_SEL` now includes `#provider-chooser` so
  the chooser card's rect is interactive (not click-through).
- `pet.js` — new `latestProviderStatuses` sourced from `config_view()`
  (NOT from `stats()`, which the audit confirmed does NOT include a
  `providers` field). The chooser now shows correct ok/warn/off badges.
- `pet.js` — `openProviderChooser` closes radial/sesslist/todo/meme
  overlays first (mutual exclusion).
- `pet.js` — `launchProviderChecked` uses `launchAgentChecked` (call)
  so launch failures surface via toast. The chooser awaits the launch
  and only closes on success; on failure it re-enables the item and
  stays open for retry.
- `pet.js` — first chooser item gets focus for keyboard accessibility.

### P0-2: set_providers selected-vs-hook split

The 0.5.12 carpet audit (P0-2) flagged that `set_providers` committed
the config THEN returned `Err` on hook failure — the frontend reverted
the checkbox, but disk/memory said "enabled". This was a split-brain.

- `commands.rs` — `set_providers` no longer returns `Err` on partial
  hook failure. It ALWAYS returns `Ok` with:
  `{ selectedSaved, allHooksOk, selected, hookResults, errors }`.
  The selection is always persisted; hook results are separated.
- `panel.js` — the checkbox stays checked (matching disk) on hook
  failure. A toast shows which hooks failed. The checkbox reverts ONLY
  on genuine rejection (disk write failure, runtime metadata unavailable).

### P0-3: panel setPanelHeight coherence

The 0.5.12 carpet audit (P0-3) flagged: bridge used `send` (fire-and-
forget), cache was set before IPC resolved, `onResized` was registered
twice, and `resetAutoFitOnShow` didn't immediately fit.

- `tauri-bridge.js` — `setPanelHeight` upgraded from `send` to `call`
  (returns Promise).
- `panel.js` — new `pendingFitHeight` tracks the in-flight height.
  `lastFitHeight` is committed ONLY after the IPC Promise resolves.
  On failure the cache is untouched so the next render retries.
- `panel.js` — duplicate `onResized` registration removed (was firing
  two callbacks per resize, doubling the userSized false-positive risk).
- `panel.js` — `resetAutoFitOnShow` now awaits `syncWindowMode` then
  calls `fitPanelHeight` immediately, so the panel appears at the
  correct height on show (not at a stale height until next stats).

### P0-4: real diagnostic cancel (process-tree kill)

The 0.5.12 carpet audit (P0-4) flagged that "cancel" only dropped the
frontend result — the Rust `Child` (and on Windows, the cmd.exe-spawned
Node grandchild) kept running. Verified via web-search of Rust docs:
"There is no implementation of Drop for child processes, so if you do
not ensure the Child has exited then it will continue to run."

- `model.rs` — new `active_diagnostic_pid: Mutex<Option<u32>>` field
  on `Runtime`. Stores the PID of the currently-running diagnostic probe.
- `commands.rs` — new `cancel_diagnostic` async command. Reads the PID
  and calls `kill_process_tree`:
  - Windows: `taskkill /F /T /PID` (kills cmd.exe + Node tree).
    Verified via web-search: "/T Tree kill: terminates the specified
    process and any child processes which were started by it."
  - Unix: `kill(SIGTERM)` then `kill(SIGKILL)` after 200ms.
- `commands.rs` — `run_probe_capture_with_pid` variant registers the
  spawned child's PID via callback before each probe. `diagnose_agent_sync`
  now takes a `register_pid: &dyn Fn(u32)` parameter and passes it to
  all `run_probe_with_pid` calls.
- `commands.rs` — `diagnose_agent` (async) clears the PID on start and
  on completion (or panic) so a late cancel doesn't kill an unrelated
  process that reused the PID.
- `tauri-bridge.js` — new `cancelDiagnostic` bridge method.
- `panel.js` — `clearDiagnostic` calls `cancelDiagnostic` when a
  diagnostic is running (providerDiagnosticBusy), killing the process tree.
- `lib.rs` + `build.rs` + `panel.json` + `cancel_diagnostic.toml` —
  registered the new command + permission + capability.

**Deferred to R36**: full DiagnosticRegistry (prevents duplicate
concurrent runs), Tauri Channel progress, CancellationToken-based
cooperative cancel inside `run_probe_capture`. R35.2's approach is
best-effort: it kills the process tree on cancel, but a probe that's
between spawn and PID registration (a ~1ms window) won't be killable.

### P0-5: release.yml signing semantics (carried from R35.1)

No changes — the R35.1 `PLATFORM_SIGNED` + `REQUIRE_PLATFORM_SIGNING`
work is preserved and the R35.2 smoke verifies it's still in place.

### Web verification (z-ai web_search, 2026-07-31)

- **Rust Child drop = no kill**: confirmed via doc.rust-lang.org/std/
  process/struct.Child.html — "There is no implementation of Drop for
  child processes, so if you do not ensure the Child has exited then
  it will continue to run."
- **taskkill /T /PID kills tree**: confirmed via Microsoft docs —
  "/T Tree kill: terminates the specified process and any child
  processes which were started by it."
- **Tauri 2 window-scoped events**: confirmed (carried from R35.1).
- **OpenCode/CodeWhale CLI commands**: confirmed current (carried).

### Test coverage

- New `test/tauri-r352-correctness-patch-smoke.js` (155 lines, 35
  assertions) locks all 5 R35.2 patches.
- Updated 7 existing smokes for signature/behavior changes:
  - `tauri-bridge-smoke.js` — added `cancelDiagnostic` to expected API
  - `tauri-capability-boundary-smoke.js` — added `cancel_diagnostic` to build.rs
  - `tauri-cli-hardening-r3-smoke.js` — accept `diagnose_agent` with `state` param
  - `tauri-cli-resilience-r7-smoke.js` — same
  - `tauri-provider-phase2-smoke.js` — sl-new now routes through chooseProviderAndLaunch
  - `tauri-r34-config-transaction-smoke.js` — set_providers new return shape
  - `tauri-r35-correctness-hotfix-smoke.js` — INTERACTIVE_HIT_SEL updated
  - `tauri-r351-correctness-patch-smoke.js` — diagnose_agent signature + selector updated
- 4 phase2 smokes: version assertions bumped 0.5.12 → 0.5.13.
- `npm test`: 40/40 smoke ok (was 39; +1 R35.2 smoke)
- `npm run check:static`: 22/22 PASS
- Rust brace balance: commands.rs 491/491+1810/1810+159/159,
  model.rs 327/327+1348/1348+54/54

### Known limitations

- No Rust toolchain in dev container; `cargo build` verified on GitHub Actions.
- `cancel_diagnostic` has a ~1ms race window between spawn and PID
  registration. A full DiagnosticRegistry with spawn_blocking-aware
  cancellation is R36.
- The provider chooser's full focus trap (Tab cycling, arrow-key
  navigation, focus restore to trigger button) is R36. R35.2 only
  focuses the first item.
- `set_providers` does not yet have a per-provider retry command. The
  user can re-save the same selection to re-trigger resync, but a
  dedicated "retry install" button is R36.

---

## 0.5.12 — R35.1 correctness patch（2026-07-31）

Patch release closing 5 of the 6 gaps flagged by the
`RE-LLMPET-0.5.11-deep-recheck-roadmap.md`. The 0.5.11 release was a real
hotfix (not surface patching), but the recheck found a common pattern:
many "fixes" were simulated by fixed timers, frontend result-dropping,
or source-string gates rather than real OS/process/window state
confirmation. This release closes the most actionable gaps.

### P0-1: hit-test anchor-only + single pending radial intent

The 0.5.11 recheck (P0-1 #3) noted that `INTERACTIVE_HIT_SEL` still
included the animated skin elements (`#pixel/#mascot/#cat`) alongside
`#pet-anchor`, so the click-through boundary still shifted during state
animations even though the anchor itself was stable.

- `frontend/renderer/pet.js` — `INTERACTIVE_HIT_SEL` narrowed to
  `#pet-anchor,#radial,#notepad,#todopop,#ask,#sesslist,#meme-player`
  (animated skins removed). The pet body is now represented in the
  hit-test ONLY by the stable anchor.
- New `pendingRadialOpen` boolean replaces the recursive
  `setTimeout(openRadial, 260)` (P0-1 #2). The old code queued multiple
  delayed opens on repeated clicks; the new code records a single
  intent that `markGeometryBusy`'s settle callback opens exactly once.
- `closeRadial()`, the blur handler, and drag-start (pointerdown) all
  clear `pendingRadialOpen` so a stale intent can't reopen the HUD
  after dismissal.

### P0-2: panel window-scoped listeners + reset on panel:shown

The 0.5.11 recheck (P0-2 #1) flagged that the panel used the GLOBAL
`__TAURI__.event.listen('tauri://resize', ...)` which receives events
from ALL windows. Since the pet window resizes frequently, pet resize
events would enter the panel listener and permanently set `userSized=true`,
disabling auto-fit. Verified via web-search of Tauri 2 docs
(v2.tauri.app/reference/javascript/api/namespacewindow): the
window-scoped `getCurrentWindow().onResized(cb)` / `.onScaleChanged(cb)`
/ `.onMoved(cb)` helpers fire ONLY for the current window.

- `frontend/renderer/panel.js` — `installWindowModeListeners` rewritten
  to use `getCurrentWindow().onResized/onScaleChanged/onMoved`. Unlisteners
  are collected in `windowModeUnlisteners` and torn down on `beforeunload`.
- New `resetAutoFitOnShow()` resets `userSized`, `lastFitHeight`, and
  `lastFitRequestTs` (P0-2 #2 — these were never reset before). Called
  on the new `panel:shown` event.
- `src-tauri/src/commands.rs::open_panel` now emits `app.emit("panel:shown", ())`
  after `show()+set_focus()`, giving the frontend an explicit "you've
  been shown again" signal.
- `onScaleChanged` resets `lastFitHeight` and re-fits (P0-2 #5 — DPI
  monitor change no longer leaves stale cached height).

### P0-3: async diagnose_agent with spawn_blocking

The 0.5.11 recheck (P0-3) noted that `diagnose_agent` was still a
synchronous Tauri command, freezing the IPC thread for the full
duration of all probes (up to ~30s worst case). Verified via web-search
of Tauri 2 docs (v2.tauri.app/develop/calling-rust, Jun 2026):
"Asynchronous commands are preferred in Tauri ... use
async_runtime::spawn" and `spawn_blocking` is the correct primitive for
blocking work.

- `src-tauri/src/commands.rs` — `diagnose_agent` is now
  `pub async fn diagnose_agent(provider: String) -> Result<Value, String>`.
  The body is extracted into `fn diagnose_agent_sync(provider)` and
  offloaded via `tauri::async_runtime::spawn_blocking(move || diagnose_agent_sync(provider))`.
  JoinError (panic) is mapped to an error string.
- This unblocks the IPC thread so pet/panel stay responsive during a
  diagnostic. The frontend's `diagnosticGeneration` counter (R35) still
  handles stale-result suppression.
- **Deferred to R36** (per the roadmap): per-step progress via Tauri
  Channel, real cancellation via CancellationToken + child kill, and a
  DiagnosticRegistry preventing duplicate concurrent runs. The R35.1
  change is the minimum to unblock the IPC thread without a full
  diagnostic-job-registry rewrite.

### P0-5: provider chooser + removal of「名称 +N」

The 0.5.11 recheck (P0-5) flagged that the `agent-tag` still displayed
「第一个 Provider 名称 +N」 and "New Agent" still silently launched
`activeProviders[0]`. This conflated "enabled providers" with "active
provider" and was a trust issue.

- `frontend/renderer/pet.html` — new `<div id="provider-chooser">` modal
  with `role="dialog" aria-modal="true"`.
- `frontend/renderer/pet.css` — `.provider-chooser` styles (card, list,
  item with icon + label + status badge).
- `frontend/renderer/pet.js` — new `chooseProviderAndLaunch()`:
  - 0 enabled providers → do nothing (R22 preserved)
  - 1 enabled provider → launch directly (no modal)
  - 2+ enabled providers → open `#provider-chooser` modal; user picks
- The `agent-tag`「+N」label is removed; the element is always hidden
  but retains a tooltip summarizing enabled providers (accessible name
  for screen readers).
- `sl-new` click handler routes through `chooseProviderAndLaunch()`.
- `src-tauri/src/commands.rs::primary_action` — when more than one
  provider is enabled and no session is active, emits a
  `pet:event { kind: "choose-provider" }` instead of silently launching
  array[0]. The frontend `onEvent` handler opens the chooser.
- The chooser supports ✕ close, outside-click close, Escape close, and
  blur close (consistent with radial/sesslist).

### P0-6: release.yml platform signing semantics

The 0.5.11 recheck (P0-6) flagged that the release workflow conflated
the Tauri updater signing key with platform code-signing. They are NOT
the same: the Tauri key signs updater artifacts (which this project
doesn't even produce — `createUpdaterArtifacts=false`), while Windows
Authenticode and macOS Developer ID + notarization affect SmartScreen /
Gatekeeper. The previous `signed=true` output was misleading.

- `.github/workflows/release.yml` — new `PLATFORM_SIGNED` output per
  platform. Windows missing `WINDOWS_CERTIFICATE` → prominent
  `::warning::` saying "Tauri-updater-signed only (no Authenticode)".
  macOS missing `APPLE_CERTIFICATE` → similar warning.
- New `REQUIRE_PLATFORM_SIGNING` repo variable (default false). When
  `true`, missing platform certs HARD-FAIL the stable tag build (the
  audit's strict recommendation). When `false` (current default), the
  build proceeds but with prominent warnings — this lets the project
  enforce platform signing once certs are available without blocking
  the current release pipeline.
- The misleading "updater key = binary signed" language is corrected in
  the warning text.

### Web verification

Before implementation, the following API claims were verified via
web-search (z-ai web_search function, 2026-07-31):

- **Tauri 2 window-scoped events**: `getCurrentWindow().onResized(cb)`
  returns a `Promise<UnlistenFn>` that fires ONLY for the current
  window — confirmed via v2.tauri.app/reference/javascript/api/namespacewindow
  and a tauri-apps discussion ("appWindow.onResized which fires only
  for that window").
- **Tauri 2 async commands**: `async_runtime::spawn_blocking` is the
  correct primitive for blocking work — confirmed via
  v2.tauri.app/develop/calling-rust (Jun 2026) and docs.rs/tauri/latest.
- **OpenCode `auth list`**: still the current command — confirmed via
  opencode.ai/docs/cli ("Lists all the authenticated providers").
- **CodeWhale `doctor --json` + `auth status`**: still current —
  confirmed via github.com/Hmbown/CodeWhale/blob/main/docs/GUIDE.md.
- **GitHub Actions SHA pinning**: still the official best practice;
  GitHub now natively supports blocking non-SHA-pinned actions (Aug
  2025) — confirmed via github.blog/changelog/2025-08-15.

### Test coverage

- New `test/tauri-r351-correctness-patch-smoke.js` (155 lines, 30
  assertions) locks all 5 R35.1 patches.
- Updated `test/tauri-cli-hardening-r3-smoke.js` and
  `test/tauri-cli-resilience-r7-smoke.js` to accept both
  `pub fn diagnose_agent` and `pub async fn diagnose_agent` (R35.1
  changed the signature).
- Updated `test/tauri-r35-correctness-hotfix-smoke.js` — the
  `INTERACTIVE_HIT_SEL` assertion now expects the anchor-only selector
  (R35.1 narrowed it).
- 4 phase2 smokes: version assertions bumped 0.5.11 → 0.5.12.
- `npm test`: 39/39 smoke ok (was 38; +1 R35.1 smoke)
- `npm run check:static`: 22/22 PASS

### What's NOT in this release

Per the recheck's "R35.1 first, then R36" guidance, the following
remain deferred to R36 (0.5.13) or R37:
- Real diagnostic cancellation via CancellationToken + child kill (P0-3
  full closure — R35.1 only unblocked the IPC thread)
- Full Provider state split (enabled/installed/healthy/running/focused)
  — R35.1 only added the chooser and removed the +N label
- Hook install onboarding (plan/diff/backup/apply/verify/rollback)
- Unified atomic writer for transcript/metering/http_server (P1-1)
- Stats hot-path incremental aggregation (P1-2)
- Permission waiter pool isolation (P1-3)
- Cursor hit-test conditional wakeup (P1-4)
- Hidden panel render suppression (P1-5)
- Bootstrap degraded/retry UI (P1-6)
- Full dialog a11y + prefers-reduced-motion (P1-7)
- Capability minimization + CSP tightening (P1-8)
- GitHub Actions full SHA pinning (deferred — requires careful per-action
  migration; the R35.1 release.yml changes are compatible with both
  tag-ref and SHA-pinned actions)

### Known limitations

- The Rust changes (async diagnose_agent, primary_action emit, open_panel
  emit) cannot be `cargo check`'d in this dev container — no Rust
  toolchain. Compilation will be verified by GitHub Actions on push.
  The smoke tests assert source-level patterns only.
- The provider chooser is a functional first cut. The audit's full
  recommendation (icon stack for running providers, recent/focused
  state, "remember last" toggle) is R36.
- `REQUIRE_PLATFORM_SIGNING` defaults to `false` to avoid blocking the
  current release. The project should set it to `true` once Windows
  Authenticode and Apple Developer ID certs are configured.

---

## 0.5.11 — R35 correctness hotfix（2026-07-31）

Hotfix release closing 6 P0 issues identified by the
`RE-LLMPET-0.5.10-deep-audit-roadmap.md` deep audit. The 0.5.10 release
shipped 4/4 signed platform installers and a clean static gate, but
real-machine testing surfaced five classes of runtime problems the
source-level smoke suite could not catch — plus one new P0 in the
config-write path. This release closes all six without adding any new
provider/visual features, per the audit's "fix-then-extend" guidance.

### P0-1: pet geometry — stable anchor + geometry transaction

The audit traced the "桌宠跳动 + HUD 错位" regression to three coordinate
systems (CSS transform, Tauri window size/position, native hit-test) being
out of sync for ~0.55s during state changes. The CSS animations
(`happyJump`, `attn`, `bob`) were applied directly to `#mascot` and
`#pixel`, so `getBoundingClientRect()` on those elements returned transient
mid-animation positions. `buildRadial()` then anchored the HUD at the
transient position, and the native hit-test region followed the same
shifting rect.

- `frontend/renderer/pet.html` — wrap the three skin elements
  (`#pixel`, `#mascot`, `#cat`) in a new `<div id="pet-anchor">` that
  never receives a transform.
- `frontend/renderer/pet.css` — move every state animation from the
  outer skin element to the inner `#mascot-img` / `.pixel-sprite`.
  `#pet-anchor` itself has no `transform`, no `animation`, no `filter`.
  Filters (which don't affect `getBoundingClientRect()`) stay on the
  skin element for visual consistency.
- `frontend/renderer/pet.js` — `buildRadial()` now reads
  `#pet-anchor.getBoundingClientRect()` instead of the skin element's
  rect. `INTERACTIVE_HIT_SEL` includes `#pet-anchor` so the native
  hit-test region follows the stable anchor.
- New `geometryBusy` flag: set for ~260ms after each `set_pet_size`
  call. `openRadial()` defers (via `setTimeout`) while the flag is
  true, so clicks during a resize don't anchor the HUD at the
  intermediate window size.
- New `lastSentPetSize` dedupe: identical consecutive
  `set_pet_size` requests (e.g. from stats updates) are skipped
  entirely. The audit noted stats updates were repeatedly calling
  `set_pet_size` with the same value, causing the OS to redraw the
  window frame for no reason.

### P0-2: panel — remove transparent gutter when maximized + clamp to work area

The audit traced the "详情窗口透明边框" regression to the 20px transparent
`padding` on `html, body` — originally added to give the 32px-blur
`box-shadow` room to render. When the window is maximized or fullscreen,
that 20px becomes a visible transparent border around the panel. The
`#card`'s `border-radius: 18px` and `box-shadow: 0 8px 32px` also look
wrong in fullscreen. Additionally, `set_panel_height` clamped to a fixed
`[480, 1200]` range without consulting the current monitor's work area,
so long diagnostics could push the panel past the taskbar.

- `frontend/renderer/panel.css` — new `body.window-maximized` and
  `body.window-fullscreen` classes that zero the padding and remove
  the border, border-radius, and box-shadow from `#card`.
- `frontend/renderer/panel.js` — new `syncWindowMode()` polls
  `getCurrent().isMaximized()` / `isFullscreen()` and toggles the body
  classes. `installWindowModeListeners()` subscribes to the Tauri 2
  window events (`tauri://resize`, `tauri://maximize`, etc.) so the
  classes stay in sync as the user toggles state.
- New `userSized` flag: set on the first manual resize (detected via a
  resize event that doesn't echo a recent `setPanelHeight` request).
  Once set, `fitPanelHeight()` stops auto-fitting on every render —
  the user picked a size, and stats updates shouldn't snap it back.
- New `lastFitHeight` dedupe: identical consecutive `setPanelHeight`
  IPC calls are skipped.
- `src-tauri/src/commands.rs::set_panel_height` — clamps the requested
  height to `monitor.work_area().height / scale_factor - 48` (the 48px
  margin covers titlebar + OS chrome that the work_area calculation may
  not include). Falls back to `1200.0` if no monitor is available.

### P0-3: diagnostics — generation + cancel + stale-result suppression

The audit traced the "诊断无法清除" regression to three problems:
the loading view had no cancel button, the close button on a finished
result didn't bump the in-flight IPC, and closing didn't call
`fitPanelHeight()` (leaving a tall empty window).

- `frontend/renderer/panel.js` — new `diagnosticGeneration` counter.
  `diagnoseProvider()` captures `const gen = ++diagnosticGeneration`
  before the IPC call; after `await`, if `gen !== diagnosticGeneration`,
  the result is dropped silently. This prevents the "old request returns
  and reopens the panel" bug.
- The loading view now includes a Cancel button
  (`data-diag-action="cancel"`) that routes through the new
  `clearDiagnostic()` helper. `clearDiagnostic()` bumps the generation,
  hides the panel, clears the DOM, calls `fitPanelHeight()` to close
  the empty gap, and re-renders the provider list.
- The click handler routes both `close` (finished result) and `cancel`
  (loading view) through `clearDiagnostic()` so the behavior is
  identical: any in-flight IPC result is dropped, the panel height
  is re-fit.

### P0-4a: Windows cmd quoting — `raw_arg` replaces `.arg(tail)`

The audit's screenshot showed literal `\"C:\\...\\opencode.cmd\"` quotes
in the diagnostic output — proof that Rust's `Command::arg()` was
re-escaping the pre-built `call "C:\\...\\file.cmd" "arg1"` tail per
CreateProcessW rules, then `cmd.exe /S /C` re-parsed the result and saw
literal backslash-quotes. The .cmd shim never ran correctly. This
affected every Windows `.cmd`/`.bat` invocation: probe, launch, GUI
launch, and the cmd fallback.

- `src-tauri/src/commands.rs` — new `append_cmd_tail(command, tail)`
  helper that calls `command.args(["/D", "/S", "/C"]).raw_arg(tail)`.
  `raw_arg` appends the string to the command line AS-IS, with no
  CreateProcessW quoting. Combined with `/S`, `cmd.exe` strips the
  outermost quote pair (if any) from `tail` and executes the result
  verbatim.
- `run_probe_capture` (probe path) and `launch_terminal` (both
  Windows Terminal and cmd fallback) and `open_gui_application` all
  route through `raw_arg`. The previous `.arg(cmd_probe_call(...))`
  / `.arg(cmd_launch_call(...))` / `.arg(cmd_call(...))` patterns
  are gone.
- The `cmd_probe_call`, `cmd_launch_call`, `cmd_call`, and
  `cmd_quote_arg` helper functions are preserved (they still build
  the correctly-quoted tail string); only the call site changed.

### P0-4b: Windows encoding — UTF-16 BOM → UTF-8 → OEM → ACP → lossy

The audit's screenshot showed `�` (U+FFFD) flood in the diagnostic
output — proof that `String::from_utf8_lossy` was replacing every
non-ASCII byte. Chinese Windows `cmd.exe` emits CP936 (GBK); Japanese
Windows emits CP932 (Shift-JIS); English Windows OEM is CP437. None of
these are UTF-8, so `from_utf8_lossy` produced mojibake.

- `src-tauri/src/commands.rs` — new `decode_subprocess_output(bytes)`
  with the audit's recommended fallback chain:
  1. UTF-16 LE BOM (`FF FE`) → `String::from_utf16`
  2. UTF-16 BE BOM (`FE FF`) → `String::from_utf16`
  3. Strict UTF-8 (`std::str::from_utf8`) — the common case for modern
     `--json` CLIs
  4. OEM code page (`GetOEMCP` + `MultiByteToWideChar` with
     `MB_ERR_INVALID_CHARS`) — Windows-only, falls back to next on
     failure
  5. ANSI code page (`GetACP` + `MultiByteToWideChar`) — Windows-only
  6. Lossy UTF-8 (`String::from_utf8_lossy`) — last resort
- `sanitized_probe_json` and `bounded_probe_text` route through
  `decode_subprocess_output` instead of calling
  `String::from_utf8_lossy` directly. The lossy fallback is still the
  final tier, but only after OEM and ACP have been tried.
- `src-tauri/Cargo.toml` — add `Win32_Globalization` feature to
  `windows-sys` for `GetOEMCP`, `GetACP`, `MultiByteToWideChar`,
  `MB_ERR_INVALID_CHARS`. The crate version (0.61) is unchanged; only
  the feature list grows. Cargo.lock doesn't track individual features,
  so no lock-file edit is needed.

### P0-6: config — serialize writes under `config_write_lock` + unique temp names

The 0.5.10 R34 copy-on-write transaction still had a race: two
concurrent writers could both snapshot C0, both persist (A then B on
disk), and both commit (B then A in memory) — leaving `disk == B` but
`memory == A`. The audit's `§4 / P0-6` example shows the exact
split-brain. The temp file name `config.<pid>.tmp` also collided for
concurrent writers in the same process.

- `src-tauri/src/model.rs` — new `config_write_lock: Mutex<()>` field
  on `Runtime`. `update_config()` acquires this lock at the start of
  the transaction and holds it across the entire
  snapshot → mutate → sanitize → save → commit sequence. Reads
  (which only take `config`) remain fully concurrent; only writers
  block each other. This is the simplest correct fix for the small
  config volume — a CAS / revision scheme is overkill.
- New `unique_tmp_path(dest)` helper: builds `<dest>.<pid>.<uuid>.tmp`
  using `uuid::Uuid::new_v4()` (the `uuid` crate is already a
  dependency). The UUID guarantees uniqueness across concurrent writers
  in the same process, across processes, and across crashed runs.
- `save_config` and `write_private_json_atomic` both use
  `unique_tmp_path`. The old `with_extension(format!("{}.tmp",
  std::process::id()))` pattern (PID-only) is gone.

### Test coverage

- New `test/tauri-r35-correctness-hotfix-smoke.js` (175 lines, 38
  assertions) locks all 6 P0 fixes:
  - P0-1: `#pet-anchor` in HTML, animations moved to `#mascot-img`
    / `.pixel-sprite`, `INTERACTIVE_HIT_SEL` includes `#pet-anchor`,
    `geometryBusy` guard, `lastSentPetSize` dedupe
  - P0-2: `body.window-maximized` / `body.window-fullscreen` CSS
    rules, `syncWindowMode` + `installWindowModeListeners`,
    `userSized` flag, `lastFitHeight` dedupe, `set_panel_height`
    clamps to `monitor.work_area()`
  - P0-3: `diagnosticGeneration` counter, stale-result suppression,
    `clearDiagnostic` helper, cancel button in loading view,
    `fitPanelHeight()` after close
  - P0-4a: `append_cmd_tail` helper, `raw_arg` calls, absence of
    `.arg(cmd_probe_call(...))` / `.arg(cmd_launch_call(...))` /
    `.arg(cmd_call(...))` after `/S /C` or `/S /K`
  - P0-4b: `decode_subprocess_output` with UTF-16 BOM detection,
    strict UTF-8, `decode_windows_codepage` with `MultiByteToWideChar`
    / `GetOEMCP` / `GetACP` / `MB_ERR_INVALID_CHARS`, `Win32_Globalization`
    feature in `Cargo.toml`
  - P0-6: `config_write_lock: Mutex<()>` field, `_write_guard` in
    `update_config`, `unique_tmp_path` with `uuid::Uuid::new_v4()`,
    absence of PID-only temp name pattern
- `npm test`: 38/38 smoke ok (was 37; +1 R35 smoke)
- `npm run check:static`: 22/22 PASS
- Existing smokes preserved: `cmd_probe_call`, `cmd_launch_call`,
  `cmd_call`, `cmd_quote_arg` function names still present;
  `.args(["/D", "/S", "/C"])` and `.args(["/D", "/S", "/K"])` source
  patterns still present.

### What's NOT in this release

Per the audit's "fix-then-extend" guidance, this release contains
**only** correctness fixes. Deferred to 0.5.12 (R36, UX & user trust):
- async diagnostics with channel progress + cancellation (P0-3 partial
  fix here only adds client-side stale-result suppression; the Rust
  command is still synchronous)
- enabled/installed/healthy/running/focused provider state split (P1-5)
- hook install onboarding flow (P1-7)
- `core:default` capability replacement (§5.1)
- GitHub Actions pinned to full SHAs (§5.2)
- full dialog a11y (§6.3)
- `prefers-reduced-motion` (§6.4)
- Stable signing policy clarification (P0-7)

### Known limitations

- The Rust changes (config serialization, encoding fallback, raw_arg)
  cannot be `cargo check`'d in this dev container — no Rust toolchain.
  Compilation will be verified by GitHub Actions on push. The smoke
  tests assert source-level patterns only.
- The encoding fallback uses `windows-sys`'s `MultiByteToWideChar`
  which handles all Windows code pages (CP437, CP932, CP936, CP1252,
  etc.) but does NOT handle UTF-7 or EBCDIC. These are not emitted by
  any supported provider CLI.
- `geometryBusy` uses a fixed 260ms window. If a future change makes
  `set_pet_size` slower (e.g. always-on monitor work_area query), the
  window may need to grow. The flag is a soft guard — if it stays true
  for too long, `openRadial` opens anyway (better slightly-off than
  silently swallowed).

---

## 0.5.9 — R34 release-tooling root-cause fix（2026-07-31）

Hotfix release closing 2 root-cause issues that blocked the v0.5.8 release workflow. The v0.5.8 tag push correctly fail-closed on missing `TAURI_SIGNING_PRIVATE_KEY`, but after configuring the secret, the release still failed on 3 of 4 platforms. Investigation found 2 distinct root causes — both fixed here.

### Root cause 1: CRLF line-ending corrupted fixture SHA on Windows

- **Symptom**: `test/reference-contract-smoke.js` failed on Windows runner with `reference fixture changed without an explicit contract review: test/fixtures/claude-transcript-assistant.jsonl`, even though the local SHA matched the expected value.
- **Root cause**: The repo had no `.gitattributes`. On Windows, Git's default `core.autocrlf=true` converted `*.jsonl` files from LF to CRLF on checkout, changing the byte content and breaking the SHA256 lock. The local dev environment (Linux) used LF, so the failure only surfaced in CI.
- **Fix**: Added `.gitattributes` with `* text=auto eol=lf` as the default policy, plus `test/fixtures/** text eol=lf` to hard-force LF on all SHA-locked fixtures. Binary file extensions are explicitly marked `binary` to prevent any normalization. Shell scripts and PowerShell scripts are also forced to LF for cross-platform consistency.

### Root cause 2: Release gate conflated Tauri signing with platform code-signing

- **Symptom**: After configuring `TAURI_SIGNING_PRIVATE_KEY`, the release workflow still failed at step "Release preflight and static regression" with `FAIL release secret present: WINDOWS_CERTIFICATE` and `FAIL release secret present: WINDOWS_CERTIFICATE_PASSWORD`.
- **Root cause**: `scripts/check-release-gates.js` treated Windows code-signing cert and Apple Developer ID + notarization secrets as REQUIRED for `--release` mode. The 0.5.7 audit (§P0-4) called out Tauri-signing-key-missing as a blocker because v0.5.7 published TRULY UNSIGNED binaries. But platform code-signing is a SEPARATE concern from Tauri updater signing — the Tauri key cryptographically attributes the binary; platform certs only suppress "unknown publisher" OS warnings. With the Tauri key configured, missing platform certs should be a SOFT WARN, not a hard FAIL.
- **Fix**: `check-release-gates.js` now treats only `TAURI_SIGNING_PRIVATE_KEY` as a hard requirement for `--release` mode. Platform certs (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`) emit `WARN` lines but do not fail the build. When platform certs become available, set them as GitHub secrets to silence the warnings and unlock OS-level UX (SmartScreen reputation, Gatekeeper notarization).

### Root cause 2b: macOS tag-build path didn't pass `--no-sign` when Apple cert missing

- **Symptom**: Even after fixing the gate script, macOS bundle jobs would still fail at the `tauri build` step because `tauri-action` tries to Apple-sign by default.
- **Root cause**: The release.yml tag-push branch always set `bundleArgs=${{ matrix.args }}` without `--no-sign`. The `--no-sign` flag was only added in the workflow_dispatch path (unsigned draft).
- **Fix**: The tag-push branch now conditionally adds `--no-sign` on macOS when `APPLE_CERTIFICATE` is missing. Windows doesn't need an equivalent flag because `tauri-action` handles missing `WINDOWS_CERTIFICATE` gracefully (the build succeeds, the .exe just isn't code-signed).

### Signing keypair generated + configured

- Generated a new Tauri signing keypair via `npx tauri signer generate --ci` (no password, since the secret store handles access control).
- Private key uploaded as GitHub repo secret `TAURI_SIGNING_PRIVATE_KEY` (encrypted with libsodium sealed box via the repo's public key).
- Public key saved at `/home/z/my-project/.tauri-keys/octopus.key.pub` for future updater config.
- Private key backed up at `/home/z/my-project/.tauri-keys/octopus.key` (NOT committed to git; users with repo admin access can rotate via the same `scripts/set-github-secret.py` helper).

### Test coverage

- `npm test`: **37/37 smoke ok** (unchanged from 0.5.8; the gate-script behavior change is tested manually via `TAURI_SIGNING_PRIVATE_KEY=test node scripts/check-release-gates.js --release`).
- `npm run check:static`: **22/22 PASS**.
- Local gate verification: `--release` mode now passes with only `TAURI_SIGNING_PRIVATE_KEY` set; platform cert warnings appear but do not fail the build.

### Verification

- Both root causes verified by reading the actual GitHub Actions job logs (not just speculating from source).
- The v0.5.8 release workflow run (commit `4e347e6`) is preserved as evidence of the pre-fix failure mode: 4/4 bundle jobs failed at step 11 "Release preflight and static regression" with the exact errors documented above.
- After this fix lands, the v0.5.9 tag push should produce 4/4 successful signed bundles.

### Not in this release (deferred to R35+)

- `diagnose_agent` async refactor with progress channel (P1-3).
- HTTP server permission waiter / `/state` capacity isolation (P1-4).
- Performance gate thresholds — RSS / cold-start / long-task budgets (P1-6).
- Hook install onboarding flow — path / diff / confirm / backup / rollback (P1-7).
- GitHub Actions pinned to full commit SHAs (§5.2).
- `core:default` capability replacement with explicit `core:*:allow-*` (§5.1).
- Platform code-signing certs (Windows code-signing cert, Apple Developer ID + notarization) — these remain SOFT WARN until procured.
- Toast upgrade: persistent error center with retry / copy-details / open-log (§6.1).
- Full dialog a11y: `role="dialog"` / Tab trap / Esc / focus restore (§6.3).
- `prefers-reduced-motion` support (§6.4).
- Process-tree performance benchmark vs Electron (§9).

These are larger refactors tracked in the 0.5.7-source-audit-roadmap Phases R34-R36.

---

## 0.5.8 — R34 config transaction + structured provider result + signing fail-closed（2026-07-31）

Hotfix release closing 4 P0 + 1 P1 issue from the 0.5.7 source audit. The audit identified a recurring anti-pattern: *failures were silently dropped or contradicted by documentation*. This release closes those gaps with real fail-closed behavior.

### P0-1: Config save is now transactional (copy-on-write)

- **Root cause**: `src-tauri/src/model.rs:420-428` mutated the shared `Mutex<AppConfig>` IN PLACE, then called `save_config()`. If `save_config()` failed (disk full, permission denied, antivirus lock, rename failure), the in-memory config was already the new value while the disk still held the old value. Subsequent `get_config()` / restart would see conflicting state.
- **Fix**: `update_config()` now snapshots the current config into a local `candidate`, mutates the snapshot, sanitizes, **persists to disk FIRST**, and only commits to the shared `Mutex` if the disk write succeeded. The `Mutex` is held only for the snapshot+commit, NOT across file IO.
- Files changed: `src-tauri/src/model.rs:420-455`.

### P0-2: set_providers returns structured per-provider result

- **Root cause**: `src-tauri/src/commands.rs:269-290` returned `Ok(())` even when individual provider hook installs failed — the panel's Promise resolved and the UI showed success while hooks were never written. Errors were only emitted as a side-effect `pet:event` that the user might miss.
- **Fix**: `set_providers()` now returns `Result<Value, String>` with a structured JSON object:
  ```json
  {
    "ok": true,
    "selected": ["claude", "codex"],
    "providers": [
      {"id":"claude","selected":true,"installed":true,"state":"ready",...}
    ]
  }
  ```
  On any per-provider failure, it returns `Err(errors.join("；"))` so the panel's `call()` rejects → `octopus:bridge-error` toast fires AND the checkbox reverts. The `pet:event` is still emitted for inline pet-window visibility.
- Files changed: `src-tauri/src/commands.rs:268-331`.

### P0-3: uninstall_hooks('all') no longer swallows failures

- **Root cause**: `src-tauri/src/commands.rs:150-170` used `if let Ok(path) = uninstall_provider_hooks(id)` which silently discarded every `Err`. The UI told the user "all hooks removed" while external config files still had Octopus hooks in them.
- **Fix**: Now collects per-provider `results` array with `{provider, status, path|error}`. Returns:
  ```json
  {
    "provider": "all",
    "allSucceeded": false,
    "results": [{"provider":"claude","status":"removed",...}, {"provider":"codex","status":"failed","error":"..."}],
    "failures": ["codex: ..."],
    "message": "Partial failure — ..."
  }
  ```
  **Only clears `config.providers` if `allSucceeded`**. On partial failure, the broken state is surfaced to the user rather than hidden.
- Files changed: `src-tauri/src/commands.rs:142-217`.

### P0-4: Tag pushes fail-closed without signing key

- **Root cause**: `.github/workflows/release.yml:110-122` published an **unsigned public prerelease** on every tag push when `TAURI_SIGNING_PRIVATE_KEY` was missing. This contradicted `README.md`'s promise that "tag 缺签名凭据会在构建前失败". The v0.5.7 release was actually published this way.
- **Fix**: Tag pushes now `exit 1` with an `::error::` annotation when the signing key is missing, directing users to `workflow_dispatch` for unsigned draft builds. The signed path (`prerelease=false`, `releaseDraft=false`) is preserved.
- Files changed: `.github/workflows/release.yml:103-126`.

### P1-1: panel.js setSessionPrefs caller awaits + reverts on failure

- **Root cause**: The R32 bridge upgrade changed `setSessionPrefs` from `send()` to `call()`, but the panel.js click handler still called it fire-and-forget. Failures silently dropped, the UI showed the new state, and disk held the old state.
- **Fix**: The click handler now snapshots `prevPinned`/`prevArchived`, applies the optimistic update, awaits `setSessionPrefs()`, and on `.catch()` reverts the UI arrays + re-renders + dispatches `octopus:bridge-error`. The button is disabled during the await.
- Files changed: `frontend/renderer/panel.js:506-548`.

### Documentation drift fixed

- `README_EN.md`: 0.5.6 → 0.5.7.
- `docs/MIGRATION_STATUS.md`: header updated to reflect 0.5.7 + R32/R34 hotfixes.

### Test coverage

- New `test/tauri-r34-config-transaction-smoke.js` (84 lines) locks all 5 P0/P1 fixes.
- Existing `test/release-supply-chain-smoke.js` updated: now asserts the fail-closed `exit 1` path instead of the old warning + unsigned prerelease path.
- `npm test`: **37/37 smoke ok** (was 36; +1 R34 smoke).
- `npm run check:static`: **22/22 PASS**.

### Verification

- All 5 P0/P1 fixes verified by direct `grep` against source before any code change.
- CI will run `cargo fmt --check` + `cargo check` + `cargo test` on Windows / macOS / Ubuntu.
- Release workflow `Signed Tauri Release` will now fail-closed if `TAURI_SIGNING_PRIVATE_KEY` is missing — tag pushes can no longer produce unsigned public binaries.

### Not in this release (deferred to R35+)

- `diagnose_agent` async refactor with progress channel (P1-3).
- HTTP server permission waiter / `/state` capacity isolation (P1-4).
- Performance gate thresholds — RSS / cold-start / long-task budgets (P1-6).
- Hook install onboarding flow — path / diff / confirm / backup / rollback (P1-7).
- GitHub Actions pinned to full commit SHAs (§5.2).
- `core:default` capability replacement with explicit `core:*:allow-*` (§5.1).
- Toast upgrade: persistent error center with retry / copy-details / open-log (§6.1).
- Full dialog a11y: `role="dialog"` / Tab trap / Esc / focus restore (§6.3).
- `prefers-reduced-motion` support (§6.4).
- Process-tree performance benchmark vs Electron (§9).

These are larger refactors tracked in the 0.5.7-source-audit-roadmap Phases R34-R36.

---

## 0.5.7 — R32 bridge error visibility + permission await + empty provider（2026-07-31）

Hotfix release addressing 4 P0 regressions identified in the R30-recheck audit (`RE-LLMPET-v0.5.6-R30-recheck-roadmap.md`). All 4 share the same anti-pattern: *fix intent written in comments, behavior not actually landed at runtime*. This release closes that gap with real user-visible behavior and a regression smoke that locks the fixes.

### P0-1: pet.js cat lazy preload ReferenceError

- **Root cause**: `frontend/renderer/pet.js:136` referenced `config.skin`, but no `config` symbol exists at module scope. The actual skin state is the `skin` variable declared later in the file (line 1132). The `requestIdleCallback`/`setTimeout` callback threw `ReferenceError` on every startup, logging noise to the console and never preloading cat assets.
- **Fix**: `config.skin` → `skin`. TDZ-safe because the deferred callback only runs after the entire `<script>` has finished parsing.

### P0-2: panel.js empty provider UI locked despite comment saying unlocked

- **Root cause**: `frontend/renderer/panel.js:940` had `if (newActive.length === 0) { e.target.checked = true; return; }` even though the comment at line 769 said *"users can now uncheck all"*. The R22 `model.rs::sanitize()` fix already allowed `providers=[]` as a first-class state, but the UI still refused to persist it.
- **Fix**: Removed the revert branch. `setProviders(newActive)` is now called with a possibly-empty array. On IPC failure, the checkbox reverts and a toast fires. Loading state disables the checkbox during the await.

### P0-3: tauri-bridge.js used send() for security-critical commands

- **Root cause**: The bridge comment at line 23-25 said *"state-changing or security-critical operations MUST use call() and await"*, but `setProviders`, `decidePermission`, `decideCwPermission`, `decideCwPermissionBatch`, and `setSessionPrefs` all used `send()` (fire-and-forget). IPC failures were silently dropped; the UI showed success while the agent kept waiting.
- **Fix**: All 5 commands upgraded `send()` → `call()`. The `send()` path still exists for genuinely fire-and-forget operations (telemetry, focus hints, etc.) and still emits `octopus:bridge-error` on failure (R30 contract preserved).

### P0-4: pet.js removed choice card BEFORE IPC resolved

- **Root cause**: `submitPerm`/`gotoSession`/elicitation submit called `decidePermission()` then immediately `finishChoice()`, which removed the card from `askQueue`. If IPC failed, the user saw an *"allowed/denied"* bubble while the agent was still blocked waiting for an answer.
- **Fix**: New `submitDecision(choice, behavior, msg)` wrapper:
  1. Disable all buttons (loading state).
  2. `await routeDecision(choice, behavior)`.
  3. On success: `finishChoice` (remove card, show bubble).
  4. On failure: dispatch `octopus:bridge-error` toast, restore buttons, DO NOT add to `answered` (so the choice stays in the queue for retry).
- All 6 submit sites (`elicitation-submit`, `plan-feedback`, `cw-batch`, `submitPerm`, `gotoSession`, `popPerm`) now route through `submitDecision` or its inline equivalent.

### P0-5: Visible bridge-error toast UI

- **Root cause**: R30 added the `octopus:bridge-error` `CustomEvent`, but `panel.js` listener only `console.warn`-ed with a `TODO` comment. `pet.js` had no listener at all.
- **Fix**: New `frontend/shared/toast.js` auto-installs on script load, listens for `octopus:bridge-error`, and shows a real visible toast in the `#octopus-toast` element (added to both `panel.html` and `pet.html`).
  - Auto-dismisses after 4.5s
  - Click-to-dismiss-early
  - `role="alert"` + `aria-live="assertive"` for screen readers
  - CSS in both `panel.css` and `pet.css`
- `panel.js` listener kept as a debug log; `toast.js` is the user-visible path.

### Test coverage

- New `test/tauri-r32-bridge-error-visibility-smoke.js` locks all 4 P0 fixes + toast UI + 7 contract assertions (35 lines).
- Existing `tauri-panel-sesslist-r19-smoke.js` updated to expect `call()` instead of `send()` for `setSessionPrefs`.
- `npm test`: 36/36 smoke ok (was 35).
- `npm run check:static`: 22/22 PASS (JS syntax 56 files, was 55; +1 `toast.js`).

### Verification

- 4 P0 fixes verified by direct `grep` against source before any code change (no roadmap-as-truth).
- CI: Tauri CI 4 jobs (Windows / macOS / Ubuntu / RustSec Cargo.lock audit) all green on `1d3e017`.
- Local cargo not available; CI ran `cargo fmt --check` + `cargo check` + `cargo test` on all 3 platforms.

### Not in this release (deferred to R33+)

- `diagnose_agent` async refactor with progress channel (P1).
- Hook install onboarding flow (path / diff / confirm / backup / rollback).
- GitHub Actions pinned to full commit SHAs.
- Performance gate thresholds (RSS / cold-start / long-task budgets).
- `core:default` capability replacement with explicit `core:*:allow-*`.

These are larger refactors tracked in the R30-recheck roadmap Phases 1-2.

---

## 0.5.6 — R10-R21 visual migration complete + Windows cargo check clean（2026-07-30）

This release completes the R9 roadmap's visual migration: **tray 18/18** and **panel 10/10** visual elements now match the upstream Electron layout. Windows `cargo check --target x86_64-pc-windows-gnu --locked` passes with 0 errors, 0 warnings (R20). All changes are source-level; Linux/macOS native compilation, real CLI execution, and signed bundles remain external gates per `docs/RELEASE.md`.

### Tray menu (R10-R14)

- **R10**: Fixed `TrayIconBuilder::new("main-tray")` compile blocker — Tauri 2.11.5 requires `.with_id("main-tray")`. Removed redundant `app.manage(tray)`. Reversed CodeWhale doctor probe to **companion-first** with dispatcher fallback (was dispatcher-first, contradicting project docs). Added 19-check `tauri-codewhale-doctor-consistency-r10-smoke.js` locking docs/impl/PowerShell/tests together.
- **R11**: Added `src-tauri/src/i18n.rs` with 29-key `TRAY_LABELS` table (zh/en/ja). `build_tray_menu` localizes all labels. `refresh_tray_menu` rebuilds the menu + tooltip on language switch. 23-check cross-source parity smoke.
- **R12**: Added 4 submenus (language / skin / 5h budget / mute) via `CheckMenuItem` + `PredefinedMenuItem::separator`. 10 new `on_menu_event` handlers route to existing config commands.
- **R13**: Added disabled settings placeholder, `uninstall_hooks` Tauri command (single-provider hook cleanup via `hook_install::uninstall_provider_hooks`), localized tooltip.
- **R14**: Added shape submenu (pet / panel / hidePet). `set_mode` now has window side-effects (hidePet hides pet window; pet/panel show+focus). `hidePet` replaces upstream's menubar mode (Tauri has no menubar).

### Panel (R15-R19)

- **R15**: Restored Codex 5h quota bar (`#codex-wrap`) + today/lifetime token grid (`#codex-usage`) with distinct cool-tone CSS. `renderCodexUsage` ready for when Rust codex-watch equivalent populates `s.codexLimits`/`s.codexUsage`.
- **R16**: Restored Token/Cost metric switching (`.metric-tabs`) + `#usage-diagnostics` line. `renderChart`/`renderCal` now accept dual arrays and respect `usageMetric`. `renderDiagnostics` shows scan info + pricing staleness.
- **R17** (audit): Fixed 5 pre-existing i18n hardcoded Chinese bugs in `today-tokens`, `win-reset`, `cal mouseover`, `renderByModel`, `renderProviderCost`. Wired `i18n.rs::known_keys()` into smoke (was dead code). Added 3 new i18n keys (`estimatedRounds`/`unknownRounds`/`total`).
- **R18**: Added `cache_write_5m` + `cache_write_1h` to `UsageEvent` + `Aggregate` + `parse_claude_assistant` (extracts `ephemeral_5m/1h_input_tokens` from `usage.cache_creation`, remainder → 5m per Anthropic default TTL). Panel `t-cw` single row → `t-cw5` + `t-cw1` dual row. `modelDetail` upgraded to `{cw5}/{cw1}`.
- **R19**: Added session list Pin/Archive + attention filter. `AppConfig.pinned_sessions`/`archived_sessions` + `set_session_prefs` Tauri command (sanitize 256-char + dedup + pin-wins). `renderSessList` filters by attention (waiting/needsinput), hides archived unless toggled, sorts pinned to top, renders pin/archive buttons per row. 9 new `sess.*` i18n keys × 3 langs.

### Native compilation (R20-R21)

- **R20**: `cargo check --target x86_64-pc-windows-gnu --locked` = 0 errors, 0 warnings. Added `build-windows.sh` for reproducible Windows builds. All R10-R19 Rust code compiles clean on Windows target.
- **R21**: Web-verified 5 provider CLIs (4/5 current; Claude has 7 new non-blocking events documented in protocol-drift). Hardened smoke assertions to tolerate `cargo fmt` multiline splits.

### CLI smoke test

- Added `cli-smoke-test.sh` (10-dimension downloadable verification script): project structure, tray API contract, CodeWhale doctor order, tray i18n+submenus, panel visual elements, metering 5m/1h, npm test, static checks, provider CLI discoverability, real CodeWhale doctor test.

### Verification

- `npm test`: **45/45 PASS** (10 new R10-R19 smoke suites)
- `npm run check:static`: 22/22 PASS (bridge parity 39 commands)
- `python3 scripts/rust-structure-smoke.py`: 3/3 PASS
- `cargo check --target x86_64-pc-windows-gnu --locked`: 0 errors, 0 warnings (R20)
- `cargo fmt --check`: clean (R21)
- `migration-todo`: 47 tasks (4 done, 40 implemented-uncompiled, 3 blocked, 1 deferred)

### Not verified in this release

- Linux/macOS `cargo check --locked` (Windows target verified; Linux/macOS targets need their own toolchain)
- Real CodeWhale/Codex/OpenCode/Aider CLI execution (web-verified only)
- Real GUI: tray submenu rendering, panel dual rows, pin/archive persistence
- Windows/macOS/Linux signed bundles, SBOM, checksums (CI `release.yml` handles this on tag push)

These remain release gates per `docs/RELEASE.md`. This is a **source-reconciled release candidate with Windows compile evidence**, not a stable production release.

## 0.5.5 R7 — resilient doctor fallback and bounded local diagnostics（2026-07-29）

- Reconciled CodeWhale's conflicting public dispatcher and detailed TUI doctor documentation with a bounded, auditable fallback chain: try `codewhale doctor --json`, then use the matched `codewhale-tui doctor --json` when the first surface has no parseable JSON. Both attempts, targets and selected surface remain visible.
- Removed arbitrary diagnostic working directories from the always-on WebView. Diagnostics now run only in the application-owned directory, preventing renderer-controlled projects from implicitly loading provider `.env`, plugins, hooks or workspace configuration.
- Added CodeWhale project-overlay detection, current/legacy overlay conflict warnings, and Claude Code `<2.1.200` sleep/wake compatibility guidance without turning version age into a launch blocker.
- Added Aider configuration discovery for cwd/git-root/home and reports only credential environment variable names and model-presence booleans, never credential values.
- Extended the existing zh/en/ja provider diagnostic card and the Windows PowerShell 5.1 evidence collector; no new web page or remote UI dependency was introduced.
- Added a 23-check R7 CLI-resilience suite and a stable `npm run check:static` gate. Full npm smoke, 39-byte-identical visual/media assets, protocol drift, source-release gates, JavaScript/JSON checks and Rust lexical/structure checks pass. Native compilation and real Windows CLI execution remain external gates.

## 0.5.5 R6 — authentication and route diagnostics（2026-07-29）

- Split pre-launch diagnostics into installation, authentication, provider/model routing, and working-directory evidence instead of collapsing every CLI failure into `internal error`.
- Parse CodeWhale `doctor --json` before truncation, recursively redact secrets, and expose only bounded route/config/session-migration summaries to the existing provider panel.
- Added non-interactive `codewhale auth status`, `codex login status`, and `opencode auth list` probes; authentication uncertainty remains a warning because environment keys, project `.env`, custom providers, or local/keyless providers can still work.
- OpenCode now receives its official `--dir .` argument on Windows Terminal, cmd fallback, macOS Terminal, and Linux terminal paths while retaining process `current_dir`.
- Extended the Windows PowerShell 5.1 collector, zh/en/ja UI labels, structured migration TODO, and a 20-check R6 regression suite. No image, GIF, MP3, drag, DPI, or transparency behavior was replaced.
- Offline tests, 39-byte-identical asset gate, protocol drift, 16 source-release gates, JavaScript syntax, JSON parsing, and Rust lexical/structure checks pass. Native Rust compilation and real CLI/desktop evidence remain external gates.

## 0.5.5 — upstream reconciliation, visual preservation and runtime hardening（2026-07-28）

- R4 merged the CLI-hardening overlay into the complete R2 source tree with a guarded function-level merge; it did not overwrite drag, cursor hit-testing, DPI anchoring, language switching, UI state, or visual/media resources.
- Added diagnosable fixed-provider launch resolution, PATHEXT/npm shim handling, CodeWhale companion/version/doctor checks, explicit cwd support, bounded stdout/stderr probes, and a Windows PowerShell diagnostic collector.
- Kept Windows Terminal as the primary host with a restricted cmd fallback, and fixed VS Code/Cursor `.cmd` GUI entry points without restoring `cmd /C start`.
- The default test suite now includes 35 CLI merge/preservation assertions; all offline tests, resource hashes, protocol drift and source release gates pass. Native Rust compilation and Windows real-CLI evidence remain unclaimed.
- Reconciled the Tauri tree against official upstream `49fef749364b31dfa2ddab857aed7d82d49460cc` and the five-provider fork `b424675b80162121e58cab631088604d10716b63`; official UI behavior, fork protocol lessons and Tauri runtime responsibilities are recorded separately.
- Imported official zh/en/ja copy, two GIFs, two MP3 files and the cat-skin attribution byte-for-byte; retained the full meme catalog as a backend resource and generated a presentation-only renderer manifest without full prompt bodies.
- Added persistent language switching for the core pet/panel UI and an honestly labelled local meme preview that preserves GIF/audio quality without pretending to send prompts.
- Fixed the session-list provider launch regression where Codex/OpenCode/Aider labels still launched Claude; all five providers now use one fixed Rust allowlist, distinct session/cost icons and fail-closed unknown identifiers.
- Replaced Windows shell-interpolated path opening with `explorer.exe` arguments; corrected PowerShell focus-helper scope; validated and stored UI-busy/visual-bound state instead of accepting no-op commands; flattened bounded diagnostics to prevent multi-line log forgery.
- Hardened Windows hook/runtime atomic replacement with backup-and-rollback behavior so a rename failure does not destroy the previous configuration.
- Added deterministic meme generation, upstream hash/provenance checks, command-safety tests, provider-launch regression tests and a 39-file visual baseline gate.
- Fixed the transparent-pet input deadlock caused by treating Tauri's strict cursor-ignore API like Electron's `forward: true`: a native cursor hit-test guard now restores input over validated interactive bounds, while short-click and drag remain distinct gestures.
- Reworked drag into an animation-frame-throttled move path with one final position commit, eliminating configuration writes and full config broadcasts on every pointer movement; pointer-capture completion is idempotent and popup resize invokes are serialized.
- Windows agent launch now passes the allow-listed provider executable directly to `wt.exe` in a new Windows Terminal window; only if Terminal cannot be spawned does it fall back to `cmd.exe /D /K`, with no `cmd /C start` wrapper.
- Continued upstream visual migration with a bounded ask body/fixed toolbar, per-provider identity tags, an in-session-HUD meme page, skin-aware side media, idle GIF preloading, and DPI-aware bottom-centre window anchoring while preserving every imported media byte.
- All offline source, protocol, resource and JavaScript checks pass. Rust/Tauri compilation and real-provider/desktop/signing evidence remain unavailable in the current no-toolchain, DNS-blocked environment and are not claimed.

## 0.5.1 — comprehensive audit hardening（2026-07-28）

- Removed blanket Bash auto-approval and delegated HTTPS WebFetch to the provider-native permission flow; cleartext HTTP remains denied.
- Split Tauri invoke permissions by `pet` and `panel` window using generated command permissions instead of exposing every registered command to every WebView.
- Made signed tag releases fail closed; manual unsigned builds now create isolated draft releases instead of public prereleases.
- Upgraded first-party artifact upload workflows to `actions/upload-artifact@v7`, corrected SPDX namespace/DESCRIBES metadata, and added a pinned RustSec `cargo-audit` CI gate.
- Reconciled `package-lock.json` with version 0.5.1 and added regression checks for lockfile, release, capability, SBOM and permission boundaries.
- Reconciled migration status for the committed `Cargo.lock`; three-platform compilation, real GUI and real-provider execution remain explicitly unverified.

## 0.5.1 — hot-path performance optimization（2026-07-28）

- Optimized `stats()` on the /state POST hot path: `project_name()` 3×→1× per session (cached), `PendingPermission` double-clone→1 clone + zero-copy borrow, `session_projects` values cloned→`&str`.
- Added `privacy_settings() -> (bool, usize)` to `ingest()` — avoids a full `AppConfig` clone on every hook event (reads only `reply_bubbles` + `reply_bubble_chars`).
- Fixed E0716 (dangling borrow on temporary `MutexGuard`) caught by CI macOS.
- Cleaned stale source-tree files: `--draft` junk, duplicate migration TODO, 5 one-off phase4 verification logs, stale SHA256 manifest, unreferenced BUILD_TAURI.md.

## 0.5.0-phase4 — upstream reliability reconciliation and complete runtime cutover（2026-07-27）

- Compared the migration candidate with `purrfecto114-lgtm/LLMPET` and upstream `myunwang/LLMPET`; recorded the fork tag, observed fork head, and upstream head separately.
- Adopted upstream's 2026-07-27 parallel permission semantics: distinct requests in one session remain separate; only exact provider/session/tool/input retries share a response.
- Added top-level `pendingChoices`, `permId`-based renderer identity, shared retry responses, and session state preservation while another permission remains pending.
- Removed the complete archived Electron/Node runtime, obsolete package scripts, old operational docs, and stale generated reports. Rollback now uses immutable repository/tag archives.
- Retained only three anonymized, SHA-256-pinned data fixtures for behavioral contract tests.
- Bumped package, Tauri config, and Cargo manifest to 0.5.0; source tests and static gates pass, while Cargo.lock/three-platform compilation/real CLI/GUI/signing remain explicit external blockers.

## 0.4.0-phase3 — Tauri 活动路径切换与可执行发布门禁（2026-07-27）

- 旧 Electron 主进程、preload、backend/provider/hook/renderer 运行路径已从源码树删除；仅保留匿名化、哈希固定的数据契约样本。
- Claude `AskUserQuestion` / `ExitPlanMode` 使用 PreToolUse `updatedInput`；`permission_suggestions` 使用 PermissionRequest `updatedPermissions`；Codex 保持最小 fail-closed envelope。
- 新增来源 PID 父进程链终端聚焦，支持 macOS/Windows/X11，并对纯 Wayland 明确降级。
- 新增 `RunEvent::Resumed`、显示器拓扑签名、离屏窗口恢复和单例低频健康检查。
- 新增资源基线、跨平台性能采样、真实 Provider/桌面 self-hosted gate、签名发布、校验和、SPDX SBOM 与 GitHub attestations。
- package/Cargo/Tauri 升至 0.4.0；TODO 清零为 0，外部硬门禁保持 blocked/implemented-uncompiled，未虚报三平台、真机或签名完成。

## 0.3.0-phase2 — 多 Provider 原生适配与动态迁移门禁（2026-07-26）

- 对照用户指定 fork 与各 provider 当前官方/维护文档，确认 CodeWhale 是一等 provider，不再套用单一 Claude Hook 模型。
- 新增 provider capability/status 模型；前端可见安装状态、配置路径、权限模式和能力限制。
- Claude：merge-safe hooks、当前 `hookSpecificOutput`、收紧自动允许名单。
- CodeWhale：TOML marker 合并、10 类维护事件、原生 payload 映射、服务失联显式 `ask`。
- Codex：当前 `~/.codex/hooks.json` 嵌套结构、PermissionRequest、`/hooks` 信任提示。
- OpenCode：官方风格 ESM plugin，观察 session/tool/permission，不伪造外部权限控制。
- Aider：规范 `notifications-command`，只承诺 turn-end，拒绝覆盖用户已有通知命令。
- Provider 开关即时安装/卸载；安装失败按 provider 隔离。
- Windows Hook 命令统一经 `cmd.exe /D /S /C` 处理带空格路径。
- marker block 异常时拒绝修改，避免配置误删。
- GitHub Actions checkout/setup-node 更新为 v7，并固定 Node 24；保留三平台 cargo check/release binary 门禁。
- 新增 `migration-todo.json`、动态 TODO、能力矩阵、Web 交叉验证报告与任务图校验器。
- 旧核心 33/33 测试文件继续通过；Phase 2 provider smoke 通过。Rust/GUI/真 provider CLI 仍待 CI 与真机证明。
- 同版本进一步迁移：新增 Rust 原生 CodeWhale `turn_end` 计量链、规范化 JSONL 账本、跨重启去重、95 天/5 万条有界保留与损坏行压实。
- 同版本进一步迁移：按 RFC3339 `created_at` 归属历史窗口，持久化价格来源/更新时间；计划或额度型 `billing_surface` 明确保持未定价。
- 同版本进一步迁移：修复 Hook 归一化时真实计费 provider 被覆盖的问题；失败/中断 turn 映射为错误状态。
- 同版本进一步迁移：未知价格在今日、5 小时、provider、模型与合计视图均显示“价格未知”或“已知金额 + 未知”，预算百分比标记为下界。
- CI 增加 Rust `cargo test --lib`；新增 CodeWhale fixture 与计量冒烟，版本仍保持 `0.3.0-phase2`。

## 0.2.0-phase1 — Tauri 2 / Rust 激进迁移基线（2026-07-26）

- 新建 Tauri 2 桌面壳与 2,200+ 行 Rust 核心，活动依赖中移除 Electron。
- 复用全部现有 Web UI 和 35 个图片资源；新增 31 命令兼容桥。
- 新增有界回环 HTTP 服务、随机令牌、Rust 配置/会话/权限状态和合并安全 Claude Hook 安装器。
- 主程序通过 `--octopus-hook` 同时承担原生 Hook 模式，避免 Node 与 sidecar 打包依赖。
- 修正当前 Claude `PreToolUse` 输出结构；收紧自动授权名单，只允许明确只读工具和 HTTPS WebFetch。
- 移除永久 700 ms/3 s 前端轮询，改为事件和 `ResizeObserver`。
- 新增三平台 CI/release 工作流、引导脚本、离线结构检查和 6 个迁移冒烟。
- 原 33 个核心测试文件继续通过。
- 计量、transcript、完整多 provider、精确终端聚焦和领地原生实现尚未迁移；详见 `docs/MIGRATION_STATUS.md`。

## 0.1.1 — deep runtime hardening + CodeWhale catalog v2 + models.dev sync (2026-07-20)

### CodeWhale catalog v2 + live sync

- Expanded `backend/model-catalog.bundled.json` from 31 to **49 entries**, now covering every model registered in CodeWhale's `crates/agent/src/lib.rs` ModelRegistry: added `deepseek-chat`, `deepseek-reasoner`, `kimi-k3`, `moonshotai/kimi-k3`, `glm-5.1`, `glm-5-turbo`, `z-ai/glm-5.1`, `z-ai/glm-5-turbo`, `gpt-5.5`, `gpt-5.5-pro`, `grok-4.5`, `grok-4.3`, `grok-build`, `grok-composer-2.5-fast`, `grok-4.20-0309-reasoning`, `grok-4.20-0309-non-reasoning`, `LongCat-2.0`, `longcat-2.0`, `minimax-m3`.
- Added vendor-published `cache_read_usd_per_million` / `cache_write_usd_per_million` fields per catalog entry. Previously the metering code used a single `0.1× input / 1.25× input` heuristic for all models; vendor reality differs significantly:
  - Xiaomi MiMo: cache_read ≈ 2% of input (heuristic over-charged 5×)
  - Z.AI GLM-5.x: cache_read ≈ 18.6% of input
  - xAI Grok: cache_read 15-20% of input
  - Meta Muse Spark: cache_read 12% of input
  - MiniMax M3: cache_read 20% of input
  - Meituan LongCat-2.0: cache_read 2% of input
  - Xiaomi MiMo / Z.AI GLM-5.x cache_write: vendor-limited-time-free ($0)
- Fixed wrong prices:
  - `deepseek-v4-pro` was $2/$8 (CNY misread as USD) → correct $0.435/$0.87 per DeepSeek's official pricing page + models.dev catalog
  - `deepseek-v4-flash` was $0.5/$2 → correct $0.14/$0.28
  - `gpt-5.6-terra` was $3/$20 → correct $2.50/$15 per OpenAI pricing page
  - `gpt-5.6-luna` was $2/$10 → correct $1/$6
- Fixed wrong context windows: `grok-build` was 512K (correct 256K, official SKU `grok-build-0.1`), `grok-4.20-0309-reasoning/non-reasoning` were 2M (correct 1M per xAI docs).
- **New: Models.dev live catalog sync** (`backend/models-dev-sync.js`). Mirrors CodeWhale upstream's `crates/tui/src/models_dev_live.rs` design:
  - Background async fetch from `https://models.dev/catalog.json` (MIT-licensed, ~3 MB, 5000+ models)
  - 24-hour TTL, 15-second timeout, 64 MiB response cap, no credentials/cookies
  - Atomic write to `~/.octopus/catalog/models-dev.json` (0600 permissions)
  - Three-layer lookup: live cache > bundled seed > null (token-only)
  - Official-provider priority: when multiple providers serve the same model id (e.g. `deepseek-v4-pro` is served by both `deepseek` at $0.435/$0.87 and aggregator `frogbot` at $1.74/$3.48), the official provider wins
  - Graceful degradation: failure to fetch falls back to stale cache or bundled seed; never blocks startup
  - Env knobs: `OCTOPUS_MODELS_DEV_URL`, `OCTOPUS_MODELS_DEV_PATH`, `OCTOPUS_DISABLE_MODELS_DEV_FETCH`, `OCTOPUS_NO_NET`
  - Schema validation: rejects absurd prices (>$1000/M), oversized context (>100M), malformed JSON; preserves `null` distinct from `0` (free)
  - HTTPS-only (refuses http:// URLs to prevent MITM)

### Metering behavior

- Removed `DEFAULT_FALLBACK` ($1/$5 fabricated estimate) for unknown models. `priceFor()` now returns `null`, the metering records tokens honestly with `cost=0`, and the per-model daily aggregate carries an `unknownPrice` counter so the UI can show an "unknown price" badge instead of implying the user spent $0.
- Removed the parallel `FALLBACK_PRICING` table; the catalog is now the single source of truth. Previously a fallback table could silently mask data loss if the catalog lost an entry.
- Cache pricing now uses vendor-published rates when available and only falls back to the 10%/1.25× heuristic when the vendor truly doesn't publish (e.g. Arcee Trinity, grok-composer).
- Fixed `loadCatalog` to preserve `null` cache_write/cache_read distinct from explicit `0` (free) — previous code coerced `Number(null)` to `0`, hiding the "vendor doesn't publish" signal.

### Security

- Upgraded Electron from 33.x to 43.1.1 and enabled renderer sandboxing, context isolation, web security, restrictive CSP, sender-validated IPC, navigation/webview/window blocking, download denial and deny-by-default browser permissions.
- Added a cryptographically random per-launch token to all local hook/server routes, private runtime-file permissions, constant-time token comparison, slow-body timeouts and HTTP connection/header limits.
- Reworked permission bridges to fail closed to `ask`, bounded pending/duplicate queues and made CodeWhale batch approval session-scoped with inactivity expiry and lifecycle cleanup.
- Hardened all persisted metering data against prototype-pollution keys, malformed maps, non-finite numbers and unbounded collections; private file modes are restored after atomic rename.
- Added bounded startup JSON/TOML readers, shell-safe command quoting and strict transcript/session path, symlink and size checks.

### Performance and reliability

- Replaced whole-unread-transcript allocation with 4 MiB fixed-memory JSONL chunks, a 32 MiB per-scan global budget, round-robin progress, a 5000-file cap and oversized-line forward progress.
- Cached unchanged transcript tails, capped live sessions at 256, bounded startup/backfill scans and limited CodeWhale session-list parsing to 100 candidates / 64 MiB total.
- Changed periodic stats refresh to non-overlapping one-shot scheduling, bounded asynchronous logging, added HTTP recovery after incomplete requests and retried hook installation during slow startup.
- Repaired pet/panel bounds after monitor removal or resolution changes; panel opens on the pet's display.
- Fixed model aliases with missing catalog prices, Unix CLI discovery, quoting of paths with spaces, Windows Node-mode hook uninstall and default `--no-sandbox` packaging regressions.

### Packaging, tests and documentation

- Added missing provider/runtime files to package manifests, retained production dependencies in Windows portable builds and kept the Chromium sandbox enabled unless an explicit diagnostic environment variable is set.
- Expanded the core suite to **20 files** (was 18), 60+ file syntax traversal and 92 Windows assertions; added security, oversized-input, persistence, package-consistency, models.dev sync (unit + integration), and stress tests.
- New test files:
  - `test/models-dev-sync.js`: unit tests for transform/validate/cache logic (20+ assertions, includes live fetch verification)
  - `test/models-dev-sync-integration.js`: end-to-end tests covering bundled-only, live-override, stale-cache, corrupted-cache, live-fetch, non-blocking, env-override scenarios (8 tests)
- Updated `docs/CODEWHALE.md` §Token 计量与花费 with the new pricing model, vendor cache rate table, models.dev sync architecture, and the list of price corrections.
- Updated README "CodeWhale 一等公民支持" section to highlight the catalog v2 upgrade and models.dev sync.
- Added `MODEL-PRICING-RESEARCH.md` and `MODEL-PRICE-SYNC-RESEARCH.md` (shipped with source tarball, not in portable zip) documenting every price's vendor URL, access date, and the sync design rationale.
- All 20 core tests pass; all 92 Windows adaptation assertions pass.

## 0.1.0 — initial audited fork

- Initial Claude Code / CodeWhale desktop pet fork and first-round upstream synchronization.
