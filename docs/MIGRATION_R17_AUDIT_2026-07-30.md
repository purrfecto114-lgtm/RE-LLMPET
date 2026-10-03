# R17 全面审视 + i18n 审计修复 — 2026-07-30

## 目标

对 R10-R16 所有改动做整体审视，挑出错误/回归/不一致，修复后发现的问题。

## 审计方法

系统性搜索以下维度：
1. **R16 回归**：`bar.dataset.c` 残留引用（R16 改为 `data-v`）
2. **函数定义位置**：`escapeHtml` 是否在使用前定义
3. **i18n 硬编码**：panel.js 中所有中文硬编码字符串
4. **死代码**：i18n.rs `known_keys()` 是否被调用
5. **Capability 一致性**：`uninstall_hooks` 是否需要 capability 条目
6. **Rust borrow 正确性**：`set_mode` 窗口副作用、`codewhale_doctor_probe` mut、tray handler `app.state()` 多次调用
7. **TODO/FIXME 残留**

## 发现的 5 个问题

| # | 问题 | 严重度 | 来源 |
|---|---|---|---|
| BUG 1 | cal mouseover 硬编码中文 `${cell.dataset.k} · <b>${fmtCost(...)}</b> · ${cell.dataset.t} tok · ${cell.dataset.m} 轮`，未使用已有的 `t('panel.calReadout')` | 中 | R8 pre-existing |
| BUG 2 | i18n.rs `known_keys()` 函数是死代码，从未被调用 | 低 | R11 引入 |
| BUG 3 | today-tokens 硬编码 `' 轮'`，未使用 `t('panel.rounds')` | 低 | R8 pre-existing |
| BUG 4 | win-reset 硬编码 `' 重置'`，未使用 `t('panel.reset')` | 低 | R8 pre-existing |
| BUG 5 | renderByModel + renderProviderCost 硬编码 `入/出/缓写/缓读/轮/按API等价估算/价格未知/合计`，未使用 i18n keys | 中 | R8 pre-existing |

## 审计结论：R10-R16 Rust 代码逻辑正确

- **`set_mode` 窗口副作用**：`window.show().and_then(|_| window.set_focus())` — 两次不可变借用，不重叠，正确
- **`codewhale_doctor_probe` `mut`**：`companion_capture.take()` 需要 `mut`，正确
- **tray handler `app.state()` 多次调用**：`app.clone()` + `app.state::<AppState>()` — 两个不可变借用，正确
- **`uninstall_hooks` 不在 capability JSON**：正确 — tray-originated 调用不走 IPC，不需要 capability
- **无 TODO/FIXME 残留**

## 修复内容

### BUG 1: cal mouseover i18n 化
```diff
- $('cal-readout').innerHTML = `${cell.dataset.k} · <b>${fmtCost(Number(cell.dataset.c))}</b> · ${cell.dataset.t} tok · ${cell.dataset.m} 轮`;
+ $('cal-readout').innerHTML = t('panel.calReadout', { k: cell.dataset.k, c: cell.dataset.c, t: cell.dataset.t, m: cell.dataset.m });
```

### BUG 2: known_keys() 纳入 smoke
在 `tauri-tray-i18n-r11-smoke.js` 新增 2 项断言：
- `pub fn known_keys() -> Vec<&'static str>` 存在
- `known_keys()` 枚举 `TRAY_LABELS` 所有 key

### BUG 3+4: today-tokens + win-reset i18n 化
```diff
- $('today-tokens').textContent = fmt(s.today.tokens) + ' tokens · ' + s.today.messages + ' 轮';
+ $('today-tokens').textContent = fmt(s.today.tokens) + ' tokens · ' + s.today.messages + t('panel.rounds');
- $('win-reset').textContent = fmt(s.window5h.tokens) + ' tok · ' + timeStr(s.window5h.resetTs) + ' 重置';
+ $('win-reset').textContent = fmt(s.window5h.tokens) + ' tok · ' + timeStr(s.window5h.resetTs) + t('panel.reset');
```

### BUG 5: renderByModel + renderProviderCost i18n 化
- `renderByModel` detail 改用 `t('panel.modelDetail', {in, out, cw, cr})` + `t('panel.modelRounds', {n})` + `t('panel.estimatedRounds', {n})` + `t('panel.unknownRounds', {n})`
- `renderByModel` total 改用 `t('panel.total')`
- `renderProviderCost` 改用 `t('panel.rounds')` + `t('panel.estimatedRounds', {n})` + `t('panel.unknownRounds', {n})`
- i18n.js 三语新增 3 键：`panel.estimatedRounds` / `panel.unknownRounds` / `panel.total`

### 自发现 bug（修复过程中）
初次添加 `panel.total` 时误以为已存在，产生重复键。smoke 的 duplicate check（精确界定语言块边界）捕获并修复。

## 新增 smoke

`test/tauri-panel-i18n-audit-r17-smoke.js`：
- 8 项 i18n `t()` 调用存在性检查
- 7 项硬编码中文移除负面断言
- 8 个必需键 × 3 语言存在性
- 3 个新键 × 3 语言无重复检查

## 验证

- `npm test` — **43/43 PASS**（新增 `tauri-panel-i18n-audit-r17-smoke`）
- `npm run check:static` — 22/22 PASS
- `python3 scripts/rust-structure-smoke.py` — 3/3 PASS
- `migration-todo` — 44 tasks valid（+1 R17 task）

## 剩余已知问题（非本轮范围）

- **cache-write 5m/1h 双行**：需 metering.rs 先支持 `cacheWrite5m` / `cacheWrite1h` 字段（R8 仅有单一 `cacheCreate`）。这是 R18+ 的任务，涉及 `Aggregate` struct + `UsageEvent` + transcript parser + pricing 表的改动。
- **`panel.modelDetail` 使用 `{cw}` 而非上游的 `{cw5}/{cw1}`**：当 metering 支持双字段后，此 key 可升级为上游格式。
