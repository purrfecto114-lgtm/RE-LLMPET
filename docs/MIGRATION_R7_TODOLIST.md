# R7 深度迁移 TODO

更新日期：2026-07-29（America/Los_Angeles）

## 本轮完成

- [x] 以 R6 完整源码为不可覆盖基线。
- [x] 对账 CodeWhale dispatcher/TUI doctor 文档冲突。
- [x] 实现 dispatcher-first、companion fallback 的有界诊断链。
- [x] 记录 doctor target、surface、尝试次数、退出状态和 JSON 形状。
- [x] 保留非零退出的 CodeWhale config-validation JSON。
- [x] 移除 WebView 对诊断 cwd 的控制。
- [x] 保持 `launch_agent_in` 不在 pet capability 中。
- [x] 检测 CodeWhale 当前/旧项目配置覆盖及冲突。
- [x] 增加 Claude 2.1.200 前的休眠恢复兼容提示。
- [x] 增加 Aider cwd/Git 根/home 配置候选。
- [x] Aider 只报告凭据变量名称，不读取值。
- [x] 同步三语现有 Provider 诊断卡。
- [x] 同步 Windows PowerShell 5.1 证据脚本。
- [x] 增加 R7 专项冒烟和稳定 `npm run check:static`。
- [x] 保持 39 个视觉/媒体资源逐字节一致。

## 下一阶段：原生可编译性

- [ ] Rust 1.85+ 执行 `cargo fmt --check`。
- [ ] 三平台执行 `cargo check --locked --all-targets`。
- [ ] 执行 `cargo test --locked` 和 Tauri dev/build smoke。
- [ ] Windows PowerShell 5.1 与 PowerShell 7 实际运行诊断脚本。

## 下一阶段：真实 CLI 矩阵

- [ ] CodeWhale：dispatcher 支持 doctor、dispatcher 不支持、companion JSON、config-validation JSON、companion 缺失、版本错配。
- [ ] Claude：2.1.200 前后、休眠/唤醒、多并行会话、PATH 更新、登录即将过期。
- [ ] Codex：ChatGPT 登录、API key、自定义 `env_key` Provider、Windows Hook/rollout 双通道。
- [ ] OpenCode：credentials 文件、环境变量、项目 `.env`、零凭据、`--dir` 四平台。
- [ ] Aider：Git 根/cwd/home 配置优先级、keyring、`.env`、notifications-command。

## 下一阶段：交互与视觉

- [ ] Windows 100/125/150/200% DPI 与混合显示器。
- [ ] 透明区域穿透、桌宠点击/拖动、快速取消和休眠恢复。
- [ ] 三款皮肤、三语、会话 HUD、meme GIF/MP3 真机视觉截图基线。
- [ ] Codex/Claude 多会话状态不会被桌宠误合并。

## 下一阶段：安全与发布

- [ ] 引入系统目录选择器后，设计一次性、用户确认的项目级 CLI 诊断能力。
- [ ] 对项目插件/Hook/`.env` 加载建立显式风险提示和独立 capability。
- [ ] Windows/macOS/Linux 签名、安装、卸载和升级回滚。
- [ ] 对第三方 GIF/MP3 再分发权进行发布前复核。
