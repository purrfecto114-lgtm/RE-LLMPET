# CodeWhale adapter

The active implementation is in `src-tauri/src/hook_install.rs`, `src-tauri/src/hook_client.rs`, `src-tauri/src/http_server.rs`, and `src-tauri/src/model.rs`.

- Configuration is merged into CodeWhale TOML without replacing foreign user hooks.
- `tool_call_before` is foreground and returns explicit `allow`, `deny`, or `ask` semantics.
- Session and tool-scoped temporary allow rules are local runtime rules and expire after 30 minutes.
- `turn_end.usage` is ingested into the provider-neutral ledger.
- Full Access or other native bypass modes must be shown honestly; the desktop app cannot claim an approval prompt occurred when the CLI bypassed it.

Run `npm run gate:provider` on an isolated self-hosted runner with the exact CodeWhale CLI version recorded in evidence.
