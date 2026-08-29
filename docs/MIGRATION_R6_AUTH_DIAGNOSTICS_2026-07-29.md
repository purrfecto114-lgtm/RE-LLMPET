# R6：认证、路由与工作目录诊断闭环

更新日期：2026-07-29（America/Los_Angeles）

## 本轮结论

R6 继续以 R5 完整 Tauri 工作树为基线，不创建新网页，不替换桌宠、会话 HUD、拖拽、DPI、三语布局或图片/GIF/MP3。修改集中在五 Provider 启动前诊断，目标是把笼统的 `internal error` 拆成可操作的四层证据：

1. **安装层**：可执行文件、npm shim、CodeWhale companion 与版本配对。
2. **认证层**：CLI 自己的只读认证状态命令是否确认凭据。
3. **路由层**：CodeWhale doctor 解析出的 Provider、模型和请求协议。
4. **工作目录层**：终端 cwd 与 Provider 自身的目录参数是否一致。

诊断仍不是启动硬门槛。认证探针失败只形成 warning，因为环境变量、项目 `.env`、自定义 Provider 或本地无密钥模型可能仍能工作。

## 上游交叉验证

### CodeWhale

当前配置文档明确区分 dispatcher 与 TUI 子命令：`doctor` 属于 `codewhale-tui`；`codewhale-tui doctor --json` 跳过实时 API 连通性探测并输出机器可读报告。稳定字段包括 `api_key.source`、`capability.resolved_provider`、`capability.resolved_model` 和 `capability.request_payload_mode`。配置错误则以非零退出码和脱敏 JSON 错误包返回。

R6 因此在截断文本前解析原始 JSON，再递归清除 token/password/secret 等字段；`api_key` 只保留非秘密的 `source`。UI 不接收完整配置正文或凭据。

参考：https://github.com/Hmbown/CodeWhale/blob/main/docs/CONFIGURATION.md

### Codex

官方命令参考说明 `codex login status` 会打印当前认证方式，存在凭据时退出 0，适合自动化探针。它不能证明后续 API 请求一定成功，也可能不能代表使用 `env_key` 的自定义模型 Provider；因此 R6 将失败显示为“认证未确认”，不把 CLI 判定为未安装或不可启动。

参考：https://developers.openai.com/codex/developer-commands

### OpenCode

官方 CLI 文档提供 `opencode auth list` 来列出凭据文件中的 Provider，同时说明环境变量和项目 `.env` 也会参与认证；TUI 明确支持 `--dir` 指定工作目录。

R6：

- 运行 `opencode auth list`；
- 识别成功输出中的 `0 credentials`；
- 对零凭据只给兼容性 warning；
- 所有终端路径都传入 `--dir .`，并继续设置进程 cwd，防止终端或 wrapper 把工作区重置到用户主目录。

参考：https://opencode.ai/docs/cli/

### Claude Code

保留 R5 的 `claude --version` 和 `claude doctor`。官方说明 doctor 是只读安装和设置诊断，不会启动会话。

参考：https://code.claude.com/docs/en/setup

## 实现摘要

### Rust 后端

- 新增 `ProbeCapture`：同时保留有界文本报告与独立解析后的 JSON。
- 结构化 JSON 在序列化给 WebView 前递归脱敏。
- CodeWhale doctor 生成最小摘要：状态、错误类型、配置路径、密钥来源、Provider、模型、请求格式和会话迁移状态。
- 新增认证探针：
  - `codewhale auth status`
  - `codex login status`
  - `opencode auth list`
- 认证失败不改变 `ready`，只形成包含 Provider 限定条件的 warning。
- OpenCode 零凭据输出单独识别。
- OpenCode 启动在 Windows Terminal、cmd fallback、macOS Terminal 和 Linux 终端模拟器中统一附加 `--dir .`。
- Windows `.cmd/.bat` 路径仍只通过绝对、白名单解析后的 shim 进入 `cmd.exe`。

### 现有 UI

Provider 诊断卡新增：

- 认证状态与脱敏输出；
- CodeWhale Provider/模型路由；
- 密钥来源；
- 请求 payload 模式；
- 会话迁移状态。

新增文本均提供中文、英文和日文，不增加页面、不改变媒体资源。

### Windows 证据脚本

`scripts/windows-cli-diagnostics.ps1` 同步采集 CodeWhale/Codex/OpenCode 的认证状态，并记录 OpenCode 的启动目录参数。脚本继续兼容 Windows PowerShell 5.1、npm shim、有界输出和敏感信息脱敏。

## 辩证取舍

- **认证状态不是端到端健康检查**：登录成功后仍可能出现授权范围、代理、TLS、模型或服务端错误；诊断只陈述它真正验证过的层次。
- **认证失败也不等于不能工作**：Codex 自定义 Provider、OpenCode 环境变量/项目 `.env`、CodeWhale 本地或无密钥 Provider 都可能绕过持久凭据存储。
- **不进行主动 API 请求**：启动前诊断保持只读、低成本、不会消耗额度，也不会把用户请求发送给外部 Provider。
- **不把 secrets 交给 renderer**：结构化摘要只保留来源和路由元数据，原始文本也经过二次脱敏和长度限制。
- **不为了统一而伪造协议等价**：Claude doctor、CodeWhale doctor、Codex login status、OpenCode auth list 分别按官方能力使用。

## 验证边界

已完成：JS 语法、静态 Rust 结构、协议/能力边界、39 个视觉资源哈希、R3/R5/R6 CLI 契约、完整 npm 冒烟和发布门禁。

未完成：当前容器没有 Cargo/Rustc/Rustfmt，且外部下载受 DNS 限制；因此 Rust 编译、Tauri 打包和 Windows 五 CLI 真机闭环仍须在 CI/真机完成。
