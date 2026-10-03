# R10 + R11 迁移轮交付报告

**日期**: 2026-07-30 (Asia/Shanghai)
**作者**: 主 Agent (Super Z)
**前置**: R9 调查报告 (`/home/z/my-project/download/R9-understanding-report.md`)

---

## 本轮成果概览

| 指标 | R9 基线 | R10+R11 后 | 变化 |
|---|---|---|---|
| 冒烟测试通过率 | 35/35 | **37/37** | +2 新套件（r10 一致性 19 项 + r11 i18n 23 项） |
| 静态检查 | 22/22 | **22/22** | 保持 |
| rust-structure-smoke | 3/3 | **3/3** | 保持 |
| migration-todo 任务数 | 35 | **38** | +3 R10/R11 任务 |
| 编译阻塞 bug | 1 (TrayIconBuilder::new) | **0** | 已修复 |
| 内部矛盾（docs/impl/tests） | 1 (CodeWhale doctor) | **0** | 已修复 |
| 托盘菜单 i18n 覆盖 | 0/18 | **18/18** (结构层 + 语言层) | 全覆盖 |
| 跨源一致性契约 | 0 | **2** (r10 + r11) | 新增 |

---

## R10：CodeWhale doctor 顺序修复 + 编译阻塞解阻

### 用户报告的问题

R8 半成品存在内部矛盾：
- `docs/CODEWHALE.md` L15、R5 自主深挖报告 §"CodeWhale doctor 的真实命令边界"、R5 TODO L17 都说 `doctor` 属于 `codewhale-tui`，应直接运行 `codewhale-tui doctor --json`，不依赖 dispatcher 别名
- 但 `commands.rs` `codewhale_doctor_probe` 是 **dispatcher-first**，companion 仅作回退
- `scripts/windows-cli-diagnostics.ps1` 同步镜像了 dispatcher-first
- 3 个冒烟测试 (r3/r5/r7) 把 dispatcher-first 锁为"正确契约"

**结果**: 测试全绿但保护了一个已知漂移；每次诊断可能先产生一次无意义失败。

### Web 交叉验证（子 Agent R10-webverify）

发现 CodeWhale 上游 `docs/RUNTIME_API.md` 实际将 `codewhale doctor --json` 标记为 "Capability endpoint... Suitable for health-check polling"。**CodeWhale 自身认为 dispatcher-first 是 canonical**。

### 辩证决策

仍按用户字面要求改为 **companion-first + dispatcher fallback**，原因：
1. 项目内 docs/tests/impl 一致性是真正要修的维护风险
2. 任何 matched bundle 都保证 companion 存在（已强制 `MISSING_COMPANION_BINARY`）
3. 在 `CODEWHALE.md` 中加 NOTE 记录 Web 验证发现，方便后续维护者重评估
4. 若 CodeWhale 未来删除 `codewhale-tui doctor`，dispatcher fallback 仍保诊断可用

### 修复内容

| 文件 | 修改 |
|---|---|
| `src-tauri/src/commands.rs` | `codewhale_doctor_probe` 重写为 companion-first；dispatcher 仅在 `companion_is_definitive=false` 且 `should_try_dispatcher=true` 时执行 |
| `scripts/windows-cli-diagnostics.ps1` | 镜像：`$agents['codewhale-tui']` 先探，`$agents['codewhale']` 回退 |
| `test/tauri-cli-hardening-r3-smoke.js` | 断言改名 "companion-first fallback chain" |
| `test/tauri-cli-diagnostics-r5-smoke.js` | 断言改名 "companion-first dispatcher fallback" |
| `test/tauri-cli-resilience-r7-smoke.js` | 4 项断言重定向：companion surface 启动、dispatcher 仅在 schema 漂移时回退、PS1 镜像 companion-first |
| `test/tauri-codewhale-doctor-consistency-r10-smoke.js` | **新增** 19 项跨源一致性检查 |
| `docs/CODEWHALE.md` | 明确 companion-first 决策 + RUNTIME_API.md Web caveat NOTE |
| `docs/MIGRATION_R10_CODEWHALE_DOCTOR_ORDER_2026-07-30.md` | **新增** 决策记录 |
| `package.json` | test:smoke 链加入新测试 |

### 同轮解决的编译阻塞

- `lib.rs:181` `TrayIconBuilder::new("main-tray")` → `TrayIconBuilder::with_id("main-tray")`（Tauri 2.11.5 `.new()` 取 0 参）
- 删除 `lib.rs:240` 冗余 `app.manage(tray)`（`with_id` 后由 `tray_by_id` 查找，重复管理导致 shutdown 所有权歧义）
- `test/tauri-static-smoke.js` 新增 4 项 TrayIconBuilder API 契约断言
- `test/tauri-native-core-smoke.js` 将 `app.manage(tray)` 必须存在的旧断言改为必须不存在

---

## R11：托盘 i18n + refresh_tray_menu

### 目标

R8 `setup_tray` 一次性构建，所有标签硬编码中文；用户在面板切换语言后，OS 渲染的托盘标签仍停留在中文。R9 路线图 R11 要求：托盘 i18n 化 + 实现 `refresh_tray_menu` 在 `set_language` 后重建。

### 实现

1. **新建 `src-tauri/src/i18n.rs`**：
   - 23 项静态表 `TRAY_LABELS: &[(&str, &str, &str, &str)]`，每项 `(key, zh, en, ja)`
   - `pub fn tray_label(lang: &str, key: &str) -> &'static str` 查找函数
   - `pub fn known_keys() -> Vec<&'static str>` 辅助
   - 未知 lang 回退到 zh（项目主语种）；未知 key 回退到 key 本身（可见的失败）

2. **重构 `lib.rs` `setup_tray`**：
   - 抽出 `fn build_tray_menu<R: Runtime>(app: &impl Manager<R>, lang: &str) -> Result<Menu<R>>`
   - 所有 `MenuItem::with_id` 标签走 `i18n::tray_label(lang, "tray.xxx")`
   - Item id 保持稳定（"show" / "panel" / "launch_claude" 等），与语言无关
   - `setup_tray` 从 `AppState.runtime.config().lang` 读取当前语言

3. **新增 `pub fn refresh_tray_menu(app: &AppHandle)`**：
   - 读 `AppState.runtime.config().lang`
   - `app.tray_by_id("main-tray")` 查找托盘
   - `build_tray_menu(app, &lang)` 构建新菜单
   - `tray.set_menu(Some(menu))` 替换（Tauri 2.11.5 API）
   - 失败时写日志，不阻塞退出

4. **修改 `commands.rs` `set_language`**：
   - 在 `emit_config(&app, &state)` 后调用 `crate::refresh_tray_menu(&app)`
   - 语言切换 → 渲染层 emit_config → 原生层 refresh_tray_menu → OS 托盘即时刷新

5. **前端 i18n.js 扩展**：新增 4 个键 × 3 种语言：
   - `tray.launchCodewhale` (🐳 唤起 CodeWhale / 🐳 Launch CodeWhale / 🐳 CodeWhale を起動)
   - `tray.launchOpencode` (🔌 ...)
   - `tray.launchAider` (🤝 ...)
   - `tray.launchAgent` (新开 Agent / Launch agent / エージェントを起動) — 子菜单标题

6. **新增 `test/tauri-tray-i18n-r11-smoke.js`**：23 项跨源一致性检查
   - 解析 `i18n.rs` 的 `TRAY_LABELS` 表
   - 解析 `frontend/shared/i18n.js` 的 zh/en/ja 三个 lang block
   - **逐键逐语言对比**，任何 mismatch 立即失败
   - 验证 `lib.rs` 有 `build_tray_menu` / `refresh_tray_menu` / `tray.set_menu(Some(menu))`
   - 验证 `commands.rs` `set_language` 调用 `crate::refresh_tray_menu(&app)`
   - 验证 tray id `"main-tray"` 稳定（refresh 可查找）

7. **更新 `reports/upstream-import-provenance.json`**：i18n.js 的 `destinationSha256` 改为新哈希 `d6a18f69...`，adaptation 字段加 R11 备注。

### 关键设计决策

- **静态表 vs 运行时解析 JS**：选静态表。避免在 Rust 中嵌入 JS 解析器；编译期可审计；smoke test 是契约。
- **泛型 `build_tray_menu<R: Runtime>`**：让 `setup_tray(&mut App)` 和 `refresh_tray_menu(&AppHandle)` 共用同一函数；item id 稳定确保 handler 不需感知语言。
- **emoji 前缀**：与上游 Electron tray.launchClaude = "🚀 唤起 Claude" 模式对齐；CodeWhale/OpenCode/Aider 各分配语义 emoji（🐳/🔌/🤝）。
- **不迁移 duo-pet / territory patrol**：按 R9 §6.3 决策，duo-pet 已过时（R8 统一 5-provider 面板），territory patrol 1700 LOC 显式 deferred。

---

## 跨源契约矩阵（新增）

| 契约 | 锁定方式 | 失败后果 |
|---|---|---|
| CodeWhale doctor companion-first | `tauri-codewhale-doctor-consistency-r10-smoke.js` 19 项 | 任何 docs/impl/ps1/smoke 不一致 → 立即失败 |
| TrayIconBuilder::with_id API | `tauri-static-smoke.js` 4 项 | 误用 `.new("id")` → 立即失败 |
| 托盘 i18n 跨源一致 | `tauri-tray-i18n-r11-smoke.js` 23 项 | i18n.rs 与 i18n.js 任何 mismatch → 立即失败 |
| 托盘 id "main-tray" 稳定 | r11 smoke + r10 smoke | id 漂移 → refresh_tray_menu 找不到托盘 → 立即失败 |

---

## 未在本环境验证

按 `docs/MIGRATION_STATUS.md` 的 release gate 要求，以下仍需有 cargo / GUI / 真实 CLI 的环境验证：

1. **`cargo check --locked`** 三平台（沙箱无 Rust 工具链）
   - 验证 `TrayIconBuilder::with_id` 真的编译通过
   - 验证 `build_tray_menu<R: Runtime>` 泛型边界正确
   - 验证 `tray.set_menu(Some(menu))` 在 Tauri 2.11.5 真实存在
   - 验证 `app.state::<AppState>()` 从 `&mut App` 与 `&AppHandle` 都能调用
2. **真实 CodeWhale v0.9.1 CLI**：companion-first 探测在 healthy install 上单次成功
3. **三平台 GUI**：切换语言后托盘标签即时刷新
4. **Windows PowerShell**：`windows-cli-diagnostics.ps1` 实际运行 companion-first 顺序

---

## 下一轮 R12 预告（按 R9 路线图）

**目标**: 托盘子菜单补齐（语言/形象/预算/静音）

按 R9 §4.1 差异矩阵，仍缺 9 项托盘视觉元素：
- 语言子菜单（zh/en/ja 单选）
- 形象子菜单（章鱼/像素怪兽/月薪喵 单选）
- 5h 预算子菜单（off/2/5/10 单选）
- 静音/取消静音（复选）
- 设置占位
- 卸载钩子
- 形态（改写 menubar 为 hide-pet-only）
- 巡视（保持 stub 或移除）

R12 将用 `SubmenuBuilder` + `CheckMenuItem` + `PredefinedMenuItem::separator()` 补齐前 4 项（高优先级、零风险，i18n keys 已存在，命令本体已存在）。新增冒烟测试 `tauri-tray-submenu-r12-smoke.js`。

---

## 文件清单

### 新增
- `src-tauri/src/i18n.rs`
- `test/tauri-codewhale-doctor-consistency-r10-smoke.js`
- `test/tauri-tray-i18n-r11-smoke.js`
- `docs/MIGRATION_R10_CODEWHALE_DOCTOR_ORDER_2026-07-30.md`
- `docs/MIGRATION_R10_R11_ROUNDUP_2026-07-30.md`（本文件）
- `/home/z/my-project/scripts/r10_codewhale_doctor_fix.py`（可重放补丁脚本）

### 修改
- `src-tauri/src/lib.rs`（mod i18n; build_tray_menu; refresh_tray_menu; setup_tray 重构；TrayIconBuilder::with_id; 删 app.manage）
- `src-tauri/src/commands.rs`（codewhale_doctor_probe companion-first; set_language 调用 refresh_tray_menu）
- `scripts/windows-cli-diagnostics.ps1`（companion-first 块顺序）
- `frontend/shared/i18n.js`（+4 keys × 3 langs）
- `test/tauri-static-smoke.js`（+4 TrayIconBuilder API 断言）
- `test/tauri-native-core-smoke.js`（app.manage→with_id 断言重定向）
- `test/tauri-cli-hardening-r3-smoke.js`（断言改名）
- `test/tauri-cli-diagnostics-r5-smoke.js`（断言改名）
- `test/tauri-cli-resilience-r7-smoke.js`（4 项断言重定向）
- `docs/CODEWHALE.md`（companion-first 决策 + Web caveat NOTE）
- `reports/upstream-import-provenance.json`（i18n.js 哈希更新）
- `package.json`（test:smoke 链 +2 新测试）
- `migration-todo.json`（+3 R10/R11 任务，updatedAt 2026-07-30，release r11）

### 工作日志
- `/home/z/my-project/worklog.md` 共 244 行，含 R9 + 4 个子 Agent + R10 + R11 共 7 段工作记录
