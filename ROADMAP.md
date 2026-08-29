# Octopus (RE-LLMPET) — Product Roadmap

> **从「可爱观察者」到「Agent Ops Console」** — Octopus 0.6.0 → 0.7.0 产品方向

**最后更新**: 2026-08-10（v0.5.52，全局审查后）
**当前版本**: 0.5.52 prerelease
**目标稳定版**: 0.6.0（仅修 blocker，不加新功能）
**下一里程碑**: 0.7.0（从观察者升级为操作台）

---

## 产品愿景

### 一句话定位
> Octopus 是 coding agent 的桌面操作台：不只看着 agent 干活，还能**中断、重放、导出、告警**——让多 agent 协作像养宠物一样轻松。

### 当前状态（0.5.52）
Octopus 是一个**高保真观察者**：
- ✅ 监控 5 个 agent 的生命周期、权限、会话
- ✅ 实时 token 计量 + 价格估算 + 5h 窗口预算
- ✅ 权限卡片（并行去重、批量批准）
- ✅ 旅行/闲逛/成长游戏化
- ✅ Duo-pet（Claude + Codex 双宠）
- ✅ 领地模式（macOS 推开竞品桌宠）
- ✅ 三语 UI（zh/en/ja）、3 套皮肤
- ✅ 配置隔离 + 恢复、hook 备份 + 收据

### 核心差距
Octopus 能**看**，但不能**做**。具体来说：
1. ❌ 不能中断/暂停/重放 agent 会话
2. ❌ 不能导出 usage 数据到外部工具
3. ❌ 不能发系统通知或 webhook
4. ❌ 不能用模板启动 agent 会话
5. ❌ 领地模式仅 macOS
6. ❌ Provider 适配层未统一（加第 6 个 provider 需数周）

---

## 里程碑规划

### 0.6.0 — 稳定发布（仅修 blocker）
**目标**: 无 P0/P1 数据安全或生命周期问题
**范围**: 完成 `migration-todo.json` 的 6 个 blocked 项
**时间**: 待三平台 cargo check + 签名证书就绪

| 任务 | 状态 | 依赖 |
|------|------|------|
| P0-003 三平台 cargo check --all-targets | blocked | Rust/Cargo + native runners |
| P0-005 真实 GUI 启动 smoke | blocked | 桌面 session |
| P1-008 真实 provider CLI 契约测试 | blocked | Provider CLIs + 凭证 |
| P6-001 空闲 CPU/RSS/启动/8h 基准 | blocked | 编译二进制 + GUI |
| P6-003 签名的可复现包 | blocked | 签名凭证 |
| R20-001 Windows 编译验证 | blocked | Rust/Cargo |

**本轮（Round 1-2）已完成**: 26 个 bug 修复（1 CRITICAL + 15 HIGH + 10 MEDIUM），详见 `worklog.md`。

### 0.6.x — 稳定后增量（低风险，可并行 ship）
**目标**: 在不破坏稳定性的前提下，补齐外部接口

#### 0.6.1 — Usage 导出 + 系统通知
- **Usage 导出**: panel 加「导出」按钮，支持 CSV / JSON 格式导出 usage-events.jsonl
- **系统通知**: 权限待决、预算超阈、会话结束时发 OS 原生通知
- **Webhook 桥**: 可选配置 webhook URL，关键事件 POST 出去
- **风险**: 低（前端 + 1-2 个 Tauri 命令，无 provider 内部改动）

#### 0.6.2 — Provider Adapter Trait（架构铺路）
- 统一 `detect / capabilities / install / verify / cleanup / repairLegacy / observe / normalizeEvent` trait
- 能力矩阵: `state / permission / usage / focus / completion / session / interrupt / replay`
- 统一事件信封: `schemaVersion / provider / sessionId / eventId / sequence / kind / capabilities / payload`
- **风险**: 中（重构 hook_install.rs + hook_client.rs，但无用户可见行为变化）

### 0.7.0 — Agent Ops Console（旗舰升级）
**目标**: 从观察者升级为操作台

#### 0.7.1 — 会话控制
- `interrupt_agent`: 中断当前 agent 执行（Claude/Codex 支持，其他降级为「不支持」）
- `pause_session` / `resume_session`: 暂停/恢复会话事件流
- `replay_session`: 重放会话事件（用于复盘）
- **依赖**: 0.6.2 Provider Adapter Trait + 能力矩阵

#### 0.7.2 — 会话引导
- **Prompt 模板**: 预置常用 prompt 模板（code review / refactor / debug / test），一键启动 agent
- **工具白名单**: 启动会话时指定允许的工具集
- **系统 prompt 覆盖**: 高级用户可注入 system prompt 片段
- **风险**: 高（需谨慎的权限 hook 集成，防止变成 steering vector）

#### 0.7.3 — 跨平台领地
- Windows: 用 SetWindowPos 实现竞品窗口推开
- X11: 用 XMoveWindow 实现
- Wayland: 明确降级为「仅置顶 Octopus 窗口」
- **依赖**: 各平台窗口管理 API 调研

### 0.8.0+ — 远期方向（探索中）
- **多机/团队视图**: 聚合多台机器的 usage，团队 cost 看板
- **OBS 叠加层**: 把 pet 状态作为 OBS 源（直播/录课用）
- **CI 集成**: headless 模式跑在 CI 里，agent 执行完发通知
- **Plugin 系统**: 第三方可扩展 Octopus 的 provider / pet-skin / growth-rule

---

## 技术债务优先级

| 优先级 | 债务 | 影响 | 建议 |
|--------|------|------|------|
| 🔴 高 | Provider 适配层未统一 | 加 provider 成本极高 | 0.6.2 完成 |
| 🔴 高 | 6 个 migration-todo blocked | 0.6.0 无法 ship | 需要真实 CI 环境 |
| 🟡 中 | emotion.rs 仅 CN+EN | 日语用户情绪检测缺失 | 0.6.x 补 JA 关键词 |
| 🟡 中 | NSIS installer 未本地化 | Windows 安装界面英文 | 0.6.x 补 |
| 🟡 中 | metering compact 无 .tmp 恢复 | 崩溃后丢最近事件 | 0.6.1 修 |
| 🟡 中 | price_info 泄漏绝对路径 | 前端可见用户名 | 0.6.1 修 |
| 🔵 低 | 测试覆盖以 smoke 为主 | 缺单元测试 | 0.7.0 补 |

---

## 决策记录

### D1: 0.6.0 不加新功能
**决策**: 0.6.0 仅修 blocker，不加新功能。
**理由**: 当前有 26 个已修 bug + 6 个 blocked 项。在稳定基线确认前加功能会增加回归风险。
**反转条件**: 如果 blocked 项长期无法解决（>3 个月），考虑在 0.6.0 加低风险增量（usage 导出）。

### D2: superpowers-zh 作为开发方法论
**决策**: 安装 superpowers-zh skills 到 `.claude/skills/`，作为 AI agent 开发本仓库的方法论框架。
**理由**: 自主修复 cron job 每轮派 agent 修 bug，需要系统化方法论（TDD、调试、代码审查）保证质量。
**不做的**: 不把 superpowers skills 集成进 Octopus 产品本身（那是 0.8.0+ plugin 系统的事）。

### D3: 前端保持无框架
**决策**: 前端继续用原生 JS，不引入 React/Vue/Svelte。
**理由**: Tauri 2 的 `withGlobalTauri: true` + 原生 JS 是最轻量方案（零运行时依赖）。引入框架会增加打包复杂度和包体积。
**反转条件**: 如果前端复杂度超过 ~3000 行/文件，考虑引入轻量框架（如 Preact）。

---

## 如何贡献

### 修 bug
1. 读 `worklog.md` 的未解决清单
2. 按 `DEEP_BUG_CHECK_0.5.46.md` 的 finding ID 追溯
3. 修复 → 跑验证 → 更新 worklog

### 加功能
1. 读本 ROADMAP 确认方向一致
2. 用 `brainstorming` skill 做需求分析
3. 用 `writing-plans` skill 写实施计划
4. 用 `test-driven-development` skill 实现
5. 用 `verification-before-completion` skill 验证

### 提 PR
1. 遵循 `chinese-commit-conventions` skill 的提交规范
2. 一个 PR 解决一个问题
3. 附 before/after 验证证据
