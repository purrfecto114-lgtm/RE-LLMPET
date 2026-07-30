# CodeWhale adapter

The active implementation is in `src-tauri/src/hook_install.rs`, `src-tauri/src/hook_client.rs`, `src-tauri/src/http_server.rs`, and `src-tauri/src/model.rs`.

- Configuration is merged into CodeWhale TOML without replacing foreign user hooks.
- `tool_call_before` is foreground and returns explicit `allow`, `deny`, or `ask` semantics.
- Session and tool-scoped temporary allow rules are local runtime rules and expire after 30 minutes.
- `turn_end.usage` is ingested into the provider-neutral ledger.
- Full Access or other native bypass modes must be shown honestly; the desktop app cannot claim an approval prompt occurred when the CLI bypassed it.

Run `npm run gate:provider` on an isolated self-hosted runner with the exact CodeWhale CLI version recorded in evidence.

## CLI internal error diagnostics

The Rust command `diagnose_agent("codewhale", cwd)` resolves the dispatcher and matched `codewhale-tui` companion, compares versions, runs `codewhale-tui doctor --json` **first** with bounded output/timeout, and reports the inherited PATH, working directory, resolved config path and Windows terminal availability. The companion is probed first because current CodeWhale documentation defines `doctor` as a TUI subcommand; the dispatcher compatibility alias is used only as a fallback when the companion explicitly rejects `doctor` (unknown subcommand, unexpected argument, or non-zero exit without JSON). Both attempts remain visible in the `doctorAttempts` audit trail.

**R10 (2026-07-30) decision record**: see [`docs/MIGRATION_R10_CODEWHALE_DOCTOR_ORDER_2026-07-30.md`](MIGRATION_R10_CODEWHALE_DOCTOR_ORDER_2026-07-30.md). Web cross-validation found that CodeWhale's own `docs/RUNTIME_API.md` labels `codewhale doctor --json` the canonical Capability endpoint suitable for health-check polling; the companion-first ordering is kept here because (a) project-internal docs/tests/impl consistency is the maintenance hazard being fixed, (b) on any matched bundle the companion is guaranteed to exist (we already enforce `MISSING_COMPANION_BINARY`), so the companion probe cannot regress on healthy installs. If CodeWhale ever drops `codewhale-tui doctor`, the dispatcher fallback keeps diagnostics working and the decision record tells the next maintainer to flip the order. Cross-source consistency is locked by `test/tauri-codewhale-doctor-consistency-r10-smoke.js`.

Configuration discovery is shared by diagnostics, Hook installation, and the Windows evidence script: `CODEWHALE_CONFIG_PATH` → legacy `DEEPSEEK_CONFIG_PATH` → `CODEWHALE_HOME/config.toml` → existing `~/.codewhale/config.toml` → existing legacy `~/.deepseek/config.toml` → new CodeWhale path. Diagnostics never return the file contents. They only report bounded metadata and compatibility flags for retired direct-DeepSeek model IDs or the rejected legacy `insecure_skip_tls_verify=true` setting.

On an affected Windows machine, run from the repository that CodeWhale should open:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows-cli-diagnostics.ps1 -WorkingDirectory 'D:\path\to\repository'
```

A successful Terminal process creation is not proof that the provider session is healthy. Treat missing companion, version mismatch, doctor failure, authentication/provider errors and cwd errors separately. Do not paste API keys into public issue reports.
