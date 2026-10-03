# R8 Claude PreToolUse Hook 去重

## 问题

R7 在 Rust 应用内安装器中先把 `PreToolUse` 当作普通生命周期事件注册为 5 秒 Hook，随后又注册带 `--pretool` 标志、超时 600 秒的专用 Hook。源码树中的 Node 安装脚本则只安装普通 5 秒版本。两条安装路径语义不一致，Rust 路径还会导致一次工具调用触发两个 Octopus Hook。

## 修复

- 从 Rust `CLAUDE_EVENTS` 通用数组移除 `PreToolUse`。
- 保留唯一的专用 Rust Hook：`--pretool PreToolUse`，超时 600 秒。
- 从 Node `EVENTS` 通用数组移除 `PreToolUse`。
- Node 安装器新增同等的专用 `--pretool PreToolUse`/600 秒 Hook。
- 新增 R8 冒烟测试，验证 Rust/Node 契约、重复安装幂等性、唯一性、参数和超时。
- 更新协议基线，仅把 Claude 通用 observer 列表中的 `PreToolUse` 移出；Codex 的 `PreToolUse` 保持不变。

## 验证

- `npm test`：通过。
- R8 专项：10/10。
- `npm run check:static`：22/22。
- 视觉与媒体资源：39 个逐字节一致。
- Source release gate：16/16。

当前环境未执行 Rust 编译或 Windows 真机 Claude Hook 触发测试。
