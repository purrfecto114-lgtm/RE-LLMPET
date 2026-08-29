# R7：CLI 韧性、诊断作用域与多源配置对账

更新日期：2026-07-29（America/Los_Angeles）

## 结论

R7 以 R6 完整源码为不可覆盖基线，继续解决五个 CLI 被压缩成 `internal error` 的问题。本轮没有新建网页，也没有替换桌宠拖拽、透明命中、DPI 锚定、三语布局、三款皮肤或任何图片/GIF/MP3。

本轮同时落地四类修复：

1. **CodeWhale 命令面漂移**：公开 Guide 写 `codewhale doctor --json`，详细配置文档又明确 doctor 属于 `codewhale-tui`。R7 不猜测单一真相，而是执行有界、可审计的 dispatcher-first 回退链。
2. **诊断目录攻击面**：取消 renderer 为 `diagnose_agent` 提供任意 cwd，避免诊断命令加载攻击者控制的项目 `.env`、插件、Hook 或配置。
3. **配置覆盖不透明**：报告 CodeWhale 项目级 `.codewhale/config.toml` / `.deepseek/config.toml` 是否存在，并在双份并存时提示路由可能随版本不同。
4. **Aider 证据缺口**：对照官方配置优先级，报告 cwd、Git 根和 home 下的 `.aider.conf.yml`；只回传常见凭据环境变量的名称，不回传值。

## Web 交叉验证

### CodeWhale

当前详细配置文档说明：dispatcher 与 TUI runtime 命令面不同，`doctor`、`setup`、`sessions` 等属于 `codewhale-tui`；`codewhale-tui doctor --json` 输出机器可读报告，配置校验失败时也输出有界、脱敏的 JSON 错误包。与此同时，公开 Guide 仍示例 `codewhale doctor --json`。

R7 因此采用：

```text
codewhale doctor --json
→ 无可解析 JSON 时尝试配套 codewhale-tui doctor --json
→ 记录每次 target、surface、退出状态与 parseableJson
```

不会静默吞掉 dispatcher 结果，也不会无条件信任 companion。结构化 JSON 在进入 WebView 前递归脱敏。

### Claude Code

官方 2.1.200 发行说明修复了系统休眠/唤醒后后台会话中途停止，以及陈旧 daemon 状态等问题。R7 解析 `claude --version`，低于 2.1.200 时给兼容性提示，但不阻止企业固定版本或自定义部署。

### OpenCode

官方 CLI 文档继续确认 `--dir` 指定 TUI 工作目录，`auth list` 只列凭据文件中的 Provider；环境变量和项目 `.env` 也可能提供凭据。R7 保留 R6 的双重工作目录约束和“0 credentials 只是 warning”的语义。

### Aider

官方配置文档说明 `.aider.conf.yml` 会在 Git 根、cwd 或 home 中查找，默认还可能从 Git 根加载 `.env`。因此诊断不能简单把“没有 home 配置”解释为未配置，也不应读取 `.env` 内容。R7 只报告候选路径是否存在和当前进程可见的凭据变量名称。

## 实现细节

### Rust 后端

- `CodeWhaleDoctorProbe` 保存最终报告、target、surface、解析 JSON 和全部尝试。
- dispatcher 输出没有可解析 JSON 时才尝试 companion；若 companion 提供 JSON、成功或 dispatcher 明确不支持命令，则选择 companion。
- 保留 JSON config-validation 错误，即使退出码非零也可归因。
- `diagnose_agent(provider)` 不再接受 cwd；使用 `LLMPET_AGENT_CWD` 或用户 home 等应用控制目录。
- `launch_agent_in` 仍未授权给 pet WebView，等待系统目录选择器和明确用户确认。
- Claude `<2.1.200` 只产生 warning。
- Aider 摘要包含配置候选、凭据变量名称和 `AIDER_MODEL` 是否存在。

### UI

在原 Provider 诊断卡中增加：

- Doctor 命令面与尝试次数；
- CodeWhale 项目配置覆盖；
- Aider 配置候选、可见凭据变量名称、模型环境状态。

所有文案同步简体中文、English、日本語；路径和诊断输出继续转义并放入有界详情区。

### Windows 证据脚本

PowerShell 5.1 脚本同步 dispatcher-first 回退、JSON 形状判断、项目覆盖和 Aider 非秘密配置发现。单个探针失败不会终止整份报告。

## 多角度取舍

- **兼容性 vs. 确定性**：固定 companion 最符合详细文档，固定 dispatcher 又符合公开 Guide；有界回退比押注任一文档更稳健。
- **诊断深度 vs. 供应链风险**：在用户项目目录运行 CLI 能得到更多真实配置证据，但也可能加载项目插件、Hook 和 `.env`。常驻 WebView 不应拥有这种隐式执行能力，因此 R7 选择应用控制目录。
- **告警准确性 vs. 阻断率**：未登录、无配置或旧版本都不必然等于不可运行；自定义 Provider、环境变量、keyring 和企业固定版本均可能有效，所以这些保持 warning。
- **可观察性 vs. 凭据保护**：报告变量名称和 credential source 足以定位桌面进程环境差异，不需要读取值。
- **视觉等价 vs. 功能堆叠**：诊断继续嵌入现有 HUD，不增加独立网页或远程资源，视觉媒体保持逐字节一致。

## 冒烟与回归

已通过：

- 完整 `npm test`；
- R3 35 项、R5 18 项、R6 20 项、R7 23 项 CLI 契约；
- 39 个图片/GIF/MP3 字节哈希；
- 38 个前端 invoke 与 Rust 注册命令对齐；
- 16 项 source release gate；
- 22 项离线静态检查；
- JavaScript/JSON 解析、Rust 词法与 3 个核心文件结构扫描；
- 协议漂移与变更空白检查。

## 未完成边界

当前容器没有 Cargo、Rustc、Rustfmt 和 PowerShell，且 Rust/GitHub 下载域名 DNS 受阻。因此没有声称完成 Rust 编译、Tauri 打包、PowerShell 实际执行或 Windows 五 CLI 真机闭环。
