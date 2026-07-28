# Provider 能力矩阵（0.5.0-phase4）

更新时间：2026-07-27

本矩阵遵循一个原则：**统一内部事件模型，不伪造外部能力对称性**。每个 provider 只承诺其官方或 fork 维护文档明确支持的能力。

| Provider | 官方/维护扩展点 | 生命周期 | 外部权限决策 | 用量来源 | 本轮实现 | 必须保留的限制 |
|---|---|---:|---:|---|---|---|
| Claude Code | JSON hooks，包含 `PreToolUse`、`PermissionRequest` 等 | 完整 | 支持 | transcript / hook payload，仍待迁移 | merge-safe hooks；当前 `hookSpecificOutput`；HTTP 权限桥 | 必须实测 CLI 版本；不能把旧顶层决策结构继续当作有效协议 |
| CodeWhale | `config.toml` 的 `[[hooks.hooks]]` | 完整，含 subagent/turn_end | 支持 `allow/deny/ask` | `turn_end.usage` 原生字段 | 10 类 Hook；`tool_call_before` 前台且失败不继续；服务失联显式 `ask` | Full Access 模式可能绕过 `ask`；空 stdout 不能作为安全降级 |
| Codex | `~/.codex/hooks.json` 与 `/hooks` 信任审查 | 完整 | 支持 `PermissionRequest` | 尚待实测选择 | 当前嵌套 schema；信任提示；Windows 安全命令行 | 写入文件不等于已信任；每次变更后都要审查实际启用状态 |
| OpenCode | 官方 ESM plugin API | 完整观察 | 本轮不外部接管 | 尚待事件/存储实测 | ESM 插件；session/tool/permission 观察事件 | 权限由 OpenCode 原生交互处理；不能宣传与 Claude 权限气泡等价 |
| Aider | `notifications-command` | 仅可靠覆盖回复完成 | 不支持 | 尚无统一精确来源 | 合并式 YAML 通知桥；不覆盖用户已有命令 | 不承诺 session/tool/permission 全生命周期；只显示 turn-end 能力 |

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
