# R5 自主迁移 TODO

更新日期：2026-07-29（America/Los_Angeles）

## 本轮目标

- [x] 固定用户上传的 R4 完整源码为本轮基线。
- [x] 尝试浅克隆 LLMPET、CodeWhale、Codex；记录容器 DNS 阻断，不把 Web 阅读冒充本地 Git 历史。
- [x] 按 CodeWhale 官方优先级统一配置路径解析：显式配置环境变量 → `CODEWHALE_HOME` → `~/.codewhale/config.toml` → 仅在新路径不存在时回退 `~/.deepseek/config.toml`。
- [x] 让 Hook 安装、CLI 诊断和 Windows 诊断脚本使用同一配置路径语义。
- [x] 为 Claude Code 增加官方 `claude doctor` 有界诊断；其余 Provider 保持保守的版本探针。
- [x] 对诊断 stdout/stderr 做二次脱敏和长度限制，避免 UI/日志暴露凭据。
- [x] 将诊断接入现有详情面板 Provider 区，不创建新网页。
- [x] 为每个 Provider 提供“诊断”动作、就绪状态、问题列表、可执行路径、版本、doctor 与终端信息。
- [x] 增加回归测试，覆盖配置回退、脱敏、Claude doctor 和面板诊断 UI。
- [x] 运行 npm 全套冒烟、资源哈希、协议漂移、静态结构和发布门禁。
- [x] 按当前 CodeWhale 命令边界修正 doctor：直接运行配对的 `codewhale-tui doctor --json`，不依赖 dispatcher 兼容别名。
- [x] 增加非泄密兼容性提示：旧 DeepSeek 模型 ID 与遗留 TLS 绕过配置只作为 warning，不把可迁移配置误判为 CLI 不可用。
- [x] 生成 R5 完整源码包、SHA-256、变更报告和机器验证报告。

## 真机/CI 保留项

- [ ] Rust 1.85+ 下运行 `cargo fmt --check`、`cargo check --locked --all-targets`、`cargo test --locked`。
- [ ] Windows 故障机采集 CodeWhale `internal error` 的真实 doctor、版本、cwd、PATH 和 stderr。
- [ ] 验证 CodeWhale 新配置、旧配置迁移、显式配置路径和 companion 错版四条路径。
- [ ] 五 CLI 分别完成启动、诊断、事件、退出闭环。
- [ ] 验证 Windows Terminal、cmd fallback、混合 DPI 和透明区域拖动。
