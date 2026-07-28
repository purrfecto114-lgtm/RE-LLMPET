# Windows development notes

Install Rust stable, Node.js 24, Microsoft C++ Build Tools, WebView2, and the Tauri 2 prerequisites. Then run `npm ci --ignore-scripts`, `npm test`, and `cargo tauri dev`.

Terminal focus follows the provider session source PID through its parent process tree and then uses Win32 foreground-window APIs. Windows Terminal tab-level selection is not guaranteed; the supported boundary is the correct top-level terminal/application window.

Production NSIS bundles must be signed with the protected PFX credential used by `.github/workflows/release.yml`. Unsigned development bundles are not release evidence.
