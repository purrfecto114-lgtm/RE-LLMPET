# Release Notes — Octopus 0.5.6 (2026-07-30)

**Octopus** (RE-LLMPET) — 低占用多 Agent 桌面宠物，Tauri 2 + Rust 原生 provider 适配层。

## 里程碑：视觉迁移全部完成

本 release 完成 R9 路线图的全部视觉迁移：
- **托盘视觉元素 18/18** ✅（R10-R14）
- **面板视觉元素 10/10** ✅（R15-R19）

从 R9 的 6/18 托盘 + 0/2 Codex 面板，到 0.5.6 的 18/18 + 10/10，共完成 22 项视觉迁移 + 5 项 i18n 审计修复 + 1 项 metering 双字段。

## 新功能

### 托盘菜单（R10-R14）
- **完全 i18n 化**：29 键 × 3 语言（zh/en/ja），语言切换即时刷新菜单 + tooltip
- **语言子菜单**：zh/en/ja 三选一
- **形象子菜单**：章鱼/像素怪兽/月薪喵三选一
- **5h 预算子菜单**：off/$10/$20/$30/$50/$100 六选一
- **静音复选**：label 在 mute/unmute 间翻转
- **形态子菜单**：浮游桌宠/角落面板/仅托盘（隐藏桌宠）— hidePet 替代上游 menubar
- **设置占位**：disabled，视觉对齐上游
- **卸载 Claude 钩子**：单 provider 卸载，保留用户其他配置
- **tooltip**：本地化，随语言切换刷新

### 面板（R15-R19）
- **Codex 5h 配额条**：冷色调，与 5h 预算暖色区分
- **Codex 今日/累计 token 网格**：compact 样式
- **Token/Cost 切换**：24h 图表 + 日历均支持
- **诊断行**：transcript 扫描时间/文件数/记录数/修正次数/价目过期
- **缓存写入 5m/1h 双行**：与上游 metering.js 对齐，解析 Anthropic `ephemeral_5m/1h_input_tokens`
- **会话列表 Pin/归档**：📌 Pin 浮顶 + 📥 归档隐藏 + attention filter（只看待处理）
- **持久化**：Pin/归档存到 config，跨 panel 重开保持

### 修复
- **R10 编译阻塞**：`TrayIconBuilder::new("main-tray")` → `.with_id("main-tray")`（Tauri 2.11.5 API）
- **R10 内部矛盾**：CodeWhale doctor 顺序从 dispatcher-first 改为 companion-first（与项目文档一致）
- **R17 i18n 审计**：5 处硬编码中文改用 i18n keys（today-tokens/win-reset/cal mouseover/renderByModel/renderProviderCost）

## 验证

| 检查项 | 结果 |
|---|---|
| `npm test` | **45/45 PASS** |
| `npm run check:static` | **22/22 PASS** |
| `python3 scripts/rust-structure-smoke.py` | **3/3 PASS** |
| `./cli-smoke-test.sh` | **31 PASS / 0 FAIL / 7 SKIP** |
| migration-todo | 47 tasks (4 done, 40 implemented-uncompiled, 3 blocked, 1 deferred) |

### 新增冒烟测试套件（R10-R19）
- `tauri-codewhale-doctor-consistency-r10-smoke.js` (19 checks)
- `tauri-tray-i18n-r11-smoke.js` (29 keys)
- `tauri-tray-submenu-r12-smoke.js` (4 submenus + routing)
- `tauri-tray-extras-r13-smoke.js` (settings + uninstall + tooltip)
- `tauri-tray-shape-r14-smoke.js` (shape + set_mode window side-effect)
- `tauri-panel-codex-r15-smoke.js` (HTML + CSS + JS + i18n)
- `tauri-panel-metrics-r16-smoke.js` (metric-tabs + diagnostics)
- `tauri-panel-i18n-audit-r17-smoke.js` (8 i18n calls + 7 hardcoded removals)
- `tauri-metering-cw-split-r18-smoke.js` (UsageEvent + Aggregate + parse + panel)
- `tauri-panel-sesslist-r19-smoke.js` (AppConfig + set_session_prefs + bridge + JS + i18n)

## 重要限制

**这是一个源码级 release candidate，不是稳定生产 release。**

### 未在本环境验证
- `cargo check --locked` 三平台（沙箱无 Rust 工具链）
- 真实 CodeWhale/Codex/OpenCode/Aider CLI 执行
- 真实 GUI：托盘子菜单渲染、面板双行、Pin/归档持久化
- Windows/macOS/Linux 签名 bundles、SBOM、校验和

### 正式发布前必须完成（按 `docs/RELEASE.md`）
1. Linux/Windows/macOS `cargo check/test/build --locked` 通过
2. 五个 Provider 的隔离 HOME 真实 CLI smoke
3. 三平台 GUI、托盘、终端聚焦、休眠/多显示器、性能门禁
4. Windows 签名、macOS 签名/公证、Linux 基线包、更新包签名、SBOM、校验和

## 下载

| 文件 | 用途 |
|---|---|
| 源码树 | `/home/z/my-project/work/llmpet_extracted/RE-LLMPET-v0.5.5-reworked-r8/` |
| `cli-smoke-test.sh` | CLI 冒烟测试脚本（10 维度验证） |
| `CHANGELOG.md` | 完整 R10-R19 变更历史 |
| `docs/MIGRATION_STATUS.md` | 迁移状态（18/18 托盘 + 10/10 面板） |
| `docs/MIGRATION_R10_R11_ROUNDUP_2026-07-30.md` ~ `MIGRATION_R19_SESSLIST_2026-07-30.md` | 各轮决策记录 |

## 升级路径

从 0.5.5 升级到 0.5.6：
1. `git pull` 或解压新源码包
2. `npm ci --ignore-scripts`
3. `npm test`（应 45/45 PASS）
4. `cargo tauri dev`（需 Rust 1.85+ + Tauri 2.11.5 系统依赖）

配置文件向后兼容：
- `cache_write_5m`/`cache_write_1h` 有 `#[serde(default)]`，旧 ledger JSON 自动补 0
- `pinned_sessions`/`archived_sessions` 默认空 Vec，旧 config 自动补
- `hidePet` mode 是新增合法值，旧 config 的 `pet`/`panel`/`menubar` 仍有效

## License

MIT — 见 `LICENSE`。
