# R6 自主迁移 TODO

更新日期：2026-07-29（America/Los_Angeles）

## 本轮完成

- [x] 以 R5 完整源码为不可覆盖基线。
- [x] Web 交叉验证 CodeWhale、Codex、OpenCode、Claude 的当前只读诊断命令。
- [x] 在文本截断前解析 CodeWhale doctor JSON，并递归脱敏。
- [x] 保留 `api_key.source`，不暴露任何 credential value。
- [x] 提取 CodeWhale Provider、模型、请求格式和会话迁移摘要。
- [x] 增加 `codewhale auth status`、`codex login status`、`opencode auth list`。
- [x] 将认证失败保持为 warning，避免误伤自定义/环境变量/本地 Provider。
- [x] 识别 OpenCode `0 credentials` 输出。
- [x] OpenCode 在四类终端路径中统一使用官方 `--dir .` 工作目录参数。
- [x] 在现有 Provider 诊断卡中显示认证和路由信息，补齐中英日文案。
- [x] 同步 Windows PowerShell 5.1 诊断脚本。
- [x] 增加 R6 专项冒烟测试并保持视觉资源门禁不变。
- [x] 更新迁移总 TODO 和上游适配哈希来源记录。
- [x] 生成完整 R6 源码包、哈希、差异和机器验证报告。

## 下一阶段

- [ ] 在 Rust 1.85+ 执行 `cargo fmt --check`。
- [ ] 在 Linux/Windows/macOS 执行 `cargo check --locked --all-targets` 和 `cargo test --locked`。
- [ ] Windows 真机覆盖已登录、未登录、过期凭据、代理/TLS、损坏配置和自定义 Provider。
- [ ] 验证 CodeWhale doctor 正常 JSON与 `config_validation` 错误 JSON 两条路径。
- [ ] 验证 Codex `login status` 对 ChatGPT、API key 与自定义 `env_key` Provider 的差异。
- [ ] 验证 OpenCode 凭据文件、环境变量、项目 `.env` 和 `0 credentials` 四条路径。
- [ ] 对 `internal error` 故障机采集脱敏证据，按安装/认证/路由/网络/服务端层分类。
- [ ] 评估 Codex Hook 与只读 rollout 监听双通道，不把 Hook 存在等同于事件可靠。
