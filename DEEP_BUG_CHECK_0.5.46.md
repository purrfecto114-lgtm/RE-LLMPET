# Octopus (RE-LLMPET) 0.5.46 — 深度 Bug 检查报告

**检查日期**: 2026-08-08
**版本**: 0.5.46 prerelease
**范围**: 7 条核心代码路径 + 跨文件 unwrap/panic/unsafe 扫描
**方法**: 7 个并行审计 agent 逐流程图深度审查，每个 agent 通读相关源文件并核对项目方清单中的每一条具体担忧

---

## 0. 文件完整性核对

所有源文件行数与项目方描述一致，**无缺失/截断**：

| 文件 | 描述行数 | 实际行数 | 状态 |
|---|---|---|---|
| lib.rs | 800 | 800 | ✓ |
| commands.rs | 3229 | 3229 | ✓ |
| model.rs | 2924 | 2924 | ✓ |
| hook_install.rs | 2256 | 2256 | ✓ |
| travel.rs | 1108 | 1108 | ✓ |
| territory.rs | 370 | 370 | ✓ |
| migration.rs | 397 | 397 | ✓ |
| codex_rollout.rs | 698 | 698 | ✓ |
| pricing_sync.rs | 1071 | 1071 | ✓ |
| 总计 | 18K | 18051 (22 个 .rs) | ✓ |

生产代码 `unwrap`/`expect`/`panic!`/`unsafe` 扫描：**全部干净**（除 `lib.rs:250` 的 `.expect("error while building Octopus")`，见 P1-1）。所有裸 `unwrap()`/`expect()` 仅出现在 `#[cfg(test)]` 测试夹具中。

---

## 1. 总览：按严重级别统计

| 严重级别 | 数量 | 说明 |
|---|---|---|
| **CRITICAL** | 1 | 退出时不清理子进程 → 孤儿进程 + 无限增长输出文件 |
| **HIGH** | 15 | 含 1 个安全风险（误删用户 hooks）、多个数据丢失/竞态 |
| **MEDIUM** | 26 | 含事务回滚缺陷、时区解析、并发锁缺失等 |
| **LOW** | 39 | 含文档过时、性能浪费、边界条件等 |
| **INFO** | 7 | 验证通过项的注记 |
| **VERIFIED OK** | 48 | 项目方清单中确认无问题的具体担忧 |

**结论**：架构整体稳健（备份 fail-closed、receipt best-effort、AppleScript 注入已正确转义、`unsafe` FFI 为零、Mutex 中毒全部用 `into_inner()` 恢复、`saturating_add` 防溢出）。主要风险集中在 **退出清理**、**并发锁缺失**、**大文件内存**、**duo 模式事件路由**、**SchemaTooNew 过度保守** 五类。

---

## 2. 优先修复清单（Top 12，按影响排序）

| # | 严重 | 路径 | 问题 | 文件:行 |
|---|---|---|---|---|
| 1 | 🔴 CRITICAL | 旅行 | 退出时不 kill 子进程，孤儿 CLI + 输出文件无限增长 | lib.rs:252-263, travel.rs:60 |
| 2 | 🟠 HIGH | Hook | `command_is_ours` 用裸文件名子串（`pretool-hook.js`/`llmpet-hook.js`）判定归属，可误删用户自定义 hooks | hook_install.rs:1504-1520 |
| 3 | 🟠 HIGH | 配置 | `backup_and_reset_config` 不更新内存 Mutex，reset 后任意 `set_*` 会用旧内存覆盖刚写入的默认值 | model.rs:2370-2408 |
| 4 | 🟠 HIGH | 配置 | `backup_and_reset_config` 不持 `config_write_lock`，与并发 `update_config` 竞态可丢失 reset | model.rs:2370-2408 |
| 5 | 🟠 HIGH | 双宠 | duo 模式下 codewhale/opencode/aider 事件被 `eventBelongs` 全部丢弃（只认 claude/codex） | pet-agent-view.js:14-22 |
| 6 | 🟠 HIGH | 双宠 | duo 模式下聚合 cost 在两只宠物上都显示（用户误以为翻倍） | pet-agent-view.js:19-50 |
| 7 | 🟠 HIGH | 双宠 | `set_pet_mode` 切换后不重发 stats，两只宠物渲染旧聚合视图直到下个 hook 事件 | commands.rs:505-520 |
| 8 | 🟠 HIGH | 双宠 | `choose-provider` 事件无 `provider` 字段，duo 下两只宠物同时弹出选择器 | commands.rs:3004-3009 |
| 9 | 🟠 HIGH | Codex | 整文件 `read_to_end`（上限 32MB）+ `String::from_utf8` 整体校验，单字节坏数据丢弃整文件 | codex_rollout.rs:308-309 |
| 10 | 🟠 HIGH | Codex | >32MB 的 rollout 文件被静默跳过，长会话 token 全丢 | codex_rollout.rs:157-161 |
| 11 | 🟠 HIGH | Territory | 巡逻线程无 `catch_unwind`，单次 panic 永久杀死自动巡逻 | territory.rs:104-114 |
| 12 | 🟠 HIGH | Territory | `run_now` IPC 与自动巡逻无互斥，可并发双发 `osascript` + 双 emit | territory.rs:104-151 |

---

## 3. 逐路径详细发现

### 路径 1：启动流程
`lib.rs run()` → `AppState::new()` → `setup_tray()` → `http_server::start()` → `sync_pet_windows()` → `territory::start_auto()` → `pricing_sync::start()`

#### P1-1 [HIGH] `.expect("error while building Octopus")` + `panic = "abort"` 把所有 setup 错误变成硬中止
- 文件: lib.rs:250（根因 lib.rs:61-76, Cargo.toml:51）
- 类别: crash
- 描述: release profile 设 `panic = "abort"`。setup 闭包在 `http_server::StartError::Unavailable` 分支精心构造了错误消息，但 `build()` 返回 Err 时被 line 250 的 `.expect()` 直接 panic，进程立即 abort，Drop 不执行，用户看不到错误消息。
- 触发: 5 个兼容端口全部不可用 / tray 构造失败 / `app.manage` 返回 false。
- 影响: 用户看到 Rust panic 回溯或静默 abort，而非优雅错误对话框。
- 建议: 把 `.expect(...)` 换成对 `build()` 返回值的 `match`，失败时 `eprintln!` + `std::process::exit(1)`。

#### P1-2 [MEDIUM] 重复启动时 pet 窗口闪现（AlreadyRunning 路径）
- 文件: lib.rs:58 + tauri.conf.json:28（`"visible": true`）
- 描述: pet 窗口在 `Builder::build()` 期间就创建并显示（早于 setup）。`AlreadyRunning` 分支 `app.handle().exit(0)` 要等 `app.run()` 事件循环才生效，用户短暂看到 pet 闪现。
- 建议: tauri.conf.json 中 pet 窗口设 `"visible": false`，setup 通过后再 `window.show()`；或在 AlreadyRunning 分支先 hide 所有窗口。

#### P1-3 [MEDIUM] instance_probe 竞态可孤立首个实例
- 文件: http_server.rs:73-76, instance_probe.rs:48-65
- 描述: `bind` 与 `write_runtime_file` 之间无锁。若 A 进程在此间被调度抢占 >300ms（4×75ms），B 进程探测失败、绑定另一端口、覆盖 runtime 文件，A 成孤儿（运行中、占端口、不可发现、tray 杀不掉）。
- 建议: 绑定前先写 runtime 文件（占位），或对 runtime 文件加 `flock` 串行化。

#### P1-4 [LOW] pet-codex 窗口在 single 模式下仍完整加载 webview
- 文件: tauri.conf.json:31-46, commands.rs:23-35
- 描述: `sync_pet_windows` 只 hide/show，从不销毁/延迟创建。single 模式下 pet-codex 渲染器照常跑 JS/CSS/IPC，浪费 ~20-50MB。
- 建议: 用 `WebviewWindowBuilder` 在首次 `set_pet_mode("duo")` 时惰性创建。

#### P1-5 [LOW] `secure_create_dir(&app_dir)` 错误被静默丢弃
- 文件: model.rs:472（`let _ = secure_create_dir(&app_dir);`）
- 建议: 失败时 `eprintln!` 或传播为 `ConfigState::Unreadable`。

#### P1-6 [LOW] `home_dir()` 在 HOME/USERPROFILE 均空时回退到 `current_dir()`
- 文件: model.rs:2058-2063
- 描述: launchd agent 无 `EnvironmentVariables` 时 cwd 不可预测，配置散落各处；且 `instance_probe::default_runtime_path()` 同场景返回 None（不一致）。
- 建议: HOME/USERPROFILE 均空时硬失败并报清晰错误。

#### P1-7 [LOW] `recover_stale_pending_metadata` 无条件覆盖 pending 文件
- 文件: model.rs:2103-2120（每次启动都写 `{"pending":[]}`，即便原本就是空）
- 建议: 仅在 `count > 0` 或文件不存在时写。

#### P1-8 [LOW] http_server accept 循环在持续错误时 CPU 自旋 + 日志洪水
- 文件: http_server.rs:112
- 建议: 连续 N 次 accept 错误后指数退避 `thread::sleep`。

#### P1-9 [LOW] `recover_windows` 中 `ensure_window_visible?` 一个窗口失败则跳过后续
- 文件: platform.rs:308-311
- 建议: `?` 改 `if let Err(...) { log; continue; }`。

#### P1-10 [LOW] `app.manage(server)` 防御性检查在 panic=abort 下变成 abort
- 文件: lib.rs:130-138
- 建议: 改 `let _ = app.manage(server);` 或 `assert!`。

#### P1-11 [LOW] setup_tray 注释过时（tooltip 实际已由 refresh_tray_menu 更新）
- 文件: lib.rs:630-632
- 建议: 更新注释。

#### P1-12 [INFO] 启动时 `panel:price` 双发（pricing_sync::start + lib.rs:167）
- 文件: lib.rs:160 + pricing_sync.rs:99,274
- 建议: 二选一。

#### 已验证无问题
- ✅ runtime Arc clone 借用安全（lib.rs:78-94 NLL 推理正确）
- ✅ migration::import_official_data 首次运行无 panic、不覆盖已有 config（hard_link noclobber）
- ✅ instance_probe TOCTOU 在正常条件下被 4×75ms 重试覆盖
- ✅ pricing_sync::start 同步 publish_status 后 lib.rs:167 的 price emit 不陈旧
- ✅ territory/pricing_sync/http_server 三个 spawn 线程的生产路径零 unwrap/expect/panic
- ✅ setup_tray 失败时 ServerInfo::drop 清理 runtime 文件，端口由 OS 回收

---

### 路径 2：Hook 安装/卸载
`install_provider()` → `backup_config_file()` → `write_install_receipt()` → `cleanup_provider_with_path()`

#### P2-1 [HIGH] `command_is_ours` 用裸文件名子串判定归属 → 可误删用户 hooks ⚠️安全
- 文件: hook_install.rs:1504-1520
- 类别: security / data-loss
- 描述: `command_is_ours` 对每条 JSON hook 的 command 字段做 `String::contains` 匹配 7 个子串，含裸 token `pretool-hook.js`、`llmpet-hook.js`。这两个是无 Octopus 品牌的通用文件名。用户若有一个叫 `pretool-hook.js` 的自定义脚本，`remove_all_ours` 会把它当我们的删掉。
- 触发: 用户 `~/.claude/settings.json` 中有 command 含 `pretool-hook.js` 或 `llmpet-hook.js` 子串的合法 hook。
- 影响: 静默删除用户官方/自定义 hooks——正是 0.5.39 修 `isOurHttp` 想防的那类 bug。
- 建议: 从 `command_is_ours` 移除文件名子串列表，只依赖 `HOOK_OWNER`/`LEGACY_HOOK_OWNER`/`MARKER`/`LEGACY_MARKER` 强归属信号；或把文件名匹配限定到 OpenCode 专用路径。

#### P2-2 [MEDIUM] install/uninstall 无并发锁 → 配置文件 lost-update 竞态
- 文件: hook_install.rs（所有 install_*/uninstall_*_at）+ commands.rs:264-468
- 描述: `Runtime.config_write_lock` 存在但 hook 路径从不获取。两个并发 IPC（如 `set_providers` 与 `uninstall_hooks("all")`）都读同一基线 JSON、各自改、第二个 `write_text_atomic` rename 覆盖第一个。
- 建议: 对每个 provider 配置文件的 read-modify-write 加进程级 `Mutex<()>` 或 `flock`。

#### P2-3 [MEDIUM] Windows `write_text_atomic` 静默忽略 restore 失败 → 可能丢配置
- 文件: hook_install.rs:1858-1874
- 描述: Windows 原子写：rename 原→.bak, rename temp→target, remove .bak。若 temp→target 失败，`let _ = fs::rename(&backup, path);` 丢弃 restore 错误。AV/索引器锁目标时 restore 也失败，用户配置留在 .bak，target 缺失，返回的错误却说"original restored"。
- 建议: 检查 restore rename 结果；失败时把 .bak 路径写进错误消息。

#### P2-4 [MEDIUM] OpenCode/Aider 先备份后才检查归属 → 把第三方文件复制成 octopus-bak
- 文件: hook_install.rs:1258-1276（OpenCode）, 1346-1374（Aider）
- 描述: `install_opencode` 无条件 `backup_config_file(&path, runtime)?`，之后才检查文件是否我们的。若不是我们的，返回 Err——但第三方文件已被复制成 `.*.octopus-bak-*.js`。
- 建议: 把归属检查移到 `backup_config_file` 之前。

#### P2-5 [LOW] `prune_backups` 的 "legacy prefix" 匹配从未存在过的命名
- 文件: hook_install.rs:1103-1142
- 描述: `legacy_prefix = format!(".{stem}.re-llmpet-bak-")`，但真实 legacy 命名是 `.{stem}-re-llmpet-backup-<ts>.<ext>`（连字符 + "backup" 全拼）。此分支是死代码，匹配 0 文件。真正 legacy 清扫只在 `backup_codewhale_config`。
- 建议: 删除该分支并加注释说明 legacy 仅 CodeWhale 有独立清扫。

#### P2-6 [LOW] `drift_signature` 文档声称 `verify_enabled` 用它，实际没有
- 文件: hook_install.rs:1922-1935
- 建议: 更新文档。

#### P2-7 [LOW] 临时文件名 PID+毫秒，同进程同毫秒并发可撞名
- 文件: hook_install.rs:1829-1833
- 描述: `.re-llmpet.{pid}.{ts}.tmp`，同进程线程共享 PID，毫秒精度。两个 IPC 同毫秒写同目录，第二个 `fs::write` 覆盖第一个 temp 内容。
- 建议: 追加线程本地计数器或随机 nonce；或用 `tempfile` crate。（注：model.rs 的 `unique_tmp_path` 已用 UUID v4，无此问题。）

#### P2-8 [LOW] `drift_signature` 分块读无锁 → TOCTOU 撕裂读
- 文件: hook_install.rs:1936-1951
- 描述: 8KB 分块 `file.read().ok()?`，并发写时哈希基于混合版本。中途 IO 错误返回 None，receipt 存 null drift。
- 建议: 用单次 `fs::read`（已限 16MB）减小窗口；彻底修需文件锁。

#### P2-9 [LOW] 卸载成功后 receipt 不删 → 旧 drift 误报
- 文件: hook_install.rs:2049-2086, commands.rs:286-314
- 描述: `CleanupResult::Removed`/`NotFound` 后 receipt 留盘。下次 `uninstall_hooks` 读到旧 receipt，对已不存在的 hook 报 changed/unchanged。
- 建议: 卸载成功时删该 provider 的 receipt，或写 tombstone。

#### P2-10 [LOW] bulk uninstall 中 `read_install_receipts` 每个 provider 调一次 → 5×目录扫描
- 文件: commands.rs:286-288
- 建议: 提到循环外，map 传入 `run_one`。

#### P2-11 [LOW] `read_install_receipts` 的 `split_once('-')` 对含连字符的 provider 名失效
- 文件: hook_install.rs:2065-2070
- 描述: 文件名 `<provider>-<ts>.json`，`split_once('-')` 对未来 `gemini-cli` 会得到 `("gemini","cli-<ts>")`，ts 解析失败静默丢弃。
- 建议: 改 `rsplit_once('-')`。

#### P2-12 [LOW] `prune_backups` 空扩展名时 `ends_with("")` 匹配任意后缀
- 文件: hook_install.rs:1107-1129
- 描述: ext 为空时 suffix=""，`ends_with("")` 恒真。前缀过滤仍正确，但同前缀的 `.tmp`/`.old`/`.swp` 会被当备份删。
- 建议: ext 空时要求时间戳后无任何字符。

#### P2-13 [LOW] `strip_marker_block` 精确匹配 marker 行 → 用户注释误触发
- 文件: hook_install.rs:1777-1807
- 描述: 用户从文档粘贴含 `# >>> octopus:codewhale-hooks:v4 >>>` 的注释，会被当真 marker。无配对 end 时阻塞卸载；有配对时静默删中间内容。
- 建议: marker 检查叠加额外归属信号。

#### P2-14 [LOW] `home_dir()` 回退 cwd（同 P1-6，hook 路径同样受影响）
- 文件: model.rs:2058-2063

#### P2-15 [INFO] `CleanupResult::Changed`/`PathDrift` 声明但从不构造
- 文件: hook_install.rs:186-197
- 建议: 要么在卸载后算 post-signature 构造 Changed，要么删变体。

#### P2-16 [INFO] Aider 是 `.aider.conf.yml` 内的 marker 块，非独立 marker 文件（澄清项目方担忧 #12）

#### 已验证无问题（12 项）
- ✅ `backup_config_file` 全 5 个 install_* fail-closed（`?` 在写之前传播）
- ✅ `write_install_receipt` best-effort（失败仅 log 不传播）
- ✅ 全 5 provider 一致返回 `Unowned`（非 Ok）当文件非我们
- ✅ `uninstall_hooks` drift 在卸载前计算（ordering 正确）
- ✅ `remove_all_ours` 用 `retain` 保留 foreign hooks（风险在 matcher 误报，见 P2-1）
- ✅ 全 5 install 函数把 `backup_path` 传入 receipt
- ✅ 0.5.39 `isOurHttp` 修复在 Rust + Node 两侧均存在且完整
- ✅ CodeWhale legacy 清扫匹配真实 legacy 模式 `-re-llmpet-backup-`
- ✅ hook_install.rs 生产代码零 panic/unsafe/unwrap
- ✅ bulk uninstall 聚合正确、单 provider 失败不阻塞其他
- ✅ `backup_config_file` 空/非空扩展名均处理
- ✅ 畸形用户 config 中止 install（不 clobber）

---

### 路径 3：配置流程
`load_config()` → `ConfigState` → `save_config()` → `backup_and_reset_config()`

#### P3-1 [HIGH] `backup_and_reset_config` 不更新内存 Mutex → reset 后任意 set_* 覆盖默认值
- 文件: model.rs:2370-2408
- 类别: correctness / data-loss
- 描述: `save_config_unchecked` 写默认值到磁盘、`config_state` 翻 Healthy 后，`Runtime.config` Mutex 仍持启动时加载的旧 `AppConfig`。命令消息让用户"重启重载"，但重启前任何 `set_*`（含拖拽触发的 `commit_win_pos`）会 `update_config` 用旧内存快照+改动覆盖刚写入的默认值。
- 触发: reset 后、重启前调用任何配置变更。
- 影响: reset 不可靠；默认值被旧内存覆盖。唯一恢复是再 reset + 立即重启且不碰任何配置。
- 建议: reset 成功后 `*self.config.lock() = AppConfig::default()`，并从命令 `emit_config`。

#### P3-2 [HIGH] `backup_and_reset_config` 不持 `config_write_lock` → 与并发 update_config 竞态
- 文件: model.rs:2370-2408
- 描述: 其他所有写者（`update_config` model.rs:703-706）持 `config_write_lock` 贯穿 snapshot→mutate→save→commit。reset 路径直接调 `save_config_unchecked`，无协调。并发时 update_config 的 rename 可落在 reset rename 之后，磁盘=旧配置突变，但 `config_state=Healthy` 且告诉用户"reset 成功"。
- 建议: reset 顶部获取 `config_write_lock`，贯穿 backup+default-write+state-commit。

#### P3-3 [MEDIUM] `backup_and_reset_config` 命令不 emit `pet:config`/`panel:config`
- 文件: commands.rs:96-116
- 描述: 其他所有配置变更器都以 `emit_config` 结尾，reset 没有。UI 缓存的旧配置（lang/skin/providers）直到手动刷新或重启才更新。
- 建议: reset 成功后 `emit_config(&app, &state)`。

#### P3-4 [MEDIUM] 无 Healthy 守卫 → 可对健康配置调 reset
- 文件: commands.rs:96-116
- 描述: 命令无条件执行，UI 只在 quarantined 时显示按钮，但 IPC 可直接调。对 Healthy 配置 reset 会备份好配置并替换默认值，叠加 P3-1 后 reset 看似成功实则无效。
- 建议: 命令顶部检查 `config_state().is_quarantined()`，否则拒绝。

#### P3-5 [MEDIUM] SchemaTooNew 隔离过严 → 降级后所有写（含 commit_win_pos）全失败
- 文件: model.rs:2266-2277, 439-441, commands.rs:953-977
- 描述: `schema_version > CURRENT(2)` 时 `writes_allowed()` 对所有 save 返回 false。`commit_win_pos`（每次拖拽）、`set_language`、`toggle_mute` 全失败。唯一恢复是 reset（丢未来字段）或重新升级。但 `extras` Map 已能保留未知字段——隔离过于保守。
- 触发: 用户跑 0.6.0(schema 3) 后降级到 0.5.46(schema 2)。
- 影响: 只读状态；宠物位置不存；所有 toggle 报错。
- 建议: (a) 放宽 SchemaTooNew 允许写（extras 已保未来字段，降级非破坏性）；或 (b) 加 `migrate_schema` 把 schema_version 降回 CURRENT 同时保留 extras；或 (c) 至少对 `commit_win_pos` 放行位置写。

#### P3-6 [LOW] schema_version 内存升级但不落盘直到下次配置变更
- 文件: model.rs:179-181（sanitize）, 2174-2292（load_config）
- 描述: 旧 config 加载时 `sanitize()` 内存里把 schema_version 设为 CURRENT，但 `load_config` 不回写磁盘。磁盘保持 0 直到首次 save。每次重启重复迁移。
- 建议: load_config 返回 Healthy 且 `schema_version < CURRENT` 时回写一次。

#### P3-7 [LOW] extras Map 原样暴露给渲染层（潜在密钥泄漏）
- 文件: model.rs:650-676（config_view 序列化含 extras）, commands.rs:55-57（get_config 直返）
- 描述: 若 config.json 含 `"apiKey":"sk-..."` 等未知顶层键，进 extras，发给 WebView。渲染层可能 log/展示/XSS 泄漏。
- 建议: `config_view` 序列化后剥离 extras，或白名单已知安全键。

#### P3-8 [LOW] extras flatten + camelCase 对 snake_case 输入产生键重复
- 文件: model.rs:28-77
- 描述: 用户手编 `schema_version`（snake），serde 不认（期望 `schemaVersion`），落入 extras。save 时同时发 `schemaVersion`（字段默认）和 `schema_version`（extras），文件膨胀且用户意图被忽略。
- 建议: 文档要求 camelCase，或加 `#[serde(alias = "schema_version")]`。

#### P3-9 [LOW] `persist_pending_metadata` 快照-写竞态（无文件写锁）
- 文件: model.rs:1180-1203
- 描述: 只持 `pending` Mutex 读 entries 就释放，之后 `write_private_json_atomic` 无锁。两个并发 `finish_permission` 都快照、都写，旧快照 rename 落最后可复活已决权限。
- 影响: 内存 HashMap 是真相，启动时 `recover_stale_pending_metadata` 清理；文件瞬时不一致。
- 建议: 持 `pending` Mutex 贯穿文件写，或加 `pending_write_lock`。

#### P3-10 [LOW] `backup_and_reset_config` 的 `fs::copy` 失败留半截 backup
- 文件: model.rs:2381-2388
- 建议: 错误路径 `fs::remove_file(&bp)`。

#### P3-11 [LOW] `set_mode` 丢弃 update_config 返回值再重读（TOCTOU 窗口）
- 文件: commands.rs:232-241
- 描述: `update_config(|c| c.mode = mode)?` 的 Ok 值被 `?` 丢弃，再 `config()` 重读。对比 `set_pet_mode`（514-517）正确捕获返回值。
- 建议: 用返回值喂 `sync_pet_windows`。

#### P3-12 [LOW] `update_config` 在检查 writes_allowed 前先跑闭包（浪费 + 副作用隐患）
- 文件: model.rs:703-731
- 建议: 顶部先查 `writes_allowed()` 提前返回。

#### 已验证无问题（10 项）
- ✅ ConfigState 隔离在 `save_config` 统一执行（所有变更器走 `update_config`）
- ✅ `update_config` copy-on-write 事务（snapshot→mutate→save→commit，`config_write_lock` 串行化）
- ✅ Mutex 中毒全部 `into_inner()` 恢复（debug 下也安全）
- ✅ `save_config_unchecked` 原子写（UUID v4 temp + 0o600 + windows_safe_rename 带 restore）
- ✅ `load_config` 错误路径从不覆盖磁盘，保留 corrupt 文件供恢复；拒符号链接；TOCTOU 用 `same_opened_config_file` 检测
- ✅ `backup_and_reset_config` backup 在 default-write 之前，失败回滚 state
- ✅ extras 正确 round-trip 未知字段
- ✅ 生产代码零 unwrap/expect/panic（仅测试模块有）
- ✅ `update_config` 无死锁（config 写锁 + config 锁 + config_state 锁无嵌套阻塞 IO）
- ✅ `sanitize` 用 `is_finite`/`<`/`.min`/`.clamp`，无 f64 `==` 陷阱；`stats()` 快照可接受撕裂

---

### 路径 4：双宠流程
`set_pet_mode()` → `sync_pet_windows()` → `pet-agent-view.js eventBelongs()` → `filterStats()`

#### P4-1 [HIGH] duo 模式静默丢弃 codewhale/opencode/aider 事件和会话
- 文件: pet-agent-view.js:14-22, model.rs:1377
- 类别: correctness / data-loss
- 描述: `eventBelongs()` 做 `petMode !== 'duo' || !provider || provider === agent`，`agent` 只能是 `'claude'`/`'codex'`（`currentAgent()` 4-12）。`filterStats` 同理 `(row.providerId || 'claude') === agent`。codewhale/opencode/aider 的事件在 duo 下两边都不认，被 `eventBelongsToThisPet`（pet.js:1435）丢弃，会话行也从列表消失。
- 触发: 启用 claude/codex 以外的 provider 并切 duo。
- 影响: duo 下这些 provider 活动完全不可见（single 下正常）——看起来"宠物没反应了"。
- 建议: 把 `agent==='claude'` 当聚合桶（任何非 codex 的都归 claude）：`provider === agent || (agent === 'claude' && provider !== 'codex')`，filterStats 对称处理。

#### P4-2 [HIGH] `choose-provider` 事件在 duo 下两只宠物都弹选择器
- 文件: commands.rs:3004-3009（emit 无 provider 字段）, pet.js:1522-1529
- 描述: `primary_action` emit `{"kind":"choose-provider",...}` 无 `provider`。`eventBelongs` 返回 `!provider || …` → duo 下两只都 `true`，同时 `openProviderChooser()`。single 下因 pet-codex 隐藏而掩盖。
- 影响: 两个选择器同时开；两个窗口都 resize；点一个不关另一个。
- 建议: emit 时盖 `provider` 字段，或用 `emit_to(window_label, …)` 定向。

#### P4-3 [HIGH] `set_pet_mode` 切换后不重发 stats → 旧聚合视图滞留到下个 hook
- 文件: commands.rs:505-520, pet.js:1771-1810
- 描述: `set_pet_mode` 只 emit `pet:config`。`applyConfigSnapshot` 更新 `petMode` 但不重滤 `lastStats`。直到下个 `pet:stats`（由 hook 事件触发）才刷新，两只宠物都渲染旧视图。
- 建议: `set_pet_mode` 在 `emit_config` 后调 `emit_stats_now(&app, &state.runtime)`（helper 已存在）。

#### P4-4 [HIGH] duo 下聚合 cost 在两只宠物都显示（误导性翻倍）
- 文件: pet-agent-view.js:19-50（filterStats 的 `...snapshot` 透传 today/window5h/codexUsage）
- 描述: `filterStats` 返回 `{...snapshot, sessions, active, …}`，`today.cost`/`window5h.cost`/`codexUsage`/`codexLimits` 透传不变。两只宠物显示相同总成本，用户以为翻倍；budget 警告双触发。
- 建议: duo 下按 provider 切分 `today`/`window5h`（从 sessions 重算，或后端 stats() 发 `todayByProvider` map）。

#### P4-5 [MEDIUM] `pet:window-blur` 广播 → 一只宠物失焦会关另一只的临时 UI
- 文件: lib.rs:190-194（broadcast emit）, pet.js:2417-2419
- 描述: Tauri 2 的 `WebviewWindow::emit` 广播所有 webview。任一 pet 窗口 `Focused(false)` 时两只都收 `pet:window-blur`，都 `dismissTransientUi`。
- 触发: duo 下 pet-codex 开着径向菜单，点 pet(Claude) → pet-codex 失焦 emit blur → 两只都关菜单。
- 建议: 用 `window.emit_to(window.label(), "pet:window-blur", ())` 定向。

#### P4-6 [MEDIUM] single 模式下隐藏的 pet-codex 渲染器照常处理事件 + 播放音频
- 文件: commands.rs:23-35（只 hide 不 destroy）, pet.js:1434-1537, pet-agent-view.js:14-17
- 描述: single 下 pet-codex 隐藏但渲染器跑着。`eventBelongsToThisPet` 在 single 下恒 true，`SOUND.done()`/`confetti()`/`scheduleIdleAction()` 照跑。音频从隐藏窗口播放（双重播放）。
- 建议: 监听 `document.visibilitychange` 或 `pet:window-hidden/shown`，隐藏时 gate 音频/动画。

#### P4-7 [MEDIUM] pet-codex 首次无保存位置 → OS 默认常与 pet 重叠
- 文件: lib.rs:110-118, model.rs:94-95, tauri.conf.json:30-46
- 描述: 首次 duo 运行 `pet_position_codex=None`，pet-codex 留在 OS 默认（多从 pet 级联），两只叠一起。
- 建议: `sync_pet_windows` 在 duo 首秀且 `pet_position_codex=None` 时给 pet 位置 +340px 偏移。

#### P4-8 [MEDIUM] `set_pet_mode` 显示 pet-codex 时不重应用保存位置
- 文件: commands.rs:505-520
- 描述: `sync_pet_windows` 只 `show()`，不 `set_position`。位置恢复只在启动 lib.rs:110-118。隐藏期间 OS 可能移动窗口（拔显示器/DPI 变），重现时在 stale 隐藏位置。
- 建议: `sync_pet_windows` 显示时重应用保存位置。

#### P4-9 [MEDIUM] tray "show"/左键只 focus pet，从不 focus pet-codex
- 文件: lib.rs:636-641, 741-755
- 建议: duo 下也 `set_focus` pet-codex。

#### P4-10 [MEDIUM] pet-codex 收全聚合 `pet:stats`，filterStats 无法切分 codexUsage/codexLimits
- 文件: http_server.rs:637-638（broadcast）, model.rs:1507-1515, pet-agent-view.js:19-50
- 描述: 每条 `pet:stats` 全局广播，靠 filterStats 切分。但 `codexUsage`/`codexLimits` 是 Codex 专属，经 `...snapshot` 透传给两只。pet(Claude) 也显示 Codex token/限额。
- 建议: 把 codexUsage/codexLimits 移到 `codex` 子对象，或 filterStats 在 `agent!=='codex'` 时剥离。

#### P4-11 [LOW] 跨显示器位置恢复用窗口当前 scale 而非目标显示器 scale
- 文件: lib.rs:110-118, commands.rs:935-978
- 描述: 位置存逻辑像素，恢复时乘 `window.scale_factor()`——但该值是窗口**当前**显示器（OS 创建时放的）的 scale，不是目标显示器的。pet 存在 2x 显示器但 OS 启动放 1x 显示器时算错。
- 建议: `set_position` 后重读新显示器 scale 再调；或存物理像素+源显示器 scale。

#### P4-12 [LOW] `filterStats` 用首个排序会话的 idle 覆盖聚合 idle
- 文件: pet-agent-view.js:25, 48 vs model.rs:1497
- 描述: 后端 `idleMs = now - max(updated_at)` 跨所有会话。filterStats 用 `latest.idleMs`（最高优先级会话的 idle）。当最高优先级会话比其他同 agent 会话旧时，pet 显示更大 idle，可能误判睡眠。
- 建议: `Math.min(...sessions.map(s => s.idleMs))`。

#### P4-13 [LOW] `pet:travel` completed/failed 无 provider 字段 → duo 下两只都显示完成
- 文件: travel.rs:376-396, pet-agent-view.js:15
- 建议: 每条 `pet:travel` emit 都盖 provider。

#### P4-14 [LOW] `currentPetAgent()` 双重检测（URL query + window label fallback）脆弱
- 文件: tauri-bridge.js:26-35, pet-agent-view.js:4-12
- 建议: 统一一个来源（URL query），删 label fallback。

#### 已验证无问题（5 项）
- ✅ `pet-codex` 标签拼写一致（全用连字符）
- ✅ `agent`/`provider` 字段大小写一致（后端 normalize 小写）
- ✅ config 字段名 round-trip 一致（petMode/petPositionCodex/skinCodex）
- ✅ `commit_win_pos` 按 agent 路由到正确 config 字段
- ✅ `pet:stats` 广播 + 每窗口 `__revision` 守卫无双计 revision

---

### 路径 5：旅行流程
`start_travel()` → `start_wander()` → `cancel_travel()` → `travel.snapshot()`

#### P5-1 [CRITICAL] 退出时不清理子进程 → 孤儿 CLI + 输出文件无限增长
- 文件: lib.rs:252-263（ExitRequested 不调 travel.cancel）, travel.rs:60-66（TravelManager 无 Drop）, :267（child_pid 存了但退出时不用）
- 类别: resource-leak / data-loss
- 描述: `RunEvent::ExitRequested` 只 hide tray + log。Unix 上子进程用 `process_group(0)`（travel.rs:719）spawn，父退出后被 reparent 成孤儿；Windows 无 Job Object，`claude.exe`/`codex.exe` 同样存活。worker `thread::spawn`（:236）被进程退出强杀，其清理（清 child_pid、删 `.travel-*.out`/`.err`）永不执行。孤儿继续写输出文件，无限增长直到磁盘满。
- 触发: 旅行/闲逛进行中用户退出（tray quit 或 OS 关机）。
- 影响: 孤儿进程耗 CPU/内存/网络；`~/.re-llmpet/.travel-{uuid}.out/.err` 无限增长；下次启动 travel.json 恢复标"interrupted"但不杀仍跑的孤儿、不删输出文件。
- 建议: `RunEvent::ExitRequested` 调 `state.runtime.travel.shutdown()`：load child_pid → `kill_process_tree(pid)` → set cancel → join worker（短超时）。Windows 用 Job Object + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。

#### P5-2 [HIGH] `cancel_travel` 不直接杀子进程 → 50ms 轮询延迟 + 退出竞态
- 文件: travel.rs:399-410（cancel）, :301-319（worker 轮询）
- 描述: `cancel()` 只 set AtomicBool 立即返回。实际 `kill_process_tree(pid)` 在 worker 50ms 轮询里。若 app 在 50ms 窗口内退出（或 worker 被调度开），子进程永不杀——叠加 P5-1。
- 建议: `cancel()` set flag 后直接读 child_pid 调 `kill_process_tree`（幂等，worker 后续调得 ESRCH 当成功）。

#### P5-3 [HIGH] 旧 trip 的 `cancelled` emit 可在新 trip 的 `started` emit 之后到达
- 文件: travel.rs:368-396, 203-240
- 描述: worker 尾部 set `active=None`（368）→ persist → emit `cancelled`（376）。在 368 与 376 之间，并发 `start_travel` 可获锁见 None、设新 trip、emit `started`、spawn 新 worker。旧 worker 随后 emit `cancelled`，但 snapshot（375）此时显示 `active=Some(新trip)`。渲染层在新 trip 上显示"🧳 旅行已取消"气泡 2.6s。
- 建议: emit `cancelled` 前先在 payload 盖 trip.id，渲染层忽略 trip.id 不匹配的终态事件；或先 emit 再 set None。

#### P5-4 [MEDIUM] worker 线程无 `catch_unwind` → panic 让 trip 永卡 "traveling"
- 文件: travel.rs:236-238
- 描述: `run_trip` 裸 `thread::spawn`，无 catch_unwind。内部闭包返回 Result 可捕获，但尾部代码（mutex 用 into_inner 安全）若任一 panic（如 `Vec::with_capacity` OOM、未来加的 unwrap），线程静默死。`active` 永远 Some，`child_pid` 永远 Some，新 trip 起不来（204 拒绝），`cancel()` 返 Ok 但无人处理 flag。
- 建议: `catch_unwind` 包裹 run_trip body，Err 时 set active=None、child_pid=None、持久化 failed postcard、emit `pet:travel failed`。

#### P5-5 [MEDIUM] `child.wait()` 在 kill 失败时可能永远阻塞
- 文件: travel.rs:310-318, 289-299
- 描述: cancel/超时路径若 `kill_process_tree(pid)` 返 Err，调 `child.kill()`（`let _ =`）再 `child.wait()`（`let _ =`）。若 kill 因 EPERM 失败（setuid 子进程/sandbox），wait 永久阻塞，worker 挂死。
- 建议: `child.wait_timeout(Duration::from_secs(2))`（Unix）/ Windows 轮询 `try_wait` 带截止。

#### P5-6 [MEDIUM] Windows `write_private_atomic` 崩溃窗口期 travel.json 缺失 → 历史全丢
- 文件: travel.rs:642-655
- 描述: Windows 原子写：rename path→.bak, rename temp→path, remove .bak。崩溃在 step1-2 之间 → travel.json 不存在，.bak 持最后好状态。下次启动 `load_persisted` 对 NotFound 返 default，**从不查 .bak**。所有明信片/growth/计数全丢。
- 建议: `load_persisted` 在 path NotFound 时查 `path.with_extension("json.bak")`。（model.rs:2020 的 windows_safe_rename 同模式同漏洞，建议抽共享 helper。）

#### P5-7 [MEDIUM] `child.kill()` fallback 只杀直系子进程，不杀进程组后代
- 文件: travel.rs:311-313, 290-292, commands.rs:2379-2422
- 描述: `kill_process_tree` 失败时 fallback `child.kill()` 只 SIGKILL 直系 PID，不信号负 PGID。孙进程（claude spawn 的 node/shell）成孤儿。
- 建议: fallback 先用 `signal_process_group(-pid, 9)` 重试，再 `child.kill()`。

#### P5-8 [LOW] growth 仅 trip 完成时持久化 → 中途崩溃丢全部已积 tokens
- 文件: travel.rs:343-367（tokens 仅末尾加）, 331（exit 后才算）
- 建议: 若 CLI 增量发 usage 事件（claude --output-format json 会），轮询里周期持久化部分 tokens。

#### P5-9 [LOW] 失败/取消 trip 一律 0 growth（哪怕跑了 29 分钟产出 50k tokens）
- 文件: travel.rs:338-342, 345
- 建议: 失败路径仍调 `usage_tokens(&output, &trip.provider)`；取消路径解析 kill 前的输出。

#### P5-10 [LOW] cancel 与自然完成竞态：cancel 已请求但报 completed/failed
- 文件: travel.rs:285-320
- 描述: 轮询先 `try_wait()`（286）后查 `self.cancel`（301）。子进程在两次 try_wait 间自然退出 → 报 completed/failed，cancel flag 被下次 start 静默重置。
- 建议: `try_wait` 返 Some(status) 后先查 cancel flag，true 则报 cancelled。

#### P5-11 [LOW] `output_exceeded` 50ms 检查间文件可长远超 2MB
- 文件: travel.rs:748-755, 305, 319
- 建议: 用有界 pipe + reader 线程（如 commands.rs:1732-1740 的 `drain_bounded`）替代写无界文件。

#### P5-12 [LOW] `now_ms()` 用 SystemTime（非单调）→ 时钟跳变致 postcard 时间戳倒退
- 文件: model.rs:2000-2007, travel.rs:214, 360
- 描述: 30 分钟超时用 `Instant::now()`（单调，安全）。但 `started_at`/`completed_at` 用 SystemTime，NTP 跳变/DST 可致 completed_at < started_at。
- 建议: 存 SystemTime（显示）+ Instant 派生 duration（准确）。

#### P5-13 [LOW] `start()` spawn worker 后才 snapshot → 微观竞态可显示 stale
- 文件: travel.rs:236-239
- 建议: spawn 前先 snapshot。

#### 已验证无问题（8 项）
- ✅ `cancel_travel` 幂等（set true 两次 no-op，无计数器递减/双 emit）
- ✅ `start_travel` 进行中再调返 Err（锁内检查，不排队/不替换/不杀旧）
- ✅ wander 与 travel 互斥（共用 `self.active`）
- ✅ 无 shell 注入（mission 走 stdin 非参数，args 全静态，`clean_text` 剥控制字符）
- ✅ travel.json 读容忍畸形（拒符号链接、4MB 上限、TOCTOU `same_opened_file` 检测、解析失败返 default）
- ✅ travel.json 写原子（Unix `fs::rename`；0o600 权限）
- ✅ Mutex 中毒全 `into_inner()` 恢复
- ✅ growth 溢出安全（全 `saturating_add`，u64 实际不可达上限）

---

### 路径 6：Codex rollout
`codex_rollout::snapshot()` → `stats()`

#### P6-1 [HIGH] 整文件 `read_to_end` 加载进内存（上限 32MB）→ 大文件 OOM/UI 卡顿
- 文件: codex_rollout.rs:308, 442-445
- 类别: resource-leak / OOM
- 描述: `read_regular_file_bounded` 做 `file.take(max_bytes+1).read_to_end(&mut bytes)`，整个文件（上限 32MB）进 `Vec<u8>`。再 `String::from_utf8(bytes)`（309）若非 UTF-8 可能再分配 32MB。峰值 ~64MB/文件。`stats()` 同步在 UI hook 路径。
- 影响: 大文件 stats() 重解析时内存尖峰/UI 卡顿，内存紧张机可能 OOM。
- 建议: 改 `BufReader<File>` + `read_until(b'\n')` + 每行 `serde_json::from_slice`，内存上限一行。可去掉 32MB 文件上限。

#### P6-2 [HIGH] 单个无效 UTF-8 字节丢弃整个 rollout 文件
- 文件: codex_rollout.rs:309
- 描述: `String::from_utf8(bytes).map_err(...)?` 32MB 内任一字节非 UTF-8 就整文件 Err，调用方丢该文件全部 token 数据。
- 建议: 逐字节行迭代 + `from_slice`，serde 接受 `&[u8]`，只跳坏行。

#### P6-3 [HIGH] >32MB 文件静默跳过 → 长会话 token 全丢
- 文件: codex_rollout.rs:157-161, 433-435
- 描述: `MAX_ROLLOUT_BYTES=32MB`，超限文件移出缓存计 `skippedLarge`。重度用户单长会话轻松超 32MB，整会话 token 消失，仅 `skippedLargeFiles` 计数器可查。
- 建议: 改流式读后可把上限提到 256MB 或去除。

#### P6-4 [MEDIUM] ISO 时间戳时区偏移被忽略 → 非 UTC 用户日期分桶错误
- 文件: codex_rollout.rs:543-611
- 描述: `parse_iso_to_unix` 只校验 0-18 字节按 UTC 算秒，从不看时区后缀。`2026-08-04T23:30:00+02:00` 被当 `23:30 UTC`，`local_day_key` 再转本地 → 进错日期。
- 建议: 用 `chrono::DateTime::parse_from_rfc3339`（metering.rs:1163 已用），处理所有 ISO-8601 时区变体。

#### P6-5 [MEDIUM] 数字时间戳（Unix 秒/毫秒）不处理 → tokens 进 1970-01-01 桶
- 文件: codex_rollout.rs:340-344
- 描述: `parsed.get("timestamp").and_then(Value::as_str)` 对 JSON 数字返 None，`timestamp_ms` 默认 0。`local_day_key(0)` 进 1970 桶，`today` 永远 0；`latest_limits` 比较非确定。
- 建议: `as_str` 失败后试 `as_u64`/`as_i64`，>1e12 当毫秒，>1e9 当秒。

#### P6-6 [MEDIUM] resumed 会话可双计 lifetime tokens
- 文件: codex_rollout.rs:356-377
- 描述: `previous_cumulative` 每文件重置（311）。Codex resume 新建 rollout 文件且 cumulative 重启时，`delta_from` 当新会话累加。`last_token_usage` 路径（366-369）可避，但缺失时双计。session ID HashSet（219-221）只去重 `sessions.len()`，token 总量跨文件累加。
- 建议: `previous_cumulative` 按 session ID 跨文件存 `HashMap<String, UsageTotals>`。

#### P6-7 [MEDIUM] 全局 `CACHE` Mutex 在所有文件 IO 期间持有 → 阻塞并发 stats()
- 文件: codex_rollout.rs:115-116, 259
- 描述: cache 锁贯穿 snapshot() 全程：目录走、所有 metadata、所有 open+read_to_end、所有 JSON 解析、聚合。两个 stats() 调用串行。3 秒 TTL 缓解命中，miss 时秒级阻塞。
- 建议: 锁内只收集路径，drop 锁后解析，再锁合并。

#### P6-8 [MEDIUM] Codex rollout 用量无 `window5h`（5 小时滚动窗口）
- 文件: codex_rollout.rs:236-255
- 描述: `codexUsage` 只有 `today`/`lifetime`，metering 有 `window5h` 但 rollout 无对应。FileSummary 只存每日桶 `daily: BTreeMap`，无事件级时间戳。
- 建议: 加 hourly 桶 map 支持 window5h，或文档说明 codexUsage 故意省略。

#### P6-9 [LOW] 跨文件 "latest" rate-limit 在时间戳相等/为 0 时非确定
- 文件: codex_rollout.rs:213-233（HashMap 随机序，`>=` 放大非确定）
- 建议: 改 `>`，并按 session_id/path 排序迭代。

#### P6-10 [LOW] `parse_rollout_file` 错误上下文被丢弃 → 无日志
- 文件: codex_rollout.rs:192-195
- 建议: `tracing::warn!` 带 path + error。

#### P6-11 [LOW] `parse_iso_to_unix` O(year) 每时间戳 → 最坏 8030 次迭代
- 文件: codex_rollout.rs:589-604
- 建议: 预算查找表或 `chrono::NaiveDateTime`（O(1)）。

#### P6-12 [LOW] Windows `same_opened_file` 只比文件长度 → 同长度替换检测不到
- 文件: codex_rollout.rs:458-461
- 建议: Windows 用 `GetFileInformationByHandle` 比 volume serial + file index。

#### P6-13 [LOW] `usedPercent`/`secondaryUsedPercent` 不 clamp → 负值/>100 泄漏 UI
- 文件: codex_rollout.rs:416-426
- 建议: `.map(|v| v.clamp(0.0, 100.0))`。

#### P6-14 [INFO] `read_regular_file_bounded` 双重 size 检查（防御冗余，无害）

#### 已验证无问题（8 项）
- ✅ 所有 token 累加用 `saturating_add`，无 u64 溢出
- ✅ 畸形 JSON 行跳过不致命（`continue`，不污染文件/其他文件）
- ✅ 目录走跳符号链接（防循环）
- ✅ Mutex 中毒 `into_inner()` 恢复
- ✅ 并发文件增长处理（`take(max+1)` 限读，超限拒）
- ✅ 缓存失效稳健（len+mtime+dev+ino 身份 + 3 秒 TTL）
- ✅ session 发现可配（`CODEX_HOME`，深度 4，上限 8000 条目，按文件名降序）
- ✅ snapshot 输出无绝对路径泄漏（session_id fallback 仅内部 HashSet key）

---

### 路径 7：Territory macOS
`territory::start_auto()` → `run_now()` → `macos_patrol()`

#### P7-1 [HIGH] IPC `run_now` 与自动巡逻线程无互斥 → 并发双发
- 文件: territory.rs:104-114, 116-151, commands.rs:758,774
- 类别: race / correctness
- 描述: `start_auto` spawn detached 线程每 15s 调 `run_now`→`macos_patrol`。IPC `territory_run_now`/`territory_toggle_auto` 也直接调 `run_now`。territory.rs 全文无 Mutex/AtomicBool "patrol-in-progress" 守卫。两个巡逻可并发。
- 影响: 两个 osascript 枚举进程同时跑；双 emit `spotted`/`victory`/`defeat`；两个都算移动目标并各发 set position，第二个覆盖第一个。
- 建议: `PlatformState` 加 `patrol_busy: AtomicBool`，`run_now` 做 `compare_exchange(false→true)`，已忙则返 `{"deferred":true}`。Drop guard 清零防 panic 卡死。

#### P7-2 [HIGH] 巡逻线程无 `catch_unwind` → 单次 panic 永久杀自动巡逻
- 文件: territory.rs:104-114
- 描述: 循环体 `sleep; if !territory || is_ui_busy { continue; } if let Err(e) = run_now(...) { log }`。`run_now` 返 Result 捕获预期错误，但 `macos_patrol` 调 Tauri API（`get_webview_window`/`available_monitors`/`emit`）和 `serde_json::json!`，任一 panic（如显示器重配时 Tauri 内部 panic）会 unwind `thread::spawn` 闭包，线程静默死。无 catch_unwind，无监督重启。
- 影响: 自动巡逻静默永久停止，config 仍 `territory=true`，toggle 显示"开"，但无任何反应。仅重启恢复。
- 建议: `catch_unwind(AssertUnwindSafe(|| patrol_once(...)))` 包裹，Err 时 log；连 N 次 panic emit `pet:event` phase=`faulted`。

#### P7-3 [MEDIUM] 巡逻错误无退避 → 辅助功能被拒的 Mac 每 15s 永久 spawn osascript
- 文件: territory.rs:106-113
- 描述: 固定 15s sleep 后无条件 `run_now`。`macos_patrol` 返 Err（如"需辅助功能权限"）只 log，15s 后再来。无指数退避、无连续失败计数、无自动禁用。
- 影响: 笔记本上永久 ~15s 唤醒 spawn 子进程 + 读 stderr + 写日志，电池消耗 + 日志增长；用户无 UI 信号。
- 建议: 跟踪 `consecutive_failures`，sleep `min(15*2^failures, 600)`s；5 次后 emit `pet:event` phase=`permission-required`。

#### P7-4 [MEDIUM] 固定 15s 间隔不可配；每次巡逻最多 spawn 13 个 osascript
- 文件: territory.rs:106, 182-185, 266-270
- 描述: `thread::sleep(Duration::from_secs(15))` 硬编码。每次 `macos_patrol` 一个枚举 osascript + 最多 12 个移动 osascript（`detected >= 12` 上限）。多个对手宠物时 ~52 spawn/min。
- 建议: `AppConfig` 加 `territory_interval_secs`（默认 15，clamp 5..=3600）；把多对手移动合并成单 AppleScript 多语句。

#### P7-5 [MEDIUM] 辅助功能检查是反应式（stderr grep）而非主动（`AXIsProcessTrusted`）
- 文件: territory.rs:186-198
- 描述: spawn osascript 后检查 stderr 含 "not authorized"/"assistive"。未调 `AXIsProcessTrusted()`（可弹系统对话框）。字符串匹配，macOS 改措辞则降级为 stderr dump。友好消息只进 log，从不 emit `pet:event`，渲染层无法提示。
- 建议: 加 `extern "C" { fn AXIsProcessTrusted() -> bool; }` 顶部检查，false 时 emit `permission-required` 提早返回。

#### P7-6 [MEDIUM] 巡逻线程 detached 且未命名；osascript 子进程退出时可孤儿
- 文件: territory.rs:104-114
- 描述: `thread::spawn(move || loop {...})` 无 JoinHandle、无 `thread::Builder::name(...)`（对比 platform.rs:94-95 正确命名）。crash log 难定位。退出时 osascript 子进程 mid-exec 可孤儿。
- 建议: `thread::Builder::new().name("octopus-territory".into()).spawn(...)`；存 JoinHandle/shutdown flag；`Command::new("osascript").kill_on_drop(true)`。

#### P7-7 [LOW] 移动脚本 `application process "<name>"` → 同名重复进程移错窗口
- 文件: territory.rs:262-265
- 描述: System Events 按名匹配首个进程。枚举脚本遍历 `background only is false` 的进程无序保证。两个同名进程时移动脚本可能定到另一个。
- 建议: 枚举时捕 `unix id`，按 pid 定位。

#### P7-8 [LOW] 枚举与每窗口移动之间 TOCTOU
- 文件: territory.rs:182-185, 266-270
- 描述: 枚举返回快照，移动逐个发 osascript。窗口在期间关/开/重排，`winIndex` 可指向不同窗口。
- 建议: 单 AppleScript 事务内枚举+移动。

#### P7-9 [LOW] 自定义对手要求精确进程名匹配（与内置 substring 不一致）
- 文件: territory.rs:82-87, 242
- 描述: `is_rival_process` 对 `DEFAULT_RIVALS` 用 `contains`，对 `custom_rivals` 用 `==`（测试 351-356 明确断言）。用户加 `"vscode"` 不匹配实际进程名 `"Code"`。
- 建议: 自定义也 substring，或文档说明 + 支持 `~` 前缀 opt-in substring。

#### P7-10 [LOW] pet 模式为 hidePet 时仍巡逻并移动对手窗口
- 文件: territory.rs:107, 121-125
- 描述: `start_auto` 检查 `territory` 和 `is_ui_busy`，不查 `config.mode`。hidePet 下 `run_now` 设 `should_show=false`（不显宠物）但仍跑 `macos_patrol`，对手窗口被无形之手挪动。
- 建议: skip 条件加 `|| config.mode == "hidePet"`。

#### P7-11 [LOW] `contains("octopus") || contains("re-llmpet")` 自跳过脆弱
- 文件: territory.rs:239-241
- 描述: 子串匹配硬编码名。fork 改名则自推自己窗口；含"octopus"的无关应用（OctopusDeploy/OctoPrint）被静默跳过。
- 建议: 按 `std::process::id()` + `unix id of proc` 自识别，或按 bundle identifier。

#### P7-12 [INFO] `take(500)` 行上限和 `detected >= 12` 每巡逻上限是合理 DOS 守卫

#### 已验证无问题（6 项）
- ✅ **AppleScript 注入已正确防护**（项目方首要担忧）：`applescript_escape`（307-310）先转 `\` 再转 `"`（AppleScript 字符串唯一两转义，顺序正确）。`"); do shell script "rm -rf ~";("` 被转成字面量。枚举脚本是裸字面量零插值。`Command::new("osascript").args(["-e", script])` 用 `arg()` 非 `sh -c`，无 shell 注入。
- ✅ **非 macOS dead_code 处理正确**：`run_now` 有 `#[cfg(not(target_os = "macos"))]` 分支返 `{"supported":false,...}` 并 emit `unsupported` 事件。IPC 命令全平台注册。`config_view` 暴露 `territorySupported: cfg!(target_os="macos")`。Linux 用户开 territory 每 15s 收"unsupported"事件（非静默）。
- ✅ **无窗口标题/文档名泄漏**：枚举只收 `name of proc`（进程名）+ winIndex + 位置/尺寸，不收 `title of win`。`pet:event` payload 只含 `rival: <进程名>`。
- ✅ **零 `unsafe` FFI**：全用 osascript 子进程，无 NSAppleScript/AXUIElement FFI，无 CFString/CFArray retain/release 风险。
- ✅ **macos_patrol 无 panic-prone unwrap**：全 `unwrap_or(...)`，唯一裸 `unwrap()` 在 `#[test]`。
- ✅ **UTF-8 处理**：`from_utf8_lossy` 安全降级；`is_ui_busy` 守卫在 start_auto、toggle、run_now 三处检查。

---

## 4. 跨文件扫描补充

对未深度审计的文件（hook_client.rs / transcript.rs / metering.rs / secure_file.rs / diagnostic_control.rs / diagnostic_io.rs / emotion.rs / instance_probe.rs / i18n.rs）做裸 `unwrap()`/`expect()`/`panic!`/`unsafe` 扫描：

**结论：所有裸 `unwrap()`/`expect()` 均在 `#[cfg(test)]` 测试夹具内，生产代码零裸调用。** 与 7 个路径 agent 的各自验证一致。

唯一生产环境裸调用：`lib.rs:250` 的 `.expect("error while building Octopus")`（见 P1-1，HIGH）。

---

## 5. 项目方清单逐条核对结果

| # | 项目方担忧 | 结论 |
|---|---|---|
| 1 | runtime Arc clone 借用安全性 | ✅ VERIFIED OK（NLL 推理正确） |
| 1 | pet-codex 窗口在 single 模式下的创建/隐藏 | ⚠️ P1-4（隐藏但渲染器照跑，浪费内存）+ P4-6（隐藏渲染器照常播音频） |
| 1 | migration::import_official_data 首次运行行为 | ✅ VERIFIED OK（无 panic、noclobber） |
| 2 | backup 命名一致性（octopus-bak vs re-llmpet-bak） | ⚠️ P2-5（prune_backups 的 legacy prefix 是从未存在的命名，死代码；真实 legacy 仅 CodeWhale 有独立清扫） |
| 2 | prune_backups 两种命名处理 | ⚠️ P2-5 + P2-12（空扩展名 ends_with("") 匹配任意） |
| 2 | command_is_ours 误删官方 hooks 风险 | 🔴 **P2-1 HIGH 安全风险**（裸文件名子串可误删用户 hooks） |
| 3 | SchemaTooNew schema_version=2 处理旧 config | ⚠️ P3-5（隔离过严，降级后所有写失败）+ P3-6（内存升级不落盘） |
| 3 | extras Map 序列化/反序列化 | ⚠️ P3-7（extras 泄漏给渲染层）+ P3-8（snake_case 输入键重复） |
| 3 | reset 事务回滚 | 🔴 **P3-1 + P3-2 HIGH**（不更新内存 Mutex + 不持写锁，reset 可被覆盖/竞态丢失） |
| 4 | duo 模式事件路由 | 🔴 **P4-1 HIGH**（codewhale/opencode/aider 事件全丢） |
| 4 | single→duo 切换时序 | ⚠️ P4-3（切换后不重发 stats，旧视图滞留）+ P4-8（不重应用 codex 位置） |
| 4 | pet-codex 位置恢复 | ⚠️ P4-7（首次无位置重叠）+ P4-11（跨显示器 scale 错） |
| 5 | child process 超时/取消清理 | 🔴 **P5-1 CRITICAL**（退出不杀）+ P5-2（cancel 不直接杀）+ P5-5（wait 可永阻塞） |
| 5 | travel.json 持久化原子性 | ⚠️ P5-6（Windows 崩溃窗口期丢历史） |
| 5 | growth 计算准确性 | ⚠️ P5-8（中途崩丢 tokens）+ P5-9（失败/取消 0 growth） |
| 6 | 大 rollout 文件内存 | 🔴 **P6-1 HIGH**（整文件 read_to_end 64MB 峰值）+ P6-3（>32MB 全丢） |
| 6 | timestamp 解析边界 | ⚠️ P6-4（时区偏移忽略）+ P6-5（数字时间戳不处理） |
| 6 | 多 session 累加去重 | ⚠️ P6-6（resumed 会话双计 lifetime） |
| 7 | AppleScript 注入风险 | ✅ VERIFIED OK（applescript_escape 正确，零 FFI，arg() 非 sh -c） |
| 7 | 辅助功能权限缺失降级 | ⚠️ P7-3（无退避，15s 永久 spawn）+ P7-5（反应式 stderr grep，非主动 AXIsProcessTrusted，不 emit UI） |
| 7 | 非 macOS dead_code 处理 | ✅ VERIFIED OK（cfg 分支返 unsupported + emit 事件 + config_view 暴露 territorySupported） |

---

## 6. 推送前建议

按项目方约束（不改仓库名/Cargo lib/数据目录、保留 LEGACY_MARKER/LEGACY_HOOK_OWNER/re-llmpet-hook 二进制、签名 TODO、release 保持 prerelease）：

**最低修复集（建议 0.5.47 必修，阻断推送）：**
1. P5-1 退出清理子进程（CRITICAL，数据/资源安全）
2. P2-1 `command_is_ours` 移除文件名子串（HIGH 安全，误删用户 hooks）
3. P3-1 + P3-2 `backup_and_reset_config` 修内存 Mutex + 加写锁（HIGH 数据丢失）
4. P4-1 duo 模式 eventBelongs 把 claude 当聚合桶（HIGH 功能丢失）

**强烈建议（0.5.47 或 0.5.48）：**
5. P4-3 set_pet_mode 后 emit_stats_now
6. P4-4 duo 下 cost/codexUsage 按 provider 切分
7. P6-1/P6-2/P6-3 Codex rollout 改流式读（一举修三个 HIGH）
8. P7-1 territory 加 patrol_busy 互斥
9. P7-2 巡逻线程加 catch_unwind
10. P1-1 `.expect` 改 match + exit

**可推迟到 0.6.0：**
- 其余 MEDIUM/LOW（文档、性能、边界条件）
- P3-5 SchemaTooNew 策略决策（需产品方向）

**验证步骤（修复后）：**
- `cargo fmt && cargo clippy --all-targets -- -D warnings`
- `cargo test --lib`
- `npm test`（66 smoke test）
- 重点回归：duo 模式 5 provider 事件可见性、退出时旅行中子进程清理、reset 后立即拖拽宠物位置、Codex 大文件（>32MB）解析、macOS 辅助功能未授权时的退避行为。

---

*报告完。所有发现均基于实际源码通读，未修改任何文件。如需某条 finding 的完整代码上下文或修复 patch，请指定 finding 编号。*
