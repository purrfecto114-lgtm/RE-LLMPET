# R4 迁移 TODO

更新日期：2026-07-28（America/Los_Angeles）

## 本轮已完成

- [x] 使用用户提供的 R2 完整源码作为精确基线。
- [x] 将 R3 CLI overlay 三方合并为完整项目，而非整文件覆盖。
- [x] 保留拖动、透明命中、DPI、三语 UI、图片/GIF/MP3 和 meme UI。
- [x] 合并五 Provider 白名单、PATH/PATHEXT、npm shim、CodeWhale companion 和版本检查。
- [x] 合并 `diagnose_agent` 与有界进程探针。
- [x] Windows Terminal 优先、cmd 回退、显式 cwd。
- [x] 修复 VS Code/Cursor `.cmd/.bat` GUI shim。
- [x] 合并 Windows 配置备份与失败回滚。
- [x] 将 CLI 加固测试加入项目默认 `npm test`。
- [x] 通过项目全套离线冒烟、资源、协议和源码发布门禁。
- [x] 生成完整源码包、SHA-256、差异与机器验证报告。

## 下一轮真机/CI

- [ ] 安装 Rust 1.85+，运行 `cargo fmt --check`、`cargo check --locked`、`cargo test --locked`。
- [ ] Windows 运行 `scripts/windows-cli-diagnostics.ps1`，保存真实 internal error 证据。
- [ ] 五 CLI 分别完成诊断、启动、新会话、事件接入、退出闭环。
- [ ] CodeWhale 测试 companion 缺失、错版、npm 安装、Cargo 安装和官方 release bundle。
- [ ] 测试 Windows Terminal 已安装/禁用/别名损坏，以及 cmd fallback。
- [ ] 增加系统目录选择器后，再考虑给 `launch_agent_in` 授予 WebView 权限。
- [ ] 将 `diagnose_agent` 结果接入现有 HUD 或设置面板，不新建独立网页。
- [ ] 验证 100%/125%/150%/200% DPI 和混合显示器拖动。
- [ ] 对照最新上游继续迁移产品行为，并保持视觉资源哈希门禁。
- [ ] 完成 Windows NSIS、签名和 WebView2 安装路径测试。
