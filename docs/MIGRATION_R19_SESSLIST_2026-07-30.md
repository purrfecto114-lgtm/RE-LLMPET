# R19 会话列表 Pin/归档 + attention filter — 2026-07-30

## 目标

补齐面板最后一项视觉元素（R9 §4.2 矩阵第 10 项）：会话列表 Pin/归档 + attention filter + `set_session_prefs` IPC。完成后面板视觉元素达 **10/10**。

## 上游核对

- `preload.js` L26: `setSessionPrefs: (pinned, archived) => ipcRenderer.send('set-session-prefs', pinned, archived)`
- `main.js` L750: `ipcMain.on('set-session-prefs', (_e, pinned, archived) => config.save({ pinnedSessions, archivedSessions }))`
- `config.js` L28-29: `pinnedSessions: []` / `archivedSessions: []` defaults + sanitize（archived 去重 + 排除 pinned）
- `i18n.js`: 9 个 `sess.*` keys（search/filters/filterAll/filterAttention/showArchived/pin/unpin/archive/unarchive）

R8 偏差：已有 search + provider filter，缺 Pin/归档/attention filter/IPC/9 i18n keys。

## 实现

### 1. `src-tauri/src/model.rs`
AppConfig 新增：
```rust
pub pinned_sessions: Vec<String>,
pub archived_sessions: Vec<String>,
```
Default 初始化为空 Vec。

### 2. `src-tauri/src/commands.rs`
新增 `set_session_prefs` Tauri 命令：
- `sanitize_ids` 辅助：trim + 256 char bound + dedup
- **pin-wins**：archived 中已 pinned 的 id 被移除
- `update_config` 持久化 + `emit_config`

### 3. 注册链
- `lib.rs` invoke_handler 加 `set_session_prefs`
- `build.rs` COMMANDS 加 `"set_session_prefs"`
- `capabilities/panel.json` 加 `allow-set-session-prefs`

### 4. `frontend/renderer/tauri-bridge.js`
```js
setSessionPrefs: (pinned, archived) => send('set_session_prefs', { pinned, archived }),
```

### 5. `frontend/renderer/panel.html`
新增 2 个按钮：
```html
<button id="sess-attention" class="sess-filter-btn" data-i18n="sess.filterAttention">待处理</button>
<button id="sess-show-archived" class="sess-filter-btn" data-i18n="sess.showArchived">归档</button>
```

### 6. `frontend/renderer/panel.js`
- 新增状态：`sessionPinned` / `sessionArchived` / `sessionAttentionOnly` / `sessionShowArchived`
- `renderSessList` 增强：
  - **filter**: attention 只显示 waiting/needsinput；archived 隐藏除非 toggled
  - **sort**: pinned 浮顶
  - **render**: 每行加 pin/archive 按钮（📍/📌 + 📥/📤），title 用 i18n
  - **click handler**: toggle membership + `setSessionPrefs` 持久化 + 重新渲染
  - pinned 行加 `.pinned` 背景；archived 行 opacity 0.55
- `onConfig` 同步 `cfg.pinnedSessions` / `archivedSessions` 到本地状态
- DOMContentLoaded 加 attention/archive toggle handler

### 7. `frontend/renderer/panel.css`
- `.sess-filter-btn` + `.active`（与 view-tabs 同风格）
- `.sess-actions` + `.sess-pin` / `.sess-archive`
- `.row.sess.pinned` / `.archived` 视觉区分

### 8. `frontend/shared/i18n.js`
三语新增 9 键：`sess.search` / `sess.filters` / `sess.filterAll` / `sess.filterAttention` / `sess.showArchived` / `sess.pin` / `sess.unpin` / `sess.archive` / `sess.unarchive`

### 9. 新增 smoke `test/tauri-panel-sesslist-r19-smoke.js`
跨源契约：AppConfig + set_session_prefs + bridge + HTML + JS state/filter/render/persist + 9 i18n keys × 3 langs

### 10. 修复 `test/tauri-bridge-smoke.js`
expected 列表加 `setSessionPrefs`（bridge API parity）

## 验证

- `npm test` — **45/45 PASS**（新增 `tauri-panel-sesslist-r19-smoke`）
- `npm run check:static` — 22/22 PASS（bridge parity 39 commands）
- `python3 scripts/rust-structure-smoke.py` — 3/3 PASS
- `migration-todo` — 46 tasks valid（+1 R19 task）

## 面板视觉元素覆盖（R9 §4.2 矩阵最终）

| 上游元素 | 状态 | 完成轮次 |
|---|---|---|
| 标题栏语言选择器 | ✅ | R8 独有增强 |
| Codex 5h 配额条 `#codex-wrap` | ✅ | R15 |
| Codex 今日/累计 token `#codex-usage` | ✅ | R15 |
| Chart Token/费用切换 `.metric-tabs` | ✅ | R16 |
| `#usage-diagnostics` 价格诊断行 | ✅ | R16 |
| 价格自动更新控件 | ✅ | R8 独有增强 |
| 待办清单 `#todo-block` | ✅ | R8 |
| **会话列表（搜索/过滤/Pin/归档）** | ✅ | **R19** |
| Token 明细 cache-write 5m/1h 双行 | ✅ | R18 |
| 三皮肤（章鱼/像素怪兽/月薪喵） | ✅ | R8 |

**面板视觉元素 10/10 全部完成** ✅

## 里程碑

- **托盘视觉元素 18/18**（R14 完成）
- **面板视觉元素 10/10**（R19 完成）
- R9 路线图视觉迁移全部完成
- 剩余工作：综合回归 + 文档更新 + 真机验证（需 cargo + GUI 环境）

## 未在本环境验证

- `cargo check --locked`（沙箱无 Rust 工具链）
- 真实会话数据：Pin/归档按钮实际点击行为
- 跨 panel 重开持久化
- attention filter 实际过滤效果
