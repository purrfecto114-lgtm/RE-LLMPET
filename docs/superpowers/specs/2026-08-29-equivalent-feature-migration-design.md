# RE-LLMPET 等价功能迁移设计

## 目标与边界

本次变更修复桌宠交互和 hook 打包问题，建立可扩展 provider 能力注册表，并以原生 Rust observer 迁移上游 dsh 支持。继续使用 Tauri 2、Rust 和原生 JavaScript；不引入 Electron、Node sidecar、前端框架或运行时 npm 依赖。

## 已确认差异

- `re-llmpet-hook.rs` 位于 `src/bin/`，被 Cargo 默认 autobins 自动发现。它和 `octopus-hook.rs` 调用同一入口，但编译成带不同元数据的两个文件。
- 右键菜单调用 `buildRadial()` 时使用未声明的 `sr`，导致 `ReferenceError`。
- HUD 将窗口从 320px 扩到 520px；右/下贴边逻辑固定新窗口外框，覆盖宠物底部中心锚点，导致视觉位置跳动。
- provider 协议适配必须保留专用实现，但 provider 列表、能力、显示元数据、启动接口和默认值不应是闭合枚举。
- dsh 是 `$DSH_HOME|~/.dsh/sessions/<project>/<session>/session.jsonl[.zstd]` 的只读 observer。它没有 hook 安装、外部 permission bridge 或可靠费用估算。

## 选择的设计

### Hook

关闭 Cargo autobins，显式保留 `octopus` 和 `octopus-hook` 两个 target，删除 legacy 源 target。NSIS 安装后将 canonical `octopus-hook.exe` 复制成 `re-llmpet-hook.exe`，卸载时删除别名。两名称指向同一版本；legacy marker、owner 和参数入口继续兼容。

### 桌宠交互

右键在 `pointerdown(button === 2)` 取得输入所有权，`contextmenu` 仅切换菜单。径向菜单从 stage 实时取得 rect。窗口缩放以宠物视觉底部中心为稳定锚点；HUD 在边缘向可用空间展开，不能通过移动宠物补偿外框越界。

### Provider 扩展

Rust 提供单一 provider registry，声明 identity、显示元数据和 capabilities：`hook`、`observer`、`launch`、`metering`、`permission`。内建 provider 保留协议适配器。自定义 provider 使用持久化的安全 launch spec（ID、label、command、args），不经 shell 执行；默认不修改第三方配置、不启用计费或 permission bridge。前端从 config/stats metadata 渲染，未知 provider 使用中性 fallback。

### dsh

dsh 注册为 `observer + launch` provider，不进入 hook resync 或费用账本。Rust worker按上游兼容的 2.5 秒节奏发现 plain JSONL 和串联 zstd frame，未知 header version fail-closed，过滤 subagent 和非用户注入消息，将生命周期事件映射到现有 Runtime/Session 状态。第一版进入主宠 aggregate，不新增第三窗口；archive/handoff 不在本次桌宠等价监控范围。

## 验证路径

- 红灯测试先证明第二个 Cargo target、右键异常、边缘锚点变化、closed provider allowlist 和 dsh 缺失。
- 绿灯证据为聚焦 JS/Rust 测试、静态检查、`npm test`、manifest verify、`cargo test --locked` 和 release no-bundle build。
- Windows 真机边缘和右键通过 release pet 检查；安装包检查两个 hook 名称 SHA-256 相同。
