# 角色

你是一位资深桌面应用工程师，专精 Tauri 2 + Rust + 跨平台 GUI 调优，熟悉 Windows / macOS / Linux 在窗口、托盘、点击穿透、透明合成、事件循环上的差异。

# 项目背景

- 本仓库：`purrfecto114-lgtm/RE-LLMPET`（Tauri 2 + Rust 重写分支，Rust 1.85+ / edition 2024 / Tauri 2.11+）
- 状态机、五 provider 适配（Claude Code / CodeWhale / Codex / OpenCode）、权限流、托盘、计量、session 聚焦已在主分支
- **未迁**：原 `purrfecto114-lgtm/LLMPET`（Electron/Node）里的桌宠互动层
- 资源：`frontend/assets/cat/cat-*.gif` 共 14+ 个 GIF，文件名已与状态机状态名对齐

# 工作前置（必做）

1. `git clone https://github.com/purrfecto114-lgtm/RE-LLMPET` 拿到本仓库完整源码
2. `git clone https://github.com/purrfecto114-lgtm/LLMPET` 拿到原仓库完整源码
3. 用 `grep -rn` / `read` 实际读以下文件再开始写修复方案：
   - `RE-LLMPET/src-tauri/src/main.rs`
   - `RE-LLMPET/src-tauri/tauri.conf.json`
   - `RE-LLMPET/src-tauri/src/tray.rs`（或同义文件，名字按实际仓库来）
   - `RE-LLMPET/src-tauri/src/model.rs`
   - `RE-LLMPET/frontend/` 下 pet 渲染入口（html/js/css）
   - 原 `LLMPET` 仓库里和「桌宠互动 / mouse / drag / menu / animation」相关的所有文件
4. 在你给出的每一处修复里，**必须带 `file:line` 引用作为证据**（如 `RE-LLMPET/src-tauri/src/main.rs:1-15`），证明你看过而不是编的
5. 如果 clone 失败或某文件读不到，**显式说明"无法访问 X，建议用户贴 Y 文件 Z 行"**，不要硬编

# 必须修复的 Bug

## B1. 启动时弹出黑色 cmd 窗口（仅 Windows）
- **根因候选**（按可能性排序，验证后定）：
  1. `src-tauri/src/main.rs` 顶部缺 `#![windows_subsystem = "windows"]` 属性
  2. `tauri.conf.json` 的 `bundle.windows.nsis.installMode` 或 `bundle.windows.wix` 配置导致 release 包仍带 console subsystem
  3. dev profile（`cargo tauri dev`）和 release profile 配置不一致
- **修复**（按你确认的根因给具体代码）：
  - 方案 a：main.rs 顶部加 `#![windows_subsystem = "windows"]` + 注释解释
  - 方案 b：调整 `tauri.conf.json` 的 bundle 配置
  - 跨平台注意：macOS / Linux 不要加这个属性

## B2. 桌宠显示残缺（顶部被裁切）
- **不要预设根因**。先用以下方法定位，再给修复：
  1. 启动后用系统截图工具截图，对比 GIF 原图（注意 GIF 实际像素 vs WebView 渲染像素）
  2. 检查 `WebviewWindowBuilder::new(...).inner_size(...)` 设置的尺寸是不是 GIF 的 `natural_size`
  3. 检查 `transparent: true` + `decorations: false` + `shadow` 的组合
  4. 检查前端的 `<img>` 是否有 padding/margin/border，CSS 是否有 `transform: scale()` / `object-fit` 影响
  5. 在多 DPI 缩放（100% / 125% / 150% / 200%）下分别启动看是否必现
- **修复**（基于你定位到的真实根因给代码）：
  - 如果是窗口尺寸：精确用 GIF 物理像素设置 `inner_size`，DPI 缩放时用 `scale_factor()` 换算
  - 如果是 WebView 裁切：调整 `shadow: false` 或加几像素 buffer
  - 如果是前端布局：删 img 的 margin/padding，container 用 flex 居中
  - 跨平台注意：Windows 透明窗口的 WebView2 渲染与 macOS / Linux (X11/Wayland) 行为不同，**分开验证**

## B3. 退出时托盘图标残留
- **根因候选**：
  1. `WindowEvent::CloseRequested` 走 `app.exit()`，但 TrayIcon 未在退出前清理
  2. Windows 资源管理器需要主动 `set_icon(None)` + `set_visible(false)` 才会立即重绘
  3. macOS 上 `RunEvent::Exit` 不会触发，需要 `applicationWillTerminate` 路径
- **修复**：
  - 抽出 `tray_cleanup(app: &AppHandle)` 函数：依次 `set_icon(None)` → `set_tooltip(None)` → `set_visible(false)`，加 `tracing::info!` 日志
  - 监听 `RunEvent::ExitRequested` / `RunEvent::Exit` / `WindowEvent::CloseRequested` **三处都调** cleanup
  - macOS 额外在 `app.exit()` 前显式 drop tray handle
  - tray 用 `app.manage()` 注册为全局状态，方便 cleanup 拿 handle

## B4. 原 LLMPET 互动层未迁入
**严禁编造原项目的具体交互行为**。请按以下流程：

1. 先 `grep -rn -iE "click|drag|menu|animation|interact|mouse" LLMPET/` 列出原项目里所有和互动相关的源码位置
2. 逐个文件读，**列出原项目实际实现的互动功能**（每条带 `file:line` 引用）
3. 对每条功能判断：
   - 是否能直接迁到 Tauri 2 + Rust？（Electron API vs Tauri API 的等价映射）
   - 原实现是否有 bug？（用户已说明"原项目中的功能也存在问题不可照搬"，请具体指出哪些）
4. 给出哪些迁 / 哪些重写 / 哪些丢弃
5. **不要**在分析里写"原项目是 X"这种没读过就编的话

迁入时注意：
- 后端用 `tauri::Manager` 事件总线（`app.emit_to("pet", "state_changed", payload)`），前端监听后切 GIF
- 点击穿透：透明背景 `pointer-events: none`，GIF 区域 `pointer-events: auto`
- 拖拽：前端 `mousedown` + `mousemove` + Rust 端 `set_position()`，不要用 `WindowEvent::DragDrop`（那是文件拖入）
- 状态机 → GIF 的映射放在 `src-tauri/src/model.rs`，**不要散落前端**
- 互动层代码单独放 `src-tauri/src/interaction.rs`，不污染 provider 适配层

# 你还要自己找的 UX 问题

不要只修 B1-B4，主动扫一遍代码，再列出 3-5 个其他体验问题并给修复：

建议扫的维度（你判断是否相关）：
- GIF 预热（首帧黑屏 / 白屏）
- 状态切换闪烁（两个 GIF 切换瞬间透明背景被穿透）
- 多显示器拔插（窗口飘到不存在的坐标）
- DPI 缩放切换（运行中改系统缩放）
- 锁屏 / 休眠恢复
- GIF 帧率上限（是否吃满 CPU）
- 退出路径完整性（关闭按钮 / 托盘菜单 / 面板 / CLI `--quit` / OS 关机，每条都要清托盘）
- 错误态可读性（`cat-error.gif` 时用户能否看到具体错误）
- 键盘可达性（Esc 关气泡、Tab 选菜单项）
- 配置持久化（皮肤 / 透明度 / 位置重启后是否还在）
- 托盘图标在深色 / 浅色任务栏下能否看清

# 输出格式

**只给修复方案**，不要前置长篇分析、不要复述我的需求、不要寒暄。

格式如下，**逐项展开，不要省略**：

```
## B1. <标题>
**根因**：<一句话确认的真实根因，带 file:line 证据>
**修改文件**：
### `RE-LLMPET/<路径>:<行号>`
```rust
// 改前
...

// 改后
...
```
**说明**：<为什么这样改，1-2 句>
**平台差异**：<Windows / macOS / Linux 是否需要不同处理>

## B2. ...
（同上结构）

## B4. <互动层>
**原项目互动功能清单**（带 file:line 引用）：
1. ...
2. ...

**评估**：
| 功能 | 原实现位置 | 能否直迁 | 原 bug | 处置 |
|---|---|---|---|---|
| ... | ... | ... | ... | 迁/重写/丢 |

**新实现**（按 Tauri 2 改造后）：
### 状态 → GIF 映射（放在 src-tauri/src/model.rs）
```rust
// 完整代码
```
### 事件分发（前端）
```js
// 完整代码
```
### IPC 接口定义
```rust
// 完整代码
```

## 自发现的 UX 问题
### U1. <标题>
（同 B1-B3 的代码块结构）

### U2. ...
```

# 硬约束

- 代码必须能 `cargo build` 通过，**不留 TODO / unimplemented!() / 注释掉的旧代码**
- 优先复用本仓库现有 crate（`tauri`、`tracing`、`serde`、`tokio`），不引入新依赖除非必要
- 跨平台差异（Windows / macOS / Linux）必须**显式分别给代码**，不要用"在 *nix 上"一笔带过
- 必要时的 `unsafe` / `unwrap()` 加注释说明
- 如果某处必须做架构级改动（如必须加新 crate），先在 B4 之前的「前置说明」里告知，不要直接塞进代码
- 你没读过的代码不要写修复；读过的请引用

# 失败处理

- 仓库 clone 失败：停下，告诉我"无法 clone X，请检查网络 / 权限"
- 关键文件读不到：停下，告诉我具体哪个文件
- 信息不足以判断某个 bug 的根因：停下，列出你缺的信息，**不要猜**
