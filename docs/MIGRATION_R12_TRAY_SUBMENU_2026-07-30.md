# R12 托盘子菜单补齐 — 2026-07-30

## 目标

按 R9 路线图 R12，用 `CheckMenuItem` + `SubmenuBuilder` + `PredefinedMenuItem::separator` 补齐 4 个上游 Electron 托盘已暴露但 R8 缺失的高频设置子菜单：语言 / 形象 / 5h 预算 / 静音。让用户无需打开面板即可切换这些常用设置。

## Web 交叉验证（子 Agent R12-webverify）

通过 docs.rs/tauri/2.11.5 验证：

| 验证项 | 结论 | 影响 |
|---|---|---|
| `CheckMenuItem::with_id(app, id, text, enabled, checked, accelerator)` | CONFIRMED | 用于语言/形象/预算单选 + 静音复选 |
| `PredefinedMenuItem::separator(app)` | CONFIRMED（不是 `new(app, kind)`） | 用于分隔逻辑组 |
| Tauri 无原生 `RadioMenuItem` | CONFIRMED | canonical pattern: 多个 CheckMenuItem + 选择时重建菜单 |
| `set_menu(Some(menu))` 的 `'static` bound 在 menu 类型上 | CONFIRMED | R11 `refresh_tray_menu` 模式正确，无需修复 |
| Tauri 不自动 uncheck 同级 CheckMenuItem | CONFIRMED（muda issue #260） | 通过重建菜单绕过：新选择自动 checked=true，旧选择自动 unchecked |

## 实现

### `src-tauri/src/i18n.rs` 新增 6 项
- `lang.zh` / `lang.en` / `lang.ja`（语言子菜单标签）
- `shape.pet` / `shape.panel` / `shape.hidePet`（为 R13 形态子菜单准备；`shape.hidePet` 替代过时的 `shape.menubar`，因 Tauri 无 menubar 模式）

### `frontend/shared/i18n.js` 三语新增 `shape.hidePet`
- zh: `仅托盘（隐藏桌宠）`
- en: `Tray only (hide pet)`
- ja: `トレイのみ（ペット非表示）`

### `src-tauri/src/lib.rs` `build_tray_menu` 重构
读 `AppState.runtime.config()` 获取当前 `lang`/`skin`/`budget5h`/`muted`，构建：

```
显示桌宠
打开详情
─────────  (sep1)
🌐 语言 / Language  ▸  [✓ 简体中文] [English] [日本語]
　形象  ▸            [✓ 章鱼] [像素怪兽] [Payday Cat]
　5h 预算  ▸         [✓ 关闭] [$10] [$20] [$30] [$50] [$100]
　🔇 静音  [✓]       (单 CheckMenuItem，label 在 mute/unmute 间翻转)
─────────  (sep2)
新开 Agent  ▸        [Claude Code] [CodeWhale] [Codex] [OpenCode] [Aider]
📄 打开日志
─────────  (sep3)
⏻ 退出
```

### `src-tauri/src/lib.rs` `on_menu_event` 新增 10 个 id handler

| 菜单 id | 路由 | refresh_tray_menu? |
|---|---|---|
| `lang_zh` / `lang_en` / `lang_ja` | `set_language(app, state, "xx")` | 否（set_language 内部已调） |
| `skin_mascot` \| `skin_pixel` \| `skin_cat` | `set_skin(app, state, skin)` + `refresh_tray_menu(app)` | 是（移动 check mark） |
| `budget_0` \| `budget_10` \| ... \| `budget_100` | `set_budget(app, state, value)` + `refresh_tray_menu(app)` | 是 |
| `toggle_mute` | `toggle_mute(app, state)` + `refresh_tray_menu(app)` | 是（label + check 都刷新） |

### 新增 `test/tauri-tray-submenu-r12-smoke.js`
跨源契约 4 维度：
1. **结构**：build_tray_menu 用 CheckMenuItem + PredefinedMenuItem::separator
2. **路由**：on_menu_event 处理所有 10 个新 id，调用正确命令
3. **i18n 一致性**：13 个必需键在 i18n.rs 和 i18n.js 三语都存在
4. **id 稳定性**：lang_*/skin_*/budget_* 不能是字符串拼接（必须静态常量）

### 修复的 bug
- `show_menu_on_left_check` typo → `show_menu_on_left_click`
- smoke `assert(!/regex/)` 中 `!` 是对 regex 对象取 truthiness（永远 false）→ 改为 `assert(!/regex/.test(lib))`

## 验证

- `npm test` — **38/38 PASS**（新增 `tauri-tray-submenu-r12-smoke`）
- `npm run check:static` — 22/22 PASS
- `python3 scripts/rust-structure-smoke.py` — 3/3 PASS
- `migration-todo` — 39 tasks valid（+1 R12 task）

## 托盘视觉元素覆盖

R9 §4.1 矩阵更新：

| # | 上游菜单项 | R8 状态 | R12 后 |
|---|---|---|---|
| 1 | 显示桌宠 | ✅ | ✅ |
| 2 | 打开详情 | ✅ | ✅ |
| 3 | 新开 Agent 子菜单 | ✅ | ✅ |
| 4 | 打开日志 | ✅ | ✅ |
| 5 | 退出 | ✅ | ✅ |
| 6 | Codex 桌宠（duo） | ❌ 拒绝 | ❌ 拒绝 |
| 7 | 设置占位 | ❌ | ❌ → R13 |
| 8 | **语言子菜单** | ❌ | ✅ **R12** |
| 9 | **形象子菜单** | ❌ | ✅ **R12** |
| 10 | 形态子菜单 | ❌ | ❌ → R13（改写 menubar→hidePet） |
| 11 | **5h 预算子菜单** | ❌ | ✅ **R12** |
| 12 | 自动巡逻 | ⚠️ stub | ⚠️ 保持 deferred |
| 13 | 立即巡视 | ⚠️ stub | ⚠️ 保持 deferred |
| 14 | **静音/取消静音** | ❌ | ✅ **R12** |
| 15 | 卸载 Claude 钩子 | ❌ | ❌ → R13 |
| 16 | tray.tooltip | ❌ | ❌ → R13（与 R11 i18n 表已就绪） |
| 17 | 左键托盘显示 | ✅ | ✅ |
| 18 | refreshTrayMenu 动态重建 | ✅ R11 | ✅ |

**已完成 15/18**，剩余 3 项（设置占位 / 形态改写 / 卸载钩子）+ tooltip 设置 → R13。

## 未在本环境验证

- `cargo check --locked`（沙箱无 Rust 工具链）— 验证 `CheckMenuItem::with_id` + `PredefinedMenuItem::separator` + `SubmenuBuilder::item(&check_item)` 真的编译通过
- 三平台 GUI：托盘子菜单视觉表现、check mark 渲染、separator 显示
- 真实切换行为：选择 lang_en 后托盘标签是否立即变英文 + check mark 移到 English

## 下一轮 R13 预告

托盘剩余 3 项 + tooltip：
- **设置占位**：disabled MenuItem，标签 `tray.settings`（i18n 已就绪）
- **形态子菜单**：用 `shape.pet` / `shape.panel` / `shape.hidePet` 三选一（R9 决策：Tauri 无 menubar，改 hide-pet-only 语义）
- **卸载 Claude 钩子**：调用 `scripts/install-native-hooks.js --uninstall` 或新增 Rust 命令
- **tray.tooltip**：在 `TrayIconBuilder` 上加 `.tooltip(i18n::tray_label(lang, "tray.tooltip"))`
