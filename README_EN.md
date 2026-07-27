# LLMPET / Octopus Tauri

`0.5.0-phase4` is a Tauri 2 / Rust migration candidate derived from the LLMPET fork. The source tree contains only the active Tauri frontend, Rust core, resources, tests, and release gates. The former Electron/Node runtime has been removed completely.

It includes provider-specific adapters for Claude Code, CodeWhale, Codex, OpenCode, and Aider; structured Claude interactions; parallel permission-card preservation; metering; terminal focus by source PID ancestry; and display/suspend recovery.

Run the offline source checks with `npm ci --ignore-scripts && npm test`. A real generated `src-tauri/Cargo.lock`, three-platform Rust builds, real-provider CLI tests, desktop tests, performance evidence, and signed/notarized packages are still required before release.
