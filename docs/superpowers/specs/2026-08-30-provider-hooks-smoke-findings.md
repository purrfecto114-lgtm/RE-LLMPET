# Provider Hooks 真实 CLI 冒烟发现（2026-08-30，0.6.1）

> 执行框架：superpowers-zh 1.7.1（writing-plans / verification-before-completion /
> systematic-debugging 的"先实证再下结论"）。本文档只记录**活体证据**——
> 每一条都来自真实 CLI 的行为或官方文档原文，未验证的一律标注。

## 1. 测试环境与工具链（全部自建）

| 组件 | 版本 | 获取方式 |
|---|---|---|
| claude | 2.1.251 | bun add -g @anthropic-ai/claude-code |
| codex | 0.151.0 | bun add -g @openai/codex |
| opencode | 1.18.25 | bun add -g opencode-ai |
| aider | 0.86.2 | pip（venv）aider-chat |
| codewhale | —（见 §6） | 官方 npm 包名 codewhale |
| Rust | 1.98.0 | rustup minimal |
| GTK dev | trixie 闭包 683 deb | apt-get download → dpkg-deb -x ~/.local/gtk-dev |

mock 模型面（仅替代模型端点，不替代 CLI 本体）：OpenAI chat/completions、
OpenAI **Responses**（codex 0.151 强制）、Anthropic Messages（claude
ANTHROPIC_BASE_URL）三种协议，均在 `scripts/provider-smoke/`。

## 2. 结论矩阵（辩证）

| Provider | 官方契约判定 | 真实触发事件 | 决策协议 | 本沙箱不可实证项 |
|---|---|---|---|---|
| claude 2.1.251 | **PASS** | SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/SessionEnd（含 Read 工具真实执行两段回合） | hookSpecificOutput.permissionDecision=allow/deny/ask **全部被遵守**（deny 阻止工具） | —（已全链路） |
| opencode 1.18.25 | **PASS** | SessionStart/SessionStatus/PreToolUse/PostToolUse/Stop/Notification(permission.asked→needsinput) | native-only（如实） | —（已全链路） |
| aider 0.86.2 | **PASS** | turn-end ×2（notifications-command 真实触发） | native-only | —（已全链路） |
| codex 0.151.0 | **FAIL（诚实）** | SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/SessionEnd + rollout session_meta | 事件名/枚举在二进制中实证；headless 不可诱发 PermissionRequest | allow/deny 决策链（需 TUI 或更严沙箱）；Interrupt（用户中止，TUI 门控） |
| codewhale | 文档级核实 | — | decision=allow/deny/ask + exit2 硬拒 + background 语义（HOOKS.md 原文） | hooks 为 **TUI 运行时特性**，`codewhale exec` 不触发（官方明示）→ 全部运行时行为待 TUI 环境 |

## 3. 掀出的理想化假设（按杀伤力排序）

1. **aider 安装会弄坏 aider 本体**（已修复）：install_aider 写
   `notifications_command:`（下划线）；aider 的 configargparse
   YAMLConfigFileParser 把 yaml 键**原样**拼成 CLI 旗标，而旗标是
   `--notifications-command`（连字符）→ 真实 aider 0.86.2 exit(2)
   `unrecognized arguments: --notifications_command=…`。修复：发射连字符
   形式（marker 不变，老块照常迁移）；phase2 旧测试的"yaml 用下划线"注释
   是当年想当然，一并纠正并以活体证据锁定（r51 回归测试）。
2. **codex 契约的虚惊与真变**（辩证过程留存）：二进制 strings 里的
   `PreToolUse…SubagentStop Interrupt` 簇一度被怀疑是 hooks.json 的合法
   键全集（若真，我们装的 Stop/UserPromptSubmit 会被拒）。实测推翻：该簇
   是 Claude settings 迁移代码的清单；**Stop/UserPromptSubmit 均真实触发**
   （带 turn_id）。真变是 **Interrupt 为新增事件**（用户中止）→ 已补装并
   归一化为 Stop/attention。
3. **codex 0.151 移除 wire_api="chat"**：model_providers 配置强制
   `responses`（对告警链接 openai/codex#7782）。影响任何把 codex 指向
   自定义网关的用户配置——与我们集成本身无冲突，但诊断文档应知晓。
4. **codex 工具改名**：shell → `exec_command`，参数为 `{"cmd":"…"}`（字符串）。
   不影响 hooks（tool_name 透传），但影响任何按旧名分诊的逻辑与用户心智。
5. **headless 陷阱三连**（记录在驱动脚本注释里，防止未来再踩）：
   - `codex exec` 在 stdin 为未关闭管道时等待附加输入（必须 `</dev/null`）；
   - `opencode run --format json` 在非 TTY 管道下可挂死 1.18.25；
   - aider 通知在**下一次用户输入提示**时触发，单回合 `--message` 永不触发
     （冒烟需管道双输入）。
6. **drift 检查器的 403 误报**：developers.openai.com/codex/hooks 对机房 IP
   返回 403（Cloudflare）。旧检查器把"看不到页面"当"内容漂移"。修复：
   401/403/429/5xx 归类 transport-blocked，不算 drift 但保留在报告里；
   needles 由真实二进制+活体冒烟背书。
7. **CodeWhale env 表缺三变量**：DEEPSEEK_TOOL_EXIT_CODE / TOTAL_TOKENS /
   SESSION_COST（HOOKS.md 实证）→ hook_client 兜底表已补。
8. **上游 fork 已前进**：head 86cbd9e → 11ff1ba（"security: harden
   Electron renderer…"）——上游仍在 Electron 线，本仓 Tauri 分叉持续扩大；
   baseline 观察点已更新。

## 4. 代码变更清单（全部有测试锁定）

- `src-tauri/src/hook_install.rs`：CODEX_EVENTS+Interrupt（实证注释）；
  install_aider 连字符发射；opencode 日志 v3→v4 更正。
- `src-tauri/src/hook_client.rs`：codex Interrupt→Stop/attention；
  CodeWhale env 兜底 +3 变量。
- `src-tauri/src/territory.rs`：eq_op 真错误修复（恒真比较→显式常量+出处注释）。
- `src-tauri/src/model.rs`：collapsible_if 折叠。
- `src-tauri/src/provider_registry.rs`：static mut→OnceLock；derive(Default)；
  文件级 allow(dead_code)+理由（能力矩阵 API 属声明面，按路线图保留）。
- `src-tauri/src/dsh_watch.rs` / `config_types.rs`：契约类型 dead_code 注记。
- `scripts/check-protocol-drift.js`：blocked 分类 + UA 0.6.1。
- `protocol-baseline.json`：codex+Interrupt、aider needle 连字符、上游头
  11ff1ba、codex-hooks 403 注记、updatedAt 2026-08-30。
- `scripts/provider-smoke/*`：9 个可复用冒烟组件（见 §5）。
- `test/pet-r51-provider-smoke-regression.js`（新增，已入 npm test 链）、
  `test/tauri-provider-phase2-smoke.js` / `tauri-protocol-drift-smoke.js` /
  `maintainability-boundary-smoke.js` 断言校准（均带证据注释）。
- 版本 0.6.1 全仓同步（package/Cargo/lock/tauri.conf/migration-todo/12 个版本
  钉测试/SOURCE_MANIFEST/CHANGELOG）。

## 5. 复现方式

```bash
# 单 provider（需要对应 CLI 已安装；aider 走 /home/z/aider-venv）
OCTOPUS_PROVIDER_SMOKE_COMMAND="bash scripts/provider-smoke/run-claude.sh" \
  node scripts/real-provider-smoke.js --provider claude
# opencode / aider 同理；codex 预期 FAIL（缺 allow/deny，见 §2）

node scripts/check-protocol-drift.js --remote --strict-network
# → remote-contract-ok-blocked; blocked=[codex-hooks:403]
```

## 6. 遗留与建议（下一轮）

1. **codex PermissionRequest 决策链**：需 TUI 会话或更严 sandbox profile
   （如 macOS seatbelt 拒写场景）才能诱发；建议挂到 self-hosted
   provider-cli runner（provider-real-cli.yml 已就绪）。
2. **CodeWhale TUI 冒烟**：同上需要真实 TTY 环境；契约面（11 事件/env 表/
   decision 词表）已按官方 HOOKS.md 双重核对。
3. **claude 23 事件中的新增观察事件**（Setup/InstructionsLoaded/CwdChanged/
   WorktreeRemove/DirectoryAdded）在 2.1.251 二进制中全部存活，本轮已在
   无鉴权下验证 SessionStart 族；完整逐事件触发矩阵可后续在真账号环境补。
4. 上游 fork 的 Electron 安全面硬化若涉及 hooks 配置解析，需评估是否回移。
