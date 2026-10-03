# Upstream reconciliation and Tauri migration review — 2026-07-28

## Scope

This review compares four source trees rather than treating one repository as universally authoritative:

| Source | Observed revision | Runtime | Best used as |
|---|---|---|---|
| `myunwang/LLMPET` | `49fef749364b31dfa2ddab857aed7d82d49460cc` (`v1.1.1-8-g49fef74`, 107 commits) | Electron + Node | Current product behavior, three-language copy, skins, meme actions and media |
| `purrfecto114-lgtm/LLMPET` | `b424675b80162121e58cab631088604d10716b63` (`v0.1.2-pre-5-gb424675`, 99 commits) | Electron + Node | Five-provider protocol work, hook hardening, Windows/cross-platform lessons |
| Original `RE-LLMPET-v0.5.5` archive | archive supplied for this review | Tauri 2 + Rust | Existing migration baseline |
| Reworked tree | `0.5.5` | Tauri 2 + Rust | Final runtime and security boundary |

The original Tauri archive and the separately supplied `RE-LLMPET-v0.5.5` archive were byte-identical. The reworked tree was therefore based on one canonical Tauri baseline.

## Reconciliation principle

The migration uses three truth sources:

1. **Official upstream for user-visible behavior.** Its latest interface copy, language model and visual assets are preferred where they do not conflict with the broader provider contract.
2. **The early fork for provider and security semantics.** Its five-provider work is used as design evidence, not copied as an Electron runtime dependency.
3. **The Tauri branch for execution.** Electron main-process, preload, Node child-process and IPC implementations are never mechanically merged. Their observable protocol is re-expressed as scoped Tauri commands and Rust-owned state.

This avoids two opposite failure modes: freezing an old UI merely because it already runs on Tauri, or reintroducing Electron/Node assumptions merely because official upstream is newer.

## Adopted, adapted, deferred and rejected

### Adopted byte-for-byte

- Official `shared/i18n.js`.
- Two official meme GIFs and two MP3 files.
- The official full meme catalog, stored under `resources/memes/catalog.json` instead of the renderer tree.
- Official cat-skin attribution file at `frontend/assets/cat/CREDITS.md`.

Hashes and source paths are recorded in `reports/upstream-import-provenance.json` and `docs/MEME_ASSET_PROVENANCE.md`.

### Adapted for Tauri

- Language selection is persisted through a Rust command and applied to the pet and panel renderers.
- The full meme catalog remains outside `frontendDist`; a deterministic generator emits only presentation-safe fields to `frontend/shared/memes.js`.
- Meme GIF/audio can be previewed locally with translated labels and reaction state, but no renderer-side prompt body is exposed.
- Provider launch actions use one fixed five-provider allowlist shared by the UI and Rust command layer.
- User-interaction state and pet visual bounds now cross the bridge into native state instead of being accepted and discarded.

### Deferred deliberately

- Full upstream meme prompt dispatch. This requires backend-only prompt ownership, exact provider/session targeting, cancellation semantics and auditable delivery acknowledgements. The present UI explicitly says it is a local preview and does not pretend that a prompt was sent.
- Fully dynamic tray translation. Core pet and panel flows are translated; the native tray remains partially Chinese.
- True native “territory” collision behavior and mixed-DPI proof. Bounds and busy state now exist, but real desktop validation is still required.

### Rejected

- Renderer-supplied executable names or shell fragments.
- Direct copies of Electron `BrowserWindow`, preload, IPC, `shell.openPath`, Node child-process or hook-server code.
- Shipping complete meme prompt/instruction bodies in the WebView bundle.
- Claiming provider actions succeeded when the dispatcher is absent.

## Bugs and risks fixed

### Provider launch correctness

The session-list “new provider” action displayed the active provider but launched Claude for Codex, OpenCode and Aider. It now calls one `launchAgent(provider)` path for all five providers, and the Rust layer rejects unknown provider identifiers.

### Command and process safety

- Provider startup is mapped through a fixed allowlist, and mixed-provider session/cost views retain distinct identities for all five providers.
- Windows path opening now invokes `explorer.exe` with an argument rather than interpolating through `cmd.exe /C start`.
- A PowerShell focus helper now uses script scope correctly.
- Renderer-fed visual bounds are finite and bounded before storage.
- Renderer/native diagnostic messages are length-bounded and flattened to one physical log line.

### Native interaction state

`ui_busy` and `pet_visual_bounds` were protocol-shaped no-ops. They now update `PlatformState`; territory work can defer while the user is interacting, and native code has validated visual bounds available for future collision logic.

### Windows atomic-write recovery

Two Windows replacement paths deleted the destination before renaming the temporary file. A rename failure could therefore destroy user hook configuration or runtime metadata. Both paths now use backup, replacement and rollback semantics.

### Renderer data minimization

The official meme catalog contains operational prompt/instruction text. It remains an exact backend resource, while the generated renderer manifest contains only IDs, localized display copy, duration, media paths and reaction states. Generator validation rejects unsafe paths, malformed localized copy and schema drift.

## Visual preservation

- The renderer contains 39 gated asset files after reconciliation (38 image/audio/icon files plus the cat attribution document).
- Imported GIF and MP3 files are byte-identical to official upstream; no transcoding, recompression or frame alteration was performed.
- The visual baseline gate rejects changed, removed or silently added image/media files unless explicitly updated.
- Existing three skins and their layout remain intact; meme selection now reuses the session HUD as a second page instead of replacing the pet renderer or introducing a disconnected visual surface.

## Follow-up migration: drag recovery, terminal policy and UI parity

### Transparent input deadlock

The previous renderer enabled cursor-event ignoring at startup and expected later `mousemove` events to turn it off when the pointer returned to the pet. That matches Electron only when `setIgnoreMouseEvents(..., { forward: true })` is available. Tauri's API exposes a strict ignore boolean, so an ignored WebView cannot receive the event required to recover itself.

The rewrite keeps transparent click-through but moves recovery authority into `PlatformState`: a single native loop reads desktop cursor position, window origin and scale factor, compares them with finite renderer-reported interactive bounds, and applies cursor ignoring only outside that region. Missing or invalid inputs fail open so the pet never becomes permanently inert.

The click/drag gesture remains renderer-owned because the product uses a short click to open the session HUD and movement to drag. Native title-bar dragging was not substituted. Move requests are serialized and limited to animation frames; `set_win_pos` is move-only, while `commit_win_pos` persists the actual final native window position once.

### Windows Terminal first

Provider launch on Windows now attempts `wt.exe -w -1 new-tab --title Octopus <allowlisted executable>`, passing the selected provider executable directly to Windows Terminal. If spawning Windows Terminal fails, it starts `cmd.exe /D /K <allowlisted executable>` directly. The legacy `cmd /C start` wrapper is removed, and the executable remains selected from the Rust provider allowlist.

### Continued visual migration

- The question/permission card now uses a bounded scrolling body and fixed footer toolbar, matching the current upstream hierarchy more closely without replacing the existing state renderer.
- The active provider is represented by a compact per-provider identity tag adapted from upstream multi-agent presentation.
- Meme selection is no longer a visually unrelated standalone card; it is a second page within the session HUD with the same title/back/scroll structure. The local preview uses the upstream skin-aware side-media placement rather than a full-width replacement card.
- Popup and meme-window sizes are expressed in logical CSS pixels, converted once in Rust, bottom-centre anchored and clamped to monitor work area. Frontend resize invokes are serialized to prevent stale asynchronous sizes from winning.
- Cat-state GIFs are preloaded during idle time to reduce visible blank frames. Original image/audio bytes remain untouched.

Web references used for the design review:

- Tauri WebviewWindow `setIgnoreCursorEvents` and `startDragging` API documentation.
- Tauri feature request documenting the absence of Electron-style event forwarding.
- Microsoft Windows Terminal command-line documentation for `wt.exe`, `-w -1`, `new-tab` and executable arguments.

## Validation performed

| Check | Result |
|---|---|
| `npm test` | Passed, including bridge, capability, provider, protocol, Windows, HTTP, supply-chain, reconciliation and drag/terminal regression tests |
| `npm run gate:assets` | Passed; all 39 gated asset files match the pinned baseline |
| `npm run gate:memes` | Passed; public manifest is deterministic and contains no full prompt fields |
| `npm run gate:source` | Passed; release/source gate reported no blocked or failed source checks |
| JavaScript syntax traversal | Passed |
| Imported asset hash comparison | Passed byte-for-byte |
| Rust/Tauri compilation | Not run in this environment: `cargo`, `rustc` and `rustfmt` are unavailable and package/GitHub DNS resolution is blocked |
| Real provider CLI and GUI tests | Not run; require installed providers and desktop machines |

Static and contract tests materially reduce migration risk, but they are not substitutes for native compilation or real-machine behavior.

Audit artifacts:

- `reports/reconciliation-validation.json` records the final command outcomes and environment limitations.
- `reports/reconciliation-file-diff.json` and `.txt` enumerate every added/modified/removed file relative to the supplied Tauri baseline.
- `reports/upstream-import-provenance.json` pins exact upstream hashes.

## Web cross-validation conclusions

The design was checked against current Tauri 2 documentation and the public upstream repositories:

- Tauri capabilities scope which windows/webviews may invoke commands, but unsafe Rust commands or overly broad scopes remain application responsibilities. The fixed provider mapping and Rust-side validation are therefore necessary even with split `pet`/`panel` capabilities.
- Tauri-managed state is the appropriate home for cross-command interaction state such as busy status and validated pet bounds.
- Official upstream currently presents Claude/Codex product behavior, three languages and meme actions; the early fork contains broader five-provider work. The migration must preserve the latter without falsely claiming complete parity with the former.

References:

- https://github.com/myunwang/LLMPET
- https://github.com/purrfecto114-lgtm/LLMPET
- https://v2.tauri.app/security/capabilities/
- https://v2.tauri.app/develop/state-management/

## Remaining release-critical work

1. Run `cargo fmt --check`, `cargo check --all-targets --locked`, Rust tests and release builds on Linux, Windows and macOS.
2. Exercise all five real provider CLIs in isolated homes and verify install/uninstall rollback.
3. Run desktop interaction tests for tray behavior, drag/resize, mixed DPI, suspend/resume, monitor removal and terminal focus.
4. Implement full meme dispatch only behind a backend-owned, session-explicit API that never exposes instruction bodies to the renderer.
5. Complete native tray language refresh and prove territory behavior on real desktops.
6. Produce signed/notarized bundles, checksums, SBOM and updater verification before a public release.
