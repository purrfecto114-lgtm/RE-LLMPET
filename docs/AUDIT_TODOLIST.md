# RE-LLMPET 0.5.1 全面审计 TODO

审计日期：2026-07-28

## 已完成

- [x] 解压并盘点项目结构、语言、工作流、测试、发布与迁移状态。
- [x] 执行原始 JavaScript 冒烟测试和 Python 静态检查，建立修改前基线。
- [x] 检查 Hook 权限决策面：Claude/Codex/CodeWhale/OpenCode/Aider 的自动许可、拒绝与降级路径。
- [x] 移除 Bash 字符串白名单自动放行，避免参数组合或子命令产生写操作。
- [x] 将 HTTPS WebFetch 交回 Provider 原生授权流程；非 HTTPS 请求继续明确拒绝。
- [x] 检查 Tauri IPC 暴露面，并按 `pet`、`panel` 窗口拆分命令权限。
- [x] 增加命令清单与 capability 权限集合的自动一致性测试，防止新增命令静默越权。
- [x] 检查 GitHub Release 状态机，阻止无签名 tag 构建公开发布。
- [x] 将手动无签名构建限制为隔离 tag 的 draft release。
- [x] 修复制品证明范围，不再把 macOS `.app` 目录当成单一可证明文件。
- [x] 将 `actions/upload-artifact` 从 v5 更新到 v7，并加入工作流回归检查。
- [x] 修复 SPDX 文档 namespace，并加入根包 `DESCRIBES` 关系。
- [x] 新增 RustSec `cargo audit` CI 门禁，固定 `cargo-audit 0.22.2`。
- [x] 修复 `package.json` 0.5.1 与 `package-lock.json` 0.5.0 的版本分叉。
- [x] 增加 tag 与 `package.json` 版本严格一致门禁，避免错 tag 发布或覆盖既有版本。
- [x] 修正 README、SECURITY、迁移 TODO 中互相矛盾的发布与锁文件状态。
- [x] 执行修改后全套 JavaScript/静态回归测试。
- [x] 编写审计报告、修改清单和剩余风险说明。

## 外部环境未完成 / 不应伪报完成

- [ ] 在 Linux、Windows、macOS 上执行 `cargo fmt --check`、`cargo check --all-targets --locked`、`cargo test --lib --locked` 和 release 双入口构建。
- [ ] 在三平台启动真实 Tauri GUI，验证窗口标签与新 capability ACL 在运行时完全匹配。
- [ ] 使用真实 Claude、CodeWhale、Codex、OpenCode、Aider CLI 验证 Hook 协议与原生授权提示。
- [ ] 使用真实 macOS/Windows 签名凭据验证签名、安装、升级、卸载、校验和、SBOM 与 attestation。
- [ ] 运行新增的联网 RustSec CI；当前沙箱没有 Cargo/Rust 工具链，不能在本地宣称审计通过。

## 建议的下一轮优先级

- [ ] P1：把所有 GitHub Actions 从可移动 tag 固定为经核验的完整 commit SHA，并用 Dependabot 维护。
- [ ] P1：为自动更新价格目录增加 DNS 解析后的私网/回环地址阻断与重定向逐跳校验。
- [ ] P1：在 capability 生成后把 `gen/schemas` 与实际命令权限作为 CI 制品保存，便于审计。
- [ ] P2：增加故障注入测试：runtime 文件损坏、端口被占、Provider 超时、权限请求并发取消、磁盘只读/写满。
- [ ] P2：增加基于真实二进制的启动耗时、空闲 CPU/RSS、长时间会话内存增长基线。
- [ ] P2：明确发布分支保护、tag 保护、Environment 审批和签名密钥轮换流程。
