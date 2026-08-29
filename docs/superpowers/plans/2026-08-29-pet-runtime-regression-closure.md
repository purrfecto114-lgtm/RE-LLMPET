# Pet Runtime Regression Closure Plan

**Goal:** remove provider misidentification, ghost sessions, sticky errors, radial-menu races, frame flashes, and input/DPI regressions without removing RE-LLMPET providers or its dual-pet/travel features.

## Acceptance matrix

| Area | Root cause to close | Acceptance evidence |
|---|---|---|
| Provider identity | non-Codex aggregate window was represented by a startup-time `claude` constant | label and wander target follow the most relevant live non-Codex session; no enabled provider is renamed Claude |
| Dual pet vs wander | display partition and action routing shared one static provider | dual pet remains a session partition; wander is a distinct action routed to the resolved provider |
| Right-click HUD | radial items were measured before the native resize transaction settled | opening requests HUD size first, then builds from the settled CSS viewport; context events are fully claimed |
| State animation | image was hidden before the next bitmap/GIF loaded | preload/decode then swap; the current frame stays visible on failure or slow decode |
| Session hygiene | child sessions and unstable fallback IDs entered the top-level session set | OpenCode child sessions are marked headless; tool hooks use canonical `sessionID`; visible rows are deduplicated defensively |
| Error arbitration | any historic error had infinite global priority | errors have a bounded visual lease; newer waiting/working sessions remain observable |
| Task expression | tool lookup was exact-case and provider-agnostic | OpenCode `task`/`Task`/agent delegation maps to summon; unknown tools degrade to work |
| Touch / DPI / performance | mouse-sized thresholds, repeated DOM rebuilds, and raster scaling | coarse-pointer drag threshold, keyed dot updates, vector/raster icon coverage and scale-change refresh |

## Execution order

1. Add focused failing Node tests for pure routing, state arbitration, session projection, image swap, radial open order, and OpenCode hook payloads.
2. Extract pure runtime policy from `pet.js`; keep the existing renderer contract and provider registry intact.
3. Update the OpenCode hook to retain parent identity and headless child status, with backwards-compatible field fallbacks.
4. Make menu opening a resize-then-measure transaction and harden pointer/context ownership.
5. Replace hide-before-load image swapping and full dot-list reconstruction.
6. Audit coarse-pointer CSS, drag thresholds, icon bundle sizes, and scale-factor refresh.
7. Run targeted tests, every runnable repository test, syntax/static checks, diff review, and package the verified tree.

## Guardrails

- Keep Claude, CodeWhale, Codex, OpenCode, Aider, DSH, and custom-provider paths.
- Keep both pet windows, travel ownership, territory, growth, legacy hook compatibility, and the dependency-free renderer.
- Unknown provider/tool/event shapes degrade to aggregate/work/idle behavior; they must not be relabeled as Claude.
- Do not infer a child session from its name or ID. Only explicit upstream parent metadata may hide it.
