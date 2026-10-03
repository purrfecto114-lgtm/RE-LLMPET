# R3 迁移待办（CLI internal error 总体定位）

更新日期：2026-07-28（America/Los_Angeles）

## 已完成

- [x] 对照官方上游 `myunwang/LLMPET`、早期五 Provider fork、公开 Rust 重写分支与 CodeWhale 官方文档。
- [x] 建立 Provider 语义差异：Claude Hook、Codex rollout/Hook、CodeWhale TUI Hook、OpenCode native permission、Aider turn-end notification 不再强行视为同一协议。
- [x] 定位 CLI `internal error` 的安装、终端、PATH、工作目录、配置、Provider 网络和错误可观测性七类根因。
- [x] 删除未知 Provider 静默回退 Claude 的行为，改为固定五 Provider 白名单。
- [x] Windows 默认使用 Windows Terminal；仅在 `wt.exe` 启动失败时回退 `cmd.exe /D /S /K`。
- [x] 支持 npm 安装产生的 `.cmd` / `.bat` shim，包括启动和版本诊断。
- [x] 增加可选工作目录命令 `launch_agent_in(provider, cwd)`，保留旧桥接命令兼容性。
- [x] 增加 `diagnose_agent(provider, cwd)`：解析绝对路径、版本、stdout/stderr、超时、退出码、Terminal、配置与 CodeWhale doctor。
- [x] 校验 CodeWhale `codewhale` + `codewhale-tui` companion 完整性和版本配对。
- [x] Windows 配置写入改为备份—替换—失败回滚，避免删除原配置后替换失败。
- [x] 提供 Windows PowerShell 5.1 兼容的独立 CLI 诊断脚本。
- [x] 25 项静态迁移冒烟测试通过。
- [x] 3 个 Rust 文件词法/括号结构冒烟测试通过。
- [x] 守卫式 patch 应用测试通过；目标树不匹配时拒绝覆盖，防止回归既有拖拽/DPI/UI 修复。

## 阻塞与未完成

- [ ] 将补丁三方合并进用户本轮所称的“Rust 半成品附件”：当前运行时未提供该附件文件，不能安全覆盖未知版本。
- [ ] 完整 `git clone` 四个仓库并固定 commit SHA：容器 DNS 无法解析 GitHub；本轮只能使用 Web 仓库页和已取得的公开源文件快照。
- [ ] 运行 `cargo fmt --check`、`cargo check`、`cargo test`：环境没有 Rust/Cargo，且下载主机 DNS 被阻断。
- [ ] 在 Windows 真机运行 `scripts/windows-cli-diagnostics.ps1`，采集发生 internal error 的机器证据。
- [ ] 在实际仓库前端把 `diagnose_agent` 接入现有桌宠 HUD/设置面板，不新建网页，不破坏图片与视觉资源。
- [ ] 分 Provider 实机冒烟：Windows Terminal 有/无、npm shim、native exe、含空格/中文工作目录、PATH 安装后重启、CodeWhale companion 缺失/错版。
- [ ] 将官方上游新增 UI/状态行为继续迁入 Tauri；需在完整附件可用后做 DOM/CSS/asset 哈希对账。
- [ ] 评估 Codex 当前 Hook 与官方 LLMPET 只读 rollout 监听的取舍，并按用户选择保留“双通道”或回归只读方案。

## 发布门禁

只有以下项目全部通过，才可称为“无回归可发布”：

1. 精确附件完成三方合并，现有拖拽、透明命中、DPI 锚点与三语 UI 测试不退化。
2. `npm test`、全部项目自带 gate、`cargo fmt/check/test` 全绿。
3. Windows 100%/125%/150%/200% DPI 与混合显示器实机通过。
4. 五个 CLI 至少各完成一次“诊断 → 启动 → 新会话 → Hook/rollout 更新 → 退出”的闭环。
5. CodeWhale `doctor --json` 无高优先级问题，dispatcher/runtime 版本一致。
