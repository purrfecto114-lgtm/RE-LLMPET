# LLMPET 仓库重置 · Release 流水线 · 重构路线 设计规格

日期：2026-08-23　分支基点：`surgery/phase0`（阶段0手术已完成，25/25 测试绿，verify-surgery 506/506）

## 0. 背景与已定决策

阶段0手术后仓库遗留混乱：远端 51 个陈旧 `v0.5.32~v0.5.81` tag、过期受保护的 `main`、手术成果孤立在 `surgery/phase0` 分支。经四项澄清确认：

| 决策项 | 结论 |
|---|---|
| 重置语义 | **历史重开**：orphan 单提交强推，不保留旧 git 历史 |
| 首个版本号 | **v0.6.0**（衔接上游 0.5.x 尾数；package.json 同步改 0.6.0） |
| Release 平台 | **Win + Mac 双平台**；macOS 签名自适应：探测本仓库 `APPLE_*` secrets，有→签名公证，无→adhoc 未签名包并在 README 声明 |
| 深度重构取向 | 有规律的全套重写为长期方向；**先架构拆分（纯 JS），Electron 迁移以 PoC 门禁决策** |

> 注：GitHub secrets 无法跨仓库读取上游 `myunwang/LLMPET` 的签名凭据，只能探测本仓库自身配置。

## 1. R1 仓库历史重开

### 流程（REST API 自动化，PAT 需 repo admin 权限）
1. 本地 `package.json` version → `0.6.0`
2. `git checkout --orphan reset/v06` → 提交全部工作树内容（遵循 .gitignore）→ 单提交 `LLMPET v0.6.0 — post-surgery rebuild`
3. push `reset/v06` 到远端
4. `GET /repos/{o}/{r}/actions/secrets` 列出 secret 名称（只列名，读不到值）→ 记录是否含 APPLE 五件套
5. `DELETE /repos/{o}/{r}/branches/main/protection` 尝试解除保护；失败则输出网页手动步骤
6. `PATCH /repos/{o}/{r}` 默认分支 → `reset/v06`
7. 删远端分支 `main`、`surgery/phase0`
8. `POST /repos/{o}/{r}/branches/reset-v06/rename` → 改名 `main`
9. 清理：API 分页遍历并删除全部 releases；删除全部 51 个 tag ref（`git push origin :refs/tags/<t>` 或 API）
10. 本地：分支对齐 `origin/main`

**不可逆声明**：远端旧历史将永久消失。本地 `D:\workspace\LLMPET-main` 在重开前保留完整旧史（baseline+T1~T10 共 12 提交），是唯一存档。
**风险与回退**：若 ⑤⑥⑧ 任一步失败且无法自动化，停止脚本并给出精确的手动操作清单（网页按钮级）；绝不半途强推造成双默认分支。

## 2. R2 Release Workflow v2

```yaml
触发: push tags 'v*'
守卫: tag 名 ≠ package.json version → fail fast
job test:        ubuntu-latest，免 npm install 跑全量测试（先挂先停，省算力）
job build-win:   windows-latest; actions/cache 缓存 electron/electron-builder 二进制;
                 npm ci → npm test → electron-builder --win --publish never → 上传 exe+zip
job build-mac:
  探测(env 桥接): HAS_P12 = secrets.APPLE_DEVELOPER_ID_P12_BASE64 非空
  ├─ full(有):    keychain 导入 → scripts/sign-notarize-mac.js 校验环境 → package:mac → verify:mac
  └─ adhoc(无):   LLMPET_MAC_SIGN_MODE=adhoc package:mac:dev；产物名追加 -unsigned；跳过 verify:mac
job publish:     download-artifact 合流 → SHA256SUMS.txt → gh release create --generate-notes
                 → github-script 内联清理：仅保留最近 3 个 release 并连带删除其 tag（防再堆积）
ci.yml:          增加 workflow_dispatch 触发；其余不动
```
README 增补：「macOS 未签名包需右键→打开 绕过 Gatekeeper」声明段（当走 adhoc 路径时）。
第三方 action 白名单：仅 github-script@v7（官方），不用 Nats-ji/jay2610 等社区清理 action——减少供应链面。

## 3. R3 架构拆分路线图（纯 JS，零行为变更）

原则：**运行时形态不变，测试零改动**。渲染端采用「有序清单拼接」而非 ESM——dom-stub 以 fs+vm 加载单文件 pet.js，ESM 会破坏 state-smoke。

```
src/renderer/pet/00-boot.js … 99-boot-tail.js（按现有执行顺序切分）
scripts/build-renderer.js  读 manifest 顺序拼接 → renderer/pet.js（唯一被 html 引用的产物）
模块缝：skin(MEME_PACKS/updateCat/toggleSkin) | state-machine(applyStats/transient)
       | sesslist(render/update) | ask(授权卡) | radial-menu | todopop
       | geometry(fitPopup/edge-layout) | drag | boot
主进程：main.js 1138 行 →
  app/main.js(~120) 启动编排 | app/windows.js | app/ipc.js | app/tray.js | app/stats.js
门禁（每里程碑）：node --check 全部产物 + 25/25 测试 + verify-surgery 506 断言
```
顺序：先拆渲染端（测试覆盖最厚），后拆主进程；每模块一提交。

## 4. Electron 去留结论（辩证）

**留守论据**：核心交互依赖 `setIgnoreMouseEvents({forward:true})`——Tauri `set_ignore_cursor_events` 无 forward 等价（tauri-apps/tauri#6164，2023 开放至今，社区仅 OS 特定 hack）；macOS 透明窗需 `macos-private-api` feature（App Store 阻断）；tray/setBounds 动画/单实例锁均为 Electron 一级 API；手术刚稳定，立即重写=丢弃 25 项测试锁定的已验证行为。
**迁移论据**：安装包 20~25× 缩小（85-250MB → 3-10MB）、空闲内存降 ~75%、冷启动 ~3.7×、Tauri 权限模型更安全、移动端可扩展（2026 多来源实测数据交叉验证）。
**结论**：短期 Electron 留守发版；R4（独立后续）先做 Tauri v2 PoC spike，验收硬指标：①Windows 穿透转发等价实现可行 ②三平台透明置顶无私有 API ③tray 完整 ④拖动动画 ≥60fps ⑤打包 <15MB。全过才立项 Rust 全套重写；任一不过 → Electron 留守，一年后复评。

## 5. 成功标准

- 远端仅剩：main（orphan 新史）+ tag v0.6.0 + 其触发的首个 Release（含 Windows 工件 ± mac 包）
- release.yml 双平台路径均可在无 Apple secrets 的 fork 上全绿
- R3 各里程碑测试保持 25/25、verify-surgery 全过、行为无回归

## 6. 不做（YAGNI）

- 不迁移 TypeScript/引入 bundler/改 ESM；不动 backend/* 模块边界；不做性能专项；不在本次实施 Tauri spike（另立规格）
