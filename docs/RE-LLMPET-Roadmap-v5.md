# RE-LLMPET 版本号驱动 Roadmap v5

**基线版本：** 0.5.38  
**目标版本：** 0.6.0  
**制定日期：** 2026-08-03  
**产品约束：**

- RE-LLMPET 继续采用 Tauri 2 + Rust 独立主线。
- Claude、Codex、CodeWhale、OpenCode、Aider 都是核心 Provider，不做产品等级降级。
- 生产版不允许与官方 LLMPET 共存。
- 升级必须保留 RE 状态；完整卸载必须清除全部 RE 状态和 RE hooks。
- 不得自动修改或删除无法证明属于 RE 的用户/官方配置。
- 新版 hook 使用 receipt + install ID；旧版 hook 通过受控 Legacy Repair 迁移。
- 静态 smoke 只能证明源码契约，不能替代真实安装器、真实桌面和真实 Provider 证据。

---

# 0.5.39 — Correctness Closure

## 版本目标

消除 0.5.38 中“代码表面存在、控制流实际未生效”和“清理结果虚报”的问题。

本版本不增加产品功能，不做上游视觉功能迁移。

## 必须完成

### 1. 移除 Node 侧宽泛 HTTP 所有权判断

从 `scripts/install-native-hooks.js` 删除：

```text
127.0.0.1:41330–41334 + /permission
```

作为 RE hook 的判断条件。

普通卸载只能识别：

- 精确 owner；
- 当前 RE marker；
- 当前 RE hook executable；
- 后续版本的 active receipt。

旧 HTTP hook 只能进入 Legacy Repair，不能由普通卸载自动删除。

### 2. 让配置 quarantine 真正生效

移除未被启用的全局 `CONFIG_WRITE_DISABLED` 设计，改成 `AppState/Runtime` 内的实例状态。

配置状态至少包括：

```text
Healthy
NotFound
ParseError
Unreadable
TooLarge
SchemaTooNew
```

非 `Healthy/NotFound` 状态：

- 禁止普通设置写入；
- 不得用默认配置覆盖原文件；
- UI 显示恢复页；
- 提供“备份后重置”；
- 保留未知字段。

### 3. 使用 typed cleanup result

五个 Provider 统一返回：

```text
Removed
NotFound
Unowned
Changed
PathDrift
Unreadable
Residue
ManualActionRequired
```

禁止再用 `Result<PathBuf, String>` 表达完整卸载结果。

OpenCode 未删除文件时不得显示 `removed`。

### 4. Bulk uninstall 复用单 Provider 清理管线

`uninstall_hooks("all")` 不得维护另一套弱逻辑。

它必须逐项调用同一个 cleanup pipeline，并返回：

```json
{
  "selectionCleared": true,
  "allHooksVerifiedAbsent": false,
  "results": [],
  "reportPath": "..."
}
```

### 5. 修复 drift 语义

把 `size + mtime` 替换为 SHA-256。

结果区分：

```text
unchanged
changed
missing
unreadable
unknown
```

没有 receipt 时不得返回“未变化”。

### 6. 删除危险 dead code

删除或重写 CodeWhale dormant legacy cleaner。

不能保留一个“当前没调用，但一旦启用可能删除用户 TOML table”的破坏性函数。

### 7. 修复测试误导

- 官方风格 HTTP hook fixture 必须保持字节不变；
- 配置损坏后写入必须被拒绝；
- OpenCode `Unowned` 不得断言为 `Removed`；
- 测试不得仅检查注释或变量名存在；
- 修正 Phase 0E 手工脚本中的 JSON 注释、未授权 IPC 和错误 tray 描述。

## 发布出口

只有以下全部通过才能发布 0.5.39：

- Node 与 Rust 普通卸载均不会删除官方风格 HTTP hook；
- 损坏配置不会被任何普通 UI 操作覆盖；
- bulk uninstall 可以报告部分残留；
- 所有 Provider cleanup 结果语义一致；
- SHA-256 drift 测试通过；
- `npm test`、Rust unit/integration tests、三平台 compile 通过。

---

# 0.5.40 — Ownership Transaction

## 版本目标

把 0.5.38 的 receipt 原型升级为真正的 hook 所有权事务。

## 必须完成

### 1. 每次安装生成 Install ID

格式：

```text
re-llmpet:<uuid>
```

不得继续只使用：

```text
re-llmpet
```

### 2. 精确 owner 解析

禁止：

```rust
command.contains("re-llmpet")
```

必须解析完整参数或结构化 command：

```text
--owner re-llmpet:<install-id>
```

并验证：

- owner；
- executable canonical path；
- command fingerprint；
- Provider；
- receipt。

### 3. Receipt 状态机

Receipt 分为：

```text
pending
active
superseded
removed
residue
rolledBack
```

目录建议：

```text
receipts/active/<provider>.json
receipts/history/<timestamp>-<provider>.json
```

### 4. 安装事务

```text
读取并验证目标
→ 创建备份
→ 写 pending receipt
→ 写 hook
→ 重新读取验证
→ 提交 active receipt
```

任一步失败：

- 恢复备份；
- 删除 pending receipt；
- 不更新 Provider 勾选；
- 返回失败。

### 5. Receipt 驱动卸载

卸载必须使用 receipt 中记录的：

- logical path；
- canonical path；
- before SHA-256；
- installed SHA-256；
- owner/install ID；
- command fingerprint；
- Provider format。

不得根据卸载时当前环境变量重新推导路径。

### 6. 幂等同步

`set_providers()` 不得无差别重写全部已选 Provider。

流程：

```text
current == desired → NoOp
current != desired → Backup + Transaction
```

重复保存相同设置不得产生新备份或新 receipt。

### 7. Symlink 和路径策略

- 保存 logical path 和 canonical path；
- 默认拒绝 Provider 配置目标为 symlink；
- 不允许越出批准的用户配置根；
- 路径发生变化时返回 `PathDrift`；
- 不自动跟随未知 symlink 执行破坏性写入。

## Legacy Repair

旧 RE 版本没有 receipt，必须提供独立流程。

可以使用的证据：

- 明确旧 RE marker；
- 明确旧 RE executable path；
- 固定旧 RE hook 文件名；
- 旧 RE 版本/迁移记录；
- 用户确认。

不能使用的单独证据：

- localhost；
- 413xx；
- `/permission`；
- 任意 `octopus` substring。

Legacy Repair 必须先备份，并生成新的 repair receipt/report。

## 发布出口

- 环境变量路径改变后仍清理安装时原路径；
- receipt 写入失败会回滚 hook；
- 无 receipt 的新格式 hook 不会被普通卸载删除；
- 用户修改 hook 后返回 `Changed/Residue`；
- 重复同步不产生备份 churn；
- 五 Provider 事务测试全部通过。

---

# 0.5.41 — Conflict Gate & Migration

## 版本目标

落实“RE 不与官方 LLMPET 共存”，并正确区分官方、旧 RE 和遗留数据。

## 必须完成

### 1. 无副作用 preflight

必须早于：

- `AppState::new()`；
- 创建 `~/.re-llmpet`；
- 启动 tray；
- 绑定 HTTP server；
- 检查或安装 hooks；
- 价格同步。

### 2. 状态分类

```text
fresh
officialInstalled
officialRunning
legacyReInstalled
legacyReRunning
staleOfficialData
ambiguous
```

### 3. 平台检测

#### Windows

- 卸载注册表 32/64 位、当前用户/本机视图；
- DisplayName、InstallLocation、UninstallString；
- 运行进程的完整 executable path；
- 旧 runtime PID/server identity；
- 旧 RE 与官方身份区分。

#### macOS

- Launch Services；
- `/Applications`；
- `~/Applications`；
- 运行中的 bundle URL 和 executable URL；
- bundle name、identifier、签名和旧 RE marker。

#### Linux

- 运行进程；
- runtime；
- desktop entry；
- 手工复制或源码运行入口；
- 单独存在 `~/.octopus` 不得直接判断“官方已安装”。

### 4. 阻断策略

`officialInstalled/officialRunning/ambiguous`：

- 不启动 RE runtime；
- 不绑定端口；
- 不修改 Provider；
- 显示冲突证据和处理说明；
- 允许重新检测和退出；
- 不提供生产版强制共存按钮。

### 5. 旧 RE 迁移

允许迁移：

- UI 偏好；
- 语言；
- 宠物；
- 预算；
- session 展示偏好。

默认不迁移：

- Provider 勾选；
- hooks；
- runtime/token；
- 旧 receipt；
- 无法确认所有权的配置。

Provider 只能作为“建议重新启用”，由用户明确确认后通过 0.5.40 的新事务重新安装。

## 发布出口

- 官方存在时 RE 在任何 Provider 和 runtime 文件上都无写入；
- 官方、旧 RE、stale data、ambiguous 可稳定分类；
- 迁移失败可回滚；
- 全新安装 Provider 默认全未选；
- 旧 RE UI 设置可迁移，但 hook 必须重新确认。

---

# 0.5.42 — Windows Complete Lifecycle

## 版本目标

先在 Windows 打通最完整的安装、升级、修复和卸载事务，作为其他平台的参考实现。

Tauri NSIS 支持 `NSIS_HOOK_PREINSTALL` 和 `NSIS_HOOK_PREUNINSTALL`；后者在删除应用文件、注册表项和快捷方式前运行，适合作为完整卸载清理入口。

## 必须完成

### Install

- NSIS PREINSTALL 调用 conflict preflight；
- 官方 LLMPET 存在时阻断；
- 旧 RE 进入迁移流程；
- helper 校验签名/hash；
- 安装成功后写 install metadata。

### Upgrade

- 明确识别 updater/覆盖安装；
- 保留 RE 配置、active receipts 和 hooks；
- schema migration 原子化；
- 不执行 purge；
- 失败可回滚。

### Repair

- 检查丢失 binary、损坏 receipt、orphan hook；
- 只修复有所有权证据的内容；
- 不重置用户设置。

### Complete Uninstall

NSIS PREUNINSTALL：

```text
停止 RE
→ 清空 Provider 选择
→ receipt-driven hook cleanup
→ post-verify
→ 删除 config/runtime/token/session/log/receipt
→ 输出外部 report
→ 删除应用文件
```

必须区分：

- 完整成功；
- 可重试；
- 带 residue 继续；
- 用户取消。

### Windows 测试

- Windows 10/11；
- 当前用户安装；
- 管理员安装；
- 设置应用卸载；
- 控制面板卸载；
- 覆盖安装；
- updater；
- 应用运行中卸载；
- 只读 Provider 配置；
- 杀进程/中断；
- 完整卸载后重装。

## 发布出口

- 更新不清配置或 hooks；
- 完整卸载后重装 Provider 全未选；
- 无指向已删除 binary 的 hook；
- 官方 LLMPET 配置 hash 不变；
- 部分失败不虚报成功。

---

# 0.5.43 — macOS & Linux Complete Lifecycle

## 版本目标

在 macOS、AppImage 和 deb 上实现符合各平台现实约束的完整生命周期。

## macOS

macOS 普通拖拽安装没有 Windows 式 preinstall 事务，因此首次启动 gate 是主要互斥防线。Apple 建议优先使用应用提供的卸载器或卸载功能；没有卸载器时用户通常直接移入废纸篓。

### 必须完成

- 首次启动和每次启动前 conflict gate；
- 应用内“完整卸载 RE-LLMPET”；
- 清理成功后退出并提示移入废纸篓；
- orphan hook repair；
- `.app` 被直接删除后，新安装可检测失效 RE hook；
- Intel 和 Apple Silicon 真机测试；
- `/Applications` 与 `~/Applications`。

独立 Uninstaller App 为可选便利功能，不作为 0.5.43 硬性门禁。

## Linux AppImage

AppImage 的标准移除方式是删除单个文件，因此删除 AppImage 本身不会执行 RE 用户配置和 Provider hook 清理。

### 必须完成

- 应用内 `Uninstall & Reset`；
- maintenance CLI；
- 清理 Provider、receipt、配置、runtime、日志；
- 可识别当前 `APPIMAGE` 路径；
- desktop integration 清理；
- 删除 AppImage 后的 orphan repair。

## Linux deb

Debian maintainer scripts 不保证拥有控制终端，必须能非交互执行。因此不能让 `prerm/postrm` 交互式遍历所有用户 home 并询问如何修改 Provider 配置。

### 必须完成

- maintainer scripts 只清系统级文件；
- 安装 maintenance CLI；
- 当前用户数据通过应用内卸载/CLI 清理；
- `remove` 与 `purge` 语义明确；
- 多用户环境不扫描修改其他用户 Provider 配置；
- 无 TTY 环境测试。

## 发布出口

- macOS 应用内完整卸载后重装为干净状态；
- 直接删除 `.app` 后可检测并修复 orphan hook；
- AppImage reset 后无 RE 状态；
- deb remove/purge 不误伤其他用户；
- 三个平台官方 LLMPET 冲突策略一致。

---

# 0.5.44 — Provider Engine Consolidation

## 版本目标

保留五个 Provider 都是核心能力，但消除重复实现和不同语义。

## 必须完成

### 1. 统一 Adapter 接口

```text
detect
capabilities
install
verify
cleanup
repairLegacy
observe
normalizeEvent
```

### 2. 能力矩阵

不做产品等级划分，只如实表示能力：

```text
state
permission
usage
focus
completion
session
interrupt
replay
```

某 Provider 没有某项官方接口时：

- UI 明确显示；
- 不伪造支持；
- 不降低其作为核心 Provider 的产品地位。

### 3. 统一事件信封

至少包含：

```text
schemaVersion
provider
providerVersion
surface
sessionId
eventId
sequence
kind
capabilities
payload
```

### 4. 统一安装清理引擎

Provider adapter 不再自行实现：

- backup；
- receipt；
- owner；
- drift；
- path policy；
- cleanup report。

这些由共享 ownership engine 完成。

### 5. 真实 fixture

五个 Provider 各自具备：

- 官方配置 fixture；
- 外部字段保留；
- 重复事件；
- 乱序事件；
- unknown event；
- 版本变化；
- 权限/完成/异常流程。

## 发布出口

- 五 Provider 通过统一 conformance suite；
- Provider 之间不复制所有权和备份逻辑；
- UI 根据 capability 而非 Provider 名称硬编码行为；
- 当前公开支持能力均有真实 CLI 证据。

---

# 0.5.45 — Upstream Parity

## 版本目标

生命周期和 Provider 基础稳定后，再恢复上游行为跟进。

## 必须完成

建立版本化 Parity Ledger：

```text
upstream feature
upstream commit/PR
RE decision
accepted / modified / rejected
reason
test evidence
RE implementation
```

优先顺序：

1. session 生命周期；
2. permission 并发；
3. usage/metering；
4. focus/resume/subagent；
5. i18n；
6. session 搜索/置顶/归档；
7. 视觉和交互一致性；
8. travel/rank/meme 等增强功能。

规则：

- 不合并 Electron main/IPC；
- 先移植行为测试，再实现 Tauri/Rust 等价行为；
- 开放 PR 只能作为设计输入，不能直接视为稳定规范；
- 每项允许明确 Reject，不追求盲目 100% parity。

## 发布出口

- Parity Ledger 进入仓库；
- 每项决策有测试和理由；
- 上游核心 session/permission 行为无高优先级未解释差异；
- 新功能不能绕过 ownership/lifecycle engine。

---

# 0.5.46 — Release Evidence

## 版本目标

把“源码似乎正确”升级为“正式发布证据可独立复核”。

## 必须完成

### CI

- Rust unit/integration tests；
- `cargo clippy -D warnings`；
- `cargo deny check`；
- MSRV；
- Node syntax/lint；
- 三平台 bundle；
- installer lifecycle E2E；
- Provider real CLI matrix；
- capability/bridge/actual-use 契约。

### Source provenance

- 完整 40 位 Git SHA；
- clean checkout；
- 固定 source date epoch；
- 正确 file modes；
- 完整 manifest；
- checksums；
- SPDX SBOM；
- artifact attestation。

### Signing

公开 stable：

- Windows 验证 Authenticode signer 和 timestamp；
- macOS 验证代码签名、notarization 和 stapling；
- Linux 发布 checksums、SBOM 和 attestation。

开发 artifact 和 draft 可以未签名，但必须明确标识，不能写成 stable production。

### Updater 决策

二选一：

1. 正式启用 updater：
   - `createUpdaterArtifacts=true`；
   - updater plugin；
   - endpoint；
   - updater artifact signature；
   - 升级生命周期测试。
2. 暂不启用 updater：
   - 删除误导性的 updater signing 宣称；
   - 不要求无实际用途的 updater key；
   - 文档明确采用手动下载升级。

Tauri updater 的签名用于验证 updater artifacts；它不能替代 Windows Authenticode 或 macOS 平台签名。

## 发布出口

- 每个绿色状态都有可复核的 CI run/artifact；
- 未执行项显示 `not-run`，不能显示 `ok`；
- stable 缺平台签名即失败；
- 源码包绑定精确 commit；
- Release body 根据真实 job outputs 生成。

---

# 0.6.0-rc.1 — Release Candidate

## 进入条件

0.5.39–0.5.46 的全部出口条件通过。

## RC 验证

- 从 0.5.38 升级；
- 从每个中间版本升级；
- 全新安装；
- 旧 RE 迁移；
- 官方 LLMPET 阻断；
- Windows/macOS/Linux 完整卸载；
- 完整卸载后重装；
- 五 Provider 真实版本矩阵；
- 长时间运行；
- 休眠/唤醒；
- 多屏；
- permission 并发；
- session resume；
- 签名、公证和 provenance。

RC 不新增功能，只修复阻塞缺陷。

---

# 0.6.0 — Stable

## 发布标准

- RC 至少完成一轮真实用户/真机验证；
- 无 P0/P1 数据安全或生命周期问题；
- 无错误 hook 所有权判断；
- 无配置覆盖风险；
- 官方 LLMPET 冲突 gate 生效；
- 三端完整卸载可验证；
- 五 Provider 均有公开能力矩阵和测试版本；
- Release assets、源码、SBOM、签名和 commit 一致；
- migration、rollback、uninstall 和 Legacy Repair 文档齐全。

---

# 版本依赖关系

```text
0.5.38
  ↓
0.5.39 正确性闭环
  ↓
0.5.40 所有权事务
  ↓
0.5.41 官方互斥与迁移
  ↓
0.5.42 Windows 生命周期
  ↓
0.5.43 macOS/Linux 生命周期
  ↓
0.5.44 Provider Engine
  ↓
0.5.45 上游行为对齐
  ↓
0.5.46 发布证据
  ↓
0.6.0-rc.1
  ↓
0.6.0
```

任何版本未满足出口条件时：

- 不允许只提升版本号并把未完成项推给下一版；
- 可以发布 `-alpha` 或内部 artifact；
- 不得将未验证状态写为 completed；
- 后续版本依赖的底层能力必须暂停。

---

# 优先级摘要

## 立即做

```text
0.5.39
0.5.40
```

它们解决当前仍存在的数据安全和所有权问题。

## 随后做

```text
0.5.41
0.5.42
0.5.43
```

它们落实不共存和完整卸载的产品意向。

## 稳定后做

```text
0.5.44
0.5.45
```

它们提升 Provider 架构并恢复上游功能迁移。

## 正式发布前做

```text
0.5.46
0.6.0-rc.1
```

它们把实现转化为可信发布证据。

---

# 外部实现依据

以下官方资料用于约束路线图中的平台实现，实际开发时仍应固定具体依赖版本并保留验证记录。

- **Tauri Windows Installer**  
  NSIS 支持 `NSIS_HOOK_PREUNINSTALL`，该 hook 在删除应用文件、注册表项和快捷方式之前运行，可用于执行完整卸载清理。  
  <https://v2.tauri.app/distribute/windows-installer/>

- **Tauri Updater**  
  `createUpdaterArtifacts=true` 才会要求 bundler 生成 updater artifacts；updater artifact 签名不能替代 Windows Authenticode 或 macOS 平台代码签名。  
  <https://v2.tauri.app/plugin/updater/>

- **Apple：删除或卸载 Mac 应用**  
  对包含额外组件的第三方应用，应优先使用应用提供的 `Uninstall` 或 `Uninstaller`。  
  <https://support.apple.com/en-us/102610>

- **Debian Policy：Maintainer Scripts**  
  maintainer scripts 不保证拥有控制终端，必须能够退回非交互行为，因此不应依赖交互式遍历用户目录清理 Provider 配置。  
  <https://www.debian.org/doc/debian-policy/ch-maintainerscripts.html>

---

# Roadmap 维护规则

1. 每个版本的“必须完成”和“发布出口”均为硬性门禁。
2. 未满足出口条件时，可以发布内部构建或预发布版本，但不得把该阶段标记为完成。
3. Roadmap 中的版本主题不可被新功能挤占。
4. 所有涉及 Provider 配置、hooks、session 和用户配置的改动，都必须先证明 RE 所有权。
5. 新发现的 P0 问题必须回填到当前尚未发布的最近版本，不得无条件推迟到后续版本。
6. 每个完成项至少需要一种行为证据；破坏性安装和卸载逻辑必须有真实文件系统或安装包 E2E 证据。
7. 正式发布状态必须区分：
   - `source-contract-passed`
   - `compiled`
   - `installer-e2e-passed`
   - `real-provider-passed`
   - `platform-signed`
   - `not-run`

