# Octopus Tauri 2 构建与冒烟指南

## 1. 环境

### Windows

需要：

- Rust stable（rustup）
- Microsoft C++ Build Tools / Desktop development with C++
- WebView2 Runtime
- Node.js LTS，仅用于运行现有 JavaScript 回归测试

可使用管理员 PowerShell：

```powershell
.\scripts\bootstrap-tauri.ps1 -InstallSystemDependencies
```

只检查已有环境：

```powershell
.\scripts\bootstrap-tauri.ps1
```

### macOS

```bash
xcode-select --install
./scripts/bootstrap-tauri.sh
```

### Ubuntu 22.04 / Debian 系

```bash
./scripts/bootstrap-tauri.sh --install-system
```

脚本会安装 WebKitGTK 4.1、构建工具、Ayatana AppIndicator、librsvg、OpenSSL、patchelf 等依赖，然后安装 Rust/Tauri CLI。

## 2. 验证命令

```bash
npm test
python3 scripts/static-check.py
cargo check --manifest-path src-tauri/Cargo.toml --all-targets
cargo build --manifest-path src-tauri/Cargo.toml --release --bins
```

第一轮成功解析 Rust 依赖后，应把生成的 `src-tauri/Cargo.lock` 提交到仓库，保证后续构建可复现。

## 3. 开发启动

```bash
npm start
```

等价于：

```bash
cargo tauri dev
```

首次启动会尝试合并安装 Claude Code Hook。为避免修改真实配置，开发时可先设置临时 HOME：

```bash
mkdir -p /tmp/octopus-home
HOME=/tmp/octopus-home cargo tauri dev
```

Windows 可在独立测试账户或临时用户目录中验证 Hook。

## 4. 打包

```bash
npm run package:win
npm run package:mac
npm run package:linux
```

构建必须在目标操作系统或支持的目标 runner 上执行。发布前还需要配置 Windows 签名和 macOS 签名/公证。

## 5. 最小人工冒烟

1. 桌宠窗口出现，背景透明，任务栏不出现额外按钮。
2. 桌宠可拖动，重启后位置恢复。
3. 左键/右键行为、面板打开关闭和托盘菜单正常。
4. `~/.octopus/runtime.json` 只包含回环端口和随机令牌，权限为私有。
5. `~/.claude/settings.json` 保留已有 Hook，只增加 Octopus 条目。
6. 新建 Claude 会话后桌宠状态变化。
7. 只读 `Read/Glob/Grep` 可自动放行；写文件和 Bash 复合命令仍进入正常权限流程。
8. 手工允许、拒绝和超时均返回正确状态。
9. 退出后本地端口释放，不残留 Hook 服务进程。
10. 休眠唤醒、多显示器拔插和 8 小时空闲无持续高 CPU。

## 6. 当前环境说明

本次交付环境能够运行 Node.js 测试，但不能通过系统源或静态分发下载 Rust/WebKitGTK 开发工具。因此交付中的 Rust 结果为源码、离线词法检查和 CI 门禁，不是本机真实编译证明。不要跳过 GitHub Actions/目标平台真机验证。
