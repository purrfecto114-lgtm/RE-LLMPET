# R16 面板 Token/Cost 切换 + 诊断行恢复 — 2026-07-30

## 目标

按 R9 路线图 R16，补回 R8 删除的上游 Electron 面板两项视觉元素：
1. **metric-tabs**（Token/Cost 切换按钮）— 让用户在 24h 图表和日历上切换 Token/Cost 两种度量
2. **#usage-diagnostics**（诊断行）— 显示 transcript 扫描时间/文件数/记录数/修正次数/家族估价/价目过期

## 实现

### 1. panel.html
- 新增 `.metric-tabs`（Token/Cost 两个按钮，`data-metric` + `data-i18n`）
- 新增 `.trend-controls` 容器包裹 `metric-tabs` + `view-tabs`（与上游布局一致）
- 新增 `#usage-diagnostics` div（在 `price-src` 之后）
- `price-src` 加 `data-i18n-title="panel.priceSrcTitle"` 属性（之前缺失）

### 2. panel.css
- `.trend-controls`（flex gap 8px，居中对齐）
- `.metric-tabs` + `.metric-tabs .mt` + `.metric-tabs .mt.active`（与 `.view-tabs/.vt` 同风格：10px 字号、3px 8px padding、7px 圆角、active 态 #d97757 背景）
- `.usage-diagnostics`（9.5px 字号、muted #8c6a5a、margin-top 4px、min-height 12px）

### 3. panel.js
- **顶层状态**：`usageMetric = 'tokens'`（默认 Token，与上游一致）+ `lastStats = null`
- **renderChart 重写**：签名改为 `(hourlyCost, hourlyTokens)`，按 `usageMetric` 选数组，display 格式化（cost→`fmtCost`，tokens→`fmt + ' tok'`），summary 用 `panel.hoursSummaryCost/Tokens` 模板
- **renderCal 按 metric**：cell level + display + summary 都按 `usageMetric` 选 cost 或 tokens
- **新增 renderDiagnostics(diag)**：读 `diag.lastScanTs/scannedFiles/records/streamingCorrections/estimatedModelCount/pricing.stale`，用 5 个 i18n 模板拼接
- **render() 调用**：`lastStats = s`；`renderChart(s.hourly, s.hourlyTok)`；`renderDiagnostics(s.transcriptDiagnostics)`
- **metric-tab click handler**：设 `usageMetric`，toggle active class，从 `lastStats` 重新 `renderChart` + `renderCal`（即时响应，无需等新 stats push）
- **chart hover 改用 `bar.dataset.v`**（display string）替代旧 `bar.dataset.c`（cost only）

### 4. i18n.js 三语新增 11 键
- `metricTokens` / `metricCost`（Token / 费用 / トークン / 費用）
- `hoursSummaryCost` / `hoursSummaryTokens`（带 `{total}/{peakH}/{peakV}` 占位符 + `$` 货币符号）
- `calSummaryCost` / `calSummaryTokens`（带 `{n}/{total}` 占位符）
- `diagNever` / `diagScan` / `diagCorrections` / `diagEstimated` / `diagStale`（诊断行 5 个模板）

### 5. 新增 smoke `tauri-panel-metrics-r16-smoke.js`
跨源契约 4 维度：
- HTML：metric-tabs + trend-controls + usage-diagnostics 存在，data-i18n 属性正确
- CSS：.metric-tabs/.mt/.trend-controls/.usage-diagnostics 样式存在
- JS：usageMetric/lastStats 状态、renderChart 双数组+按 metric、renderCal 按 metric、renderDiagnostics 函数、metric-tab click handler、chart hover 用 data-v
- i18n：11 个必需键三语都存在，占位符语法正确

## 关键决策

- **默认 Token 视图**：与上游 Electron 一致（Token tab active by default）
- **即时切换**：metric-tab click 从 `lastStats` 重新渲染，无需等新 stats push
- **chart hover 用 data-v**：renderChart 现在生成 `data-v`（display string，"$0.123" 或 "1,234 tok"），hover handler 直接显示，不再需要格式化
- **诊断行数据源**：`s.transcriptDiagnostics`，由 `metering.rs snapshot()` 的 `diagnostics` 字段提供（已存在）

## 验证

- `npm test` — **42/42 PASS**（新增 `tauri-panel-metrics-r16-smoke`）
- `npm run check:static` — 22/22 PASS
- `python3 scripts/rust-structure-smoke.py` — 3/3 PASS
- `migration-todo` — 43 tasks valid（+1 R16 task）

## 面板视觉元素覆盖（R9 §4.2 矩阵更新）

| 上游元素 | 状态 | 完成轮次 |
|---|---|---|
| 标题栏语言选择器 | ✅ | R8 独有增强 |
| Codex 5h 配额条 `#codex-wrap` | ✅ | R15 |
| Codex 今日/累计 token `#codex-usage` | ✅ | R15 |
| **Chart Token/费用切换 `.metric-tabs`** | ✅ | **R16** |
| **`#usage-diagnostics` 价格诊断行** | ✅ | **R16** |
| 价格自动更新控件 | ✅ | R8 独有增强 |
| 待办清单 `#todo-block` | ✅ | R8 |
| 会话列表（搜索/过滤/Pin/归档） | ⚠️ partial | R17 |
| Token 明细 cache-write 5m/1h 粒度 | ❌ | R17 |
| 三皮肤（章鱼/像素怪兽/月薪喵） | ✅ | R8 |

**面板视觉元素 8/10 完成**，剩余 2 项 → R17。

## 未在本环境验证

- `cargo check --locked`（沙箱无 Rust 工具链）— 本轮纯前端，无 Rust 改动
- 三平台 GUI：Token/Cost 切换视觉表现、诊断行实际数据填充
- 真实 transcript 扫描数据：诊断行在 `transcriptDiagnostics` 有数据时显示扫描时间/文件数等

## 下一轮 R17 预告

**会话列表搜索/Pin/归档 + cache-write 5m/1h 双行**：
- 补回 `set_session_prefs` IPC + 9 个 i18n keys
- Token 明细恢复 `tokCacheWrite5m` / `tokCacheWrite1h` 双行（当前 R8 合并为单一 `cacheWrite` 行）
- 新增 `tauri-panel-sesslist-r17-smoke.js`
