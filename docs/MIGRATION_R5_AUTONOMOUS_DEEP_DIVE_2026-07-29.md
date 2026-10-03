# R5 自主深挖：CLI 可诊断闭环与上游漂移修正

更新日期：2026-07-29（America/Los_Angeles）

## 结论

R5 以 R4 完整源码为基线继续迁移，没有创建独立网页，也没有替换桌宠、会话 HUD、三语界面、图片、GIF、MP3 或拖拽/DPI 实现。本轮把 CLI 启动从“能创建终端进程”推进到“在现有详情面板中可以区分安装、版本、配置、doctor、PATH、cwd 与终端问题”。

CodeWhale `internal error` 不能由单一修复解释。R5 将以下层次分开：

1. **入口发现**：桌面进程是否能看到 CLI，Windows npm `.cmd/.bat` 是否按命令 shim 执行。
2. **安装完整性**：CodeWhale dispatcher、`codew`/安装分发和 `codewhale-tui` companion 是否配套，dispatcher/runtime 版本是否一致。
3. **配置选择**：显式配置环境变量、`CODEWHALE_HOME`、当前路径和旧 `~/.deepseek` 回退是否在 Hook 与诊断中一致。
4. **健康探针**：版本、退出码、stderr、超时、Claude doctor 与 CodeWhale doctor 是否成功。
5. **Provider/模型层**：认证、模型 ID、代理、CA/TLS、服务端响应或 Provider 特定映射问题。
6. **终端交互层**：Windows Terminal/cmd、工作目录、焦点和 TUI 自身崩溃不能被误归类为同一错误。

## 上游交叉验证后的关键修正

### CodeWhale doctor 的真实命令边界

当前 CodeWhale 配置文档明确说明 `setup`、`doctor`、`mcp`、`features`、`sessions` 等属于 `codewhale-tui` 子命令，并明确给出 `codewhale-tui doctor --json` 的机器可读行为。发布说明中也存在 `codewhale doctor` 的兼容入口，但桌面诊断不应依赖 dispatcher 别名永久存在。

R5 因此：

- 继续分别运行 dispatcher 与 companion 的 `--version`，验证安装边界；
- doctor 改为直接运行已解析、已配对的 `codewhale-tui doctor --json`；
- 返回 `doctorTarget`，UI 明确展示实际被执行的程序；
- companion 缺失时不运行 doctor，并保留 `MISSING_COMPANION_BINARY` 硬错误。

参考：

- https://github.com/Hmbown/CodeWhale/blob/main/docs/CONFIGURATION.md
- https://github.com/Hmbown/CodeWhale/releases

### CodeWhale 版本与配置漂移

Web 对账时，CodeWhale 发布页显示最新正式版本已到 v0.9.1（2026-07-24），而不是此前报告记录的 v0.8.57。v0.9.1 的 npm/发布包包含 `codewhale`、`codew` 和 `codewhale-tui` 三个入口；Cargo 安装仍要求 dispatcher 与 TUI 两个 crate 同时存在。

当前配置文档还说明：直接 DeepSeek 路由在 2026-07-24 退役 `deepseek-chat` 和 `deepseek-reasoner`，但聚合器、Wanjie Ark、自托管和自定义端点不能被全局机械改写。因此 R5 不把旧 ID 直接视为致命错误，而是：

- 只读取最多 256 KiB 的普通配置文件；拒绝符号链接和超大文件；
- 不返回配置正文或凭据；
- 仅报告检测到的旧模型 ID；
- 以 compatibility warning 提醒运行 doctor/models；
- 对 `insecure_skip_tls_verify=true` 单独提醒当前客户端会拒绝，应使用可信 `SSL_CERT_FILE`。

### Claude doctor

Anthropic 官方安装/故障排查文档建议使用 `claude doctor` 检查安装。R5 对 Claude 增加 15 秒、有界 stdout/stderr、退出码和超时探针，并复用统一脱敏器。

参考：

- https://docs.anthropic.com/en/docs/claude-code/setup
- https://docs.anthropic.com/en/docs/claude-code/troubleshooting

### Codex 不应强行与 Claude Hook 等价

Codex 当前 Windows Hook 仍存在公开边界：大文件 payload 可能超过操作系统参数限制，非 ASCII Stop payload 也有 malformed JSON 报告。它们证明“配置文件存在”不等于“所有事件可靠送达”。R5 没有为了表面统一而扩大 Hook 声明；后续应保留 Hook 与上游只读 rollout 监听的双通道评估。

参考：

- https://github.com/openai/codex/issues/18067
- https://github.com/openai/codex/issues/23784

## 实现

### 后端

- `diagnose_agent(provider, cwd)` 固定五 Provider 白名单。
- CodeWhale 配置解析在命令、Hook 安装和 PowerShell 证据脚本中统一。
- doctor 输出在读取管道时限制 64 KiB，清理控制字符、逐行脱敏，最终限制 8192 字符。
- 诊断区分 hard issues 和 compatibility warnings；warning 不把 `ready` 改为 false。
- 配置兼容扫描只返回布尔值、文件大小和旧模型 ID，不返回正文。
- `launch_agent_in` 继续未授权给 WebView，避免任意目录启动作用域。

### 现有 UI 内集成

- 在详情面板原 Provider 区增加每个 Provider 的“诊断”按钮。
- 展示 ready/problem、issues、warnings、可执行路径、入口类型、版本、companion、cwd、PATH、配置来源、Hook marker、doctor target、终端路径和脱敏输出。
- 诊断详情使用有界滚动区域；错误与兼容提醒视觉分层。
- 支持中文、英语和日语标签。
- 诊断后可重新运行或尝试启动；启动失败通过 Promise 返回并显示，不再只写 console。

## 辩证取舍

- **不把 doctor 设成启动硬门槛**：doctor 可能因网络或 Provider 状态失败，但用户仍可能需要进入终端修复。UI 提供证据与选择，而不是擅自阻断。
- **不把 warning 混入 failure**：旧模型 ID 在不同 Provider 路由上的语义不同，机械替换可能破坏聚合器或自托管配置。
- **不把配置正文送到 renderer**：诊断价值来自路径、状态、版本和有界错误，不需要把 secrets 暴露给 WebView。
- **不新建网页**：复用现有详情面板，视觉和窗口尺寸体系保持一致。
- **不机械统一五 Provider**：Provider 共享诊断外壳，但 Hook、rollout、原生权限和完成通知仍按各自协议处理。

## 验证

完成：

- `npm test` 全套；
- R3/R5 CLI 契约 35 + 16 项；
- 39 个视觉/媒体资源逐字节回归；
- source release gate 16/16；
- protocol drift；
- 42 个 JavaScript 文件语法；
- 13 个 Rust 文件词法结构与 3 个核心文件结构门禁；
- JSON/YAML、桥接命令、capability、Hook、供应链和静态结构检查。

未完成：

- 当前容器没有 Cargo/Rustc/Rustfmt，不能执行原生编译。
- 容器 DNS 无法解析 GitHub，浅克隆三次失败；Web 源码、发布页和 issue 只用于交叉验证，不能冒充本地 Git 历史。
- 浏览器进程被环境管理策略阻断本地 `file://` 和 localhost，未生成 Playwright 截图；DOM/CSS/JS 静态与契约检查通过，但不冒充真实 WebView2 视觉测试。
- Windows 五 CLI、真实 CodeWhale doctor、混合 DPI 与签名安装包仍需真机/CI。
