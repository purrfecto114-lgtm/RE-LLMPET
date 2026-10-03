# Provider Hooks 真实 CLI 冒烟 + 0.6.1 返工计划

> 按 superpowers-zh 1.7.1 的 writing-plans 技能编写；
> 执行全程遵守 verification-before-completion（无新鲜验证证据不许宣称完成）。
> 日期：2026-08-30 ｜ 目标版本：0.6.0 → 0.6.1

## 背景（去理想化前提）

上一轮（R50，0.6.0）修复了 8 类桌宠问题，但 provider hook 侧的验证全部来自
文档与源码推断（protocol-baseline needle 检查），没有跑过真实 provider CLI。
本轮用户要求：**自行下载工具链与 provider CLI 冒烟测试**，辩证核对
"最新 provider hooks 是否可用"，并升版 0.6.1。

已下载的真实 CLI（本沙箱，2026-08-30）：

| Provider | 版本 | 来源 |
|---|---|---|
| claude | 2.1.251 (Claude Code) | npm @anthropic-ai/claude-code（原生二进制） |
| codex | codex-cli 0.151.0 | npm @openai/codex（原生二进制） |
| opencode | 1.18.25 | npm opencode-ai |
| aider | pip install --user aider-chat（进行中） |
| codewhale | 未见公开分发渠道 → 尝试 GitHub Hmbown/CodeWhale，时限 10 分钟 |

## 冒烟前 ground truth（已验证的事实）

1. **claude 2.1.251 二进制 strings**：我们安装的 23 事件 + PreToolUse +
   PermissionRequest 全部存在；决策协议 token（hookSpecificOutput /
   permissionDecision / permissionDecisionReason / additionalContext /
   systemMessage / suppressOutput）全部存在。无未知新增生命周期事件。
2. **codex 0.151.0 二进制 strings**：hooks.json 事件枚举簇为
   `PreToolUse PermissionRequest PostToolUse PreCompact PostCompact
   SessionStart SessionEnd SubagentStart SubagentStop Interrupt`：
   - **不含 `Stop`、不含 `UserPromptSubmit`** —— 而我们的 CODEX_EVENTS
     仍在安装这两个事件（理想化残留，疑似上游旧版行为）。
   - **新增 `Interrupt`**，我们未安装。
   - 存在 `--dangerously-bypass-hook-trust`（headless 冒烟可绕过 /hooks 信任）。
   - rollout wire 类型含 `session_meta payload response_item compacted
     turn_context event_msg … trigger_turn`（与 codex_rollout.rs 宽容解析需比对）。
3. **opencode 1.18.25**：插件经 config 目录 plugins/ 扫描加载（与 R13 结论一致，
   待运行验证）；v4 插件源码 POST /state + X-Re-Llmpet-Token 头（与
   hook_client.rs:177/710 一致）。
4. **check-protocol-drift --remote**：claude/codewhale/opencode/models.dev/
   upstream 全绿；**codex-hooks 文档 developers.openai.com/codex/hooks 返回 403**
   （沙箱被 Cloudflare 拦或文档迁移，需换路径核实）。
5. **本沙箱无 provider 账号/API key** → LLM 侧用本机 mock
   OpenAI-compatible 服务器替代（只替代模型，不替代 CLI 本体）；
   claude 无 API key，能验证到哪一步算哪一步，**不得伪造通过**。

## 文件结构（新增）

- `scripts/provider-smoke/collector.js` — 事件收集器（POST /state，JSONL 落盘）
- `scripts/provider-smoke/hook-capture.js` — 无 octopus-hook 二进制时的
  stdin 捕获 shim（记录原始 payload；与二进制行为对照用）
- `scripts/provider-smoke/mock-llm.js` — OpenAI 兼容 mock（chat/completions，
  支持流式/非流式、可编排 tool_calls）
- `scripts/provider-smoke/run-opencode.sh` — opencode 端到端驱动
- `scripts/provider-smoke/run-claude.sh` — claude 无鉴权生命周期验证
- `scripts/provider-smoke/run-codex.sh` — codex hooks.json 双变体对照 + rollout 核对
- `scripts/provider-smoke/run-aider.sh` — aider notifications 桥验证
- `scripts/provider-smoke/run-codewhale.sh` — 文档契约 + CLI 可得性探测
- `docs/superpowers/specs/2026-08-30-provider-hooks-smoke-findings.md` — 冒烟发现与辩证结论

## 修改（预期，按冒烟结果收敛）

- `src-tauri/src/hook_install.rs`：CODEX_EVENTS 依据真 CLI 实测收敛
  （移除/保留 Stop、UserPromptSubmit；评估加 Interrupt）+ 注释更新
- `protocol-baseline.json`：codex 事件基线同步；codex-hooks 远端 URL 若确证
  迁移则替换为可达等价物
- 版本 0.6.1：package.json / Cargo.toml / tauri.conf.json / migration-todo.json /
  版本钉测试 / CHANGELOG / SOURCE_MANIFEST 重生成
- `test/pet-r51-provider-smoke-regression.js`（新增）：锁定本轮结论的回归测试

## 冒烟矩阵（辩证预期）

| Provider | 本沙箱可实证 | 本沙箱不可实证（如实记录） |
|---|---|---|
| claude | hooks 配置可被 2.1.251 接受；无鉴权下哪些生命周期事件真实触发；payload 字段 | tool 事件与 allow/deny/ask 决策（需真实 LLM 会话） |
| opencode | 插件 v4 真实加载；session/tool/permission 事件端到端（mock LLM）；permissionMode=native-only | 无（mock 仅替代模型） |
| codex | hooks.json 两种变体是否被接受/触发；Interrupt 可触发性；rollout 文件真实格式 | /hooks 信任 TUI 流（用 bypass flag 如实标注） |
| aider | notifications_command 真实触发（mock LLM） | 权限（本就 native-only，N/A） |
| codewhale | CONFIGURATION.md 契约（事件名/决策词表/TOML 键） | CLI 运行（若无公开渠道） |

## 任务分解（小步骤，每步带验证）

1. 写 collector/mock-llm/hook-capture → `node -e` 自测端口连通（PASS 才继续）
2. opencode 驱动 → collector 收到 session.created/status + tool.execute.before/
   after + session.idle（真实 opencode 进程）→ 写 evidence → real-provider-smoke
   --provider opencode 判定
3. claude 驱动 → 记录无鉴权下实际触发集合 → evidence 如实标注部分通过
4. codex 驱动 A（现行 11 事件含 Stop/UserPromptSubmit）→ 观察接受度/触发
   驱动 B（收敛变体 + Interrupt）→ 对照 → 决定 CODEX_EVENTS 收敛方案
5. codex rollout 首行与 codex_rollout.rs 期望比对
6. aider 驱动（若 pip 完成）→ notifications_command 触发证据
7. codewhale：抓 CONFIGURATION.md 全文核对 + CLI 探测
8. 依证据改 hook_install.rs / protocol-baseline.json / 新回归测试
9. 版本 0.6.1 全仓同步 + CHANGELOG
10. cargo fmt/clippy/test --lib（rustup+GTK 自装工具链）
11. npm test 全量 + static-checks + manifest 重生成
12. 打包 download/RE-LLMPET-0.6.1-*.zip + 主 worklog 追加 + 辩证报告

## 验证命令

```bash
node scripts/provider-smoke/mock-llm.js &        # 4599
node scripts/provider-smoke/collector.js &       # 41330
OCTOPUS_PROVIDER_SMOKE_COMMAND="bash scripts/provider-smoke/run-opencode.sh" \
  node scripts/real-provider-smoke.js --provider opencode
npm test                                          # 全绿
python3 scripts/static-check.py                   # 全绿
cargo fmt/clippy/test --manifest-path src-tauri/Cargo.toml
```

## 风险与止损

- opencode 自定义 provider 配置若与 1.18.25 不兼容 → 降级为插件加载 +
  session 创建级验证，如实记录
- codex mock provider wire_api 不匹配 → 降级为无鉴权 exec + rollout 首行核对
- cargo 工具链装不上 → JS 侧结论照常交付，Rust 侧标注"待用户侧验证"
  （但尽力装；前辈日志证明该沙箱型号可行）
