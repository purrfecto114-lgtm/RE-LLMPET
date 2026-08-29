# dsh observer 交付记录（2026-08-29）

## 结论

阶段 3 已实现到“源码与仓库本地门禁通过、等待 Rust 编译验证”的状态，记录为 `implemented-uncompiled`，不标记为 `ci-verified`。

## 相对 handoff 的补充发现

1. plain JSONL 分支也没有 seek 到既有 offset，会重复消费整个文件。
2. 所有映射事件固定发送 `seq: 0`，会与 Runtime 的事件排序/去重契约冲突。
3. 未知版本和 subagent header 只跳过 header 行，后续事件仍可能进入 Runtime，不是真正的 fail-closed。
4. dsh 时间戳是毫秒，旧 idle cleanup 使用秒，tracker 无法按预期淘汰。
5. 原实现把 `tool` 放在嵌套 `data` 中，而 Runtime 读取根级 `tool_name`。

## 本轮修改

- `dsh_zstd.rs`：按 frame header/block chain/checksum 识别完整压缩边界；`single_frame()` 解码；支持串联 frame、半帧保留、skippable frame、32 MiB 解压上限。
- `dsh_watch.rs`：plain/zstd 都从已提交 offset 读取；zstd 解压后再送 JSONL parser；只推进完整 frame；文件截断/类型切换重置；Runtime 改为 `Arc<Runtime>`；内部 ID 使用 `dsh:<id>`；事件传真实 seq；未知 header/subagent 整文件 fail-closed；清理统一用毫秒。
- `lib.rs`：Tauri setup 启动原生 dsh watcher。
- `test/tauri-dsh-observer-closure-smoke.js`：锁定关键集成不变量；同一测试对导入基线失败、对当前实现通过。
- `migration-todo.json`：新增 `R21-DSH-OBSERVER`，状态为 `implemented-uncompiled`。

## 验证证据

- dsh closure smoke：通过；对基线的红灯失败已观察到。
- 静态检查：17 passed / 0 failed。
- source manifest：333 files，generate 与 verify 均通过。
- migration todo schema：50 tasks valid。
- Node 测试逐项运行：77 项中 56 通过、21 失败。失败均可在导入基线或环境约束中复现，主要是：无 Cargo、无 `jsdom`、容器没有 `/tmp`、源码包缺 `.github/workflows/release.yml`，以及既有 bridge/asset 契约漂移。
- Rust 编译/单测：未运行；当前容器没有 `cargo`、`rustc`、`rustfmt`。

## 外部验证待办

在有 Rust 1.85+ 与 Tauri 系统依赖的 runner 上执行：

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml --locked
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

随后运行完整 `npm test`，并在真实 dsh 会话中验证 plain、zstd、半写 frame、未知版本与 subagent 过滤。
