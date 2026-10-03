# R18 metering cache-write 5m/1h 双字段 + CLI 冒烟测试 — 2026-07-30

## 目标

核对上游 `metering.js` 的 `cacheWrite5m` / `cacheWrite1h` 实现，修正 R8 偏差（只有单一 `cache_create`），补齐面板双行显示。完成后提供可下载的 CLI 冒烟测试脚本。

## 上游核对

上游 `metering.js` `usageSnapshot()` 从 `usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` 提取 5m/1h。Older transcript rows 只有 aggregate `cache_creation_input_tokens` 时，remainder 归 5m（Anthropic 默认 TTL 5 分钟）。

R8 偏差：
- `UsageEvent` 只有 `cache_create` 单字段
- `Aggregate` 同
- `parse_claude_assistant` 不读 `cache_creation` 子对象
- 面板只有单行 `t-cw`

## 实现

### 1. `src-tauri/src/metering.rs`

**UsageEvent struct** 新增：
```rust
#[serde(default)]
pub cache_write_5m: u64,
#[serde(default)]
pub cache_write_1h: u64,
```
`#[serde(default)]` 保证旧 ledger JSON 兼容。

**Aggregate struct** 新增 `cache_write_5m` + `cache_write_1h`，`add()` 累加，`to_json()` 输出 `cacheWrite5m` / `cacheWrite1h`。

**parse_claude_assistant** 新增 5m/1h 提取：
```rust
let cache_creation_obj = usage.get("cache_creation").and_then(Value::as_object);
let explicit_5m = cache_creation_obj
    .and_then(|o| number(o, &["ephemeral_5m_input_tokens"]))
    .unwrap_or(0);
let one_hour = cache_creation_obj
    .and_then(|o| number(o, &["ephemeral_1h_input_tokens"]))
    .unwrap_or(0);
let five_minute = explicit_5m
    .saturating_add(cache_create.saturating_sub(explicit_5m.saturating_add(one_hour)));
```
remainder 归 5m（与上游 `usageSnapshot()` 一致）。

**parse_hook（CodeWhale turn_end）**：`cache_write_5m` / `cache_write_1h` 设为 0（CodeWhale 不暴露 TTL split，aggregate `cache_create` 保留用于 cost math）。

### 2. `frontend/renderer/panel.html`
- `t-cw` 单行拆为 `t-cw5` + `t-cw1` 双行
- `data-i18n="panel.tokCacheWrite5m"` / `panel.tokCacheWrite1h"`

### 3. `frontend/renderer/panel.js`
- `render()` 读 `s.today.cacheWrite5m` / `cacheWrite1h`
- `t-cw5` fallback 到 `cacheCreate`（旧数据兼容）
- `renderByModel` detail 用 `v.cacheWrite5m` / `cacheWrite1h`，传 `{cw5}/{cw1}` 给 `modelDetail` 模板

### 4. `frontend/shared/i18n.js`
- 三语新增 `panel.tokCacheWrite5m` / `panel.tokCacheWrite1h`
- 三语升级 `panel.modelDetail` 为 `{cw5}/{cw1}` 格式（与上游一致）

### 5. 新增 smoke `test/tauri-metering-cw-split-r18-smoke.js`
跨源契约：UsageEvent + Aggregate + parse_claude_assistant + 面板双行 + i18n 一致性。

## CLI 冒烟测试脚本

新增 `cli-smoke-test.sh`（可下载，已复制到 `/home/z/my-project/download/`）：

10 个检查维度：
1. 项目结构完整性（package.json / Cargo.toml / lib.rs / i18n.rs 等）
2. 托盘 API 契约（R10：TrayIconBuilder::with_id + 无 app.manage(tray)）
3. CodeWhale doctor 顺序（R10：companion-first + dispatcher fallback）
4. 托盘 i18n + 子菜单（R11-R14：TRAY_LABELS + refresh_tray_menu + CheckMenuItem + shape_hidePet）
5. 面板视觉元素（R15-R16：codex-wrap + codex-usage + metric-tabs + usage-diagnostics）
6. metering cache-write 5m/1h（R18：UsageEvent + Aggregate + parse + 面板双行）
7. npm test 套件（运行 + 计数通过数）
8. 静态检查（static-check.py + rust-structure-smoke.py）
9. Provider CLI 可发现性（可选：claude/codewhale/codex/opencode/aider/codewhale-tui）
10. CodeWhale doctor 顺序实测（可选：codewhale-tui doctor --json）

运行结果（沙箱）：
```
PASS: 31
FAIL: 0
SKIP: 7  (provider CLI 未安装)
结果: PASS
```

## 验证

- `npm test` — **44/44 PASS**（新增 `tauri-metering-cw-split-r18-smoke`）
- `npm run check:static` — 22/22 PASS
- `python3 scripts/rust-structure-smoke.py` — 3/3 PASS
- `./cli-smoke-test.sh` — 31 PASS / 0 FAIL / 7 SKIP
- `migration-todo` — 45 tasks valid（+1 R18 task）

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
| 会话列表（搜索/过滤/Pin/归档） | ⚠️ partial | R17+ (deferred) |
| **Token 明细 cache-write 5m/1h 双行** | ✅ | **R18** |
| 三皮肤（章鱼/像素怪兽/月薪喵） | ✅ | R8 |

**面板视觉元素 9/10 完成**（仅剩会话列表搜索/Pin/归档，需 `set_session_prefs` IPC，留待后续）。

## 未在本环境验证

- `cargo check --locked`（沙箱无 Rust 工具链）— 验证 `UsageEvent` 新字段编译、`parse_claude_assistant` borrow 正确性
- 真实 Claude transcript：验证 `ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` 解析
- 三平台 GUI：面板双行实际显示

## 下载

CLI 冒烟测试脚本已复制到：
- `/home/z/my-project/download/cli-smoke-test.sh`
- 项目根：`cli-smoke-test.sh`

运行方式：
```bash
chmod +x cli-smoke-test.sh
./cli-smoke-test.sh
```
