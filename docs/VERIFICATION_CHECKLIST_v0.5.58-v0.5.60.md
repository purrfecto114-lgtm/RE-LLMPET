# 真机验证清单 — v0.5.58 ~ v0.5.60

> **用途**: 本文档列出 v0.5.58 至 v0.5.60 版本中所有用户可见的修复，以及对应的真机验证步骤。每次发布新版本后，按此清单逐项验证，确保修复在真机上实际生效。
>
> **测试环境**: Windows 10/11 (主力)、macOS (辅助)、Linux (辅助)。标注 `[WIN]` 的项仅在 Windows 验证，`[ALL]` 在所有平台验证。

---

## v0.5.58 修复验证

### 1. GUI 穿模修复（z-index 冲突）`[ALL]`

**用户反馈**: 闲逛功能当 claude/codex CLI 不在 PATH 会导致回退的 GUI 穿模，panel 模态窗被 pet 透明窗口遮挡。

**根因**: pet 窗口 `alwaysOnTop:true`，panel 窗口 `alwaysOnTop:false`。打开 panel 时 pet 透明覆盖层始终遮住 panel。

**验证步骤**:
1. 启动 Octopus，确认桌宠显示
2. 右键桌宠 → 点击「详情」打开 panel
3. **验证**: panel 完整可见，不被桌宠透明窗口遮挡
4. 拖动 panel 使其与桌宠位置重叠
5. **验证**: panel 显示在桌宠之上（z-index 正确）
6. 关闭 panel
7. **验证**: 桌宠恢复正常 alwaysOnTop 行为（在其他普通窗口之上）
8. 再次打开 panel，确认行为一致

**预期结果**: panel 打开时始终在桌宠之上，关闭后桌宠恢复 alwaysOnTop。

**回归标志**: panel 被桌宠透明区域遮挡，或关闭 panel 后桌宠不再置顶。

---

### 2. Launch agent 错误提示可关闭 `[ALL]`

**用户反馈**: Launch agent 错误提示消不掉，红色 toast 的 ✕ 按钮点击无效。

**根因**: `#re-llmpet-toast` 不在 `INTERACTIVE_HIT_SEL` 选择器中，toast 渲染在 pet 窗口右下角（`#pet-anchor` 矩形外），落入 click-through 区域，✕ 按钮点击穿透到桌面。

**验证步骤**:
1. 启动 Octopus（确保 aider CLI **未安装**，或其他 provider 未安装）
2. 右键桌宠 → 「新开 Agent ▼」→ 选择未安装的 provider（如 aider）
3. **验证**: 红色 error toast 出现，显示 "aider: Aider CLI not found..."
4. 点击 toast 上的 **✕** 按钮
5. **验证**: toast 立即消失
6. 重复步骤 2-3，点击 toast 主体（非 ✕ 按钮）
7. **验证**: toast 同样消失（click-to-dismiss 也生效）
8. 重复步骤 2-3，等待 4.5 秒（非 persistent 的情况）
9. **验证**: toast 自动消失（auto-dismiss 生效，但 launch_agent 错误是 persistent，不会自动消失——这是设计行为）

**预期结果**: ✕ 按钮和点击 toast 主体都能关闭 toast。

**回归标志**: ✕ 按钮点击无效，toast 无法关闭。

---

### 3. 桌宠动画随状态变化 `[ALL]`

**用户反馈**: 桌宠的动作不会随状态变化而更新，始终卡在 idle/sleeping。

**根因**:
- A: Rust stats 匹配没有 `"attention" =>` 分支，CodeWhale/OpenCode 的 attention 状态被忽略
- B: 前端 `applyStats` 优先级梯子没有 attention 分支
- C: `case 'state'` 在 transient 窗口内阻塞所有状态事件

**验证步骤**:
1. 启动 Octopus，确认桌宠显示为 idle 状态
2. 启动一个 coding agent 会话（如 Claude Code），发送一个 prompt
3. **验证**: 桌宠切换到 `thinking` 或 `working` 状态（cat 皮肤: cat-thinking.gif / cat-working.gif）
4. 等待 agent 完成回复
5. **验证**: 桌宠短暂显示 `happy`（完成庆祝），然后回到 idle/loafing
6. 如果使用 CodeWhale: 触发一个 turn_end
7. **验证**: 桌宠显示 `attention` 状态（cat 皮肤: cat-attention.gif，mascot: mascot-wait.png + 黄色光晕，pixel: attn 动画）
8. 切换皮肤（右键 → 皮肤 → pixel/mascot/cat），重复上述步骤
9. **验证**: 三种皮肤都能正确显示状态动画

**预期结果**: 桌宠动画随 agent 状态实时变化，包括 attention 状态。

**回归标志**: 桌宠始终显示 idle/sleeping，不随 agent 活动变化。

---

### 4. 诊断探针并行化 `[ALL]`

**用户反馈**: 诊断工具会卡在检查中（串行探针太慢）。

**根因**: 4 个独立探针（--version、companion --version、doctor、auth）串行执行，最坏情况 26s。

**验证步骤**:
1. 启动 Octopus，打开 panel
2. 点击「诊断」按钮，选择 CodeWhale（或 Claude）
3. **计时**: 从点击到结果显示的时间
4. **验证**: CodeWhale 诊断应在 ~8s 内完成（并行），而非 ~26s（串行）
5. 点击「取消」按钮
6. **验证**: 所有探针立即终止，不再有 cmd 窗口残留

**预期结果**: 诊断时间从 26s 降至 ~8s，取消即时生效。

**回归标志**: 诊断时间超过 20s，或取消后 cmd 窗口残留。

---

## v0.5.59 修复验证

### 5. 隐藏 Windows 黑色 cmd 窗口 `[WIN]`

**用户反馈**: 每次打开都会出现黑色 cmd 的 curl.exe，很烦人。

**根因**: Octopus 是 GUI 子系统二进制，spawn console 子进程时 Windows 分配 conhost，弹出黑色 cmd 窗口。

**验证步骤**:
1. 启动 Octopus（Windows）
2. **观察启动过程**: 不应有黑色 cmd 窗口闪现（curl 价格刷新）
3. 等待 10 秒（价格刷新触发）
4. **验证**: 全程无黑色 cmd 窗口
5. 打开 panel → 点击「刷新价格」按钮
6. **验证**: curl 执行时无黑色 cmd 窗口
6. 右键桌宠 → 「诊断」→ 选择任意 provider
7. **验证**: 诊断探针执行时无 cmd 窗口（.cmd shim 也无）
8. 点击桌宠聚焦一个 agent 会话
9. **验证**: 聚焦时无 PowerShell 窗口闪现
10. 启动闲逛功能（如果 provider 已安装）
11. **验证**: 闲逛全程无 cmd 窗口（30s-2min 期间）

**预期结果**: 所有非交互式 spawn 不产生可见的 console 窗口。

**回归标志**: 任何黑色 cmd / PowerShell 窗口闪现。

**注意**: `launch_terminal`（右键 → 新开 Agent）**应该**显示终端窗口，这是预期行为。

---

### 6. 模型价格中国镜像源 `[ALL]`

**用户反馈**: 模型价格更新的镜像源在中国大概率不可用。

**根因**: `models.dev` 在中国大陆经常不可访问（GFW + Cloudflare）。

**验证步骤**:
1. 在中国大陆网络环境下启动 Octopus
2. 打开 panel → 查看「模型价格」区域
3. 等待价格刷新（或手动点击「刷新价格」）
4. **验证**: 价格成功更新（不显示离线价格）
5. 检查 `~/.re-llmpet/pricing-sync-state.json`
6. **验证**: `last_updated_ms` 有值，`last_error` 为 null 或空
7. 如果直连 models.dev 可用：设置 `RE_LLMPET_MODELS_DEV_URL=https://your-mirror.example.com/api.json`
8. 重启 Octopus
9. **验证**: 优先使用用户自定义镜像

**预期结果**: 中国大陆网络环境下价格能成功更新。

**回归标志**: 价格更新失败，`last_error` 显示连接超时或 DNS 解析失败。

---

## v0.5.60 修复验证

### 7. hide_console_window 回归测试 `[WIN]`

**说明**: 这是测试增强，非用户可见功能。验证测试存在且通过。

**验证步骤**:
1. 运行 `node test/tauri-windows-static-smoke.js`
2. **验证**: 输出 `tauri-windows-static-smoke: ok`
3. 检查测试包含 6 个 hide_console_window 断言
4. **验证**: 测试覆盖 platform.rs / pricing_sync.rs / travel.rs / hook_client.rs / launch_terminal

**预期结果**: 测试通过，防止未来回归。

---

### 8. ghproxy.com 中国镜像源 fallback `[ALL]`

**说明**: v0.5.59 添加了 GitHub raw 镜像，但 raw.githubusercontent.com 本身有时也被封锁。v0.5.60 添加 ghproxy 作为第三层 fallback。

**验证步骤**:
1. 在中国大陆网络环境下（raw.githubusercontent.com 被封锁时）
2. 启动 Octopus，等待价格刷新
3. **验证**: 价格成功更新（ghproxy 镜像生效）
4. 检查 `~/.re-llmpet/pricing-sync-state.json`
5. **验证**: `last_error` 为 null，`last_updated_ms` 有值
6. 临时屏蔽 ghproxy（修改 hosts 文件将 gh-proxy.com 指向 127.0.0.1）
7. 重启 Octopus，等待价格刷新
8. **验证**: 回退到 models.dev 原始源（如果可达）或显示离线价格

**预期结果**: 4 层 fallback（用户 env → GitHub raw → ghproxy → models.dev）确保中国可访问性。

**回归标志**: 所有镜像都失败，价格无法更新。

---

## 综合冒烟测试

每次发布前快速验证核心功能：

| # | 测试项 | 预期 | 版本 |
|---|--------|------|------|
| 1 | 启动 Octopus | 桌宠显示，无黑窗 | v0.5.59+ |
| 2 | 右键 → 详情 | panel 打开，不穿模 | v0.5.58+ |
| 3 | 触发 launch 错误 | toast 可关闭 | v0.5.58+ |
| 4 | 运行 agent | 桌宠动画变化 | v0.5.58+ |
| 5 | 诊断 CodeWhale | ~8s 完成，无黑窗 | v0.5.58+ |
| 6 | 刷新价格 | 中国网络下成功 | v0.5.59+ |
| 7 | 闲逛功能 | 全程无黑窗 | v0.5.59+ |
| 8 | 聚焦会话 | 无 PowerShell 闪现 | v0.5.59+ |

---

## 已知限制

- **launch_terminal 仍显示终端窗口**: 这是设计行为，用户期望看到终端。`cmd.exe /K` 不应用 `CREATE_NO_WINDOW`。
- **persistent toast 不自动消失**: `launch_agent` 等关键命令的错误 toast 是 persistent 的，必须手动关闭。这是设计行为，确保用户看到错误。
- **macOS/Linux 无黑窗问题**: 此问题仅影响 Windows（GUI 子系统 spawn console 子进程）。Unix 使用 `process_group(0)` 替代。

---

## 版本历史

| 版本 | 日期 | 主要修复 |
|------|------|----------|
| v0.5.58 | 2026-08-10 | GUI 穿模 + toast 可关闭 + 动画 + 诊断并行化 |
| v0.5.59 | 2026-08-10 | 隐藏黑窗 + 模型价格镜像 |
| v0.5.60 | 2026-08-10 | 黑窗回归测试 + ghproxy 镜像 |

---

## 反馈

如果真机验证发现修复未生效或出现新问题，请在 GitHub Issues 提交：
- 仓库: https://github.com/purrfecto114-lgtm/RE-LLMPET
- 附带：版本号、操作系统、复现步骤、截图（如有）
