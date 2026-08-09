# Octopus（原 RE-LLMPET）修复与审查报告

日期：2026-08-04  
对象：上传的 `RE-LLMPET-main.zip`  
对照：上传的官方/上游 `LLMPET-main.zip`、早期可用 `LLMPET-main codewhale.zip`，以及 2026-08-04 检索到的 CodeWhale 与 Tauri 官方文档。

## 1. 结论

本次修改不是只针对截图打补丁，而是沿着“窗口坐标与合成、焦点生命周期、Provider 启动链、Hook 协议、产品身份、后台轮询”六条路径完成了系统性修复。用户列出的八项问题均已落到源码；同时补了回归测试、安装迁移保护、Hook 所有权精确匹配和发布元数据一致性。

当前源码层验证通过。受执行环境限制，本报告不能把 Windows 原生编译、WebView2 半透明合成、混合 DPI、多屏负坐标、真实 CodeWhale CLI Hook、NSIS 卸载交互和 Release CPU 数据写成“已实机通过”；这些仍列为发布前强制门禁。

## 2. 对照与路线

### 源码对照

- 官方 Electron 版用于确认原始窗口意图：桌宠窗口为无边框透明窗口且关闭原生阴影；详情页是单一自绘标题栏/关闭按钮。
- 早期 CodeWhale 可用版用于确认 `tool_call_before` 通过 `DEEPSEEK_*` / `CODEWHALE_*` 环境变量获取会话、工具和参数，并在工具开始时上报 `working`。
- 当前 CodeWhale 官方 `docs/HOOKS.md` / `docs/CONFIGURATION.md` 用于防止沿用过时协议：`[hooks].enabled = true` 是总开关；`tool_call_before` 只从环境变量取上下文并通过 stdout 返回决策；`turn_end` 与 subagent 事件读取 stdin JSON；`session_start`、`session_end`、`tool_call_after`、`mode_change`、`on_error` 为仅环境变量事件。
- 当前 Tauri 2 文档用于确认无边框自绘标题栏、Windows 阴影限制、NSIS `NSIS_HOOK_PREINSTALL`、显示器工作区和 DPI 换算方式。

### 实施顺序

1. 先固定桌宠视觉锚点，避免状态动画改变点击命中容器。
2. 再修临时弹层焦点、鼠标穿透与透明合成。
3. 打通“新开 Agent”到 Provider chooser 的完整路径。
4. 重写详情窗口尺寸/居中逻辑并统一标题栏。
5. 按当前 CodeWhale Hook 合约重构事件输入路径。
6. 统一 Octopus 产品身份，同时保留必要的升级兼容名称。
7. 将常驻光标轮询改为自适应频率。
8. 删除表情包功能、资源和门禁残留。
9. 增加回归 smoke、全量静态门禁与发布清单校验。

## 3. 八项问题的根因与修复

### 3.1 状态更新时短暂错位

**根因**：`#pixel.error` 与 `#mascot.act-work` 的状态动画直接对桌宠外层命中/锚点容器施加 `transform`。窗口尺寸/菜单中心仍按外层容器计算，因此视觉层在状态切换时和点击区域短暂分离，动画结束后才回到原位。

**修复**：

- 将错误抖动限制到 `#pixel.error .pixel-sprite`。
- 将工作动画限制到 `#mascot.act-work #mascot-img`。
- 新增回归断言，禁止桌宠外层 skin 容器参与位移动画。

### 3.2 点击桌宠后的窗口不自动消失，阴影异常

**根因**：原实现主要依赖 WebView DOM 事件；透明窗口切换为点击穿透后，窗口外点击不一定再回到 DOM。`drop-shadow` 又会让 Windows 透明合成器按矩形表面生成错误边缘。

**修复**：

- Rust 监听 `WindowEvent::Focused(false)`，向前端发送 `pet:window-blur`。
- DOM `blur` 和原生 blur 都进入同一个幂等 `dismissTransientUi()`，关闭 provider/radial/session/todo 临时 HUD。
- chooser 展开时设置 UI busy，强制恢复鼠标命中；关闭后恢复透明区域点击穿透。
- provider 遮罩覆盖扩容后的整个窗口，空白处可关闭。
- 移除透明弹层的 compositor `drop-shadow`，只保留不会越出透明表面的内阴影。
- 权限确认卡不纳入失焦自动关闭，防止安全决策被窗口失焦吞掉。

### 3.3 “新开 Agent”按钮无反应

**根因**：按钮调用链没有完整处理“零个、一个、多个 Provider”三种情况，chooser 也没有在打开前扩大桌宠窗口。

**修复**：

- 配置返回的 Provider 列表更新 `availableProviders`；缺失时使用五 Provider 安全默认列表。
- 单 Provider 直接启动。
- 多 Provider 或尚未配置时打开 chooser。
- chooser 打开前扩容透明窗口，并显示 Provider 活跃状态。
- 新增按钮绑定与 chooser 路径回归测试。

### 3.4 “详细”窗口不居中、过长、关闭按钮重复、Provider 硬编码

**根因**：

- 窗口只改高度，不在内容高度变化后重新居中。
- 初始位置依赖窗口管理器，未按桌宠所在显示器定位。
- 原生标题栏和页面自绘关闭按钮同时存在。
- 标题区在无活动会话时保留旧值或使用 Provider 默认值，形成 Codex/Claude 被“硬编码”的观感。

**修复**：

- 新增 `fit_and_center_panel()`：优先选桌宠所在显示器，再回退详情窗口显示器/主显示器。
- 使用显示器物理 `work_area` 与 `scale_factor`，将 560×目标高度钳制在工作区内，保留 24 logical px 边距。
- 高度上限 720 logical px、下限 320；窄屏宽度最低约束只在工作区允许时生效。
- `open_panel` 和 `set_panel_height` 都执行尺寸钳制与重新居中。
- 详情窗口改为 `decorations:false`、`shadow:false`，仅保留页面自绘关闭按钮。
- 合并重复 close 监听。
- 头部每次按真实活动快照重置 Provider、project、model；无活动会话显示等待状态，不把缺失值冒充 Codex/Claude。

### 3.5 CodeWhale 工作状态无法检测

**根因**：

- 配置中可能已有 Hook 条目但顶层 `[hooks].enabled` 未开启。
- 不同事件的输入通道被混用；对仅环境变量事件读取 stdin 可能等待未关闭管道，导致状态事件延迟或丢失。
- `tool_call_before` 没有稳定映射成桌宠的 `working`。

**修复**：

- 安装 Hook 时精确编辑/补入顶层 `[hooks] enabled = true`，保留其他用户 TOML。
- `tool_call_before`、`tool_call_after`、`session_start/end`、`mode_change`、`on_error` 按当前协议只读环境变量。
- `message_submit`、`turn_end`、`subagent_spawn/complete` 保留有界 stdin JSON。
- 同时识别兼容前缀 `DEEPSEEK_*` 与 `CODEWHALE_*`。
- `tool_call_before → PreToolUse / working`；工具结束、回合结束、错误等映射到对应统一状态。
- CodeWhale `tool_call_before` 同时是安全决策 Hook；Octopus 服务不可用或缺少会话 ID 时输出 `{"decision":"deny"}`；异常 helper 也以非零状态退出，避免空 stdout 被解释为允许。
- Hook 清理从宽泛字符串搜索改成当前/旧 marker 与 owner 的精确匹配，避免删除其他用户 Hook。

### 3.6 程序 ID 应为 Octopus

**修复**：

- `productName`、窗口标题、可见文案、Cargo package/bin、helper bin、SBOM 根包、源码清单根名称和发布标题统一为 Octopus。
- bundle identifier 使用 `io.github.purrfecto114.octopus`，而不是官方 Electron 的 `com.myunwang.octopus`，避免覆盖官方安装。
- 新 Hook 标识为 `--octopus-hook --owner octopus`。
- 仍接受并能精确清理旧 `--re-llmpet-hook --owner re-llmpet`，用于升级。
- NSIS 预安装 Hook 检查旧产品名 `RE-LLMPET` 与旧 identifier `io.github.purrfecto114.rellmpet` 在 HKCU/HKLM 的卸载项；发现后要求先卸载，不静默删除。
- `.re-llmpet` 数据目录、本地协议 header/event 和兼容环境变量暂时保留。直接改目录会让现有配置、用量、runtime 文件和已安装 Hook 全部失联；这是升级兼容层，不是可见产品身份。

### 3.7 性能占用大

**根因**：透明区域点击穿透需要原生光标命中恢复，但旧实现无论是否交互都固定约 24ms 轮询，空闲时仍接近 42 次/秒唤醒。

**修复**：

- 光标靠近桌宠时 45ms 轮询，保证恢复命中响应。
- 光标远离时 240ms。
- UI busy 或未请求点击穿透时 500ms，且不做命中几何计算。
- 桌宠隐藏时 1000ms。
- 调试 confetti 默认不运行；现有定时器/ResizeObserver 生命周期加入/保留清理。

**取舍**：纯事件方案在窗口已经设置点击穿透后无法可靠收到 WebView 鼠标事件，因此没有完全删除原生轮询；自适应轮询是在响应性和空闲功耗之间更稳妥的折中。

### 3.8 移除表情包所有功能

已删除：

- 表情包选择 UI 与交互代码。
- `frontend/shared/memes.js`。
- `frontend/assets/memes/`。
- `resources/memes/`。
- 公共目录生成脚本、表情包 smoke、素材功能来源文档。
- package script、i18n、配置调用和活动 README 中的旧功能说明。

月薪喵仍作为普通桌宠皮肤存在；它不再有表情包选择、提示词、侧边媒体预览或发送链路。素材出处文件只承担许可/来源说明，不是运行功能。

## 4. 额外修复与一致性处理

- 详情窗口每次内容自适应后重新居中，避免第一次正常、后续变长越界。
- Provider chooser 的活动 Provider 排在前面，同时不再因配置尚未加载而“点击无反应”。
- OpenCode 等其他 Hook 的清理不再被 `contains("re-llmpet")` 误伤。
- 新 helper 可独立运行，也可由主程序 `--octopus-hook` 模式承载；旧参数保留升级兼容。
- `SOURCE_MANIFEST.json`、SPDX 根包、协议漂移检查 User-Agent、release 名称改成 Octopus；仓库 URL仍保留真实仓库地址。
- 新增 `test/octopus-fix-regression-smoke.js`，覆盖八项修复中最容易回退的结构性约束。

## 5. 辩证取舍

### 无边框详情页 vs 原生标题栏

原生标题栏有更稳定的系统拖动与辅助功能，但会和现有页面关闭按钮重复，并与官方布局不一致。此次选择无边框不透明详情页，保留页面标题栏；桌宠透明窗口仍保持无边框。

### 原生阴影 vs CSS 阴影

Tauri 文档明确提示 Windows 上装饰窗口阴影无法关闭，未装饰窗口开启 shadow 还可能出现 1px 白边/圆角。透明桌宠和截图中的错误正属于合成边界问题，因此关闭原生/滤镜外阴影，只保留容器内部阴影。

### 直接使用官方 ID vs 独立 ID

使用 `com.myunwang.octopus` 会与官方 Electron 包冲突；继续使用 RE-LLMPET 又违背产品身份。采用独立的 `io.github.purrfecto114.octopus` 同时满足“可见品牌为 Octopus”和“不覆盖官方”。

### 重命名全部内部路径 vs 升级兼容

一次性重命名数据目录、HTTP header、event、环境变量会让旧安装的数据和 Hook 失联。此次只统一可见身份与新所有权标识，内部旧名作为兼容接口保留；未来可在有显式数据迁移器和回滚方案时分阶段清理。

### CodeWhale 状态 Hook vs 权限 Hook

`tool_call_before` 既是工作开始信号，也是能阻止/询问工具执行的 steering Hook。只上报状态并空输出会按 CodeWhale 合约等同 allow，可能削弱原有授权。此次保留 Octopus 权限链；由于 CodeWhale Full Access 不会响应 `ask`，服务失败与未知返回均显式 `deny`，避免无提示放行。

## 6. 验证矩阵

最终执行结果：

- `npm test`：通过；reference contract 与完整 smoke 链全部成功。
- `npm run check:static`：22 passed，0 failed。
- JavaScript 语法：74 个文件通过。
- Rust 词法/结构检查：15 个 Rust 文件词法平衡通过；`commands.rs`、`hook_install.rs`、`lib.rs` 结构 smoke 通过。
- Tauri bridge/Rust command 对齐：43 个命令。
- 前端资源引用：35 个资源通过。
- `SOURCE_MANIFEST.json`：290 个文件生成并校验通过。

当前环境可执行：

- 全量 Node smoke：`npm test`
- 静态门禁：`npm run check:static`
- Rust 源码结构检查：`python3 scripts/rust-structure-smoke.py`
- JS 语法、Tauri bridge/Rust command 对齐、资源引用、源码 manifest 校验

当前环境不可执行：

- `cargo check/test/build`（容器没有 Cargo/Rust toolchain）
- Windows WebView2 GUI 与透明合成实测
- 混合 DPI/多显示器/任务栏位置实测
- `makensis`/Tauri Windows bundle 生成和旧版卸载交互
- 真实 CodeWhale TUI 的 11 事件端到端触发
- Windows Release 构建的 CPU、唤醒率和内存基准

## 7. 发布前实机门禁

1. Windows 10 与 Windows 11 各跑一次 Release 构建。
2. 100%/125%/150% 缩放，以及主副屏互换、负坐标副屏验证详情页。
3. 连续切换 idle/thinking/working/error，录屏逐帧确认桌宠锚点不漂移。
4. 点击桌宠后分别点击透明窗口内部空白、其他应用和任务栏，确认临时 HUD 关闭。
5. 安装旧 RE-LLMPET 后运行 Octopus NSIS，验证卸载提示、取消路径和完成后重装路径。
6. 在当前 CodeWhale TUI 中运行 `/hooks list`，确认 `[hooks].enabled`、事件和命令；触发工具调用、回合结束、错误和 subagent。
7. 空闲 10 分钟与持续工作 10 分钟记录 CPU、上下文切换、内存和 WebView2 子进程。

## 8. 主要变更位置

- `frontend/renderer/pet.css`
- `frontend/renderer/pet.js`
- `frontend/renderer/pet.html`
- `frontend/renderer/tauri-bridge.js`
- `frontend/renderer/panel.{html,css,js}`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/platform.rs`
- `src-tauri/src/hook_client.rs`
- `src-tauri/src/hook_install.rs`
- `src-tauri/tauri.conf.json`
- `src-tauri/windows/installer-hooks.nsh`
- `scripts/install-native-hooks.js`
- `test/octopus-fix-regression-smoke.js`
- `docs/FIX_TODOLIST_2026-08-03.md`

## 9. 外部依据

- CodeWhale `docs/HOOKS.md`（当前事件输入、环境变量、stdin 与 steering 合约）
- CodeWhale `docs/CONFIGURATION.md`（Hook 配置与 `[hooks].enabled`）
- Tauri 2 `Window Customization`
- Tauri 2 `Configuration`（window decorations/shadow/transparent）
- Tauri 2 `Windows Installer`（NSIS installer hooks）
- Tauri 2.11 `Monitor` API（work area 与 scale factor）

