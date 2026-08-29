# Octopus（原 RE-LLMPET）修复动态清单（2026-08-03 / 08-04）

状态标记：`[ ]` 待处理，`[~]` 处理中，`[x]` 已完成，`[!]` 受环境限制待实机验证。

## P0 用户报告问题

- [x] 1. 桌宠状态更新短暂错位
  - [x] 定位外层命中/锚点容器仍被 `transform` 动画影响：`#pixel.error`、`#mascot.act-work`
  - [x] 将状态位移动画限定到 `.pixel-sprite` / `#mascot-img` 内部视觉层
  - [x] 增加静态回归测试，禁止外层 skin 容器参与 transform 动画
  - [!] 混合 DPI、不同刷新率下的最终视觉观感待 Windows 实机验证
- [x] 2. 点击桌宠弹窗：外部点击不消失、半透明阴影异常
  - [x] 增加 Tauri 原生 `Focused(false)` 事件兜底，统一关闭 provider/radial/session/todo 临时 HUD
  - [x] provider 遮罩覆盖扩容后的整窗，空白区域可命中关闭
  - [x] 透明窗口卡片禁用 compositor `drop-shadow`，仅保留不越界的内阴影
  - [x] UI busy 时强制恢复鼠标命中；关闭后恢复透明区穿透
  - [!] Windows 10/11 WebView2 半透明合成效果待实机验证
- [x] 3. “新开 Agent”无反应
  - [x] 修正零/单/多 Provider 路径：单个直接启动，多个/未配置时展开 chooser
  - [x] chooser 打开前扩容 pet 窗口，并展示全部可用 provider 与状态
  - [x] 增加静态点击/chooser 回归检查
- [x] 4. “详细”窗口位置、尺寸、重复关闭、provider 默认
  - [x] 合并重复 close 监听
  - [x] 基于桌宠所在显示器的 `work_area` 居中，按 DPI 同时钳制宽高
  - [x] 内容自适应高度后再次居中，最大高度 720 logical px 且保留工作区边距
  - [x] 关闭原生 decorations/shadow，避免原生与自绘关闭按钮重复
  - [x] 头部每次按真实 provider/project/model 重置，不再保留旧值或用缺失值冒充 Claude/Codex
  - [!] 多屏负坐标、任务栏位置和 Windows 缩放待实机验证
- [x] 5. CodeWhale 工作状态检测
  - [x] 对比早期可用版与当前 CodeWhale Hook 文档
  - [x] 安装时确保顶层 `[hooks] enabled = true`，保留用户其他 TOML
  - [x] `tool_call_before` 等环境变量事件不读取 stdin，避免挂起；工具开始映射为 `working`
  - [x] 保留 `message_submit` / `turn_end` / subagent 的 stdin JSON 路径
  - [x] 增加 CodeWhale 协议静态回归检查
  - [!] 需使用真实 CodeWhale CLI 做端到端 Hook 触发验证
- [x] 6. 程序 ID/品牌应为 Octopus
  - [x] productName、窗口标题、可见文案、Cargo bin、helper bin 统一为 Octopus
  - [x] bundle identifier 改为 `io.github.purrfecto114.octopus`，避免与官方 `com.myunwang.octopus` 冲突
  - [x] 新 Hook 使用 `--octopus-hook --owner octopus`；仍接受/清理旧 `--re-llmpet-hook` 所有权
  - [x] 安装器加入旧 RE-LLMPET 检测提示，不静默删除旧安装
  - [x] 保留 `.re-llmpet` 数据目录、本地协议 header/event 与兼容环境变量，避免升级后配置/hooks 失联
  - [!] NSIS 注册表检测与卸载交互待 Windows 打包机验证
- [x] 7. 性能占用大
  - [x] 将透明点击穿透线程从固定高频轮询改为 near/far/idle/hidden 四级休眠
  - [x] UI busy/未请求穿透时不做光标命中计算；隐藏窗口降至 1 秒轮询
  - [x] renderer 定时器与 ResizeObserver 初审，调试 confetti 默认不启动，生命周期清理存在
  - [x] 全量性能 smoke / 静态检查通过，未发现旧断言回归
  - [!] CPU/唤醒次数需在 Windows Release 构建中用任务管理器/性能记录器实测
- [x] 8. RE 版移除表情包功能
  - [x] 删除 meme UI、共享脚本、资源目录、目录生成脚本、测试与来源文档
  - [x] 移除 package scripts / i18n / 配置调用残留
  - [x] 保留普通状态动画与 cat/pixel/mascot 皮肤

## 额外审查

- [x] 窗口坐标/DPI/多显示器边界：使用物理 work area + scale factor，宽高和位置统一计算
- [x] 半透明窗口焦点与关闭竞态：DOM blur + 原生 blur 双路径，关闭函数幂等
- [x] Provider 选择与 Hook 所有权：新旧 marker 精确匹配，移除宽泛 `contains("re-llmpet")`
- [x] 品牌/安装器/数据目录兼容性：可见品牌更新，内部持久化/协议名保留迁移兼容
- [x] Rust 源码结构、JS smoke、静态检查、打包配置静态检查
  - [x] 变更 JS `node --check`
  - [x] 聚焦 smoke 通过
  - [x] 全量 `npm test` 通过（reference contract + 完整 smoke 链）
  - [x] `npm run check:static`：22 passed / 0 failed；Rust 结构检查通过
  - [!] 当前容器无 Cargo/Rust/Windows，无法完成原生编译和 GUI 集成测试
- [x] 生成变更报告、补丁与可下载修复包
