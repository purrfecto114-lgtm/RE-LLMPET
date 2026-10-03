# Provider 能力矩阵（0.5.0-phase4）

更新时间：2026-09-24（R56：按 0.6.5 实际词汇复核修正）

本矩阵遵循一个原则：**统一内部事件模型，不伪造外部能力对称性**。每个 provider 只承诺其官方或 fork 维护文档明确支持的能力。

| Provider | 官方/维护扩展点 | 生命周期 | 外部权限决策 | 用量来源 | 本轮实现 | 必须保留的限制 |
|---|---|---:|---:|---|---|---|
| Claude Code | JSON hooks，包含 `PreToolUse`、`PermissionRequest` 等 | 完整 | 支持 | transcript / hook payload，仍待迁移 | merge-safe hooks；当前 `hookSpecificOutput`；HTTP 权限桥 | 必须实测 CLI 版本；不能把旧顶层决策结构继续当作有效协议 |
| CodeWhale | `config.toml` 的 `[[hooks.hooks]]` | 完整，含 subagent/turn_end（官方 HOOKS.md「The 15 events」） | 支持 `allow/deny/ask` | `turn_end.usage` 原生字段 | 14 事件安装（shell_env 为传输通道不装）；`tool_call_before` 前台且失败不继续；服务失联显式 `deny` | `ask` 在 Full Access 下不会降级权限，因此仅用于正常交互，不作为故障回退；空 stdout 不能作为安全降级 |
| Codex | `~/.codex/hooks.json` 与 `/hooks` 信任审查；后续评估只读 rollout 旁路 | 条件完整 | 支持 `PermissionRequest` | 尚待实测选择 | 当前嵌套 schema；信任提示；Windows 安全命令行 | 写入文件不等于已信任；Windows/大 payload/非 ASCII Stop 仍有上游问题，不能把 Hook 当唯一状态源 |
| OpenCode | 官方 ESM plugin API | 完整观察 | 本轮不外部接管 | 尚待事件/存储实测 | ESM 插件；session/tool/permission 观察事件 | 权限由 OpenCode 原生交互处理；不能宣传与 Claude 权限气泡等价 |
| Aider | `notifications-command` | 仅可靠覆盖回复完成（唯一事件面：v0.76.0+ ring_bell 单信号，无事件枚举） | 不支持 | 尚无统一精确来源 | 合并式 YAML 通知桥；不覆盖用户已有命令 | 不承诺 session/tool/permission 全生命周期；唯一信号=回合结束/需要输入（mid-turn 提问上游本就不可区分） |

## 内部统一事件

内部允许统一以下字段，但原始 provider payload 必须保留：

- `provider`
- `native_event`
- `hook_event_name`
- `session_id`
- `cwd`
- `tool_name`
- `state`
- `source_pid`
- `received_at`

统一后的事件名称只服务于桌宠状态机。它不能被反向理解为“所有 provider 都原生支持同样的事件、权限和计量”。

## 决策

1. Claude、CodeWhale、Codex：允许进入“外部权限桥”研发路径，但必须各自使用原生返回协议。
2. OpenCode：先作为状态观察插件，权限仍留在其原生 UI。
3. Aider：只作为回复完成通知源，不人为模拟不存在的权限协议。
4. 用量统计不从 UI 状态反推；必须来自 provider 原生 usage 或可审计 transcript。
5. 任一 provider 的 Hook 安装失败，只影响该 provider，不应阻止桌宠启动。
