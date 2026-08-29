# RE-LLMPET 0.5.1 全面审计与优化报告

审计日期：2026-07-28  
对象：`RE-LLMPET-0.5.1.zip`  
方法：源码阅读、差分审计、静态扫描、现有测试、增量回归测试、发布/供应链检查、官方文档交叉验证。

## 1. 结论

该项目不是“整体不可用”，也不能仅凭现有 smoke tests 宣称“生产就绪”。更准确的判断是：

- Web/Node 契约测试和源码静态门禁较完整，项目对迁移状态、协议漂移、资源一致性已有较强的工程意识。
- 原版本存在数个位于“安全边界和发布边界”的高价值问题：Bash/HTTPS 自动许可过宽、Tauri 自定义命令默认跨窗口暴露、无签名构建可形成公开 prerelease、锁文件与清单版本分叉、SBOM 关系不完整。
- 本次已对上述问题进行代码级修复，并增加回归测试。
- 由于当前沙箱没有 Cargo/Rust/rustfmt，也没有三平台 GUI、真实 Provider CLI 和签名凭据，本报告只把相关改动标为“源码已实现并通过静态/契约测试”，不把它们虚报为“已编译、已真机、已签名验证”。

综合风险评级：**修改前中高风险；修改后中等风险，主要剩余风险集中在缺少 Rust 编译/真机/真实 Provider/签名证据，以及 Actions 尚未固定完整 SHA。**

## 2. 审计范围

1. 架构与迁移状态：Tauri 2/Rust 主体、Web UI、Hook 服务、Provider 适配、计量与价格同步。
2. 安全：本地 HTTP、运行时令牌、Hook 自动授权、IPC/capability、文件权限、命令执行面。
3. 发布与供应链：Cargo/npm 锁文件、GitHub Actions、签名、Release 可见性、SBOM、attestation、RustSec。
4. 正确性：权限状态机、并发请求、协议漂移、配置安装/卸载、版本元数据。
5. 性能与可靠性：热路径、轮询、缓存、有界读取、失败降级、运行门禁。
6. 可维护性：文档真相、测试覆盖、自动一致性检查、变更边界。

## 3. 主要问题与处理结果

| 等级 | 问题 | 影响 | 本次处理 | 状态 |
|---|---|---|---|---|
| 高 | Bash 被词法“只读白名单”自动放行 | 部分表面只读命令可通过参数写文件、改 Git 状态或触发外部程序；字符串策略难证明安全 | 删除 Bash 自动许可，交回 Provider 原生权限流程 | 已修复，静态/JS 回归通过；待 Rust 编译 |
| 高 | 任意 HTTPS WebFetch 自动放行 | HTTPS 只保证传输加密，不等于目标可信；可访问回环、私网、云元数据或经重定向改变目标 | HTTPS 不再自动 allow，返回无本地决策；HTTP 明确 deny | 已修复，静态/JS 回归通过；待真实 Provider |
| 高 | Tauri 注册命令默认供所有窗口使用 | 低权限宠物窗口一旦被前端注入，可调用面板/配置/退出等高权限命令 | 在 `build.rs` 注册命令 manifest，拆分 `pet.json`/`panel.json`，显式启用 | 已修复，权限集合测试通过；待 Cargo/GUI |
| 高 | 无签名构建被发布为公开 prerelease | 注释与实际 YAML 不一致，可能公开分发无法验证来源的安装包 | tag 发布缺签名立即失败；手动无签名仅创建隔离 draft | 已修复，工作流回归通过；待真实签名 |
| 中高 | `package-lock.json` 仍为 0.5.0，而清单为 0.5.1 | 版本追溯、SBOM、CI 元数据和发布产物可能出现分叉 | 重新生成锁文件，并新增版本一致性断言 | 已修复 |
| 中 | SPDX namespace 指向旧仓库且缺少 `DESCRIBES` | SBOM 身份和根包关系不准确，降低自动消费与追溯质量 | 从仓库元数据生成 namespace，加入根包关系 | 已修复，生成测试通过 |
| 中 | 未自动检查 Cargo.lock 漏洞公告 | 锁定版本可复现，但不会自动发现 RustSec 公告 | CI 新增固定版本 `cargo-audit 0.22.2` | 已配置；当前环境未联网执行 |
| 中 | `upload-artifact@v5` 已落后 | 运行时和维护线较旧，后续兼容性/安全更新缺失 | 全部更新至 v7，测试禁止回退 v5 | 已修复 |
| 中 | README、迁移 TODO 对 Cargo.lock 状态冲突 | 发布负责人可能根据错误状态做判断 | P0-004 改为 implemented-uncompiled，保留三平台验证门禁 | 已修复 |
| 中 | 任意 `v*.*.*` tag 可触发与包版本不一致的发布 | 错 tag 可能生成错误版本 Release，甚至和既有版本发生冲突 | tag 必须严格等于 `v${package.json.version}` | 已修复 |
| 中 | Actions 使用 tag 而非完整 SHA | tag 可被移动，供应链不可完全不可变 | 本次未批量盲 pin；列为下一轮 P1 | 未修复，明确记录 |

## 4. 关键设计取舍：多角度辩证讨论

### 4.1 自动放行：效率与安全

自动放行确实能减少弹窗，对高频只读工具体验更好。但 Bash 是一个“组合语言”，安全性取决于完整解析、环境、别名、重定向、子进程和平台差异；靠首个 token 或少量参数黑名单很难形成可证明边界。HTTPS 也只说明链路加密，并不说明目标不是 localhost、RFC1918 私网、云元数据服务或恶意重定向。

因此本次采用保守策略：只对语义封闭的一等只读工具保留自动决策；Bash 与 HTTPS WebFetch 都交给原生权限系统。代价是弹窗可能增多，收益是权限边界可解释、Provider 升级时不易静默越权。未来若要恢复 WebFetch 自动许可，应先实现 DNS 解析后地址校验、重定向逐跳校验、端口/域名策略和 DNS rebinding 防护，而不是只看 URL scheme。

### 4.2 Draft 与 prerelease：可见性不是同一概念

Prerelease 是“已公开但不建议生产使用”，draft 才是“尚未发布”。原工作流把无签名构建设置为 prerelease，和注释中的“仅草稿”相冲突。本次把生产 tag 与手动试构建拆开：tag 必须签名并正常发布；手动无签名构建只能进入唯一的 draft tag。这样牺牲了一点临时分享便利，但避免用户下载到来源无法验证的公开安装包。

### 4.3 IPC 最小权限：安全边界与维护成本

按窗口拆分 34 个命令会增加维护成本：每新增命令都要更新 build manifest 与 capability。可是默认“所有注册命令对所有窗口可用”会让窗口隔离形同虚设。本次同时加入集合一致性测试：命令漏登记、权限重复、pet/panel 越界都会使测试失败，用自动化抵消手工维护成本。

### 4.4 依赖更新与可复现性

升级到 `upload-artifact@v7` 能跟上官方维护线；固定 `cargo-audit` 版本能让 CI 行为可追溯。但工作流里的 Action 仍采用 major tag，便利性高、可自动获得补丁，却不是不可变引用。官方建议完整 commit SHA 最安全。本次没有在无法逐一验证源码和 SHA 的情况下机械替换，避免“看似 pin、实际 pin 错 fork/提交”；把它保留为明确 P1，而不是隐瞒。

### 4.5 测试通过与生产可用

JavaScript smoke/static tests 能证明源码文本、协议约束和配置之间没有已知漂移，不能证明 Rust 类型正确、Tauri 权限生成成功、GUI 窗口标签正确、平台 API 可用，也不能证明签名/安装链可用。因此报告将 26 项标为 implemented-uncompiled，并保留三项 blocked。这种表达比“测试全绿所以完成”更保守，也更可信。

## 5. 修改位置

### 权限与本地服务

- `src-tauri/src/hook_client.rs`：移除 Bash 自动许可；HTTPS WebFetch 委托原生权限；新增 Rust 单元测试。
- `src-tauri/src/http_server.rs`：HTTP Hook 路径同步采用相同 WebFetch 决策。
- `test/tauri-native-core-smoke.js`：增加 Bash/HTTPS 不得静默 allow 的回归断言。

### Tauri IPC capability

- `src-tauri/build.rs`：登记全部 invoke command，生成 allow/deny 权限。
- 删除 `src-tauri/capabilities/default.json`。
- 新增 `src-tauri/capabilities/pet.json`。
- 新增 `src-tauri/capabilities/panel.json`。
- `src-tauri/tauri.conf.json`：显式启用 `pet`、`panel` capabilities。
- 新增 `test/tauri-capability-boundary-smoke.js`。
- `scripts/static-check.py`：识别并校验新的 capability 文件。

### 发布与供应链

- `.github/workflows/release.yml`：签名门禁、tag/包版本一致性、draft/public 状态机、唯一 draft tag、attestation 范围。
- `.github/workflows/ci.yml`：新增 RustSec job，固定 cargo-audit 版本。
- `.github/workflows/*.yml`：`upload-artifact@v5` 升级到 v7。
- `scripts/generate-sbom.js`：修正 namespace 与 `DESCRIBES`。
- 新增 `test/release-supply-chain-smoke.js`。
- `package.json`：补充 repository；把新增回归测试接入 `npm test`。
- `package-lock.json`：根版本同步到 0.5.1。
- `scripts/check-release-gates.js`：把 npm 锁文件版本一致性加入 source/CI/release 门禁。

### 文档与状态

- `README.md`：更新签名发布与锁文件说明。
- `SECURITY.md`：更新无签名构建、权限与 capability 边界。
- `migration-todo.json`：修正 Cargo.lock 状态和统计。
- `CHANGELOG.md`：记录本次审计修复。
- `AUDIT_TODOLIST.md`：完成项、外部门禁和下一轮优先级。
- `AUDIT_REPORT_2026-07-28.md`：本报告。

## 6. 验证结果

在当前沙箱完成：

- `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`：成功。
- `npm ci --ignore-scripts --no-audit --no-fund`：成功。
- `npm test`：完整回归链通过；包含 1 个参考契约测试和 17 个连续 smoke/gate 步骤。
- `python3 scripts/static-check.py`：22 passed / 0 failed。
- JavaScript 语法、协议漂移、权限并发、Hook 安装、计量、价格同步、HTTP 加固、Windows 静态、发布供应链、capability 边界等均已纳入回归链。

当前环境无法完成：

- `cargo fmt/check/test/build`：没有 Cargo/Rust/rustfmt。
- RustSec 实际漏洞查询：新增 CI 需联网执行。
- 三平台 GUI、真实 Provider、签名安装包、升级卸载。

## 7. Web 交叉验证依据

以下均为官方/主项目资料：

- Claude Code Hooks：PreToolUse 可 allow/deny/ask，也可不作本地决定而交给原生权限流程。  
  https://code.claude.com/docs/en/hooks
- Tauri Capabilities：capability 按 window/webview 限制权限；默认注册命令对所有窗口开放，需 `AppManifest::commands` 改变。  
  https://v2.tauri.app/security/capabilities/
- GitHub Releases：draft 是未发布状态；prerelease 是公开但标记不稳定的发布。  
  https://docs.github.com/repositories/releasing-projects-on-github/managing-releases-in-a-repository
- GitHub Actions 安全：完整 commit SHA 是最安全的 Action 固定方式。  
  https://docs.github.com/actions/reference/security/secure-use
- npm package-lock：根包 name/version 应与 package.json 对应，锁文件用于可复现安装。  
  https://docs.npmjs.com/cli/v7/configuring-npm/package-lock-json/
- RustSec cargo-audit：依据 Cargo.lock 检查已知安全公告。  
  https://github.com/RustSec/rustsec/tree/main/cargo-audit
- SPDX 2.3 Relationships：多包文档需要明确 document 描述的包。  
  https://spdx.github.io/spdx-spec/v2.3/relationships-between-SPDX-elements/
- actions/upload-artifact Releases：核对当前维护版本。  
  https://github.com/actions/upload-artifact/releases

## 8. 推荐验收顺序

1. 合并前 CI：三平台 locked check/test/build + RustSec。
2. 测试分支：手动 workflow_dispatch，确认只生成 draft 且 tag 唯一。
3. 三平台真机：启动 pet/panel，逐项验证 capability 允许和拒绝行为。
4. 真实 Provider：重点验证 Bash、HTTPS WebFetch、并发权限卡、取消/超时。
5. 使用正式签名凭据打 tag；校验安装包、SHA256、SBOM、attestation、升级卸载。
6. 最后再把所有 Action 固定到已核验完整 SHA，并开启 Dependabot 维护。
