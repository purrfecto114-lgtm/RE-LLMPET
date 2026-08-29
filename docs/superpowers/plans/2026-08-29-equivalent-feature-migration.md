# RE-LLMPET 等价功能迁移实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 逐任务实现；每项生产代码前必须运行对应红灯测试。

**目标：** 修复交互和 hook 打包，支持安全的自定义 provider，并原生迁移 dsh observer。

**架构：** 专用协议适配器保留，公共 identity/capability/launch/UI metadata 移入 registry。dsh 走 observer ingest，不走 hook install。窗口几何和菜单行为以可测试 helper 固化。

**技术栈：** Tauri 2、Rust 2021、原生 JavaScript、Node smoke tests、NSIS、纯 Rust zstd decoder。

---

## 阶段 1：交互正确性与单一 Hook 构建

**所有权：** Designer 修改 `frontend/renderer/pet.js`、相关 shared helper/CSS/JS 测试；Fixer 修改 `src-tauri/src/commands.rs`、`src-tauri/Cargo.toml`、legacy bin、NSIS hooks 和 hook 测试。两条写入范围不重叠。

- [ ] 新增右键菜单和窗口锚点红灯测试；运行并确认分别因 `sr` 未定义和边缘锚点变化失败。
- [ ] 在 `buildRadial()` 内取得 stage rect；右键 pointerdown 先关闭 click-through，contextmenu 只切换菜单。
- [ ] 提取/测试窗口 resize 纯几何 helper，保持宠物视觉底部中心；HUD 选择向内展开。
- [ ] 新增 hook consolidation 红灯测试，断言只有一个 Cargo hook target、NSIS legacy alias 来自 canonical 文件、legacy marker/owner 仍存在。
- [ ] 在 `[package]` 设置 `autobins = false`，删除 `src-tauri/src/bin/re-llmpet-hook.rs`，在 NSIS postinstall/preuninstall 复制/删除 legacy 别名。
- [ ] 运行聚焦测试、`cargo test --manifest-path src-tauri/Cargo.toml --locked`、静态检查并更新 manifest。
- [ ] Oracle 审查阶段 1；合并重要反馈为一次修复并复验。

## 阶段 2：Provider Registry 与自定义 Provider

**所有权：** Fullstack Engineer 独占 registry、model、commands、hook boundary、bridge 和 provider metadata 文件。

- [ ] 新增红灯测试：自定义 provider survives sanitize、generic launch 不经 shell、无 hook capability 不进入 resync、未知 provider 有中性 UI metadata。
- [ ] 创建 `src-tauri/src/provider_registry.rs`，定义内建 specs 和 capability 查询；先镜像现有五个 provider 行为。
- [ ] 给 `AppConfig` 增加有界 `customProviders` launch spec；校验 ID/label/command/args，拒绝控制字符、重复 ID 和超限字段。
- [ ] 将 provider sanitize/config view/set_providers/hook resync 改为 capability-driven；现有 provider ID 和 hooks 行为保持不变。
- [ ] `launch_agent` 统一查询 registry/custom spec 并用 `Command::new` + args 启动；保留现有 bridge 方法为兼容 alias，新增 generic `launchAgent(id)`。
- [ ] 前端 provider label/icon/color 读取后端 metadata，未知项使用中性 fallback；把 Claude 专属占位文案改成 agent 中性文案。
- [ ] 运行聚焦测试、完整 smoke、Rust tests、静态检查并更新 manifest。
- [ ] Oracle 审查阶段 2；批量修复重要反馈并复验。

## 阶段 3：原生 dsh Observer

**所有权：** Backend Engineer 独占 dsh Rust 模块、Runtime observer ingest、Cargo dependency 和 fixtures；Designer 仅在需要 dsh 显示元数据时修改前端，不改变阶段 1 交互设计。

- [ ] 从上游 `afaaaf399b2abb819949bee8fc72199ef890709e` 提炼 fixtures，先写 header/version/subagent/plain/zstd/event-mapping 红灯测试。
- [ ] 创建 `dsh_zstd.rs`，只在完整 frame 边界提交 cursor；覆盖串联、半帧、坏帧和大小限制。
- [ ] 创建 `dsh_watch.rs`，支持 `DSH_HOME`、`LLMPET_DSH_DIR`、`LLMPET_NO_DSH`、plain/zstd、2.5 秒发现和静默缺目录。
- [ ] 将 dsh 事件映射到现有 Session/Runtime；使用内部 `dsh:<id>` key 防碰撞，UI 保留原始 ID；approval 只产生 notification，不进入 external permission。
- [ ] dsh 注册为 observer + launch、无 hook/metering，显示 context percent，不显示费用；第一版归入主宠 aggregate。
- [ ] 运行上游对照 fixtures、Rust tests、完整 smoke、静态检查、manifest verify 和 release no-bundle build。
- [ ] Oracle 审查阶段 3；批量修复重要反馈并复验。

## 最终集成

- [ ] 运行全量验证与 NSIS 构建，检查安装后的两个 hook 文件 SHA-256 相同。
- [ ] 从远端 `12ad394b2feaccde95f93acb1a0e3a1f97440c78` 建安全集成分支，不覆盖未知 main；提交项目交付物，排除 `.slim/deepwork/` 和凭据。
- [ ] 使用现有安全认证推送分支；记录 URL/分支。完成或截止时更新 progress 并关机。
