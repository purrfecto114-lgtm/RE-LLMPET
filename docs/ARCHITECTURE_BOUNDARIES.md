# Octopus architecture boundaries

This document records the ownership rules for the desktop runtime. They are
small on purpose: new fixes should extend one owner rather than duplicate state
across renderer and native layers.

## Renderer / native boundary

- `frontend/renderer/tauri-bridge.js` is the only owner of global Tauri event
  subscriptions. It returns ordinary unsubscribe functions to feature code and
  disposes every native listener on WebView teardown, including subscriptions
  whose asynchronous registration finishes after teardown.
- Renderer feature files call named methods on `window.pet`; they do not expose
  or retain raw Tauri handles.
- State-changing calls that affect geometry, click-through or permission state
  use awaited IPC. Fire-and-forget calls are reserved for best-effort actions.

## Async state ownership

- `frontend/shared/latest-value-controller.js` owns coalescing, success-only
  acknowledgement and bounded retry for latest-value native state.
- `frontend/shared/config-write-controller.js` gives each persistent config key
  one writer, reports only current failures, and reloads authoritative native
  state without allowing a stale reload to overwrite a newer user change.
- `frontend/shared/panel-fit-controller.js` owns panel fit revisions, stale
  response suppression and resize attribution.
- `frontend/renderer/pet-travel-view.js` owns wander state, growth/status
  rendering and the wander/cancel transition; `pet.js` only forwards snapshots.
- Renderer files provide measurements and UI policy only. They must not rebuild
  these state machines with timestamps, promise chains or parallel caches.

## Window geometry ownership

- Rust commands own monitor selection, work-area clamping and logical/physical
  conversion. Opening centers on the pet's monitor; later content-fit calls
  preserve the panel's current center and monitor so renderer updates do not
  undo a user move.
- The renderer owns content measurement and animation presentation.
- `src-tauri/src/platform.rs` owns native cursor hit-testing and polling cadence;
  one active polling tick performs one cursor query and exits early while the
  pet is hidden or interaction state is idle.


## Diagnostic process ownership

- `src-tauri/src/diagnostic_control.rs` is the sole owner of provider, PID and
  cancellation transitions for the one supported diagnostic job.
- `src-tauri/src/diagnostic_io.rs` drains stdout and stderr to EOF while keeping
  only a bounded prefix. Do not use `Read::take` on a live child pipe: closing a
  full pipe early can turn a healthy CLI into a broken-pipe failure.
- Timeout- or cancellation-truncated output is diagnostic text only and must not
  be accepted as authoritative JSON capability data.

## Provider hook ownership

- Fresh provider installations use Octopus markers and names.
- Old RE-LLMPET markers are accepted only through explicit legacy marker arrays
  and compatibility cleanup functions. Do not use broad substring ownership
  checks: they can delete unrelated user hooks or fail to remove current hooks.
- Provider protocol parsing and installation-marker migration are separate
  concerns. A marker migration must not change the provider's documented stdin,
  environment or stdout decision contract.

## Compatibility identifiers

Some internal identifiers can remain historical while users migrate, including
legacy storage paths and the `re-llmpet:bridge-error` DOM event. They are
compatibility contracts, not product branding. New public names, installer
identity, hook ownership and log prefixes use Octopus.

## Change rule

Before adding a new flag, timer, listener or retry loop to `panel.js`, `pet.js`,
`commands.rs` or `hook_install.rs`, first decide whether it belongs to one of the
owners above. Prefer a pure module with focused tests when the behavior has more
than one state transition. Broad rewrites of the remaining large files require
native builds and Windows runtime evidence; file size alone is not a safe reason
to move code. `test/maintainability-boundary-smoke.js` therefore uses no-growth
budgets for the existing yellow-zone files and tighter budgets for extracted
controllers. The budgets are a tripwire against accretion, not a claim that the
large files are already well-factored.

## Release evidence and persistent-window lifecycle

- Updater artifacts are disabled at both the Tauri bundler and tauri-action
  input layers. Do not add matrix-wide post-upload deletion loops: they hide
  producer drift and can race against other jobs sharing the release tag.
- Manual draft tags remain isolated from `v<package version>` and are never
  reused as stable publication identities.
- Matrix jobs upload only to a private draft. Before publication,
  `scripts/verify-release-assets.js` reconciles every distributable asset with
  four platform checksum manifests and matching SPDX files, rejects basename
  collisions, and confirms the release is still both draft and prerelease.
- The panel is a persistent Tauri window. Feature and recovery paths request
  `close_panel` (hide); they do not call browser `window.close()` or destroy the
  WebView. Native close requests are intercepted in `lib.rs`, prevented, hidden,
  and translated to the same `panel:hidden` lifecycle event.
- Filesystem paths and provider/runtime strings enter the DOM through
  `textContent`, `createTextNode`, or an audited escaping helper. Recovery UI
  must not concatenate a path into `innerHTML`.
- `http_server::emit_stats_now` is the single immediate stats broadcast owner.
  Renderer commands delegate to it; throttle state lives only in
  `StatsCoalescerState`.
- `migration-todo.json` records repository-local evidence only. A static smoke
  result cannot be relabeled as a native Cargo, installer, or real-provider
  result without a retained run artifact and exact source revision.


## Reproducible evidence ownership

- `SOURCE_DATE_EPOCH` is the timestamp source for generated source manifests and SPDX creation metadata. Re-running either generator over identical inputs must be byte-identical.
- `SOURCE_REVISION` and `SOURCE_DATE_EPOCH` are part of the source-manifest digest set. Verification compares the manifest metadata with those files instead of trusting duplicated, unhashed labels.
- A provider permission fallback is allowed to narrow authority only. Unknown decisions and unexpected helper failures fail closed; `ask` is not a failure fallback where a provider's Full Access posture ignores approval prompts.
## Single-instance compatibility guard

- `instance_probe.rs` is the sole owner of the dependency-free compatibility guard. A public loopback `/state` response is diagnostic information, not process ownership proof. Only a valid private runtime token plus an authenticated `/activate` response may suppress a new launch.
- `http_server::ServerInfo` owns the runtime credential lease and removes `runtime.json` on clean shutdown only when app, port, PID and token still match. An older process must never delete a newer instance's credential.
- A bound compatibility port whose authenticated activation fails is treated as foreign/unproven rather than an existing Octopus instance. The official Tauri single-instance plugin remains the preferred future replacement once Cargo.lock can be updated and validated on all desktop targets.
- The authenticated HTTP server is the provider-hook control plane, not an optional enhancement. Startup fails closed if it cannot be created, and a failed accept-loop thread spawn revokes the runtime credential written just before it. Do not launch a UI that appears healthy while provider events are impossible.
- Do not add a second lock/state framework around this guard. Any replacement must delete the compatibility owner in the same change and retain authenticated activation for old installed hooks during migration.
