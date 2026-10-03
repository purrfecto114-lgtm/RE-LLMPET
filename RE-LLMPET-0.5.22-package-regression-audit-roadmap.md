# RE-LLMPET 0.5.22 产物回退、协议偏移与新路线审查

审查对象：`RE-LLMPET-0.5.22.zip`  
归档 SHA-256：`8d994e0e6e01ae8c8fb3a92eb0544eb79a99a4bd922f4bac68878cf6428846f5`  
对照基线：上传的 `RE-LLMPET-0.5.21.zip`、前序 0.5.19.1 审查、Electron 上游当前公开主线、Provider 当前公开契约。  
审查日期：2026-08-01

---

## 1. 执行结论

0.5.22 不是一次成功导入修复的功能版本，而是一次**元数据重打包失败**。

逐树哈希结果：

| 树 | 0.5.21 文件 | 0.5.22 文件 | 字节完全相同 | 功能变更 |
|---|---:|---:|---:|---:|
| `frontend/` | 51 | 51 | 51 | 0 |
| `src-tauri/src/` | 14 | 14 | 14 | 0 |
| `src-tauri/capabilities/` | 2 | 2 | 2 | 0 |
| `scripts/` | 18 | 18 | 18 | 0 |
| `docs/` | 38 | 38 | 38 | 0 |
| `resources/` | 2 | 2 | 2 | 0 |
| `.github/` | 5 | 5 | 5 | 0 |

相对 0.5.21，实际变化只有：

- 版本元数据；
- CHANGELOG/BUILD_REPRODUCIBILITY/SOURCE_*；
- protocol report 时间或内容；
- 6 个测试中的版本号/日志预期；
- 意外新增 `.env`。

CHANGELOG 却宣称导入了 panel、pet、bridge、commands、hook、HTTP server、build、capability、Tauri 配置、fixture、manifest generator 等大量修复。这些代码树与 0.5.21 **逐字节相同**，多个声称新增的文件根本不存在。

因此：

> **0.5.22 应视为无效 release artifact，而不是 0.5.21 的功能修复版。不要发布、不要再在其版本号上叠加功能。**

正确处理是从可追溯 Git commit 重新生成 `0.5.22.1`，而不是继续修改这个 ZIP。

---

## 2. 新鲜验证结果

| 检查 | 结果 | 能证明什么 | 不能证明什么 |
|---|---|---|---|
| `npm test` | 通过 | 源码字符串契约仍在 | 窗口、异步、协议和真实 CLI 行为 |
| `npm run check:static` | 22/22 | JSON/YAML/JS 语法、桥接名称平衡 | Rust 编译和运行时正确性 |
| `npm run gate:source` | 16/16 | 版本字段一致、旧 Electron 路径不在活动树 | SOURCE_MANIFEST 真实有效 |
| `npm run gate:assets` | 39 项 | 资源字节未变化 | 渲染/DPI/内存表现 |
| JS `node --check` | 68/68 | JavaScript 可解析 | DOM/Promise/事件行为 |
| Rust 编译/Clippy | 未执行 | 当前环境无 `cargo`/`rustc` | 不能宣称 Rust 构建通过 |
| Windows 实机 | 未执行 | — | OpenCode/CodeWhale、透明窗口、WebView2 内存 |

现有测试的主要问题不是“数量少”，而是测试对象错误：多数断言源码包含字符串。例如 manifest smoke 只检查：

```js
manifest.version === '0.5.22'
manifest.file_count > 200
manifest.sha256_of_manifest 存在
```

它没有验证：

- 文件集合完全一致；
- 每个 hash 正确；
- manifest 自身 hash 可验证；
- SOURCE_REVISION 是 Git SHA；
- CHANGELOG 声称的路径真的发生变化；
- 新增 fixture/script 真的存在。

所以测试全部通过，但产物仍然失真。

---

## 3. P0：CHANGELOG 与真实差异相反

`CHANGELOG.md:3-22` 声称 0.5.22 导入：

- `panel.css/html/js`；
- `pet.js`；
- `tauri-bridge.js`；
- `commands.rs`；
- `hook_install.rs`；
- `http_server.rs`；
- `lib.rs`；
- `build.rs`；
- capability；
- `tauri.conf.json`；
- protocol baseline；
- gate scripts；
- 4 个新 fixture；
- `generate-source-manifest.js`；
- 0.5.21 架构审查报告。

真实结果：上述应用源码、脚本、capability、workflow 和 docs 树与 0.5.21 完全相同。

以下声称新增的文件不存在：

```text
test/fixtures/codewhale-message-submit.json
test/fixtures/opencode-session-status-busy.json
test/fixtures/opencode-session-status-idle.json
test/fixtures/opencode-session-status-retry.json
scripts/generate-source-manifest.js
RE-LLMPET-0.5.21-architecture-regression-audit-roadmap.md
reports/protocol-baseline.json
```

### 风险

- 用户以为修复已交付，实际仍运行旧缺陷；
- 后续开发者基于错误 CHANGELOG 判断分支；
- release binary 无法与源码声明对应；
- 回归定位会被错误版本边界干扰；
- SBOM、attestation、源码包即使存在，也证明了错误产物。

### 必须修复

release gate 应自动计算 `previous_tag..current_tag`，并验证 CHANGELOG 中所有“changed/new”路径：

```text
声称 changed → Git diff 必须包含该路径
声称 new     → 文件必须存在，且 previous tag 不存在
声称 removed → 当前 tag 必须不存在
```

不能再手工复制“修复清单”后仅修改版本号。

---

## 4. P0：SOURCE_MANIFEST 无效

真实验证：

```text
manifest.file_count       = 280
manifest entries          = 280
实际文件                  = 282
manifest 中存在但包内缺失 = upload/RE-LLMPET-0.5.21.zip
实际存在但未列入         = SOURCE_DATE_EPOCH
                           SOURCE_MANIFEST.json
                           SOURCE_REVISION
hash 不匹配               = CHANGELOG.md
                           reports/protocol-drift.json
声明的 manifest SHA       = cdb1c93e...
实际文件 SHA              = 9d8e4274...
```

`SOURCE_REVISION` 内容是：

```text
re-llmpet-0.5.22
```

这不是 Git commit SHA，无法把源码包绑定到 tag、构建和 CI。

### 正确产物模型

生成包时应从 clean checkout 执行：

```text
SOURCE_COMMIT=<40 hex GITHUB_SHA>
SOURCE_REF=refs/tags/v0.5.22.1
SOURCE_TREE_DIRTY=false
SOURCE_DATE_EPOCH=<commit timestamp>
```

manifest 应：

- 明确定义是否包含 manifest 自身；
- 若包含自身，使用规范化双阶段生成或 detached checksum；
- 验证实际文件集合等于声明集合；
- 对每个普通文件重算 SHA-256；
- 对路径排序、mtime、owner、group、权限进行规范化；
- 打包完成后从全新临时目录再次解包验证。

---

## 5. P0：源码包意外携带 `.env`

0.5.22 新增了一个 50 字节 `.env`：

- 包含非空 `DATABASE_URL`；
- 指向打包环境的本地数据库路径；
- `.gitignore` 没有忽略 `.env`；
- manifest 将它当作正常发布文件；
- ZIP 中权限为 `0755`。

本报告不披露其具体路径。

即使它当前不是访问令牌，也属于：

- 构建者本机信息泄露；
- 不可复现环境污染；
- 下游工具误读项目环境的风险；
- 未来把真实 secret 一并打包的先兆。

### 必须修复

```gitignore
.env
.env.*
!.env.example
```

release 工作流增加：

```text
禁止 .env、*.pem、*.p12、*.pfx、keychain、credentials 等进入归档
运行 secret scanner
从显式 allowlist 生成归档，而不是 zip 当前工作目录
```

---

## 6. P1：ZIP 权限全部错误

归档中 282 个普通文件全部为：

```text
-rwxr-xr-x
```

README、JSON、PNG、Rust、JS、配置文件全部被标记为可执行。

这不会必然阻止构建，但会：

- 破坏可复现性；
- 制造无意义权限 diff；
- 在 Unix 解包后扩大可执行面；
- 暗示打包脚本没有规范化文件属性。

建议：

```text
普通源码/文档/资源 = 0644
真正脚本            = 0755
目录                = 0755
owner/group          = 0/0 或固定值
mtime                = SOURCE_DATE_EPOCH
路径顺序             = bytewise stable
```

---

## 7. 0.5.21 的功能回归全部仍在

由于 `frontend/` 与 `src-tauri/src/` 完全相同，0.5.21 已确认的问题均未被 0.5.22 修复。

### 7.1 详细窗口仍是视觉上的“双层窗口”

`src-tauri/tauri.conf.json:30-45`：

```json
{
  "label": "panel",
  "decorations": false,
  "transparent": true,
  "shadow": false,
  "visible": false
}
```

`frontend/renderer/panel.css:2-10,53-62`：

```css
html, body {
  background: transparent;
  padding: 20px;
}

#card {
  border-radius: 18px;
  box-shadow: 0 8px 32px rgba(...);
}
```

实质结构是：

```text
透明原生 WebView 窗口
└── 20px 透明 gutter
    └── 内部可见 #card
```

用户 resize 的是外部透明窗口，视觉上却在操作内卡片，因此边缘、最大化和高度计算天然错位。

为了维护这个结构，panel 仍有：

- 最大化/全屏 class；
- 96% near-fullscreen heuristic；
- 每 500ms 查询窗口状态的永久 poller；
- 多套透明边缘补丁。

### 路线判断

不要继续补透明 panel。改为：

```text
pet   = 透明、常驻、最小 WebView
panel = 普通不透明、原生边框或简单自定义标题栏、按需创建
```

panel 配置增加 `create:false`，首次打开时创建，关闭或闲置后销毁。这样可同时移除：

- 双层 resize；
- 20px 透明 gutter；
- near-fullscreen；
- 500ms poller；
- 隐藏第二 WebView 的持续内存。

### 7.2 冷启动 Provider 按钮仍会缺失

`pet.js:1857`：

```js
let activeProviders = [];
```

Provider 只在 `onConfig` 事件中应用：

```js
window.pet.onConfig((cfg) => {
  activeProviders = cfg.providers.active;
  updateProviderUI();
});
```

但冷启动主动 `getConfig()` 的路径 `pet.js:2519-2528` 没有应用：

```text
cfg.providers.active
cfg.providers.statuses
updateProviderUI()
```

按钮在没有 Provider 时又被直接隐藏：

```js
if (!provider) slNew.style.display = 'none';
```

所以早期 `pet:config` 在 listener 注册前丢失时，按钮会一直隐藏，直到用户再次勾选 Provider 触发新事件。

### 产品修法

按钮永久存在：

```text
🚀 新开 Agent ▾
```

点击展开可用 Provider：

- 健康：正常启动；
- 已启用但异常：显示诊断/修复；
- CLI 已安装但未启用：启用并启动；
- 未检测到：打开配置；
- 多个：默认高亮最近使用，不静默选择数组第一项。

代码建立唯一入口：

```js
function applyConfigSnapshot(cfg) {
  activeProviders = Array.isArray(cfg?.providers?.active)
    ? [...cfg.providers.active]
    : [];
  latestProviderStatuses = cfg?.providers?.statuses || {};
  updateProviderUI();
}
```

同时用于 `onConfig` 和 `await getConfig()`；再增加 renderer-ready/bootstrap handshake。

### 7.3 stats revision 修复仍会阻止缓存重放

Panel：

- `render(s)` 先消费 revision；
- hidden 时把同一快照放进 `pendingStats`；
- show 时再次 `render(cached)`；
- 因 `rev <= lastStatsRevisionPanel` 被拒绝；
- panel 可能继续显示旧内容或空内容。

Pet：

- revision guard 放在 `applyStats()`；
- transient/happy/error/territory 结束后多处调用 `applyStats(lastStats)`；
- 同一 revision 已消费，因此不能恢复真实状态。

另外，`commands.rs:107-110` 的 `get_stats()` 返回 `runtime.stats()`，没有 revision。较早发起的无版本 bootstrap 响应仍可能覆盖较新的 versioned event。

### 正确分层

```text
ingestStats(snapshot)
  └── 只处理外部输入、revision 和缓存

renderStats(snapshot) / derivePetState(snapshot)
  └── 允许同一 snapshot 重复渲染
```

`get_stats()` 和 event 必须调用同一个 versioned snapshot builder。

### 7.4 OpenCode 启动参数仍硬编码错误面

`commands.rs:2767-2774`：

```rust
"opencode" => &["--dir", "."],
```

当前用户实机 CLI 帮助显示 TUI 是：

```text
opencode [project]
```

因此不能继续假设顶层 TUI 固定支持 `--dir`。

建议：

1. 运行 `opencode --help`/`--version`，缓存 capability；
2. 永远设置 `Command.current_dir(cwd)`；
3. 当前 CLI 接受 project positional 时传 `.`；
4. server 模式显式使用 `opencode serve --hostname 127.0.0.1 --port <managed>`；
5. 诊断中展示实际选择的 launch surface。

### 7.5 OpenCode 状态 payload 仍解析错误

当前插件把：

```js
event.properties.status
```

当作字符串。当前官方 SDK 类型中它是：

```ts
{ type: 'idle' }
{ type: 'busy' }
{ type: 'retry', attempt, message, next }
```

因此对象被拿去做 `stateMap[raw]`，最终无法正确映射 busy/retry。

应读取：

```js
const status = event?.properties?.status ?? event?.status;
const type = typeof status === 'string' ? status : status?.type;
```

并保留 retry metadata。

更重要的是，OpenCode 官方 server 提供 health、SSE 全局事件、session 状态、OpenAPI 和 SDK。新的 adapter 应以 server/SSE 为状态真相源，global plugin 只做兼容 fallback。

### 7.6 CodeWhale 仍不会收到 `message_submit`

`hook_install.rs:82-98` 仍把 `message_submit` 从安装事件中移除。

当前 CodeWhale 文档明确支持 `background=true` 的 observer-only `message_submit`：它不会等待、不能修改或阻止消息，但仍收到相同 payload。因此短期可恢复经 fixture 验证的 background observer hook。

中期应转向 `codewhale app-server`。其当前文档将 app-server 定义为新集成的 canonical HTTP/SSE control plane，可提供线程/turn、事件、usage 和状态，而无需依赖 TUI hook 推测。

### 7.7 冷启动和内存没有任何代码级改善

0.5.22 没有修改应用代码，所以不可能相对 0.5.21 产生结构性启动或内存改善。

当前高概率成本：

- 启动即创建 pet + hidden panel 两个 WebView；
- panel 即使隐藏仍保持页面、状态和监听器；
- panel 可见时每 500ms 两次窗口 IPC；
- 启动阶段同时初始化 config、usage、transcript、HTTP server、hook verify、tray、cursor hit-test、price sync、stats；
- benchmark 只采一个 PID，不汇总 WebView/browser/GPU/utility 子进程；
- benchmark gate 没有冷启动和硬阈值。

必须先把 panel 变成 `create:false` 的懒加载不透明窗口，再做 staged startup 和整进程树基准。

---

## 8. 与 Electron 上游的偏移

### 应保留的正向偏移

- Tauri/Rust 核心；
- 零 npm runtime dependency；
- 更小分发面；
- capability 分离；
- 多 Provider 框架；
- 本地 token、loopback server；
- 可逆 hook 的产品方向。

不建议退回 Electron。

### 已产生负面影响的偏移

#### 8.1 Provider 广度超过真相源深度

Electron 上游的 Codex 接入是：

```text
只读 rollout 增量 tail
零配置
不修改 Codex 配置
恢复近期会话
过滤内部 subagent
解析 token/rate limits
```

RE-LLMPET 仍把精力集中在统一 hook/plugin 抽象，但 Codex rollout watcher 被长期 defer。这使“支持更多 Provider”在部分场景中变成“显示存在，但状态不可靠”。

#### 8.2 UI 差异已变成维护负担

上游详情体验围绕 scroll、detail、popup shadow 分支持续打磨；RE 的透明 panel 则引入 Windows maximize、DPI、透明边框、轮询和双层 resize 问题。

这不是 Tauri 本身必须付出的成本，而是 panel 设计选择造成的成本。

#### 8.3 协议判断依赖注释和字符串测试

OpenCode status、OpenCode `--dir`、CodeWhale `message_submit` 都曾因人工假设偏离当前协议。应改为：

- 官方 schema fixture；
- 实际 CLI capability probe；
- 真实 server canary；
- drift gate 未联网时返回 `local-only`，不能返回 `ok`。

---

## 9. 是否需要更换大方向

### 不需要

- 不退回 Electron；
- 不需要全面改成 egui/纯原生；
- 不需要重写 Rust Core。

### 需要

进行一次明确的局部架构转向：

```text
Rust Core
├── ConfigTxn / SessionStore / PermissionStore / Usage
├── StatsActor / ErrorCenter / WindowCoordinator
└── ProviderAdapter V2
    ├── Claude     官方 hooks
    ├── Codex      rollout/app-server 只读 truth source
    ├── OpenCode   server/SSE truth source，plugin fallback
    ├── CodeWhale  app-server truth source，background hook fallback
    └── Aider      notification/log，明确能力降级

透明、常驻、极小 Pet WebView
普通不透明、按需创建 Detail WebView
```

核心原则：

> **官方可查询状态源优先，hooks/plugins 只补充低延迟事件；UI 不再通过透明窗口技巧承担系统窗口职责。**

---

## 10. 新路线图

### 0.5.22.1 — 产物紧急修复（1–2 天）

只处理发布可信度，不混入功能：

1. 从 clean Git commit/tag 重新生成源码包；
2. 删除 `.env`，加入 ignore 和 secret scan；
3. SOURCE_REVISION 使用 40 位 commit SHA；
4. 重写 manifest generator 和 verifier；
5. 验证文件集合、hash、模式、mtime、owner；
6. CHANGELOG 与真实 Git diff 对账；
7. 不存在的 fixture/script 不得写入 CHANGELOG；
8. CI 强制 Rust fmt/check/test/clippy；
9. release 前从全新目录解包并运行全部 gate；
10. 将 0.5.22 标记为 withdrawn/invalid artifact。

推荐提交：

```text
chore(release): withdraw invalid 0.5.22 artifact
fix(archive): exclude dotenv and local build inputs
build(provenance): bind source archive to exact git commit
build(manifest): verify exact file set, hashes and modes
ci(release): compare changelog claims against git diff
ci(rust): require fmt check test clippy before packaging
```

完成标准：

- manifest missing/unlisted/bad-hash 均为 0；
- `.env` 和秘密扫描结果为 0；
- SOURCE_COMMIT 可在仓库中解析；
- 归档解包两次 hash 一致；
- changelog 的每个 changed/new path 都有真实 diff；
- Rust 四门禁真实通过。

### 0.5.23 — 行为闭环（3–7 天）

1. panel 改为不透明；
2. panel `create:false`，按需创建/销毁；
3. 删除 gutter、near-fullscreen、500ms poller；
4. Provider 启动按钮常驻 + 下拉框；
5. `applyConfigSnapshot` + renderer-ready bootstrap；
6. stats ingest/render 分层；
7. `get_stats()` 带 revision；
8. OpenCode launch capability probe；
9. OpenCode `status.type` fixture 行为测试；
10. CodeWhale background `message_submit` fixture；
11. 所有修改操作 await，失败不提前关闭 UI。

完成标准：

- 冷启动无需再勾选 Provider；
- panel resize 边界与可见内容一致；
- hidden→show 快照立即重放；
- transient 状态结束后恢复同一 revision；
- OpenCode 能启动并产生 busy/idle/retry；
- CodeWhale 提交任务在 150ms 内显示“收到新任务”。

### 0.5.24 — Provider Adapter V2（1–3 周）

1. OpenCode server/SSE adapter；
2. CodeWhale app-server adapter；
3. Codex rollout watcher；
4. hooks/plugins 变为 fallback；
5. 统一 capability negotiation；
6. selected/installed/healthy/running/focused/recent 状态分离；
7. 真实诊断 job registry、取消 token 和进程树回收；
8. hook diff/备份/verify/rollback；
9. protocol fixture 绑定上游 schema commit。

### 0.5.25 — 性能与安全（2–4 周）

1. staged startup；
2. async HTTP；
3. 单一 StatsActor；
4. usage/transcript worker；
5. delta snapshot；
6. 整进程树 CPU/RSS；
7. 冷启动、panel 首开、hook→UI latency；
8. 8–24h soak；
9. 关闭 global Tauri；
10. 最小 capability 和收紧 CSP。

### 0.6.0 Stable

- Windows Authenticode；
- macOS Developer ID、notarization、staple；
- 第三方 Actions 固定 SHA；
- exact-source provenance；
- 五 Provider 真机 canary；
- 中文/日文/空格/特殊字符用户路径；
- 100/125/150/200% DPI；
- 多显示器、睡眠恢复、远程桌面；
- 安装、升级、卸载、hook 恢复；
- 与 Electron 上游同机整进程树对照。

---

## 11. 下一步优先级

### 立即停止

- 不发布当前 0.5.22 ZIP；
- 不再基于其 CHANGELOG 判断已修功能；
- 不继续加 Provider/皮肤/动画；
- 不继续修透明详情窗口补丁。

### 立即开始

1. 先修产物生成链；
2. 再把 0.5.21 未完成的真实代码修复重新落地；
3. 每个修复先写可执行行为测试，而不是字符串断言；
4. Provider 接入改为官方 truth source 优先；
5. 性能先移除启动第二 WebView，再测整进程树。

---

## 12. 最终判断

0.5.22 最大的问题不是“又出现了几个 bug”，而是：

> **版本声明、CHANGELOG、源码树、manifest 和测试结论彼此不再代表同一份软件。**

在 provenance 修好前，继续做功能优化会让每一轮审查都无法确认“修复究竟进入了哪个包”。

技术大方向仍然成立：保留 Tauri/Rust；但详情窗口和 Provider 接入需要局部转向——普通懒加载 panel，官方 server/SSE/rollout 优先，hooks/plugins 降级为补充。

