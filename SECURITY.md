# Security model

## Trust boundaries

- Hook traffic is accepted only on loopback and requires the runtime token.
- Request sizes, headers, connection counts, and waits are bounded.
- Permission payload metadata is persisted without raw tool input.
- Provider contracts are not treated as interchangeable: Claude-only `updatedInput` / `updatedPermissions` are never inserted into Codex responses.
- Tauri custom commands are generated into the application ACL and split between the `pet` and `panel` window capabilities; a compromised panel cannot invoke pet-only approval, launch, log-open or quit commands.
- OpenCode and Aider keep permission decisions in their native interaction path.
- Hook installers merge only Octopus-owned entries and refuse malformed ownership markers.

## Permission fail-safe behavior

Read-only operations may be auto-approved only through the explicit allowlist. Interactive requests time out conservatively. App shutdown resolves pending requests as deny. Parallel requests remain distinct unless provider, session, tool, and normalized input are identical, in which case retry connections share one decision.

## Release security

A production tag release requires a committed Cargo lockfile, locked/offline Rust build after dependency fetch, Tauri updater signing, Windows code signing, macOS signing and notarization, checksums, SPDX SBOM, and artifact attestations. Missing credentials are a hard failure for tag releases. Manual workflow runs may build unsigned artifacts only as isolated GitHub draft releases; they must never become public releases without a separate signed tag run.

Report vulnerabilities privately to the repository maintainers. Do not include secrets, raw prompts, or private transcripts in reports.
