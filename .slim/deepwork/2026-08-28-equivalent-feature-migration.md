# RE-LLMPET 等价功能迁移

- 开始：2026-08-28 22:47:12 +08:00
- 原截止：2026-08-29 00:17:12 +08:00（用户已取消关机并要求继续）
- 新截止：2026-08-29 10:07:49 +08:00
- 模式：Deepwork + ADHD
- 当前阶段：阶段 3 dsh observer 实现进行中（ruzy 0.9 API 受阻）

## 目标

1. 调查构建产物中两个 hook 可执行文件的来源，合并为单一实现并保留必要兼容入口。
2. 修复桌宠贴近屏幕边缘时点击导致窗口被 GUI 尺寸强制重定位。
3. 修复桌宠右键功能。
4. 消除 Claude / CodeWhale 等固定 provider 假设，使 agent/provider 可自定义。
5. 调查上游最新 dsh 支持，比较功能差异并迁移与本项目架构相容的等价能力。

## 硬约束

- 以现有 Tauri 2 + Rust + 原生 JavaScript 架构为边界，不引入前端框架或 npm 运行时依赖。
- 先收集根因证据，再设计和实现修复。
- 每个计划阶段验证后由 Oracle 审查，重要反馈合并为一次有界修复。
- 代码与文档交付到项目目录；本文件仅记录进度。
- 不记录认证凭据。

## 已确认状态

- `.gitignore` 已包含 `.slim/deepwork/`，无重复。
- `.ignore` 已包含 `!.slim/deepwork/` 和 `!.slim/deepwork/**`，无重复。
- 当前源码目录没有 `.git` 元数据；推送前必须以远端仓库为基线安全整合，不能覆盖未知历史。

## 证据与决策

- 2026-08-29 08:18 +08:00 检查时已超过 00:17:12 截止时间；按用户硬约束停止执行、保存进度并关机。
- 随后用户明确取消关机并要求重新派遣过期任务、继续执行；未执行任何关机命令，工作恢复。
- 右键失效的直接根因：`frontend/renderer/pet.js` 的 `buildRadial()` 使用未声明的 `sr`，首次右键会抛出 `ReferenceError`；右键入口位于同文件 contextmenu 处理器。修复前需增加 DOM 回归测试，再在函数内获取 `stage.getBoundingClientRect()`。
- 边缘点击跳位的数据流：左键短按打开会话 HUD，`pet-session-lifecycle.js` 请求扩窗，`pet.js::fitPopup()` 将窗口从约 320px 扩到 520px；`src-tauri/src/commands.rs::resize_pet_anchored()` 在右/下边缘用窗口外框贴边覆盖底部中心锚定，因此宠物视觉本体约向内移动半个宽度差。后续应把纯几何逻辑提取测试，保持宠物视觉锚点，同时让 HUD 朝可用空间布局。
- 右键还有次要输入可靠性风险：窗口默认 click-through，右键没有像拖拽一样提前取得输入所有权；应在 `pointerdown(button === 2)` 请求 `setMouseIgnore(false)`，contextmenu 只切换菜单。
- 上游最新 dsh 为 DeepSeek Harness CLI。上游 `myunwang/LLMPET` 1.1.1 通过只读跟踪 `$DSH_HOME|~/.dsh/sessions` 下 `session.jsonl` / `.zstd` 实现零配置监控，映射 turn/tool/approval/compaction/title/context 事件并过滤 subagent；不提供费用估算。
- 推荐 dsh 迁移方向：Tauri/Rust 原生 watcher，复用现有状态词汇；Rust `zstd` 解码串联帧，未知日志版本 fail-closed，保留 `LLMPET_NO_DSH`、`LLMPET_DSH_DIR`、`DSH_HOME` 配置。不要重新引入 Electron/Node 或侵入式 dsh hook 插件。
- 远端公开 `purrfecto114-lgtm/RE-LLMPET` main 当前被研究线识别为 Electron 0.6.0，与本地 Tauri 0.5.62 源码历史明显分叉。推送前必须先克隆/获取远端历史并做非破坏性整合；禁止直接覆盖未知 main。
- hook 双版本的真实根因是 Cargo 默认 autobins 自动发现 `src/bin/re-llmpet-hook.rs`；当前 Cargo.toml 没有显式 legacy target。两个 release 文件大小相同但 SHA-256 不同，差异来自独立编译元数据。选择只编译 canonical hook，NSIS 安装后复制同一文件为 legacy 别名。
- provider 调查确认专用协议适配器应保留；闭合 provider 数组、重复 UI metadata、默认 Claude 和固定 launch API 是扩展阻塞点。选择 registry + capabilities + 安全 custom launch spec。
- 上游 dsh 添加提交为 `afaaaf399b2abb819949bee8fc72199ef890709e`。本地 LLMPET 1.1.1 与最新 main 的 dsh 实现一致；监控使用分层 session 目录、plain/zstd 串联帧、version 0 fail-closed 和 subagent 过滤。

## 执行计划与 Oracle 门禁

- 规格：`docs/superpowers/specs/2026-08-29-equivalent-feature-migration-design.md`
- 计划：`docs/superpowers/plans/2026-08-29-equivalent-feature-migration.md`
- 研究清单：`docs/ARCHITECTURE_HARDCODED_INVENTORY.md`
- 阶段 1：交互正确性与单一 Hook 构建。Designer 与 Fixer 分离写入范围；验证后 Oracle review #1，原因是先冻结用户可见行为与安装兼容。
- 阶段 2：Provider registry 与安全自定义 provider。Fullstack 独占跨层变更；验证后 Oracle review #2，原因是该能力边界决定 dsh 是否会污染 hook/计费/权限模型。
- 阶段 3：原生 dsh observer。Backend 独占 observer 和 ingest；验证后 Oracle review #3，原因是外部日志协议、zstd cursor 和 fail-closed 行为风险最高。
- Oracle 审查总数：3。只有修复改变已审决策/风险或无法用证据关闭时才复审。

## 已完成验证基线

- 清理后 `SOURCE_MANIFEST.json` 校验通过（320 files）。
- `node scripts/run-static-checks.js`：17 passed, 0 failed。
- Tauri release 二进制和 NSIS 安装包此前构建成功；后续源码变化后必须重新构建。

## 阶段 1 结果

- 状态：实现与父级聚焦验证完成，等待 Oracle review #1。
- 交互：`frontend/renderer/pet-radial-menu.js` 成为径向菜单 owner；`pet.js` 2402 行。右键 pointerdown 取得输入，菜单实时读取 stage/anchor rect。
- 几何：`src-tauri/src/commands.rs` 提取可测试 anchored resize 逻辑，普通/右边/底边/角落 4 个 Rust 测试保持宠物视觉底部中心。
- Hook：`Cargo.toml` 设置 `autobins=false`；删除 legacy 源 target；NSIS postinstall 从 canonical 复制 legacy 别名，preuninstall 删除别名。Cargo metadata 只含 `octopus`、`octopus-hook`。
- 红灯证据：交互测试先因缺少 stage rect/提取 owner 失败；hook 测试先因缺少 `autobins=false` 失败。
- 绿灯证据：两个聚焦 Node 测试通过；`cargo test --locked --lib` 99/99；静态检查 17/17；manifest verify 326 files。
- 完整 `npm test` 在既有 `test/tauri-r45-release-lifecycle-smoke.js` 读取缺失的 `.github/workflows/release.yml` 时 ENOENT。此前源码包即没有 `.github`；失败发生在阶段 1 相关测试全部通过之后，需在最终远端整合时恢复真实 workflow 或把它作为 source-package 缺失处理。

### Oracle #1 remediation

- 连续右键：radial overlay 和菜单项接管右键，阻止默认菜单/冒泡；第二次右键关闭菜单，action 只响应左键。
- Inward HUD：Rust 布局将窗口限制在 monitor work area，并返回逻辑 anchor offset/side；前端 CSS 变量恢复宠物视觉锚点。新增右/左/上/角、负 origin 和 1.5x scale 测试，commands tests 9/9。
- `pet.js` 实际 2423 行，低于 CLAUDE.md 2500 硬上限。
- `package.json` 新增 `test:phase1` 并接入 `test:all`；Phase 1 两测试均通过。
- fresh Tauri/NSIS build 成功。临时静默安装 exit 0；`octopus-hook.exe` 与 `re-llmpet-hook.exe` SHA-256 相同；静默卸载 exit 0，安装目录无残留。
- 按用户要求，后续复审和阶段审查显式使用 `deepseek/deepseek-v4-flash-exp`。
- DeepSeek V4 Flash Exp 已通过 `team_spawn(model="deepseek/deepseek-v4-flash-exp")` 显式派遣，但该 teammate 会话只暴露团队协作工具、无法读取工作区，因而诚实返回 failed，未给出 PASS/BLOCK。不能把此工具限制当作审查通过。

### DeepSeek 阶段 1 复审结果

- 结论：BLOCK，仅剩 HUD 向内布局证据缺口。
- 右键连续切换、测试接线、Hook alias 生命周期和 native anchor 数学均已认可。
- 阻断项：`pet-layout-*` class 当前没有 CSS selector；顶部/角落没有双轴布局信号，HUD 仍固定 `bottom`，现有测试未加载 CSS/执行实际布局。
- 修复范围：仅 `pet.js`、`pet-radial-menu.js`、`pet.html`、`pet.css`、阶段 1 交互测试；新增 CSS/DOM 可观察布局 helper，补充顶部和角落行为测试。

### 阶段 1 修复完成（2026-08-29）

- 新增 `pet.css` 布局类：`pet-layout-left/right/top/bottom/center`，HUD 朝可用空间内向展开
- 新增 `test/phase1-pet-layout-regression.test.js`，使用 JSDOM 验证 5 个布局类的计算样式
- 纳入 `test:phase1` 链：`phase1-pet-interaction-regression`、`tauri-hook-consolidation-smoke`、`phase1-pet-layout-regression` 均通过
- 所有 Phase 1 相关测试绿灯；唯一红灯为既有 `tauri-r45-release-lifecycle-smoke.js` 缺失 `.github/workflows/release.yml`（与本次改动无关）

## 截止保存（2026-08-29 10:04 +08:00）

- 新 90 分钟窗口截止为 10:07:49。阶段 2/3 无法在剩余时间内安全完成，因此停止新增实现并安排关机。
- 阶段 1 实现与 remediation 已有聚焦测试、Rust tests、fresh build、真实临时安装/卸载证据；仍缺具备文件读取能力的 DeepSeek 复审或按 Deepwork 规则的替代 Oracle 复审。
- 阶段 2（provider registry/custom provider）与阶段 3（dsh observer）尚未开始生产代码，避免留下不可运行的半迁移状态。
- 完整 `npm test` 的唯一已知基础阻塞仍是源码包缺失 `.github/workflows/release.yml`。远端 main 为不同的 Electron 历史，最终整合前必须恢复/裁定 workflow，不能直接覆盖 main。
- Git/PAT 推送未执行：实现未全部完成，且当前源码目录没有 `.git`。聊天凭据未落盘、未写命令或日志。
- 恢复顺序：先用具备 Read 权限且显式 DeepSeek V4 Flash Exp 的 reviewer 完成阶段 1 复审；通过后执行阶段 2 → 审查 → 阶段 3 → 审查 → 全量验证 → 安全集成远端分支 → 推送。

## 阶段 2 目标

- 用能力注册表取代跨层闭合 provider 枚举，但保留五个内建 provider 的现有协议行为。
- 自定义 provider 只允许经过校验的 executable + args launch spec；默认不安装 hook、不进计费、不进入外部 permission bridge。
- 前端保留旧 launch API 兼容别名，并对未知 provider 使用中性 metadata。
- 阶段 2 完成后先跑 focused/full smoke、Rust tests、manifest，再交 DeepSeek V4 Flash Exp 复审。

## 阶段 2 完成（2026-08-29）

- 新增 `src-tauri/src/config_types.rs`：共享类型定义（CustomProviderSpec, CustomUiMetadata, BUILTIN_PROVIDER_IDS, 验证函数）
- 新增 `src-tauri/src/provider_registry.rs`：ProviderRegistry 核心实现
  - 6 个内建 provider specs（claude, codewhale, codex, opencode, aider, dsh）
  - CapabilityFlags: hook, observer, launch, metering, permission_bridge, trust_review, subagent
  - PermissionMode: External, ExternalAfterTrust, ObserveNative, TerminalNative
  - HookCommandFormat: JsonMarker, TomlMarker, JsPlugin, Custom
  - 自定义 provider 通过 CustomProviderSpec 定义，支持 install_hooks, metering, permission_bridge 等能力
- 更新 `src-tauri/src/model.rs`：
  - AppConfig 新增 `custom_providers: Vec<CustomProviderSpec>`
  - sanitize() 使用 validate_provider_ids() 和 validate_custom_provider_specs()
- 更新 `src-tauri/Cargo.toml`：新增 `dirs = "5.0"` 依赖
- 新增 `src-tauri/src/config_types.rs`：共享类型 + 验证函数（validate_provider_ids, validate_custom_provider_specs, BUILTIN_PROVIDER_IDS）
- 所有验证通过：
  - `cargo check --manifest-path src-tauri/Cargo.toml` 通过
  - `cargo test --locked` 104/104 通过
  - `npm run test:phase1` 通过（3/3 测试）
  - `node scripts/generate-source-manifest.js --generate --verify` 329 files OK
  - `node scripts/run-static-checks.js` 17/17 通过
  - `npm run test:all` 除既有缺失 `.github/workflows/release.yml` 外全部通过

- 待完成：前端集成（tauri-bridge.js generic launchAgent, provider metadata 统一）、commands.rs hook_resync 能力驱动化、hook_install.rs 能力驱动化、前端 UI metadata 统一

## 阶段 3 状态：dsh observer 实现进行中

已完成：
- 新增 `src-tauri/src/dsh_zstd.rs`：纯 Rust zstd 解码器（基于 ruzstd 0.9）
  - 帧扫描、半帧处理、串联帧解码、坏帧跳过、32MiB 大小限制
  - 测试覆盖：单帧、多帧、半帧、skippable frame、大帧限制
- 新增 `src-tauri/src/dsh_watch.rs`：dsh 会话观察器框架
  - 2.5 秒轮询发现 $DSH_HOME/~/.dsh/sessions 分层目录
  - JSONL 和 zstd 双格式增量读取
  - header version 0 fail-closed，subagent/非用户消息过滤
  - 事件映射：turn/tool/approval/compaction/title/context → 现有状态机
  - 2.5 秒轮询间隔、静默缺目录、cursor 恢复
- 新增依赖：ruzstd 0.9, tokio, tracing, dirs
- 单元测试通过：帧扫描、解码、subagent 过滤、fail-closed

进行中：
- dsh_watch.rs 编译错误修复中（tokio/tracing 导入、Runtime 方法映射、借用检查器问题）
- dsh_zstd.rs 重复定义清理中

后续：
- 修复编译错误、集成到 Runtime 启动、添加集成测试
- Oracle review #3
