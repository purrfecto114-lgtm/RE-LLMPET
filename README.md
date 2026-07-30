# RE-LLMPET / Octopus — Tauri 2 桌面宠物

> **低占用多 Agent 桌面宠物**：Tauri 2 + Rust 原生 provider 适配层，保留原有 Web UI 与图片资源。
>
> 盯着 **Claude Code / CodeWhale / Codex / OpenCode / Aider** 五个 coding agent，随状态变表情、弹消息气泡、一键授权，并统计 token 用量与花费。本地优先、MIT。

[简体中文](README.md) | [English](README_EN.md) | [日本語](README_JA.md)

---

## 仓库关系

本仓库 `purrfecto114-lgtm/RE-LLMPET` 是 LLMPET 项目的 **Tauri 2 / Rust 重写分支**，走独立主线。

| 仓库 | 角色 | 运行时 |
|---|---|---|
| **[myunwang/LLMPET](https://github.com/myunwang/LLMPET)** | 原始上游（v1.1.1 + 后续提交） | Electron + Node |
| **[purrfecto114-lgtm/LLMPET](https://github.com/purrfecto114-lgtm/LLMPET)** | 早期 Electron fork（R1–R20，5-provider hook 系统） | Electron + Node |
| **purrfecto114-lgtm/RE-LLMPET**（本仓库） | Tauri 2 / Rust 重写，独立新分支 | Tauri 2 + Rust |

本分支从 Electron/Node 运行时完整迁移到 Tauri 2 + Rust：旧主进程、preload、Node backend/provider/hook 和归档运行时已从源码树删除；活动运行路径只包含 `src-tauri/`、`frontend/`、`resources/` 与安装/门禁脚本。完整迁移历史见 [`docs/MIGRATION_STATUS.md`](docs/MIGRATION_STATUS.md)、[`docs/UPSTREAM_RECONCILIATION_2026-07-28.md`](docs/UPSTREAM_RECONCILIATION_2026-07-28.md)、[`docs/FOLLOWUP_DRAG_TERMINAL_UI_2026-07-28.md`](docs/FOLLOWUP_DRAG_TERMINAL_UI_2026-07-28.md) 与 [`docs/FORK_UPSTREAM_CUTOVER_REPORT_2026-07-27.md`](docs/FORK_UPSTREAM_CUTOVER_REPORT_2026-07-27.md)。

---

## 当前能力

- **五 provider 适配**：Claude Code、CodeWhale、Codex、OpenCode、Aider 的 provider-specific 安装与事件适配
- **分层 CLI 诊断**：在现有 Provider 面板内区分安装、认证、CodeWhale Provider/模型路由、工作目录和终端问题；输出有界脱敏，不将 doctor 或登录状态误当成端到端联网健康检查
- **权限流**：Claude 结构化提问、方案评审和 `updatedPermissions` 建议回传；Codex 不伪造 Claude 专属字段
- **并行权限请求**：只合并相同 provider + session + tool + input 的重试；同一会话内不同请求分别显示、分别决策
- **计量**：provider-neutral 会话状态、JSONL 用量账本、Claude transcript 增量扫描和离线价格目录
- **会话聚焦**：会话源 PID 到真实终端窗口的聚焦；Windows、macOS、X11 分平台实现，纯 Wayland 明确降级
- **平台恢复**：休眠/恢复、显示器变化和离屏窗口恢复
- **透明桌宠交互**：透明区域继续点击穿透；光标回到桌宠/弹层时由 Rust 原生命中守护恢复输入，短按打开会话 HUD、移动手势拖动窗口，结束时仅持久化一次位置；弹层缩放按 DPI 换算并保持桌宠底部中心锚点
- **Windows 终端策略**：新会话优先把白名单 Provider 可执行文件直接交给 Windows Terminal (`wt.exe`) 的新窗口；系统未提供 Terminal 时才回退 `cmd.exe /D /K`
- **三语核心界面**：桌宠与详情面板支持简体中文 / English / 日本語并持久化选择；原生托盘仍为部分翻译
- **上游视觉与 UI**：两套官方 GIF/MP3 按原字节保留；提问卡、Provider 标识、会话 HUD 二级表情页及皮肤感知的桌宠侧边媒体布局继续对齐上游，完整 Prompt 分发在后端会话归属实现前保持延期
- **安全**：`pet` / `panel` 分窗口 Tauri capability、限制性 CSP、loopback-only HTTP server、token 仅 header、constant-time 比较、固定 provider 启动白名单、沙箱 curl 强制 HTTPS

---

## 源码运行

前置：Node.js 24、Rust 1.85+（项目 `rust-version`；Cargo edition 2021）、Tauri 2 系统依赖。

```bash
npm ci --ignore-scripts
npm test                              # 结构/协议/fixture/供应链静态回归
cargo install tauri-cli --version '^2.11.0' --locked
cargo tauri dev                       # 启动桌宠
```

Linux 系统依赖：

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev libssl-dev patchelf xdg-utils
```

`src-tauri/Cargo.lock` 已提交（424 包），CI/发布统一使用 `--locked` 可复现构建。

---

## CI / 自动构建

| Workflow | 触发 | 作用 |
|---|---|---|
| [`ci.yml`](.github/workflows/ci.yml) | push `main` / PR / 手动 | 3 平台 smoke + locked Rust gates + `cargo check/test/build` |
| [`release.yml`](.github/workflows/release.yml) | push tag `v*.*.*` / 手动 | 4 矩阵签名 bundle（deb/appimage/nsis/dmg）+ checksums + SBOM + 证明 |
| [`protocol-drift.yml`](.github/workflows/protocol-drift.yml) | 每周一 05:17 UTC / 手动 | 上游 provider 协议漂移检查 |
| `provider-real-cli.yml` | 手动（self-hosted） | 真实 CLI 契约门 |
| `desktop-real-machine.yml` | 手动（self-hosted） | 真实 GUI + 性能基准 |

**push 到 `main` 即自动触发 CI**（3 平台并行）。**打 tag 触发 release**：

```bash
VERSION=$(node -p "require('./package.json').version")
git tag "v$VERSION"
git push origin "v$VERSION"
```

Release 需在仓库 Settings → Secrets 配置：`TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（更新签名）、`WINDOWS_CERTIFICATE` + `WINDOWS_CERTIFICATE_PASSWORD`（Windows 签名）、`APPLE_*`（macOS 公证）。tag 发布缺少这些签名凭据时会在构建前失败，禁止产生未签名的公开 Release；手动 workflow_dispatch 仅创建带独立 tag 的 draft，便于检查而不会公开发布。

---

## 验证层级

`npm test` 是结构、协议、离线 fixture 与供应链配置回归，不等同于 Rust 编译或真机验收。发布前仍必须通过：

1. Linux / Windows / macOS `cargo check --all-targets --locked`、Rust tests 和 release binaries
2. 五个 Provider 的隔离 HOME 真实 CLI smoke
3. 三平台 GUI、托盘、终端聚焦、休眠/多显示器和性能门禁
4. Windows 签名、macOS 签名/公证、Linux 基线运行、更新包签名、SBOM 与校验和

详见 [`docs/FORK_UPSTREAM_MIGRATION_RELIABILITY_2026-07-27.md`](docs/FORK_UPSTREAM_MIGRATION_RELIABILITY_2026-07-27.md)、[`docs/MIGRATION_STATUS.md`](docs/MIGRATION_STATUS.md) 和 [`docs/RELEASE.md`](docs/RELEASE.md)。

---

## 三款皮肤

章鱼 🐙、像素怪兽 👾、月薪喵 🐱（猫 meme 表情包，素材来自抖音 @月薪喵，见 [`frontend/assets/cat/CREDITS.md`](frontend/assets/cat/CREDITS.md)）。

## License

MIT — 见 [`LICENSE`](LICENSE)。状态机、计量、权限流、进程对账和桌面 UI 均为本仓库自有实现；各 provider 通过其公开 hook/plugin 接口接入，不注入 agent 进程。
