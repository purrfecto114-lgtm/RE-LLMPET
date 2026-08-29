# Windows development notes

Install Rust stable, Node.js 24, Microsoft C++ Build Tools, WebView2, Windows Terminal when available, and the Tauri 2 prerequisites. Then run `npm ci --ignore-scripts`, `npm test`, and `cargo tauri dev`.

## Agent terminal launch

Agent sessions prefer Windows Terminal through `wt.exe -w -1 new-tab`, passing the fixed provider executable directly as the new-tab command line. `cmd.exe` is not inserted on this path. If `wt.exe` cannot be spawned, the application falls back directly to `cmd.exe /D /K`; it does not interpolate renderer input through `cmd /C start`.

The provider identifier is resolved by a Rust allowlist before launch. Renderer-supplied executable paths or arbitrary shell fragments are not accepted.

## Transparent pet drag and click-through

The desktop pet intentionally ignores cursor events over transparent space. Tauri's cursor-ignore toggle is strict and does not provide Electron's mouse-event forwarding behavior, so the native layer periodically compares the desktop cursor with renderer-reported interactive bounds and restores input over the pet, menus and cards.

Dragging preserves the upstream compound gesture: a short primary-button press opens the session HUD, while movement beyond the threshold moves the window. Pointer moves are animation-frame throttled; the final position is written to configuration once at gesture end. Pointer-capture teardown is idempotent so `lostpointercapture` cannot duplicate a commit or short-click action.

Renderer measurements are CSS/logical pixels. Rust converts them using the current scale factor, preserves the old window bottom-centre anchor, clamps the resized window to the current monitor work area, and serializes frontend resize invokes so a stale popup request cannot win after a close/reset.

Windows release validation must cover:

- all three skins at 100%, 150% and 200% display scale;
- crossing monitors with different scale factors;
- transparent-area click-through and input restoration over every popup;
- rapid press-move-release, pointer cancellation and application focus changes;
- one final config write per completed drag, with no position corruption after forced shutdown.

## Focus and release

Terminal focus follows the provider session source PID through its parent process tree and then uses Win32 foreground-window APIs. Windows Terminal tab-level selection is not guaranteed; the supported boundary is the correct top-level terminal/application window.

Production NSIS bundles must be signed with the protected PFX credential used by `.github/workflows/release.yml`. Unsigned development bundles are not release evidence.
