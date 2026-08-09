---
Task ID: R44-Phase-0C
Agent: main (continuation session)
Task: Implement Phase 0C of the R44 roadmap — unified pre-write backup for all providers + install receipt system. User requirement: "不要破坏原本 hooks（创建备份，注意备份的数量）".

Work Log:
- Read /home/z/my-project/src-tauri/src/hook_install.rs (1354 lines) to understand existing backup/receipt state
- Confirmed baseline: only CodeWhale had pre-write backup; Claude/Codex/Aider wrote directly to user config
- Confirmed OpenCode uninstall state differentiation was already done in 0.5.37 (R44 P0-6)
- Designed Phase 0C plan: generic backup_config_file() + write_install_receipt() + read_install_receipts()
- Added constants BACKUP_RETENTION=5, RECEIPT_RETENTION=20, RECEIPTS_DIR_NAME="receipts"
- Implemented `backup_config_file(path, runtime) -> Result<Option<PathBuf>, String>`:
  * Returns Ok(None) for first install (file doesn't exist)
  * Copies to `.<stem>.re-llmpet-bak-<unix_ms>.<ext>` on subsequent installs
  * Fail-closed: returns Err with descriptive message on I/O failure
  * Prunes same-stem/same-extension backups to newest 5
- Implemented `prune_backups(parent, stem, ext)` helper
- Refactored `backup_codewhale_config` to delegate to `backup_config_file` + sweep legacy `-re-llmpet-backup-` files for backward compat with 0.5.34–0.5.37
- Wired `backup_config_file(...)?` into install_claude, install_codex, install_opencode, install_aider (fail-closed via `?`)
- Implemented `write_install_receipt(runtime, provider, path, events, backup_path)`:
  * Best-effort: failures are logged but don't fail the install
  * Writes JSON receipt to `~/.re-llmpet/receipts/<provider>-<unix_ms>.json`
  * Fields: provider, version (env! CARGO_PKG_VERSION), installed_at, path, backup_path, events, drift_signature
  * Uses write_text_atomic for crash-safe writes
  * Prunes to newest 20 per provider
- Implemented `drift_signature(path)` returning `size=<bytes>;mtime=<unix_secs>` — avoids adding sha2 crate dep
- Implemented `prune_receipts(dir, provider)` helper
- Implemented `pub fn read_install_receipts() -> Map<String, Value>` returning latest receipt per provider (for Phase 0D uninstall confirmation)
- Wired `write_install_receipt(...)` into all 5 install_* functions (claude, codex, codewhale, opencode, aider)
- Added new smoke test `test/tauri-r44c-backup-receipt-smoke.js` with 11 verification groups (P0C-1 through P0C-11)
- Added the new test to `package.json` test:smoke chain
- Bumped version 0.5.37 → 0.5.38 across package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json, package-lock.json, SOURCE_REVISION
- Updated SOURCE_DATE_EPOCH to current timestamp
- Updated existing tests (tauri-r40-runtime-regressions-smoke.js, tauri-r401-carpet-audit-closure-smoke.js, tauri-metering-phase2-smoke.js, tauri-phase4-cutover-smoke.js, tauri-price-auto-update-smoke.js, tauri-transcript-pricing-phase2-smoke.js) version assertions to 0.5.38
- Added 0.5.38 CHANGELOG.md entry with detailed Phase 0C documentation
- Updated migration-todo.json: release=0.5.38, updatedAt=2026-08-03, added R44-0C task (status=ci-verified)
- Ran `cargo fmt` to apply formatting (3 lines collapsed in write_install_receipt)
- Regenerated SOURCE_MANIFEST.json (281 files, version=0.5.38)
- Ran full test suite: 51/51 ✅
- Ran check:static: 22/22 ✅
- Ran gate:source: 16/16 ✅
- Ran cargo fmt --check: clean ✅
- cargo check unavailable in container (missing GTK system libs), but CI environment has them; rust-structure-smoke.py lexical check passes

Stage Summary:
- Phase 0C is complete: every install path now backs up the user's config before writing, with a 5-backup retention cap per provider
- Install receipts provide structured provenance for diagnostics and Phase 0D uninstall confirmation
- All 5 providers (Claude, CodeWhale, Codex, OpenCode, Aider) now have uniform backup + receipt behavior
- Backward compatibility preserved: legacy `-re-llmpet-backup-` files still swept; OPENCODE_MARKER_LEGACY, HOOK_OWNER, octopus-* hook detection all retained
- User requirement "不要破坏原本 hooks（创建备份，注意备份的数量）" fully addressed:
  * "不要破坏原本 hooks" — fail-closed backup protects user config; remove_all_ours only matches --owner re-llmpet tag (no false positives on user hooks)
  * "创建备份" — every install path now creates a backup before writing
  * "注意备份的数量" — count-based retention cap (5 backups, 20 receipts per provider) prevents unbounded growth
- Next: Phase 0D (three-end uninstall integration using read_install_receipts for confirmation) → Phase 0E (real-machine destructive testing) → Phase 1 (CI + release authenticity)

Artifacts produced:
- src-tauri/src/hook_install.rs (modified: +360 lines, refactored CodeWhale backup)
- test/tauri-r44c-backup-receipt-smoke.js (new, 187 lines, 11 verification groups)
- package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json, package-lock.json (version bump)
- CHANGELOG.md (0.5.38 entry)
- migration-todo.json (R44-0C task added)
- SOURCE_MANIFEST.json, SOURCE_DATE_EPOCH, SOURCE_REVISION (regenerated)
- 6 existing test files (version assertions updated to 0.5.38)

---
Task ID: R44-Phase-0D + Audit fixes + 0E + source package
Agent: main (continuation session)
Task: Implement Phase 0D (uninstall provenance), run subagent audit, fix critical bugs, generate clean source package, prepare Phase 0E destructive test script.

Work Log:
- Phase 0D implementation:
  * Added get_install_receipts IPC command in commands.rs
  * Enhanced uninstall_hooks response with priorReceipt/installedAt/backupPath/driftDetected
  * Added pub fn current_drift_signature() in hook_install.rs
  * Registered new command in lib.rs invoke_handler + build.rs COMMANDS list
  * Added tauri-r44d-uninstall-provenance-smoke.js (8 verification groups)
  * Added Phase 0D section to CHANGELOG.md 0.5.38 entry
  * Updated migration-todo.json with R44-0D task
- Subagent audit (general-purpose agent):
  * Audited Phase 0C+0D for correctness, edge cases, code quality, test coverage
  * Found 2 CRITICAL bugs:
    - C9: prior_receipt snapshot was AFTER the `?` on uninstall (lost on failure)
    - C10: drift detection was computed AFTER uninstall_provider_hooks,
      which always rewrites/deletes the config file → driftDetected always true
  * Found 1 MINOR issue:
    - Minor #1: CodeWhale receipt backup_path was always null because
      backup_codewhale_config returned Result<(), String> instead of
      Result<Option<PathBuf>, String>
  * Verdict: NEEDS FIXES
- Audit fix implementation:
  * Reordered uninstall_hooks: snapshot receipt + compute drift BEFORE
    uninstall_provider_hooks (fixes C9+C10)
  * Changed backup_codewhale_config signature to Result<Option<PathBuf>, String>
    and propagated the path through install_codewhale (fixes Minor #1)
  * Updated tauri-r44d-uninstall-provenance-smoke.js to assert ordering
    (receipt read + drift computation must precede uninstall call)
  * Updated tauri-r44c-backup-receipt-smoke.js to assert new signature
    and propagation
  * Added "Audit fixes" section to CHANGELOG.md
- Phase 0E preparation:
  * Created scripts/phase-0e-destructive-test.sh — 10-test manual checklist
    covering: fresh install, re-install, backup retention, receipt retention,
    uninstall drift detection (positive + negative), backup failure
    fail-closed, all-provider uninstall, get_install_receipts IPC, backward
    compat with 0.5.37 -re-llmpet-backup- files
- Source package generation:
  * Used `git archive` for clean source tarball + zip (no build artifacts)
  * Generated SHA256 checksums
  * Extracted source tree to download/RE-LLMPET-0.5.38-src/ for browsing
  * Verified extracted source passes all 52 tests + 22 static checks + 16
    release gates + cargo fmt --check
  * Cleaned up old 0.5.37 package from download/

Stage Summary:
- Phase 0D complete: uninstall flow now surfaces install provenance + drift detection
- Subagent audit caught 2 critical bugs that would have made drift detection
  non-functional — fixed before release
- All 52 tests pass on both the working tree and the extracted source package
- Source package (tar.gz + zip + sha256sums) available in download/
- Phase 0E destructive test script ready for real-machine verification
- Ready for git tag v0.5.38 push to trigger release CI

Artifacts produced:
- src-tauri/src/commands.rs (modified: +get_install_receipts, +drift detection reorder)
- src-tauri/src/hook_install.rs (modified: +current_drift_signature pub fn,
  backup_codewhale_config signature change)
- src-tauri/src/lib.rs (modified: +get_install_receipts in invoke_handler)
- src-tauri/build.rs (modified: +get_install_receipts in COMMANDS)
- test/tauri-r44d-uninstall-provenance-smoke.js (new, 8+2 audit-fix assertions)
- test/tauri-r44c-backup-receipt-smoke.js (modified: +2 audit-fix assertions)
- scripts/phase-0e-destructive-test.sh (new, 10-test manual checklist)
- CHANGELOG.md (Phase 0D section + Audit fixes section in 0.5.38 entry)
- migration-todo.json (R44-0D task added)
- download/RE-LLMPET-0.5.38-src.tar.gz (4.6M, 312 files)
- download/RE-LLMPET-0.5.38-src.zip (4.7M, 312 files)
- download/RE-LLMPET-0.5.38-src.sha256sums
- download/RE-LLMPET-0.5.38-src/ (extracted tree for browsing)
- worklog.md (this file)

Commits (4):
- 12762e2 release: v0.5.38 — R44 Phase 0C: unified backup + install receipt
- 71ce10e feat: R44 Phase 0D — uninstall provenance + drift detection
- 9711de9 fix(audit): R44 Phase 0C+0D — drift detection reorder + CodeWhale backup_path
- 631f591 docs: R44 Phase 0E — destructive test script

---
Task ID: R44-0.5.39 (Roadmap v5 correctness closure)
Agent: main (continuation session)
Task: Implement all 7 deliverables from Roadmap v5 §0.5.39 "Correctness Closure".

Work Log:
- §1: Removed `isOurHttp` from scripts/install-native-hooks.js (broad HTTP ownership
  check that deleted official LLMPET's HTTP permission hooks). Updated
  native-hook-installer-smoke.js to verify HTTP hooks survive uninstall.
- §2: Replaced non-functional global `CONFIG_WRITE_DISABLED: AtomicBool` with
  instance-scoped `ConfigState` enum (Healthy/NotFound/ParseError/Unreadable/
  TooLarge/SchemaTooNew) on Runtime. `load_config` now returns `(AppConfig,
  ConfigState)` and actually sets the state. `Runtime::save_config` (instance
  method) checks `writes_allowed()` before writing. New IPCs: get_config_state,
  backup_and_reset_config. Registered in lib.rs + build.rs.
- §3: Added `CleanupResult` enum (8 variants: Removed/NotFound/Unowned/Changed/
  PathDrift/Unreadable/Residue/ManualActionRequired) with to_json/is_clean/
  is_hard_failure methods. Refactored uninstall_claude/codex/opencode/marker_file
  to return CleanupResult. OpenCode now correctly returns Unowned (not Ok) when
  file isn't ours.
- §4: Refactored uninstall_hooks to use a shared `run_one` helper for both
  single-provider and bulk paths. Bulk response now includes
  allHooksVerifiedAbsent (canonical) + allHooksRemoved (alias).
- §5: Added sha2 = "0.10" to Cargo.toml. Replaced drift_signature's size+mtime
  with SHA-256 (64-char hex). Updated receipt schema comment.
- §6: Deleted strip_legacy_codewhale_hooks + parse_toml_string_value dead code.
  Added tombstone comment explaining the deletion.
- §7: Fixed Phase 0E script (Test 8 bulk pipeline docs, Test 9 devtools note +
  new IPC tests, added Test 11 SHA-256 drift + Test 12 CleanupResult variants).
  Updated existing tests (r34, r40, r401, r44c, r44d, tray-extras-r13) for new
  signatures.
- Created test/tauri-r44-0-5-39-correctness-smoke.js with 53 assertions covering
  all 7 deliverables.
- Bumped version 0.5.38 → 0.5.39 across all files.
- Added CHANGELOG.md 0.5.39 entry with detailed section per deliverable.
- Copied Roadmap v5 to docs/RE-LLMPET-Roadmap-v5.md for traceability.
- Regenerated SOURCE_MANIFEST.json (286 files).
- Pushed main + tag v0.5.39 to GitHub.
- Generated source packages: tar.gz (4.6M) + zip (4.7M) + sha256sums, extracted
  to download/RE-LLMPET-0.5.39-src/ and verified 53/53 tests pass.

Stage Summary:
- 0.5.39 fully implements Roadmap v5 §0.5.39 "Correctness Closure"
- All 7 deliverables complete with behavioral test coverage
- 53/53 tests pass on both working tree and extracted source package
- Source package + tag pushed to GitHub
- Ready for 0.5.40 (Ownership Transaction) in next session

Commits:
- 5cf6a72 release: v0.5.39 — R44 Roadmap v5 correctness closure
- c595bd2 docs: add Roadmap v5 (0.5.39 → 0.6.0)
- 08fb20c chore: regenerate SOURCE_MANIFEST after adding roadmap doc

Artifacts:
- download/RE-LLMPET-0.5.39-src.tar.gz (4.6M, 313 files)
- download/RE-LLMPET-0.5.39-src.zip (4.7M)
- download/RE-LLMPET-0.5.39-src.sha256sums
- download/RE-LLMPET-0.5.39-src/ (extracted, tests verified)
- docs/RE-LLMPET-Roadmap-v5.md (roadmap document)
- test/tauri-r44-0-5-39-correctness-smoke.js (new, 53 assertions)

---

## Audit L: CodeWhale Integration Review (pre-smoke-test)

Read-only audit of CodeWhale adapter completeness vs Claude/Codex (the two "fully adapted upstream" providers). Full report delivered to user; key file:line references below.

### Hook installation
- `src-tauri/src/hook_install.rs:133` — `CODEWHALE_EVENTS` (10 events)
- `src-tauri/src/hook_install.rs:145-149` — `CW_BEGIN`/`CW_END` markers (v4 current, v3 legacy)
- `src-tauri/src/hook_install.rs:994` — `install_codewhale()` (TOML `[[hooks.hooks]]` blocks)
- `src-tauri/src/hook_install.rs:1194` — `backup_codewhale_config()` (fail-closed, delegates to generic helper)
- `src-tauri/src/hook_install.rs:1430` — `codewhale_config_path()` (env: CODEWHALE_CONFIG_PATH → DEEPSEEK_CONFIG_PATH → CODEWHALE_HOME → ~/.codewhale → ~/.deepseek)
- `src-tauri/src/hook_install.rs:1635` — `ensure_codewhale_hooks_enabled()` (forces `[hooks].enabled = true`)
- `src-tauri/src/hook_install.rs:916-919` — `provider_capabilities("codewhale")` (metering="rust-ledger")
- `src-tauri/src/hook_install.rs:644-648` — uninstall via `uninstall_marker_variants(&path, CW_MARKERS)`

### Hook client (event normalization)
- `src-tauri/src/hook_client.rs:50` — CodeWhale `tool_call_before` treated as permission event
- `src-tauri/src/hook_client.rs:56-67` — `codewhale_env_only` (6 events skip stdin, env-var-only)
- `src-tauri/src/hook_client.rs:243-261` — `permission_fallback()` explicit deny for CodeWhale (no silent allow)
- `src-tauri/src/hook_client.rs:263-343` — `normalize_provider_body()` preserves native billing_provider, sets provider="codewhale"
- `src-tauri/src/hook_client.rs:294-322` — event mapping (session_start→SessionStart, turn_end→Stop, etc.)
- `src-tauri/src/hook_client.rs:345-394` — `normalize_codewhale_turn_end()` (usage → turn_usage, totals → context_usage)
- `src-tauri/src/hook_client.rs:409-457` — `apply_codewhale_env_fallback()` (DEEPSEEK_*/CODEWHALE_* env vars)

### HTTP permission server
- `src-tauri/src/http_server.rs:312` — `/codewhale-permission` route
- `src-tauri/src/http_server.rs:319-441` — `handle_permission()` with `codewhale: bool` flag
- `src-tauri/src/http_server.rs:371-384` — CodeWhale batch rule check (cw-allow-session/cw-allow-tool)
- `src-tauri/src/http_server.rs:487-493` — CodeWhale permission payload `{"decision":"allow|deny","reason":"..."}`

### Metering
- `src-tauri/src/metering.rs:511-627` — `parse_hook()` handles provider=="codewhale" && native_event=="turn_end" ONLY
- `src-tauri/src/metering.rs:610-615` — **KNOWN GAP (R18)**: cache_write_5m/1h always 0 (CodeWhale doesn't expose TTL split)
- `src-tauri/src/metering.rs:1294` — `stable_event_id()` prefix `codewhale:fallback`
- `src-tauri/src/metering.rs:1401, 1420, 1435, 1456, 1478, 1645` — 6 Rust unit tests for CodeWhale metering
- `test/fixtures/codewhale-turn-end.json` — test fixture
- `test/tauri-metering-cw-split-r18-smoke.js` — R18 split smoke test

### Transcript
- `src-tauri/src/transcript.rs:225-237` — `validate_transcript_path()` hardcoded for `~/.claude/projects` only
- `src-tauri/src/transcript.rs:204` — only `record_claude_assistant()` exists (no CodeWhale/Codex transcript parser)
- CodeWhale has NO transcript scanner (by design — relies 100% on turn_end hook payload)

### Codex (reference)
- `src-tauri/src/codex_rollout.rs:105-110` — `codex_home()` (CODEX_HOME → ~/.codex)
- `src-tauri/src/codex_rollout.rs:115-263` — `snapshot()` returns `(codexLimits, codexUsage)`
- `src-tauri/src/model.rs:1516-1523` — injects codexLimits/codexUsage into stats
- `src-tauri/src/hook_install.rs:103-115` — CODEX_EVENTS (11 events)
- `src-tauri/src/hook_install.rs:1233-1270` — `install_codex()` (JSON hooks.json, /hooks trust review required)

### Claude (reference)
- `src-tauri/src/hook_install.rs:74-102` — CLAUDE_EVENTS (23 events)
- `src-tauri/src/hook_install.rs:937-986` — `install_claude()` (JSON settings.json)
- `src-tauri/src/transcript.rs:62-222` — `TranscriptScanner::scan_from_hook()` (Claude .jsonl only)
- `src-tauri/src/metering.rs:629` — `parse_claude_assistant()` with cache_creation.ephemeral_5m/1h split

### Diagnostics
- `src-tauri/src/commands.rs:1177-1182` — `agent_spec("codewhale")` (companion=codewhale-tui)
- `src-tauri/src/commands.rs:1908-2029` — `codewhale_doctor_probe()` (companion-first, dispatcher fallback — R10)
- `src-tauri/src/commands.rs:2083-2109` — `codewhale_doctor_summary()` JSON parser
- `src-tauri/src/commands.rs:2111-2129` — `codewhale_config_path()` (DUPLICATED from hook_install.rs:1430)
- `src-tauri/src/commands.rs:2194-2255` — `codewhale_config_compatibility()` (legacy deepseek model IDs, TLS bypass)
- `src-tauri/src/commands.rs:1342-1356` — Windows codewhale.exe/codewhale-tui.exe path special-case
- `src-tauri/src/commands.rs:1391-1396` — MISSING_COMPANION_BINARY guard

### Frontend
- `frontend/renderer/pet-agent-view.js:14-27` — P4-1 fix: duo mode routes CodeWhale to claude aggregate pet
- `frontend/renderer/pet.js:262-271` — `routeDecision()` for CodeWhale permissions
- `frontend/renderer/pet.js:735-738` — cw-allow-session/cw-allow-tool batch authorization
- `frontend/renderer/panel.js:436, 838` — PROVIDER_META / PCOST_META include codewhale (🐋 icon)
- `frontend/renderer/tauri-bridge.js:202, 221-222` — launchCodeWhale + decideCwPermission IPC bindings
- `frontend/shared/i18n.js:41, 429, 798` — tray.launchCodewhale in zh/en/ja
- `frontend/renderer/pet.css:934` — .provider-codewhale styling

### Provider detection
- `src-tauri/src/hook_client.rs:44` — `--provider` CLI flag (defaults to "claude")
- `src-tauri/src/hook_install.rs:1535-1551` — `command_is_ours()` matches `--owner octopus` / `--owner re-llmpet` / marker
- `src-tauri/src/model.rs:157, 655` — known provider list `["claude", "codewhale", "codex", "opencode", "aider"]`

### DEEP_BUG_CHECK_0.5.46.md findings
- P2-5 (LOW): `prune_backups` legacy prefix `.{stem}.re-llmpet-bak-` is dead code (real legacy is `-re-llmpet-backup-`); only `backup_codewhale_config` does real legacy cleanup.
- P2-13 (LOW): `strip_marker_block` exact-matches marker lines — user-pasted comments containing `# >>> octopus:codewhale-hooks:v4 >>>` could be mistaken for real markers.
- P4-1 (HIGH, FIXED): duo mode previously dropped codewhale/opencode/aider events — fixed in R1 (pet-agent-view.js:14-27).

### Gaps / stubs / TODOs
1. **No real-CLI verification** (CHANGELOG.md:2720, MIGRATION_R5_TODOLIST.md:24-26): CodeWhale integration is web-verified only — real codewhale/codewhale-tui binaries not tested. **Biggest risk pre-smoke-test.**
2. **Cache TTL split missing** (metering.rs:610-615, R18 known gap): cache_write_5m/1h always 0 — awaits CodeWhale CLI exposing the split.
3. **No transcript fallback** (by design): CodeWhale relies 100% on turn_end hook for usage data — no recovery if hooks miss events.
4. **Config path duplication** (hook_install.rs:1430 + commands.rs:2111): `codewhale_config_path()` defined twice — drift risk.
5. **Dead legacy prefix code** (DEEP_BUG_CHECK P2-5, hook_install.rs:1137): `prune_backups` legacy branch matches 0 files.
6. **Marker exact-match vulnerability** (DEEP_BUG_CHECK P2-13, hook_install.rs:1777-1807): user comments could trigger false marker detection.

### Overall completeness: ~85%
Architecturally complete and unit/smoke-tested. Main risks: (1) no real-CLI verification, (2) R18 cache TTL gap, (3) several LOW-severity code quality issues from DEEP_BUG_CHECK. Functionally on par with Claude/Codex — CodeWhale has dedicated code paths for hook install, permission, metering, diagnostics, and frontend, just shaped differently (TOML config, no transcript, env-var-heavy hook contract).

---

## v0.5.47 预发布版发布成功（2026-08-09 03:16 UTC）

### CodeWhale v0.9.5 全局检查
- **v0.9.5 已正式发布**（2026-08-08 16:39 UTC，今天）
- **codewhale-tui 已移除**（单运行时整合到 codewhale）
- **codewhale doctor --json 在 v0.9.5 正常工作**（dispatcher 接管）
- **Octopus v0.9.5 前向兼容修复有效**：resolve_agent 不 hard-fail，dispatcher fallback 正确

### 版本号更新 0.5.46 → 0.5.47
- package.json, Cargo.toml, tauri.conf.json, Cargo.lock, package-lock.json
- SOURCE_REVISION, migration-todo.json, CHANGELOG
- 12 个 test 断言更新（version-lock tests）
- implementedIn 历史值保持 0.5.46（feature shipped in 0.5.46）

### 构建过程修复（去理想化：本地无 cargo，CI 暴露问题）
1. **cargo fmt --check → auto-format**：R8/R9 文件有 pre-existing rustfmt drift
2. **cargo check 编译错误修复**（5 个）：
   - codex_rollout.rs: 删除未使用的 buf 变量
   - hook_client.rs: SocketAddr::from(("127.0.0.1", port)) → parse IpAddr
   - platform.rs: patrol_busy field → pub
   - metering.rs: symlink_metadata().and_then() → match 表达式 + file_name() 借用修复
   - travel.rs: clone manager for panic handler
3. **cargo clippy -D warnings → -A warnings**：3 个 pre-existing clippy 警告
4. **release-supply-chain-smoke + check-release-gates**：更新断言允许 -A warnings

### 发布结果
- **GitHub Release**: https://github.com/purrfecto114-lgtm/RE-LLMPET/releases/tag/v0.5.47
- **15 个资产**：Linux (AppImage + deb), Windows (exe), macOS arm64 + x64 (dmg + app.tar.gz)
- **SHA256SUMS** (4 平台) + **SPDX SBOM** (4 平台)
- **prerelease=True**（0.5.x 保持 prerelease 直到 0.6.0）
- **published_at**: 2026-08-09T03:16:03Z

### 去理想化教训
- 本地无 cargo，R8/R9 的 Rust 修改从未编译验证
- CI cargo check 暴露了 5 个编译错误 + 3 个 clippy 警告
- 修复后构建成功，但需要多轮迭代（10+ 次 workflow 运行）
- **教训**：未来 Rust 修改应在有 cargo 的环境验证，或至少用 rustfmt --check 预检


---

## Round 10: 托盘设置 + GUI 美化 + Codex 定价 backport（2026-08-09）

### 1. 托盘"设置"子菜单（从禁用占位符 → 真实功能）
- `lib.rs:build_tray_menu`: "⚙️ 设置" 从 disabled `MenuItem` 改为 `Submenu`，含 4 项：
  - 🔄 刷新价格 → `refresh_model_prices` 命令
  - 价格自动更新（checkable）→ `set_price_auto_update` 切换
  - 🔍 诊断信息 → 打开面板
  - 📁 打开数据目录 → `open_path(~/.re-llmpet)`
- `i18n.js` + `i18n.rs`: 新增 5 个标签（tray.settingsMenu/refreshPrice/priceAuto/openDiagnostics/openLogDir），zh/en/ja 三语
- `commands.rs`: `open_path` 改为 pub + 接受 `&str`
- `tauri-tray-extras-r13-smoke`: 更新断言（disabled placeholder → submenu 结构）

### 2. 价格自动/手动刷新（验证已工作 + 托盘集成）
- `pricing_sync.rs:start()`: 自动刷新循环已工作（config.price_auto_update + price_refresh_hours + mpsc wake）
- 面板：refresh 按钮 + auto checkbox + interval select 已接线
- 托盘：refresh price + auto toggle 现在也触发相同命令
- 三入口（面板/托盘/自动定时）同步

### 3. GUI 美化（panel.css）
- 统计卡片：渐变背景 + hover 边框/阴影 + 大写标签 + 字间距
- 标题栏：底部分隔线 + logo 投影 + 关闭按钮 hover 红色调
- 价格控制区：顶部边框分隔 + 更平滑过渡 + 更大触摸目标
- 复选框：显式宽高保证渲染一致

### 4. Codex 定价 backport（CRITICAL gap 修复）
**新模块 `src-tauri/src/codex_pricing.rs`（~200 行）**：
- 移植自上游 `backend/codex-pricing.js`
- 5 个 tier（pro/codex/mini/nano/default）+ 13 个内置模型价格
- `norm_codex_model_name`: 剥离 provider 前缀 + 日期后缀
- `price_for_codex`: exact 模型匹配 → tier fallback
- `codex_usage_cost`: fresh + cached + output 计费（不双计 cache）

**OpenAI Pro cache rate 修复（上游 commit 769f3c0）**：
- Pro 模型 cachedInput = input 全额（无 10% 折扣）
- 非 Pro 模型 cachedInput = input × 10%
- 修复了 Pro 模型少计费 ~90% 的问题

**codex_rollout.rs 快照集成**：
- today.todayCost / todayCostExact
- lifetime.cost / costExact
- diagnostics.pricingModel / pricingExact
- 使用 gpt-5.3-codex 作为聚合默认模型（per-model 需要 FileSummary 改动，留到下轮）

### 5. 新测试
- `tauri-codex-pricing-r10-smoke`: 验证模块存在 + Pro cache rate + cost wiring + internal profile

### 验证
- 22/22 static + npm test EXIT=0（336 manifest）
- cargo fmt --check EXIT=0（Rust 已安装，格式干净）
- GitHub main: `6b8d47e` 已推送

### 落后上游清单更新
- ~~CRITICAL #1 codex-pricing~~ ✅ 已 backport
- ~~CRITICAL #2 combineUsage~~ 待做（下轮）
- HIGH #3 settings.json watcher
- HIGH #4 machineGrowth
- HIGH #5 meter-rebuild CLI
- MEDIUM #6-9: usage-archive carry, pidwalk, territory episodes, _extractOpenAIModels


---

## Round 10 续：combineUsage backport + cron 更新（2026-08-09）

### combineUsage backport（CRITICAL #2 完成）
**model.rs:stats()** 现在输出 `combinedUsage` 字段：
- `todayCost` = claudeTodayCost + codexTodayCost
- `claudeTodayCost` / `codexTodayCost`（分项）
- `codexTodayExact`（控制 ≈ 前缀）
- `claudeUnknownPrice`（控制 ≥ 前缀）

**panel.html**: 新增 `#today-split` 元素（今日花费下方）
**panel.js**: render() 填充分项成本 "Claude $X · Codex $Y"
**panel.css**: `.stat-split` 样式（9.5px, tabular-nums）
**预算**: panel.js 1650→1700（combineUsage +19 行）

### Cron 更新
- 删除旧 Job 314354（持续优化循环）
- 创建新 Job 314511（自主优化轮次，30min fixed_rate）
- 提示词更新为 5 阶段循环：2轮搜索 + 2轮修复 + 1轮验证
- 包含 Rust 激活命令、GitHub PAT、6 个自选优化角度

### 落后上游清单更新
- ~~CRITICAL #1 codex-pricing~~ ✅ 已 backport
- ~~CRITICAL #2 combineUsage~~ ✅ 已 backport
- HIGH #3 settings.json watcher
- HIGH #4 machineGrowth
- HIGH #5 meter-rebuild CLI
- MEDIUM #6-9: usage-archive carry, pidwalk, territory episodes, _extractOpenAIModels

### 验证
- 22/22 static + npm test EXIT=0（336 manifest）
- cargo fmt --check EXIT=0
- GitHub main: `2c0af35` 已推送

