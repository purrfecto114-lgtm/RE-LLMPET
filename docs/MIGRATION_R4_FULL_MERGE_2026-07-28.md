# R4 完整合并报告：R2 视觉/交互基线 + R3 CLI 加固

更新日期：2026-07-28（America/Los_Angeles）

## 结论

本目录是完整项目源码，不是 overlay。它以 `LLMPET-Tauri-v0.5.5-reworked-r2-source.zip` 为基线，将 R3 的 CLI 加固按函数和协议边界三方合并，同时保留 R2 已完成的桌宠拖动、透明命中、DPI 锚点、三语 UI、GIF/MP3、本地 meme 预览和 Tauri 状态管理。

没有采用 R3 的整文件覆盖，因为其 `commands.rs`/`lib.rs` 基于更早代码：直接覆盖会删除 `set_language`、`commit_win_pos`、原生 cursor hit-test、DPI-aware anchored resize、真实 `ui_busy`/`pet_visual_bounds` 等已修复行为。

## 已合并

- 五 Provider 固定白名单：Claude、CodeWhale、Codex、OpenCode、Aider。
- 未知 Provider fail-closed，不再回退 Claude。
- PATH/PATHEXT 原生解析，Windows 支持 `.exe/.com/.cmd/.bat`；Unix 拒绝 PATH 中不可执行的同名普通文件。
- CodeWhale 主程序与 `codewhale-tui` companion 完整性检查。
- dispatcher/runtime 版本探针与不一致报告。
- `diagnose_agent(provider, cwd)`：绝对路径、版本、stdout/stderr、退出码、超时、CodeWhale doctor、配置与终端信息。
- `launch_agent_in(provider, cwd)`：后端已注册，但没有授予 pet WebView 权限，直到 UI 提供明确的目录选择器。
- Windows Terminal 优先，`cmd.exe` 仅作为缺失/启动失败回退；npm `.cmd/.bat` shim 使用受限兼容分支。
- VS Code/Cursor 的 `.cmd/.bat` GUI shim 同样修复，避免 `Bad EXE format`。
- Windows Hook 配置备份—替换—失败恢复。
- PowerShell 5.1 兼容的独立诊断脚本。
- renderer 桥接新增只读 `diagnoseAgent(provider, cwd)`，没有暴露任意命令或可执行路径。

## CodeWhale internal error 的辨证定位

`internal error` 不是单一异常。进程能被终端创建，只能证明 Terminal/cmd 启动成功，不能证明 CLI 安装、companion、Provider 配置、工作目录、认证、网络或服务端响应正常。

当前诊断按以下层次区分：

1. **发现层**：桌面进程 PATH 是否能找到真实入口；npm shim 与 native binary 是否被正确识别。
2. **安装层**：CodeWhale dispatcher 与 `codewhale-tui` 是否成套、版本是否一致。
3. **运行层**：`--version`、`doctor --json` 是否能启动、是否超时、退出码和 stderr 是什么。
4. **上下文层**：实际 cwd、配置文件、环境变量和 Terminal/cmd 是否一致。
5. **Provider 层**：API key、Provider/model、代理/TLS、服务端与响应解码问题；这类问题只能由 doctor 或真实会话暴露。

CodeWhale 当前文档要求安装路径同时提供 dispatcher 与 runtime，并建议用 `codewhale doctor --json` 生成机器可读诊断；因此 R4 的 doctor 探针优先运行公共 dispatcher 命令，而不是绕过 dispatcher 只探测 companion。参考：

- https://github.com/Hmbown/CodeWhale/blob/main/docs/GUIDE.md
- https://github.com/Hmbown/CodeWhale/blob/main/docs/CONFIGURATION.md

Windows Terminal 参数按 Microsoft 当前文档使用 `-w -1 new-tab --startingDirectory ... commandline`：

- https://learn.microsoft.com/en-us/windows/terminal/command-line-arguments

Tauri 命令继续通过 `generate_handler!` 与生成的 command permission 注册，WebView 能力单独最小授权：

- https://v2.tauri.app/develop/calling-rust/
- https://v2.tauri.app/security/capabilities/

## 保留的 R2 行为

- `set_language` 与中英日文案。
- Pointer Events + rAF 节流拖动。
- `commit_win_pos` 仅在拖动结束后写盘。
- 原生 cursor hit-test 恢复透明窗口输入。
- `set_ignore_mouse` 只记录 renderer 意图，实际穿透由原生守护控制。
- CSS logical pixels → physical pixels DPI 转换。
- 扩窗保持桌宠底部中心锚点并限制在显示器工作区。
- 真实 `ui_busy` 和可视区域状态。
- 39 个图片/GIF/音频视觉资源字节不变。
- 会话 HUD、meme 二级页、三款皮肤与 Provider 身份样式不变。

## 权限取舍

`diagnose_agent` 被授予 pet 窗口，因为它只接受固定 Provider 和可选目录，并返回有界诊断 JSON。`launch_agent_in` 虽已在 Rust 注册，但未加入 pet capability：在没有系统目录选择器和用户确认之前，让 renderer 任意选择现有目录会扩大被攻陷 WebView 的文件作用域。

## 验证范围

已执行：

- 项目原有 `npm test` 全套。
- R3/R4 CLI 加固 35 项静态契约。
- 39 资源字节基线。
- source release gate、protocol drift、JS/JSON/YAML 解析。
- 13 个 Rust 文件词法结构检查；核心改动 3 文件额外括号/字符串扫描。
- 补丁空白、完整源码清单与 ZIP 完整性检查。

未执行：

- `cargo fmt --check`、`cargo check`、`cargo test`、Tauri bundle。
- Windows Terminal/Command Prompt 真机与五个真实 CLI 闭环。
- Windows 混合 DPI、WebView2、签名和安装包。

原因是当前容器没有 Rust 工具链；尝试访问 Debian 软件源时 DNS/网络超时。报告不会把词法扫描写成编译成功。

## Windows 故障机建议闭环

从实际项目目录运行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows-cli-diagnostics.ps1 -WorkingDirectory 'D:\path\to\project'
```

然后保留生成的 `octopus-cli-diagnostics.json`。不要公开 API key、完整私有源码或包含秘密的环境变量。
