# RE-LLMPET Architecture & Hardcoded Agent Assumptions Inventory

**Generated:** 2026-08-29 | **Scope:** `src-tauri/src/*.rs`, `frontend/**/*.js`, `resources/`, `protocol-baseline.json`, `test/*.js`

---

## 1. Architecture Overview (Data Flow)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            AGENT CLIs (5 providers)                         │
│  claude | codewhale | codex | opencode | aider                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  hook_client.rs (octopus-hook binary) — stdin → TCP loopback (port 41330-41334)│
│  - normalize_provider_body() per provider                                   │
│  - permission_fallback() differs per provider                               │
│  - run_pretool() Claude-specific logic                                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  http_server.rs — token-authenticated loopback HTTP server                  │
│  - /state (observer), /permission (blocking), /codewhale-permission         │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼ Tauri events (pet:stats, pet:event, panel:stats)
┌─────────────────────────────────────────────────────────────────────────────┐
│  model.rs (AppState, Runtime, Sessions, UsageLedger, TranscriptScanner)    │
│  - AppConfig: providers: Vec<String> (hardcoded allowlist in sanitize())    │
│  - ProviderStatus: hardcoded capabilities per provider                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
            ┌──────────┐      ┌──────────────┐  ┌────────────┐
            │ metering │      │ hook_install │  │ commands.rs│
            │ .rs      │      │ .rs          │  │ (50 IPC)   │
            └──────────┘      └──────────────┘  └────────────┘
                    │                 │                 │
                    ▼                 ▼                 ▼
            ┌─────────────────────────────────────────────────────┐
            │  frontend/ (pet.js, panel.js, native JS, no bundler) │
            │  - tauri-bridge.js: hardcoded launchClaude/Codex... │
            │  - pet-agent-view.js: 'claude'/'codex' bucket logic │
            │  - panel.js: PCOST_META, PROVIDER_META hardcoded    │
            └─────────────────────────────────────────────────────┘
```

---

## 2. Hardcoded Agent/Provider Assumptions — By File

### 2.1 Rust Backend (`src-tauri/src/`)

| File | Line(s) | Hardcoded Assumption | Type |
|------|---------|---------------------|------|
| **commands.rs** | 16-20 | `pet_label_for_agent()` — only `"codex"` gets `"pet-codex"`, else `"pet"` | Window label enum |
| | 305 | `all_providers = ["claude","codewhale","codex","opencode","aider"]` | Closed enum |
| | 1110-1143 | `agent_spec()` — match on 5 literal provider IDs, fixed `command`, `companion` | Spec table |
| | 1187-1285 | CodeWhale executable search: hardcoded `"Programs/CodeWhale/bin"`, `.exe` suffixes | Path resolution |
| | 1319-1322 | `codewhale` vs `codewhale-tui` v0.9.5+ forward-compat logic | Version logic |
| | 1564 | Comment references `docs/CODEWHALE.md`, `docs/RUNTIME_API.md` | Doc coupling |
| | 1761-1875 | `codewhale_doctor_probe()` — companion-first dispatcher fallback | Diagnostic logic |
| | 1894-1973 | `codewhale_config_candidates()`, `codewhale_config_compatibility()` | Config discovery |
| | 2031-2070 | `aider_configuration_summary()` — `.aider.conf.yml` path, credential env vars | Config/cred paths |
| **hook_install.rs** | 70-98 | `CLAUDE_EVENTS: [&str; 23]` — fixed event array | Event enum |
| | 99-111 | `CODEX_EVENTS: [&str; 11]` | Event enum |
| | 128-139 | `CODEWHALE_EVENTS: [&str; 10]` + v4 marker constants | Event enum + markers |
| | 140-152 | `CW_MARKERS`, `AIDER_MARKERS`, `OPENCODE_MARKER` (v3 + legacy v1/v2) | Marker strings |
| | 277-286 | `provider_config_path()` — match on 5 IDs → hardcoded paths | Config paths |
| | 304 | `sync_enabled()` loop: `for id in ["claude","codewhale","codex","opencode","aider"]` | Closed enum |
| | 383, 402 | `verify_enabled()` same hardcoded array | Closed enum |
| | 438-452 | `install_provider()` match on 5 IDs | Dispatch table |
| | 517-541 | `hook_presence()` — per-provider marker detection logic | Detection logic |
| | 578-628 | `cleanup_provider()` match on 5 IDs | Cleanup dispatch |
| | 853-877 | `provider_capabilities()` — hardcoded permission_mode + JSON capabilities per provider | Capability table |
| | 880-923 | `install_claude()` — `~/.claude/settings.json`, `CLAUDE_EVENTS` | Install logic |
| | 925-971 | `install_codewhale()` — TOML config, `CODEWHALE_EVENTS`, `CW_MARKERS` | Install logic |
| | 1120-1145 | `install_codex()` — `~/.codex/hooks.json`, `CODEX_EVENTS` | Install logic |
| | 1147-1209 | `install_opencode()` — `~/.config/opencode/plugins/llmpet-hook.js` | Install logic |
| | 1240-1278 | `install_aider()` — `~/.aider.conf.yml`, YAML markers | Install logic |
| | 1284-1302 | `codewhale_config_path()` — env var precedence chain | Path resolution |
| | 1304-1353 | `hook_command()` — per-provider command formatting (Windows `cmd /C` vs bare) | Command format |
| **hook_client.rs** | 44 | `provider` default = `"claude"` | Default provider |
| | 49-50 | `force_permission` logic: `"codewhale" && "tool_call_before"` | Provider-specific |
| | 56-67 | `codewhale_env_only` — stdin skip for 7 specific CodeWhale events | Stdin behavior |
| | 155-168 | `codewhale` + `PreToolUse` → session_id check | Permission logic |
| | 169-178 | `permission` path: `/codewhale-permission` vs `/permission` | Endpoint routing |
| | 295-324 | `normalize_provider_body()` — CodeWhale event mapping table (10 events) | Event normalization |
| | 325-337 | Aider: injects cwd, session_id, maps to `Stop` event | Event normalization |
| | 346-395 | `normalize_codewhale_turn_end()` — usage field mapping | Usage parsing |
| | 410-458 | `apply_codewhale_env_fallback()` — 14 env var pairs (`DEEPSEEK_*`/`CODEWHALE_*`) | Env var mapping |
| | 478-516 | `run_pretool()` — Claude `AskUserQuestion`/`ExitPlanMode` special handling | PreTool logic |
| **hook_watcher.rs** | 4-30 | **Claude-only** watcher for `~/.claude/settings.json` (CC-Switch) | Watcher scope |
| | 63, 95 | Hardcoded `home_dir().join(".claude").join("settings.json")` | Path |
| | 109 | Calls `install_claude()` directly | Re-install logic |
| **metering.rs** | 339-343 | `parse_hook()` — only processes `provider == "codewhale" && native_event == "turn_end"` | Ingest filter |
| | 358-360 | `record_claude_assistant()` — hardcoded provider `"claude"` | Ingest filter |
| | 579 | Default provider = `"claude"` | Default |
| | 613-616 | CodeWhale `billing_surface` token pricing check | Pricing logic |
| | 695-805 | `parse_claude_assistant()` — Anthropic transcript format, cache split logic | Transcript parsing |
| **model.rs** | 157-174 | `AppConfig::sanitize()` — `known = ["claude","codewhale","codex","opencode","aider"]` | Allowlist |
| | 317-325 | `ProviderStatus` struct — capabilities JSON from `provider_capabilities()` | Status shape |
| | 503 | `transcript_root = ~/.claude/projects` | Transcript path |
| | 671-697 | `config_view()` — hardcoded `all = ["claude","codewhale","codex","opencode","aider"]` | Config view |
| **codex_pricing.rs** | Entire file | Codex-specific pricing: `builtin_codex_models()`, `norm_codex_model_name()`, `price_for_codex()` | Pricing engine |
| **codex_rollout.rs** | 106-110 | `codex_home()` — `CODEX_HOME` env or `~/.codex` | Config path |
| | 113-260 | Rollout parsing: `sessions/` dir, `gpt-5.3-codex` fallback | Rollout logic |
| **diagnostic_control.rs** | 121-172 | Tests use hardcoded `"claude"`, `"codewhale"`, `"opencode"` | Test fixtures |

### 2.2 Frontend (`frontend/`)

| File | Line(s) | Hardcoded Assumption | Type |
|------|---------|---------------------|------|
| **tauri-bridge.js** | 27-43 | `defaultPetAgent()` — first non-codex provider, fallback `"claude"` | Default logic |
| | 45-55 | `currentPetAgent()` — URL `?agent=claude|codex`, window label `pet-codex` | Agent resolution |
| | 229-233 | `launchClaude`, `launchCodeWhale`, `launchCodex`, `launchOpenCode`, `launchAider` | Launch IPC |
| **pet-agent-view.js** | 14, 20-25 | `resolveAgentForPet()` — same query/window logic, fallback `"claude"` | Agent resolution |
| | 36-43 | `ownsSession()` — **duo mode: claude pet = ALL non-codex**, codex pet = ONLY codex | Session bucketing |
| | 89-122 | `renderSession()` — strips `codexUsage`/`codexLimits` for non-codex pet | View filtering |
| **panel.js** | 457-463 | `PCOST_META` — 5 providers with icon/label | Display metadata |
| | 807-813 | `PROVIDER_META` — duplicate of PCOST_META | Display metadata |
| | 185-230 | `combinedUsage.claudeTodayCost` / `codexTodayCost` split | Cost split |
| | 250-270 | `codexLimits` / `codexUsage` rendering blocks | Codex-specific UI |
| | 468-482 | `renderCodexUsage()` — Codex today/lifetime tokens | Codex UI |
| | 641-651 | `refreshSessionProviderOptions()` — dynamic but filters to known providers | Provider filter |
| **pet.js** | 56 | `attention` state comment: `CodeWhale turn_end / OpenCode idle` | State comment |
| | 212 | `slFilter = 'all' | 'claude' | 'codex' | ...` | Filter enum |
| | 264-271 | CodeWhale batch authorization IPC: `cw-permission-decide` | IPC naming |
| | 718 | Placeholder text: `打回让 Claude 改…` | UI string |
| | 973-978 | `PROVIDER_ICONS`, `PROVIDER_LABELS` — 5 providers | Display metadata |
| **i18n.js** | 22-43 | Tray keys: `tray.launchClaude`, `tray.launchCodex`, `tray.launchCodewhale`, `tray.launchOpencode`, `tray.launchAider` | I18n keys |
| | 160, 167, 192-194, 202-203, 225-226, 249, 268, 294-298, 367, 421 | Many i18n keys reference specific providers | I18n keys |
| **panel.html** | 54-76 | `#codex-wrap`, `#codex-usage` — hardcoded Codex sections | DOM structure |
| | 86 | `data-pet-mode="duo"` label: `双宠 · Claude + Codex` | UI label |
| **panel.css** | 154-158 | `.bar-fill.codex` — Codex-specific gradient | Styling |
| **pet.css** | 964-968 | `.agent-tag.provider-{claude,codex,codewhale,opencode,aider}` | Styling |

### 2.3 Resources & Protocol

| File | Hardcoded Assumption |
|------|---------------------|
| **protocol-baseline.json** | `localContracts.claudeEvents` (23), `codewhaleEvents` (10), `codexEvents` (11), `opencodeNeedles` (10), `aiderNeedles` (2) — frozen event sets |
| | `remoteContracts` — 5 provider doc URLs with required fields |
| | `cliVersionCommands` — 5 hardcoded `command --version` entries |
| **resources/model-catalog.bundled.json** | Model catalog includes provider-specific IDs (e.g., `anthropic/claude-*`, `openai/gpt-*`, `codex/*`) |

---

## 3. Classification: Intentional Built-in vs Accidental Closed Enums

| Category | Examples | Intentional? |
|----------|----------|--------------|
| **Built-in Adapters (Intentional)** | `hook_install.rs` per-provider `install_*()`, `hook_client.rs` `normalize_provider_body()`, `metering.rs` `parse_hook()`/`parse_claude_assistant()` | ✅ Yes — each provider has genuinely different config formats, hook protocols, event schemas |
| **Legacy Compatibility (Intentional)** | `LEGACY_MARKER`, `LEGACY_HOOK_OWNER`, `re-llmpet-hook` binary alias, `CW_LEGACY_MARKERS`, `OPENCODE_MARKER_LEGACY` | ✅ Yes — migration path for existing users |
| **Fixed Path/Name Matching (Accidental)** | `provider_config_path()`, `codewhale_config_path()`, `opencode_config_dir()`, `transcript_root = ~/.claude/projects` | ⚠️ Mixed — paths ARE provider-specific but could be registry-driven |
| **Closed Enum Iteration (Accidental)** | `for id in ["claude","codewhale","codex","opencode","aider"]` in 6+ locations | ❌ No — blocks extensibility |
| **Hardcoded Capabilities JSON (Accidental)** | `provider_capabilities()` returns fixed JSON per provider | ❌ No — should be declarative |
| **UI/Display Metadata Duplication (Accidental)** | `PCOST_META`, `PROVIDER_META`, `PROVIDER_ICONS`, `PROVIDER_LABELS`, i18n keys — 4+ copies | ❌ No — single source of truth needed |
| **Default Fallback to "claude" (Accidental)** | `defaultPetAgent()`, `currentPetAgent()`, `provider` default in metering, `pet_label_for_agent()` | ❌ No — assumes Claude as primary |

---

## 4. Extensibility Boundary Proposal

### 4.1 Minimal Registry Design (`src-tauri/src/registry.rs`)

```rust
// Provider capability declaration — single source of truth
pub struct ProviderSpec {
    pub id: &'static str,                    // "claude"
    pub title: &'static str,                 // "Claude Code"
    pub command: &'static str,               // "claude"
    pub companion: Option<&'static str>,     // Some("codewhale-tui") or None
    pub config_path: ConfigPathResolver,     // fn() -> PathBuf
    pub events: &'static [&'static str],     // lifecycle events to hook
    pub markers: MarkerSet,                  // begin/end markers for config
    pub permission_mode: PermissionMode,     // External, ExternalAfterTrust, ObserveNative, TerminalNative
    pub capabilities: CapabilityFlags,       // lifecycle, permissionBubble, metering, trustReview
    pub hook_command_format: HookCommandFormat, // JSON/TOML/JS/YAML + Windows wrapper rules
    pub env_var_prefixes: &'static [&'static str], // ["CODEWHALE_", "DEEPSEEK_"]
    pub metering: MeteringAdapter,           // parse_hook, parse_transcript, pricing_module
    pub diagnostic_probes: DiagnosticProbes, // version, doctor, auth, config
    pub ui_metadata: UiMetadata,             // icon, label, color, i18n key prefix
}

// Registry: static array + dynamic registration
pub static PROVIDER_REGISTRY: &[ProviderSpec] = &[
    CLAUDE_SPEC, CODEWHALE_SPEC, CODEX_SPEC, OPENCODE_SPEC, AIDER_SPEC,
];

// Extension point: third-party can call `register_provider(spec)` at runtime
// (requires dynamic loading / plugin system — Phase 2)
```

### 4.2 Migration Slices (Backward Compatible)

| Slice | Files to Modify | Risk | Validation |
|-------|----------------|------|------------|
| **S1: Centralize Provider List** | `commands.rs:305`, `hook_install.rs:304,402`, `model.rs:157,676`, `lib.rs:154-156` | Low | `tauri-capability-boundary-smoke.js` L23 (provider array) |
| **S2: Capability Registry** | `hook_install.rs:853-877` → `registry::provider_capabilities(id)` | Medium | `tauri-cli-diagnostics-r5-smoke.js` capability checks |
| **S3: Config Path Resolver Registry** | `hook_install.rs:277-286,1284-1302` → `registry::config_path(id)` | Medium | `tauri-codewhale-config-path-dedup-r9-smoke.js` |
| **S4: Hook Command Format Registry** | `hook_install.rs:1304-1353` → `registry::hook_command_format(id)` | Medium | `tauri-cli-hardening-r3-smoke.js` L16 |
| **S5: Event/Marker Registry** | `hook_install.rs:70-152` → `registry::events(id)`, `registry::markers(id)` | High | `maintainability-boundary-smoke.js` L60-64 |
| **S6: Metering Adapter Registry** | `metering.rs:339-343,358-360,695-805` → `registry::metering_adapter(id)` | High | `tauri-metering-phase2-smoke.js`, `tauri-codex-pricing-r10-smoke.js` |
| **S7: Diagnostic Probe Registry** | `commands.rs:1761-2070` → `registry::diagnostic_probes(id)` | High | `tauri-cli-diagnostics-r5-smoke.js`, `tauri-cli-resilience-r7-smoke.js` |
| **S8: Frontend Metadata Unification** | `panel.js:PCOST_META,PROVIDER_META`, `pet.js:PROVIDER_ICONS`, `tauri-bridge.js:launch*`, `i18n.js` | Medium | `tauri-bridge-smoke.js` L62-63, `tauri-panel-i18n-audit-r17-smoke.js` |
| **S9: Default Agent Resolution** | `tauri-bridge.js:27-55`, `pet-agent-view.js:14-25`, `commands.rs:16-20` | Low | `tauri-bridge-smoke.js` |

---

## 5. Compatibility Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Config schema change** | Existing `config.json` has `providers: ["claude"]` — registry must accept same IDs | Keep ID strings stable; registry is additive |
| **Hook receipt format** | `install_receipt.provider` must match registry ID | Registry ID = receipt provider field |
| **Frontend i18n keys** | `tray.launchClaude` etc. — registry `ui_metadata.i18n_prefix` generates keys | Auto-generate i18n keys from registry; keep existing as aliases |
| **Test fixtures** | `test/fixtures/claude-transcript-assistant.jsonl`, `codewhale-turn-end.json` | Fixtures are provider-specific by nature — no change |
| **Protocol baseline** | `protocol-baseline.json` localContracts — update when registry changes | Regenerate as part of release process |

---

## 6. Focused Tests That Should Fail Before Changes

These tests **must fail** (red) before implementing the registry, then pass (green) after:

### Unit / Static Checks
1. **`tauri-capability-boundary-smoke.js` L23** — Asserts hardcoded provider array exists in `commands.rs`
   - **Should fail** when `["claude","codewhale","codex","opencode","aider"]` literal is removed from `commands.rs`
2. **`tauri-codewhale-config-path-dedup-r9-smoke.js`** — Verifies single shared `codewhale_config_path()` 
   - **Should fail** if registry introduces duplicate or changes precedence
3. **`maintainability-boundary-smoke.js` L60-64** — Checks for exact marker strings (`octopus:codewhale-hooks:v4`, etc.)
   - **Should fail** if markers moved to registry without preserving string values

### Integration / Smoke Tests
4. **`tauri-bridge-smoke.js` L62-63, L87-99** — Verifies `launchClaude`, `launchCodeWhale`, `launchCodex`, `launchOpenCode`, `launchAider` exist on `window.pet`
   - **Should fail** if bridge methods are renamed to generic `launchAgent(provider)`
5. **`tauri-cli-hardening-r3-smoke.js` L16** — Checks five provider IDs in `agent_spec()` match
   - **Should fail** if `agent_spec()` match arms are replaced by registry lookup
6. **`tauri-cli-diagnostics-r5-smoke.js` L19-21, L25-27** — Verifies CodeWhale/Codex/OpenCode diagnostic probes exist
   - **Should fail** if probes moved to registry without preserving function names
7. **`tauri-cli-resilience-r7-smoke.js` L18-22, L24-26** — CodeWhale doctor fallback chain, Aider non-secret discovery
   - **Should fail** if diagnostic logic restructured

### Functional Tests
8. **`tauri-r11-settings-watcher-smoke.js`** — Claude-only settings watcher
   - **Should fail** if watcher becomes generic (by design — watcher IS Claude-specific)
9. **`tauri-codewhale-doctor-consistency-r10-smoke.js`** — Cross-source doctor ordering
   - **Should fail** if doctor probe logic changes
10. **`tauri-r44-0-5-43-codex-rollout-smoke.js`** — Codex rollout parsing
    - **Should fail** if rollout logic changes

---

## 7. Recommended Implementation Order

1. **Phase 0** (Prep): Add `registry.rs` with static `PROVIDER_REGISTRY` mirroring current hardcoded data exactly — **all tests stay green**
2. **Phase 1** (S1-S2): Replace closed-enum iterations with registry lookup; centralize capabilities — **tests S1, S2, S4 fail then pass**
3. **Phase 2** (S3): Config path resolvers → registry — **test S3 passes**
4. **Phase 3** (S5): Events/markers → registry — **maintainability-boundary-smoke fails then passes**
5. **Phase 4** (S6-S7): Metering & diagnostic adapters → registry — **metering/diagnostic smokes fail then pass**
6. **Phase 5** (S8-S9): Frontend metadata unification + generic `launchAgent(provider)` — **bridge smokes fail then pass**
7. **Phase 6** (Optional): Dynamic registration API for third-party providers

---

## 8. Validation Checklist for Orchestrator

After each slice, verify:
- [ ] `node scripts/run-static-checks.js` passes (22 checks)
- [ ] `npm test` passes (all smoke tests)
- [ ] `node scripts/generate-source-manifest.js` updates `SOURCE_MANIFEST.json`
- [ ] No regression in `tauri-r401-carpet-audit-closure-smoke`
- [ ] Config migration: old `config.json` loads without `SchemaTooNew`

---

*This inventory distinguishes **intentional provider adapters** (necessary for protocol differences) from **accidental closed enums/duplication** (extensibility blockers). The registry approach preserves all intentional adapters while exposing a clean extension boundary.*
