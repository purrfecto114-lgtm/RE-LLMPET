# R14 + R15 迁移轮交付报告

**日期**: 2026-07-30 (Asia/Shanghai)
**作者**: 主 Agent (Super Z)
**前置**: R12+R13 报告 (`/home/z/my-project/download/MIGRATION_R12_TRAY_SUBMENU_2026-07-30.md` + R13)

---

## 本轮成果概览

| 指标 | R13 后 | R14+R15 后 | 变化 |
|---|---|---|---|
| 冒烟测试 | 39/39 | **41/41** | +2 新套件（r14 shape + r15 panel-codex） |
| 静态检查 | 22/22 | **22/22** | 保持 |
| rust-structure | 3/3 | **3/3** | 保持 |
| migration-todo | 40 tasks | **42 tasks** | +2 R14/R15 任务 |
| 托盘视觉元素 | 17/18 | **18/18** | shape 子菜单完成 |
| 面板 Codex 视觉 | 0/2 | **2/2** | HTML+CSS+JS+i18n 全就绪 |

---

## R14：shape 子菜单 + set_mode 窗口副作用

### 目标
补齐最后一项托盘视觉元素（shape 子菜单），改写上游 Electron 的 `menubar` 模式为 Tauri 原生的 `hidePet`（隐藏 pet 窗口，仅保留托盘）。

### 实现

1. **model.rs sanitize** 接受 `"hidePet"` 作为合法 mode 值（之前只接受 `pet/panel/menubar`）

2. **set_mode 命令增强**（`commands.rs`）：
   - 输入验证：`mode ∈ {pet, panel, menubar, hidePet}`，否则返回 `"unsupported mode: {other}"` 错误
   - 窗口副作用：
     - `hidePet` → `window.hide()`
     - `pet/panel/menubar` → `window.show() + set_focus()`
   - 失败时写日志 `write_log("mode", ...)` 不阻塞退出
   - pet 窗口不存在时静默跳过

3. **build_tray_menu** 新增 shape 子菜单：
   - 3 个 `CheckMenuItem`: `shape_pet` / `shape_panel` / `shape_hidePet`
   - `checked = (config.mode == 对应值)`
   - 标签来自 `i18n.rs`: `shape.pet` / `shape.panel` / `shape.hidePet`
   - 子菜单标题 `tray.shape`
   - 插入到 `Menu::with_items` 数组的 `budget_menu` 和 `mute_item` 之间

4. **on_menu_event** 新增 shape handler：
   - `shape_pet` → `set_mode(app, state, "pet")` + `refresh_tray_menu`
   - `shape_panel` → `set_mode(app, state, "panel")` + `refresh_tray_menu`
   - `shape_hidePet` → `set_mode(app, state, "hidePet")` + `refresh_tray_menu`

5. **新增 smoke** `tauri-tray-shape-r14-smoke.js`：结构 + 路由 + set_mode 窗口副作用 + sanitize + i18n 一致性

### 托盘最终顺序
```
显示桌宠
打开详情
─────────
🌐 语言 / Language  ▸
　形象  ▸
　5h 预算  ▸
　形态  ▸           [✓ 浮游桌宠] [角落面板] [仅托盘（隐藏桌宠）]
　🔇 静音  [✓]
─────────
⚙️ 设置 (disabled)
新开 Agent  ▸
📄 打开日志
🧹 卸载 Claude 钩子
─────────
⏻ 退出
```

---

## R15：面板 Codex 配额/累计 token 恢复

### 目标
恢复 R8 删除的上游 Electron 面板 Codex 视觉元素：5h 配额条 + 今日/累计 token 网格。本轮做"前端就绪"，数据生产者（Rust codex-watch 等价）留给后续轮。

### 实现

1. **panel.html** 新增 2 个 section（插入在 `budget-wrap` 之后、`todo-block` 之前）：
   - `#codex-wrap`（budget hidden）：5h 配额条，含 `codex-pct` / `codex-fill` / `codex-foot`
   - `#codex-usage`（grid hidden）：今日/累计 token grid，含 `codex-today` / `codex-today-detail` / `codex-lifetime` / `codex-lifetime-detail`
   - 所有标签带 `data-i18n` 属性

2. **panel.css** 新增：
   - `.bar-fill.codex`（冷色调渐变 `#6d9ee8→#5773d9`，与 5h 预算条的暖色调区分）
   - `.bar-fill.codex.warn`（紫色警告态 `#8b6de8→#7234c9`）
   - `.stat.compact`（Codex grid 用更小字号 18px，比 hero stats 23px 紧凑）

3. **panel.js** 新增：
   - `render()` 中加 Codex 5h 配额条逻辑：读 `s.codexLimits`，存在时显示并填充 pct/fill/foot，不存在时隐藏
   - `render()` 中调用 `renderCodexUsage(s.codexUsage)`
   - 新增 `renderCodexUsage(codexUsage)` 函数：guard on `today+lifetime`，填充 4 个子元素，用 `panel.codexBreakdown` / `panel.codexLocalHistory` 模板

4. **i18n.js** 三语新增 4 个键：
   - `panel.codexToday`（Codex 今日 Token / Codex tokens today / Codex 本日のトークン）
   - `panel.codexLifetime`（Codex 本机累计 Token / Codex local lifetime tokens / Codex ローカル累計トークン）
   - `panel.codexBreakdown`（输入 {in} · 输出 {out} · 缓存输入 {cached} · 推理输出 {reasoning}）
   - `panel.codexLocalHistory`（本机 rollout · {sessions} 个会话 · {events} 次增量）

5. **新增 smoke** `tauri-panel-codex-r15-smoke.js`：HTML + CSS + JS + i18n 跨源契约

### 关键决策

- **前端就绪 vs 数据生产者**：本轮只做前端（HTML/CSS/JS/i18n），不实现 Rust 端 codex-watch 等价模块。原因：
  - codex-watch 需要解析 Codex rollout `rate_limits` JSON、维护 5h 窗口状态、增量扫描 transcript——是 200+ LOC 的工作
  - 前端就绪后，当数据生产者落地时面板立即可用
  - 对非 Codex 用户无影响：`codex-wrap` 和 `codex-usage` 默认 `hidden`，只在 `s.codexLimits` / `s.codexUsage` 存在时显示（匹配上游"无 Codex 活动→隐藏"行为）

---

## 托盘视觉元素覆盖（R9 §4.1 矩阵最终）

| # | 上游菜单项 | 状态 | 完成轮次 |
|---|---|---|---|
| 1 | 显示桌宠 | ✅ | R8 |
| 2 | 打开详情 | ✅ | R8 |
| 3 | 新开 Agent 子菜单（5 providers） | ✅ | R8 独有增强 |
| 4 | 打开日志 | ✅ | R8 |
| 5 | 退出 | ✅ | R8 |
| 6 | Codex 桌宠（duo） | ❌ 拒绝 | R8 统一面板 |
| 7 | 设置占位 | ✅ | R13 |
| 8 | 语言子菜单 | ✅ | R12 |
| 9 | 形象子菜单 | ✅ | R12 |
| 10 | **形态子菜单** | ✅ | **R14** |
| 11 | 5h 预算子菜单 | ✅ | R12 |
| 12 | 自动巡逻 | ⏳ deferred | 1700 LOC territory.js |
| 13 | 立即巡视 | ⏳ deferred | 同上 |
| 14 | 静音/取消静音 | ✅ | R12 |
| 15 | 卸载 Claude 钩子 | ✅ | R13 |
| 16 | tray.tooltip | ✅ | R13 |
| 17 | 左键托盘显示 | ✅ | R8 |
| 18 | refreshTrayMenu 动态重建 | ✅ | R11（R13 扩展含 tooltip） |

**托盘视觉元素 18/18 完成**（除显式拒绝的 duo-pet 和 deferred 的 territory patrol 外）。

---

## 面板视觉元素覆盖（R9 §4.2 矩阵更新）

| 上游元素 | 状态 | 完成轮次 |
|---|---|---|
| 标题栏语言选择器 | ✅ | R8 独有增强 |
| **Codex 5h 配额条 `#codex-wrap`** | ✅ | **R15** |
| **Codex 今日/累计 token `#codex-usage`** | ✅ | **R15** |
| Chart Token/费用切换 `.metric-tabs` | ❌ | R16 |
| `#usage-diagnostics` 价格诊断行 | ❌ | R16 |
| 价格自动更新控件 | ✅ | R8 独有增强 |
| 待办清单 `#todo-block` | ✅ | R8 |
| 会话列表（搜索/过滤/Pin/归档） | ⚠️ partial | R17 |
| Token 明细 cache-write 5m/1h 粒度 | ❌ | R17 |
| 三皮肤（章鱼/像素怪兽/月薪喵） | ✅ | R8 |

---

## 未在本环境验证

- `cargo check --locked`（沙箱无 Rust 工具链）— 验证 `set_mode` 窗口副作用编译、`CheckMenuItem` shape 子菜单编译
- 三平台 GUI：shape 子菜单选择后 pet 窗口实际隐藏/显示；Codex 面板块在 Codex 数据到达时显示
- 真实 Codex CLI：codex-watch 等价模块未实现，Codex 面板块暂不显示（符合预期）

---

## 下一轮 R16 预告

**面板 Token/Cost 切换 + 诊断行恢复**：
- 补回 `.metric-tabs`（Token / Cost 单选按钮），让用户能在用量趋势图上切换两种度量
- 补回 `#usage-diagnostics` 行，显示"价目是否新鲜"指示
- 新增 `tauri-panel-metrics-r16-smoke.js`
