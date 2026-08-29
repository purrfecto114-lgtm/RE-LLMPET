# Drag, Windows Terminal and UI parity follow-up — 2026-07-28

Baseline: `02b58f8b0632962e2a9fe41950c95f3293a0f2da`

## Problem reproduced from source

The pet renderer enabled click-through on startup and expected a later WebView `mousemove` to restore input. Electron can support this pattern with forwarded mouse movement, but Tauri 2 exposes a strict cursor-ignore boolean. Once the full WebView ignored cursor events, it could no longer receive the event needed to recover itself. The visible pet therefore became inert and could not start a drag.

## Implemented drag architecture

- `PlatformState` owns a single native cursor-hit-test worker.
- The worker reads the desktop cursor, the pet window's physical origin and current scale factor, then compares them with finite renderer-reported logical bounds.
- Missing or invalid geometry fails open: the window remains interactive rather than entering an unrecoverable click-through state.
- Transparent space outside the interactive union can still ignore input even while a HUD is open.
- Renderer gestures preserve upstream behavior: short press opens the session HUD; movement beyond four CSS pixels starts manual movement.
- Pointer movement is animation-frame throttled and Tauri invokes are serialized.
- `set_win_pos` only moves the native window. `commit_win_pos` writes and broadcasts the final native position once when the gesture ends.
- Pointer-capture teardown clears gesture ownership before releasing capture, preventing `lostpointercapture` from duplicating a commit or short-click action.

Native title-bar dragging was intentionally not substituted because this UI needs to distinguish a short click from movement and retain the WebView completion event.

## DPI and window geometry

Renderer popup measurements remain CSS/logical pixels. Rust converts them once with the current window scale factor, resizes in physical pixels, preserves the old bottom-centre anchor and clamps the resulting rectangle to the current monitor work area. The frontend serializes resize invokes so a stale open-popup request cannot arrive after a close/reset and leave the pet at the wrong size.

The meme preview now follows the current upstream's skin-aware side-media layout. It measures the active pet DOM rectangle, respects each meme's preferred side, flips when space is insufficient, keeps caption/status inside the viewport, and retains imported GIF/MP3 bytes unchanged.

## Windows launch policy

For the five fixed provider identifiers, Windows now attempts:

```text
wt.exe -w -1 new-tab --title Octopus <allow-listed-provider-executable>
```

The provider executable is passed directly to Windows Terminal. `cmd.exe` is not inserted on this path. Only when `wt.exe` cannot be spawned does the application use:

```text
cmd.exe /D /K <allow-listed-provider-executable>
```

No renderer-provided executable path or shell fragment is accepted, and the legacy `cmd /C start` wrapper remains removed.

## UI parity carried forward

- Current upstream popup width and bounded ask-body hierarchy.
- Fixed ask action toolbar.
- Five-provider identity treatment rather than Claude-only icon reuse.
- Session HUD second page for meme selection.
- Skin-aware side-media meme presentation.
- Three-language core pet/panel copy.
- Idle-time cat GIF preload.
- Original images, GIFs and audio retained byte-for-byte.

Full meme prompt delivery remains deliberately deferred. The WebView receives only a generated presentation-safe catalog and labels the feature as local preview.

## Verification

- `npm test`: passed.
- `npm run gate:assets`: passed, 39 byte-identical assets.
- `npm run gate:memes`: passed, two public entries and no full prompt fields.
- `npm run gate:source`: passed, 16/16 source gates.
- `npm run test:protocol`: passed.
- JavaScript syntax traversal: 40 files passed.
- CSS parse: zero parse errors.
- Pet HTML: 61 unique IDs, zero duplicates; 59 JavaScript ID references, zero missing.
- Local HTML resources: zero missing.
- Markdown local links: 18 checked, zero missing.

Native Rust/Tauri compilation and real Windows/WebView2 interaction remain unverified in this environment because `cargo`, `rustc` and `rustfmt` are unavailable and package/GitHub hosts cannot be resolved. Required real-machine tests include Windows 100/125/150/200% scale, mixed-DPI monitor crossing, fast pointer cancellation, transparent click-through, Terminal absence fallback and all three skins.

## Web cross-checks

- Tauri Window API (`setIgnoreCursorEvents`, `startDragging`): https://v2.tauri.app/zh-cn/reference/javascript/api/namespacewindow/
- Tauri Monitor API (`work_area`, `scale_factor`): https://docs.rs/tauri/latest/tauri/window/struct.Monitor.html
- Windows Terminal command line (`wt.exe`, `-w -1`, `new-tab`, executable command line): https://learn.microsoft.com/windows/terminal/command-line-arguments
- Tauri forward-option feature request: https://github.com/tauri-apps/tauri/issues/6164
- Tauri drag/mouseup behavior report: https://github.com/tauri-apps/tauri/issues/11945
