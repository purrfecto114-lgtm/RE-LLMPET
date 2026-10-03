# R13 托盘剩余项 + tooltip — 2026-07-30

## 目标

按 R9 路线图 R13，补齐托盘剩余 3 项（设置占位 / 卸载 Claude 钩子 / tooltip），让托盘视觉与上游 Electron 完全对齐（除 shape 子菜单外）。shape 子菜单需要 `set_mode` 增加窗口隐藏副作用，涉及行为变更，推迟到 R14。

## 实现

### 1. 设置占位项
- `build_tray_menu` 新增 `MenuItem::with_id(app, "settings", tray.settings, enabled=false, None)`
- `enabled=false` 让该项灰显，点击无响应；视觉上对齐上游 Electron 的"设置"占位
- 真实设置面板从 dashboard 进入，托盘不是设置入口

### 2. 卸载 Claude 钩子
**新增 Tauri 命令 `uninstall_hooks`**（`src-tauri/src/commands.rs`）：
- 参数：`app: AppHandle, state: State<AppState>, provider: String`
- 验证 `provider ∈ {claude, codewhale, codex, opencode, aider}`（防注入）
- 调用 `hook_install::uninstall_provider_hooks(&provider)` 移除该 provider 的 Octopus 自有 hook 块
- 写日志、`resync_current` 刷新 provider 状态、`emit_config` 通知前端
- 返回 `{provider, path, message}` JSON

**新增 `hook_install::uninstall_provider_hooks` 公开包装**：
- 包装私有 `uninstall_provider(id)`
- 让托盘能单 provider 卸载而不影响其他 provider 配置

**托盘菜单项**：
- id: `uninstall_claude_hooks`（id 名字保留 "claude" 以匹配上游 Electron 标签）
- label: `tray.uninstallHook`（🧹 卸载 Claude 钩子 / 🧹 Uninstall Claude hooks / 🧹 Claude フックを削除）
- on_menu_event 路由到 `uninstall_hooks(app, state, "claude".into())`

### 3. 本地化 tooltip
- `TrayIconBuilder::with_id("main-tray").tooltip(i18n::tray_label(&lang, "tray.tooltip"))`
- `refresh_tray_menu` 现在同时调用 `tray.set_tooltip(Some(...))` 和 `tray.set_menu(Some(...))`
- 语言切换时，托盘菜单标签 + tooltip 全部同步刷新

### 4. 菜单最终顺序
```
显示桌宠
打开详情
─────────  (sep1)
🌐 语言 / Language  ▸
　形象  ▸
　5h 预算  ▸
　🔇 静音  [✓]
─────────  (sep2)
⚙️ 设置 (disabled)
新开 Agent  ▸
📄 打开日志
🧹 卸载 Claude 钩子
─────────  (sep3)
⏻ 退出
```

### 5. 注册链
- `src-tauri/src/lib.rs` invoke_handler 加 `uninstall_hooks,`
- `src-tauri/build.rs` COMMANDS 加 `"uninstall_hooks"`
- `test/tauri-tray-extras-r13-smoke.js` 锁定跨源契约

## 验证

- `npm test` — **39/39 PASS**（新增 `tauri-tray-extras-r13-smoke`）
- `npm run check:static` — 22/22 PASS
- `python3 scripts/rust-structure-smoke.py` — 3/3 PASS
- `migration-todo` — 40 tasks valid（+1 R13 task）

## 托盘视觉元素覆盖（R9 §4.1 矩阵最终更新）

| # | 上游菜单项 | 状态 |
|---|---|---|
| 1 | 显示桌宠 | ✅ |
| 2 | 打开详情 | ✅ |
| 3 | 新开 Agent 子菜单（5 providers） | ✅ R8 独有增强 |
| 4 | 打开日志 | ✅ |
| 5 | 退出 | ✅ |
| 6 | Codex 桌宠（duo） | ❌ 拒绝（R8 统一面板） |
| 7 | **设置占位** | ✅ **R13** |
| 8 | 语言子菜单 | ✅ R12 |
| 9 | 形象子菜单 | ✅ R12 |
| 10 | 形态子菜单 | ⏳ R14（menubar→hidePet 改写） |
| 11 | 5h 预算子菜单 | ✅ R12 |
| 12 | 自动巡逻 | ⏳ deferred（1700 LOC territory.js） |
| 13 | 立即巡视 | ⏳ deferred |
| 14 | 静音/取消静音 | ✅ R12 |
| 15 | **卸载 Claude 钩子** | ✅ **R13** |
| 16 | **tray.tooltip** | ✅ **R13** |
| 17 | 左键托盘显示 | ✅ |
| 18 | refreshTrayMenu 动态重建 | ✅ R11（R13 扩展含 tooltip） |

**已完成 17/18**，仅剩 shape 子菜单 → R14。

## 未在本环境验证

- `cargo check --locked`（沙箱无 Rust 工具链）— 验证 `uninstall_hooks` 命令编译、`uninstall_provider_hooks` 公开包装可见性、`tray.set_tooltip` API 存在
- 真实卸载行为：点击托盘"卸载 Claude 钩子"后 `~/.claude/settings.json` 中 Octopus hook 块被移除，用户其他配置保留
- 三平台 tooltip 视觉：Windows/macOS/Linux 悬停托盘时显示本地化 tooltip
- 语言切换后 tooltip 是否即时刷新（refresh_tray_menu 现已调用 set_tooltip）

## 下一轮 R14 预告

**shape 子菜单**（pet / panel / hidePet 三选一）：
- `set_mode` 增加 `hidePet` 模式：隐藏 pet 窗口，仅保留托盘
- `model.rs` sanitize 接受 `"hidePet"` 作为合法 mode 值
- `build_tray_menu` 加 shape 子菜单（3 个 CheckMenuItem）
- on_menu_event 路由 shape_pet/shape_panel/shape_hidePet 到 set_mode + refresh_tray_menu
- set_mode 命令增加窗口显示/隐藏副作用：pet 模式 show pet 窗口，hidePet 模式 hide pet 窗口
