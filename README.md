# LLMPET / Octopus Tauri

`0.5.0-phase4` 是 LLMPET fork 的 Tauri 2 / Rust 迁移候选源码。活动运行路径只包含 `src-tauri/`、`frontend/`、`resources/` 与安装/门禁脚本；旧 Electron 主进程、preload、Node backend/provider/hook 和归档运行时已从源码树完整删除。

## 当前能力

- Claude Code、CodeWhale、Codex、OpenCode、Aider 的 provider-specific 安装与事件适配。
- Claude 结构化提问、方案评审和 `updatedPermissions` 建议回传；Codex 不伪造 Claude 专属字段。
- 并行权限请求：只合并相同 provider + session + tool + input 的重试；同一会话内不同请求分别显示、分别决策。
- provider-neutral 会话状态、JSONL 用量账本、Claude transcript 增量扫描和离线价格目录。
- 会话源 PID 到真实终端窗口的聚焦；Windows、macOS、X11 分平台实现，纯 Wayland 明确降级。
- 休眠/恢复、显示器变化和离屏窗口恢复。

## 源码运行

前置：Node.js 24、Rust stable、Tauri 2 系统依赖。

```bash
npm ci --ignore-scripts
npm test
cargo install tauri-cli --version '^2.11.0' --locked
cargo tauri dev
```

当前源码包没有伪造 `src-tauri/Cargo.lock`。首次在受支持平台成功解析并编译后，必须提交真实 lockfile，此后 CI/发布统一使用 `--locked`。

## 验证层级

`npm test` 是结构、协议和离线 fixture 回归，不等同于 Rust 编译或真机验收。发布前仍必须通过：

1. Linux / Windows / macOS `cargo check --all-targets --locked`、Rust tests 和 release binaries；
2. 五个 Provider 的隔离 HOME 真实 CLI smoke；
3. 三平台 GUI、托盘、终端聚焦、休眠/多显示器和性能门禁；
4. Windows 签名、macOS 签名/公证、Linux 基线运行、更新包签名、SBOM 与校验和。

详见 `FORK_UPSTREAM_MIGRATION_RELIABILITY_2026-07-27.md`、`MIGRATION_STATUS.md` 和 `docs/RELEASE.md`。
