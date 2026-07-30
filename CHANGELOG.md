# Changelog

## 0.5.5 R7 — resilient doctor fallback and bounded local diagnostics（2026-07-29）

- Reconciled CodeWhale's conflicting public dispatcher and detailed TUI doctor documentation with a bounded, auditable fallback chain: try `codewhale doctor --json`, then use the matched `codewhale-tui doctor --json` when the first surface has no parseable JSON. Both attempts, targets and selected surface remain visible.
- Removed arbitrary diagnostic working directories from the always-on WebView. Diagnostics now run only in the application-owned directory, preventing renderer-controlled projects from implicitly loading provider `.env`, plugins, hooks or workspace configuration.
- Added CodeWhale project-overlay detection, current/legacy overlay conflict warnings, and Claude Code `<2.1.200` sleep/wake compatibility guidance without turning version age into a launch blocker.
- Added Aider configuration discovery for cwd/git-root/home and reports only credential environment variable names and model-presence booleans, never credential values.
- Extended the existing zh/en/ja provider diagnostic card and the Windows PowerShell 5.1 evidence collector; no new web page or remote UI dependency was introduced.
- Added a 23-check R7 CLI-resilience suite and a stable `npm run check:static` gate. Full npm smoke, 39-byte-identical visual/media assets, protocol drift, source-release gates, JavaScript/JSON checks and Rust lexical/structure checks pass. Native compilation and real Windows CLI execution remain external gates.

## 0.5.5 R6 — authentication and route diagnostics（2026-07-29）

- Split pre-launch diagnostics into installation, authentication, provider/model routing, and working-directory evidence instead of collapsing every CLI failure into `internal error`.
- Parse CodeWhale `doctor --json` before truncation, recursively redact secrets, and expose only bounded route/config/session-migration summaries to the existing provider panel.
- Added non-interactive `codewhale auth status`, `codex login status`, and `opencode auth list` probes; authentication uncertainty remains a warning because environment keys, project `.env`, custom providers, or local/keyless providers can still work.
- OpenCode now receives its official `--dir .` argument on Windows Terminal, cmd fallback, macOS Terminal, and Linux terminal paths while retaining process `current_dir`.
- Extended the Windows PowerShell 5.1 collector, zh/en/ja UI labels, structured migration TODO, and a 20-check R6 regression suite. No image, GIF, MP3, drag, DPI, or transparency behavior was replaced.
- Offline tests, 39-byte-identical asset gate, protocol drift, 16 source-release gates, JavaScript syntax, JSON parsing, and Rust lexical/structure checks pass. Native Rust compilation and real CLI/desktop evidence remain external gates.

## 0.5.5 — upstream reconciliation, visual preservation and runtime hardening（2026-07-28）

- R4 merged the CLI-hardening overlay into the complete R2 source tree with a guarded function-level merge; it did not overwrite drag, cursor hit-testing, DPI anchoring, language switching, UI state, or visual/media resources.
- Added diagnosable fixed-provider launch resolution, PATHEXT/npm shim handling, CodeWhale companion/version/doctor checks, explicit cwd support, bounded stdout/stderr probes, and a Windows PowerShell diagnostic collector.
- Kept Windows Terminal as the primary host with a restricted cmd fallback, and fixed VS Code/Cursor `.cmd` GUI entry points without restoring `cmd /C start`.
- The default test suite now includes 35 CLI merge/preservation assertions; all offline tests, resource hashes, protocol drift and source release gates pass. Native Rust compilation and Windows real-CLI evidence remain unclaimed.
- Reconciled the Tauri tree against official upstream `49fef749364b31dfa2ddab857aed7d82d49460cc` and the five-provider fork `b424675b80162121e58cab631088604d10716b63`; official UI behavior, fork protocol lessons and Tauri runtime responsibilities are recorded separately.
- Imported official zh/en/ja copy, two GIFs, two MP3 files and the cat-skin attribution byte-for-byte; retained the full meme catalog as a backend resource and generated a presentation-only renderer manifest without full prompt bodies.
- Added persistent language switching for the core pet/panel UI and an honestly labelled local meme preview that preserves GIF/audio quality without pretending to send prompts.
- Fixed the session-list provider launch regression where Codex/OpenCode/Aider labels still launched Claude; all five providers now use one fixed Rust allowlist, distinct session/cost icons and fail-closed unknown identifiers.
- Replaced Windows shell-interpolated path opening with `explorer.exe` arguments; corrected PowerShell focus-helper scope; validated and stored UI-busy/visual-bound state instead of accepting no-op commands; flattened bounded diagnostics to prevent multi-line log forgery.
- Hardened Windows hook/runtime atomic replacement with backup-and-rollback behavior so a rename failure does not destroy the previous configuration.
- Added deterministic meme generation, upstream hash/provenance checks, command-safety tests, provider-launch regression tests and a 39-file visual baseline gate.
- Fixed the transparent-pet input deadlock caused by treating Tauri's strict cursor-ignore API like Electron's `forward: true`: a native cursor hit-test guard now restores input over validated interactive bounds, while short-click and drag remain distinct gestures.
- Reworked drag into an animation-frame-throttled move path with one final position commit, eliminating configuration writes and full config broadcasts on every pointer movement; pointer-capture completion is idempotent and popup resize invokes are serialized.
- Windows agent launch now passes the allow-listed provider executable directly to `wt.exe` in a new Windows Terminal window; only if Terminal cannot be spawned does it fall back to `cmd.exe /D /K`, with no `cmd /C start` wrapper.
- Continued upstream visual migration with a bounded ask body/fixed toolbar, per-provider identity tags, an in-session-HUD meme page, skin-aware side media, idle GIF preloading, and DPI-aware bottom-centre window anchoring while preserving every imported media byte.
- All offline source, protocol, resource and JavaScript checks pass. Rust/Tauri compilation and real-provider/desktop/signing evidence remain unavailable in the current no-toolchain, DNS-blocked environment and are not claimed.

## 0.5.1 — comprehensive audit hardening（2026-07-28）

- Removed blanket Bash auto-approval and delegated HTTPS WebFetch to the provider-native permission flow; cleartext HTTP remains denied.
- Split Tauri invoke permissions by `pet` and `panel` window using generated command permissions instead of exposing every registered command to every WebView.
- Made signed tag releases fail closed; manual unsigned builds now create isolated draft releases instead of public prereleases.
- Upgraded first-party artifact upload workflows to `actions/upload-artifact@v7`, corrected SPDX namespace/DESCRIBES metadata, and added a pinned RustSec `cargo-audit` CI gate.
- Reconciled `package-lock.json` with version 0.5.1 and added regression checks for lockfile, release, capability, SBOM and permission boundaries.
- Reconciled migration status for the committed `Cargo.lock`; three-platform compilation, real GUI and real-provider execution remain explicitly unverified.

## 0.5.1 — hot-path performance optimization（2026-07-28）

- Optimized `stats()` on the /state POST hot path: `project_name()` 3×→1× per session (cached), `PendingPermission` double-clone→1 clone + zero-copy borrow, `session_projects` values cloned→`&str`.
- Added `privacy_settings() -> (bool, usize)` to `ingest()` — avoids a full `AppConfig` clone on every hook event (reads only `reply_bubbles` + `reply_bubble_chars`).
- Fixed E0716 (dangling borrow on temporary `MutexGuard`) caught by CI macOS.
- Cleaned stale source-tree files: `--draft` junk, duplicate migration TODO, 5 one-off phase4 verification logs, stale SHA256 manifest, unreferenced BUILD_TAURI.md.

## 0.5.0-phase4 — upstream reliability reconciliation and complete runtime cutover（2026-07-27）

- Compared the migration candidate with `purrfecto114-lgtm/LLMPET` and upstream `myunwang/LLMPET`; recorded the fork tag, observed fork head, and upstream head separately.
- Adopted upstream's 2026-07-27 parallel permission semantics: distinct requests in one session remain separate; only exact provider/session/tool/input retries share a response.
- Added top-level `pendingChoices`, `permId`-based renderer identity, shared retry responses, and session state preservation while another permission remains pending.
- Removed the complete archived Electron/Node runtime, obsolete package scripts, old operational docs, and stale generated reports. Rollback now uses immutable repository/tag archives.
- Retained only three anonymized, SHA-256-pinned data fixtures for behavioral contract tests.
- Bumped package, Tauri config, and Cargo manifest to 0.5.0; source tests and static gates pass, while Cargo.lock/three-platform compilation/real CLI/GUI/signing remain explicit external blockers.

## 0.4.0-phase3 — Tauri 活动路径切换与可执行发布门禁（2026-07-27）

- 旧 Electron 主进程、preload、backend/provider/hook/renderer 运行路径已从源码树删除；仅保留匿名化、哈希固定的数据契约样本。
- Claude `AskUserQuestion` / `ExitPlanMode` 使用 PreToolUse `updatedInput`；`permission_suggestions` 使用 PermissionRequest `updatedPermissions`；Codex 保持最小 fail-closed envelope。
- 新增来源 PID 父进程链终端聚焦，支持 macOS/Windows/X11，并对纯 Wayland 明确降级。
- 新增 `RunEvent::Resumed`、显示器拓扑签名、离屏窗口恢复和单例低频健康检查。
- 新增资源基线、跨平台性能采样、真实 Provider/桌面 self-hosted gate、签名发布、校验和、SPDX SBOM 与 GitHub attestations。
- package/Cargo/Tauri 升至 0.4.0；TODO 清零为 0，外部硬门禁保持 blocked/implemented-uncompiled，未虚报三平台、真机或签名完成。

## 0.3.0-phase2 — 多 Provider 原生适配与动态迁移门禁（2026-07-26）

- 对照用户指定 fork 与各 provider 当前官方/维护文档，确认 CodeWhale 是一等 provider，不再套用单一 Claude Hook 模型。
- 新增 provider capability/status 模型；前端可见安装状态、配置路径、权限模式和能力限制。
- Claude：merge-safe hooks、当前 `hookSpecificOutput`、收紧自动允许名单。
- CodeWhale：TOML marker 合并、10 类维护事件、原生 payload 映射、服务失联显式 `ask`。
- Codex：当前 `~/.codex/hooks.json` 嵌套结构、PermissionRequest、`/hooks` 信任提示。
- OpenCode：官方风格 ESM plugin，观察 session/tool/permission，不伪造外部权限控制。
- Aider：规范 `notifications-command`，只承诺 turn-end，拒绝覆盖用户已有通知命令。
- Provider 开关即时安装/卸载；安装失败按 provider 隔离。
- Windows Hook 命令统一经 `cmd.exe /D /S /C` 处理带空格路径。
- marker block 异常时拒绝修改，避免配置误删。
- GitHub Actions checkout/setup-node 更新为 v7，并固定 Node 24；保留三平台 cargo check/release binary 门禁。
- 新增 `migration-todo.json`、动态 TODO、能力矩阵、Web 交叉验证报告与任务图校验器。
- 旧核心 33/33 测试文件继续通过；Phase 2 provider smoke 通过。Rust/GUI/真 provider CLI 仍待 CI 与真机证明。
- 同版本进一步迁移：新增 Rust 原生 CodeWhale `turn_end` 计量链、规范化 JSONL 账本、跨重启去重、95 天/5 万条有界保留与损坏行压实。
- 同版本进一步迁移：按 RFC3339 `created_at` 归属历史窗口，持久化价格来源/更新时间；计划或额度型 `billing_surface` 明确保持未定价。
- 同版本进一步迁移：修复 Hook 归一化时真实计费 provider 被覆盖的问题；失败/中断 turn 映射为错误状态。
- 同版本进一步迁移：未知价格在今日、5 小时、provider、模型与合计视图均显示“价格未知”或“已知金额 + 未知”，预算百分比标记为下界。
- CI 增加 Rust `cargo test --lib`；新增 CodeWhale fixture 与计量冒烟，版本仍保持 `0.3.0-phase2`。

## 0.2.0-phase1 — Tauri 2 / Rust 激进迁移基线（2026-07-26）

- 新建 Tauri 2 桌面壳与 2,200+ 行 Rust 核心，活动依赖中移除 Electron。
- 复用全部现有 Web UI 和 35 个图片资源；新增 31 命令兼容桥。
- 新增有界回环 HTTP 服务、随机令牌、Rust 配置/会话/权限状态和合并安全 Claude Hook 安装器。
- 主程序通过 `--octopus-hook` 同时承担原生 Hook 模式，避免 Node 与 sidecar 打包依赖。
- 修正当前 Claude `PreToolUse` 输出结构；收紧自动授权名单，只允许明确只读工具和 HTTPS WebFetch。
- 移除永久 700 ms/3 s 前端轮询，改为事件和 `ResizeObserver`。
- 新增三平台 CI/release 工作流、引导脚本、离线结构检查和 6 个迁移冒烟。
- 原 33 个核心测试文件继续通过。
- 计量、transcript、完整多 provider、精确终端聚焦和领地原生实现尚未迁移；详见 `docs/MIGRATION_STATUS.md`。

## 0.1.1 — deep runtime hardening + CodeWhale catalog v2 + models.dev sync (2026-07-20)

### CodeWhale catalog v2 + live sync

- Expanded `backend/model-catalog.bundled.json` from 31 to **49 entries**, now covering every model registered in CodeWhale's `crates/agent/src/lib.rs` ModelRegistry: added `deepseek-chat`, `deepseek-reasoner`, `kimi-k3`, `moonshotai/kimi-k3`, `glm-5.1`, `glm-5-turbo`, `z-ai/glm-5.1`, `z-ai/glm-5-turbo`, `gpt-5.5`, `gpt-5.5-pro`, `grok-4.5`, `grok-4.3`, `grok-build`, `grok-composer-2.5-fast`, `grok-4.20-0309-reasoning`, `grok-4.20-0309-non-reasoning`, `LongCat-2.0`, `longcat-2.0`, `minimax-m3`.
- Added vendor-published `cache_read_usd_per_million` / `cache_write_usd_per_million` fields per catalog entry. Previously the metering code used a single `0.1× input / 1.25× input` heuristic for all models; vendor reality differs significantly:
  - Xiaomi MiMo: cache_read ≈ 2% of input (heuristic over-charged 5×)
  - Z.AI GLM-5.x: cache_read ≈ 18.6% of input
  - xAI Grok: cache_read 15-20% of input
  - Meta Muse Spark: cache_read 12% of input
  - MiniMax M3: cache_read 20% of input
  - Meituan LongCat-2.0: cache_read 2% of input
  - Xiaomi MiMo / Z.AI GLM-5.x cache_write: vendor-limited-time-free ($0)
- Fixed wrong prices:
  - `deepseek-v4-pro` was $2/$8 (CNY misread as USD) → correct $0.435/$0.87 per DeepSeek's official pricing page + models.dev catalog
  - `deepseek-v4-flash` was $0.5/$2 → correct $0.14/$0.28
  - `gpt-5.6-terra` was $3/$20 → correct $2.50/$15 per OpenAI pricing page
  - `gpt-5.6-luna` was $2/$10 → correct $1/$6
- Fixed wrong context windows: `grok-build` was 512K (correct 256K, official SKU `grok-build-0.1`), `grok-4.20-0309-reasoning/non-reasoning` were 2M (correct 1M per xAI docs).
- **New: Models.dev live catalog sync** (`backend/models-dev-sync.js`). Mirrors CodeWhale upstream's `crates/tui/src/models_dev_live.rs` design:
  - Background async fetch from `https://models.dev/catalog.json` (MIT-licensed, ~3 MB, 5000+ models)
  - 24-hour TTL, 15-second timeout, 64 MiB response cap, no credentials/cookies
  - Atomic write to `~/.octopus/catalog/models-dev.json` (0600 permissions)
  - Three-layer lookup: live cache > bundled seed > null (token-only)
  - Official-provider priority: when multiple providers serve the same model id (e.g. `deepseek-v4-pro` is served by both `deepseek` at $0.435/$0.87 and aggregator `frogbot` at $1.74/$3.48), the official provider wins
  - Graceful degradation: failure to fetch falls back to stale cache or bundled seed; never blocks startup
  - Env knobs: `OCTOPUS_MODELS_DEV_URL`, `OCTOPUS_MODELS_DEV_PATH`, `OCTOPUS_DISABLE_MODELS_DEV_FETCH`, `OCTOPUS_NO_NET`
  - Schema validation: rejects absurd prices (>$1000/M), oversized context (>100M), malformed JSON; preserves `null` distinct from `0` (free)
  - HTTPS-only (refuses http:// URLs to prevent MITM)

### Metering behavior

- Removed `DEFAULT_FALLBACK` ($1/$5 fabricated estimate) for unknown models. `priceFor()` now returns `null`, the metering records tokens honestly with `cost=0`, and the per-model daily aggregate carries an `unknownPrice` counter so the UI can show an "unknown price" badge instead of implying the user spent $0.
- Removed the parallel `FALLBACK_PRICING` table; the catalog is now the single source of truth. Previously a fallback table could silently mask data loss if the catalog lost an entry.
- Cache pricing now uses vendor-published rates when available and only falls back to the 10%/1.25× heuristic when the vendor truly doesn't publish (e.g. Arcee Trinity, grok-composer).
- Fixed `loadCatalog` to preserve `null` cache_write/cache_read distinct from explicit `0` (free) — previous code coerced `Number(null)` to `0`, hiding the "vendor doesn't publish" signal.

### Security

- Upgraded Electron from 33.x to 43.1.1 and enabled renderer sandboxing, context isolation, web security, restrictive CSP, sender-validated IPC, navigation/webview/window blocking, download denial and deny-by-default browser permissions.
- Added a cryptographically random per-launch token to all local hook/server routes, private runtime-file permissions, constant-time token comparison, slow-body timeouts and HTTP connection/header limits.
- Reworked permission bridges to fail closed to `ask`, bounded pending/duplicate queues and made CodeWhale batch approval session-scoped with inactivity expiry and lifecycle cleanup.
- Hardened all persisted metering data against prototype-pollution keys, malformed maps, non-finite numbers and unbounded collections; private file modes are restored after atomic rename.
- Added bounded startup JSON/TOML readers, shell-safe command quoting and strict transcript/session path, symlink and size checks.

### Performance and reliability

- Replaced whole-unread-transcript allocation with 4 MiB fixed-memory JSONL chunks, a 32 MiB per-scan global budget, round-robin progress, a 5000-file cap and oversized-line forward progress.
- Cached unchanged transcript tails, capped live sessions at 256, bounded startup/backfill scans and limited CodeWhale session-list parsing to 100 candidates / 64 MiB total.
- Changed periodic stats refresh to non-overlapping one-shot scheduling, bounded asynchronous logging, added HTTP recovery after incomplete requests and retried hook installation during slow startup.
- Repaired pet/panel bounds after monitor removal or resolution changes; panel opens on the pet's display.
- Fixed model aliases with missing catalog prices, Unix CLI discovery, quoting of paths with spaces, Windows Node-mode hook uninstall and default `--no-sandbox` packaging regressions.

### Packaging, tests and documentation

- Added missing provider/runtime files to package manifests, retained production dependencies in Windows portable builds and kept the Chromium sandbox enabled unless an explicit diagnostic environment variable is set.
- Expanded the core suite to **20 files** (was 18), 60+ file syntax traversal and 92 Windows assertions; added security, oversized-input, persistence, package-consistency, models.dev sync (unit + integration), and stress tests.
- New test files:
  - `test/models-dev-sync.js`: unit tests for transform/validate/cache logic (20+ assertions, includes live fetch verification)
  - `test/models-dev-sync-integration.js`: end-to-end tests covering bundled-only, live-override, stale-cache, corrupted-cache, live-fetch, non-blocking, env-override scenarios (8 tests)
- Updated `docs/CODEWHALE.md` §Token 计量与花费 with the new pricing model, vendor cache rate table, models.dev sync architecture, and the list of price corrections.
- Updated README "CodeWhale 一等公民支持" section to highlight the catalog v2 upgrade and models.dev sync.
- Added `MODEL-PRICING-RESEARCH.md` and `MODEL-PRICE-SYNC-RESEARCH.md` (shipped with source tarball, not in portable zip) documenting every price's vendor URL, access date, and the sync design rationale.
- All 20 core tests pass; all 92 Windows adaptation assertions pass.

## 0.1.0 — initial audited fork

- Initial Claude Code / CodeWhale desktop pet fork and first-round upstream synchronization.
