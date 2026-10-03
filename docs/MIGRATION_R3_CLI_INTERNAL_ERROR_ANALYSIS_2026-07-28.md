# R3 迁移与 CLI `internal error` 总体定位

日期：2026-07-28（America/Los_Angeles）

## 1. 范围与证据边界

本轮目标不是制作网页，而是继续 Tauri 2 / Rust 桌面重写，重点处理 CodeWhale、Codex、OpenCode、Aider 等 CLI 的启动与诊断问题，并尽量不扰动已迁移的视觉资源和 UI。

本轮存在两项必须诚实保留的环境限制：

1. 当前运行时没有出现用户所称的 Rust 半成品附件，因此无法在该精确版本上执行三方合并。
2. `git clone` 因容器 DNS 无法解析 GitHub 而失败；也没有 Rust/Cargo。公开仓库通过 Web 仓库页、官方文档和已取得的 `commands.rs`、`hook_install.rs`、`lib.rs` 源文件快照交叉阅读。未把 Web 摘要冒充完整 Git 历史。

因此交付采用“守卫式补丁”而不是整文件覆盖：如果目标树与公开基线不匹配，应用脚本立即停止，不破坏可能已经存在的拖拽、透明命中、DPI 和 UI 修复。

## 2. 四条代码线的角色差异

| 代码线 | 主要真相 | 不应直接照搬的部分 |
|---|---|---|
| `myunwang/LLMPET` | 最新产品行为、三语 UI、三款皮肤、Claude 状态机、Codex rollout 只读监听、视觉资源 | Electron main/preload、Node 子进程、Electron 透明穿透与窗口 API |
| `purrfecto114-lgtm/LLMPET` | 早期多 Provider 尝试、CodeWhale Hook 经验 | 针对旧 CodeWhale/旧 Codex 的协议假设、Electron Shell 启动方式 |
| `purrfecto114-lgtm/RE-LLMPET` | Tauri 2 / Rust 最终运行时、五 Provider UI 契约 | 把“进程 spawn 成功”当成“CLI 可用”、Provider 统一化过度、空实现状态接口 |
| `Hmbown/CodeWhale` | 当前 CodeWhale 安装包、dispatcher/TUI 配对、doctor、配置和 Hook 真相 | 不能假设所有其他 CLI 也具有 companion 和 doctor |

### 辩证结论

统一桌宠 UI 是合理的；统一 Provider 的底层接入方式是不合理的。五个 CLI 应共享“状态模型、错误模型、诊断模型”，但不能共享同一套 Hook、权限或进程假设。

- Claude：原生生命周期和 PermissionRequest Hook 最完整。
- Codex：官方 LLMPET 使用 rollout 只读 tail；当前 Codex 又出现 Hook 能力，但 Hook 发现、信任和 worktree 行为仍有版本差异。应允许双通道而非强行单一路径。
- CodeWhale：互动 Hook 属于 TUI 路径；dispatcher 与 `codewhale-tui` 是配对安装。
- OpenCode：权限应继续由其原生 UI 决策，桌宠以观察为主。
- Aider：更接近 turn-end 通知，不应伪装成完整权限协议。

## 3. `internal error` 根因树

### A. 安装完整性（CodeWhale 高概率）

当前 CodeWhale 由 `codewhale` dispatcher、`codew` shim 和 `codewhale-tui` runtime 组成。只安装 dispatcher 或 companion 不同版本，会在真正进入 TUI 时失败。旧 Rust 启动器只验证主命令可见，无法区分：

- `codewhale.exe` 存在但 `codewhale-tui.exe` 缺失；
- 两个程序来自不同安装目录；
- dispatcher/runtime 版本不一致；
- npm wrapper、安装器和便携包残留形成双安装。

### B. Windows Shell 与 shim

Codex、OpenCode、Aider 可能通过 npm/pipx 安装，PATH 中出现 `.cmd`、`.bat` 或 shim，而不是原生 PE。Rust `Command::new(path.cmd)` 不能等价于交互式 shell 调用。旧实现还使用 `cmd /C start ... cmd /K`，引入二次解析、引号和工作目录漂移。

### C. 桌面进程 PATH 陈旧

安装 CLI 后，已运行的桌面应用不会自动获得新 PATH。用户在新 PowerShell 中能运行命令，不代表 Tauri 进程能找到它。Windows 安装器常只更新“当前用户 PATH”，必须重启桌宠或重新登录。

### D. 工作目录错误

Coding agent 的仓库发现、项目配置、MCP、skills、Git 信任和 Hook 都与 cwd 有关。旧实现没有显式 cwd 契约，终端可能落在用户目录、System32 或启动器目录，随后报内部错误或“找不到项目”。

### E. 配置与 Hook

可能包括：

- CodeWhale TOML 无效或新旧 `~/.deepseek` / `~/.codewhale` 双根状态；
- Hook marker block 写入中断；
- Provider、API endpoint、认证或模型配置无效；
- Codex Hook 能力、全局/项目发现和 trust 行为与版本不匹配；
- Full Access/bypass 模式绕开桌宠权限气泡，UI 却误报“等待授权”。

### F. Provider / 网络上游错误

CLI 确实启动成功后，HTTP 响应解码、代理、TLS、限流、模型路由或服务端错误仍可能显示为 internal error。这类错误属于 CLI/Provider，不应被 LLMPET 启动器吞并或重命名。

### G. 可观测性缺失

旧实现只知道 `spawn()` 是否返回成功。终端里的 stderr、退出码、版本、doctor、实际绝对路径、companion 和 cwd 都没有回传，因此完全不同的故障最终都被 UI 压成同一句 `internal error`。

## 4. 本轮重写

### 4.1 固定 Provider 白名单

`claude`、`codewhale`、`codex`、`opencode`、`aider` 使用 Rust `AgentSpec`。未知 Provider 明确报错，不再静默启动 Claude，也不把 renderer 文本传给 shell。

### 4.2 PATH 与 executable 解析

- 不调用 shell 做 `where/which`。
- Windows 遵循 PATHEXT，并识别 `.exe/.com/.cmd/.bat`。
- CodeWhale 额外检查官方 Windows 安装目录和 `%USERPROFILE%\bin`。
- 返回绝对路径，减少命令行二次解释。

### 4.3 CodeWhale 配对诊断

- 缺 `codewhale-tui` 时返回明确 `MISSING_COMPANION_BINARY`。
- 分别运行 dispatcher/runtime `--version`，比较版本。
- 运行 `codewhale-tui doctor --json`；采集有界、机器可读结果。
- 报告配置路径、是否存在和 Octopus marker block。

### 4.4 通用诊断协议

新增：

```text
diagnose_agent(provider, cwd?)
```

返回：

- provider、ready、issues；
- executable/companion 绝对路径；
- working directory；
- version、companion version、doctor；
- started、success、timedOut、exitCode；
- stdout/stderr（每项最多 8192 字符，读取上限 64 KiB）；
- Windows Terminal/cmd 路径和 PATH 条目数。

探针无法创建进程、超时或非零退出时，`ready` 不再误报 true。

### 4.5 Windows Terminal 优先、cmd 回退

默认链路：

```text
wt.exe -w -1 new-tab --title <fixed title> --startingDirectory <cwd> <absolute executable>
```

- 原生 exe 直接作为 WT commandline。
- `.cmd/.bat` 只在 tab 内使用 `cmd.exe /D /S /K call ...`。
- 仅 `wt.exe` 进程创建失败时使用直接 `cmd.exe /D /S /K`。
- 删除 `cmd /C start`。

### 4.6 工作目录

新增：

```text
launch_agent_in(provider, cwd?)
```

优先级：显式 cwd → `LLMPET_AGENT_CWD` → 用户目录 → 当前目录。显式目录不存在时拒绝启动。

### 4.7 配置写入回滚

Windows 不允许 rename 覆盖已存在文件。旧路径先删除目标再 rename，替换失败时可能丢配置。现改为：

1. 原文件 rename 到唯一备份；
2. 临时文件 rename 到目标；
3. 成功删除备份；
4. 失败则恢复原文件，并返回 `original restored`。

### 4.8 独立 Windows 诊断脚本

`scripts/windows-cli-diagnostics.ps1`：

- 兼容 Windows PowerShell 5.1，不使用 `??`；
- 单个 CLI 探针失败不会终止整份报告；
- `.cmd/.bat` 通过 `cmd.exe` 探测；
- 检查 CodeWhale companion、doctor、PATH、WT、cwd；
- 输出 JSON，便于从故障机器回传证据。

## 5. 视觉与 UI 的取舍

本轮没有修改 renderer、CSS、GIF、PNG 或音频。这不是放弃视觉迁移，而是避免在精确附件不可用时，用公开旧基线覆盖已经完成的拖拽/DPI/三语 UI。

下一步 UI 应在现有桌宠 HUD 内增加“Agent 诊断”二级页：

- 沿用现有卡片、标题、返回按钮、Provider 图标和三语词典；
- 用状态点区分“未发现 / companion 缺失 / 版本错配 / doctor 失败 / 可启动”；
- 只显示脱敏摘要，完整 JSON通过“打开诊断文件”查看；
- 不新建 Web 服务或浏览器页面；
- 图片、GIF、音频继续按字节哈希门禁。

## 6. 冒烟验证

已执行且通过：

- 静态迁移契约：25/25；
- Rust 三文件词法/括号结构：3/3；
- patch 在公开基线上的 `git apply --check` 和实际应用复现：通过；
- 应用脚本目标不匹配时不修改文件；
- 本轮包内不含 renderer/assets 变更。

这些测试证明本轮触达的静态契约没有自相矛盾，但**不等同于 Rust 编译或 Windows 真机无回归**。

## 7. 仍需真机回答的问题

1. internal error 是在 CLI 启动前、TUI 初始化、加载项目、加载配置、首次 API 请求还是 Hook 执行时出现？
2. 故障机上 `codewhale` 和 `codewhale-tui` 是否同目录同版本？
3. Tauri 进程 PATH 是否包含用户刚安装的 npm/pipx/cargo/bin 目录？
4. 失败项目 cwd 是否含空格、中文、UNC 或网络盘？
5. `codewhale-tui doctor --json` 的 error.kind 是 companion、config_validation、provider/auth、runtime 还是 PATH？
6. 关闭 Octopus 自有 Hook marker 后，CLI 是否仍复现？若仍复现，则错误不应归因于 Hook。
7. 在普通 PowerShell 直接从同一 cwd 启动是否成功？这能把“桌面启动器问题”和“CLI/Provider 问题”分开。

## 8. 定时任务说明

用户要求每 30 分钟一轮。当前自动化调度器最高频率为每小时一次，不能创建一个虚假的 30 分钟任务，因此本轮没有创建定时任务。当前环境也不能后台持续修改源码；所有交付均在本轮完成并固定为文件。
