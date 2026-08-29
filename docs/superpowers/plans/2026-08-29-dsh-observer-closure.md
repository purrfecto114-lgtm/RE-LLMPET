# dsh observer 收口实施计划

## 目标

把现有但未接线的 Rust dsh observer 修到可增量消费 plain JSONL 与串联 zstd frame，并在 Tauri 启动时启用。未知日志版本、子 agent、半写 frame 和文件截断必须安全处理。

## 边界

- 本轮包含：zstd 单帧边界、半帧续读、plain/zstd offset、Runtime 接线、启动接线、回归测试与验证。
- 本轮不包含：dsh archive/handoff、独立第三只宠、远程审批、费用估算、前端大改。
- 不修改 package/lib/data-dir/legacy hook 兼容约束，不增加 npm runtime 依赖。

## 已证实根因

1. `decode_zstd_frame` 使用默认 `Decoder`，会把串联 frame 一次解完；调用者无法得到首帧边界。
2. 旧 scanner 把 Frame Content Size 当压缩 frame 长度，边界算法错误。
3. watcher 的 zstd 分支从文件开头读取压缩字节，随后按 UTF-8 JSONL 解析；没有解压。
4. plain 分支同样未 seek 到 `file_offset`，每轮重复读全文件并持续增加 offset。
5. watcher 持有 `Arc<AppState>`，而 setup 已有可直接克隆的 `Arc<Runtime>`；该类型选择阻碍启动接线。
6. 当前 `lib.rs` 声明模块但未调用 `start_dsh_watcher`。

## TODO 与验收

- [ ] T1（RED）：新增 Rust 测试，覆盖串联 frame 只消费首帧、半帧不提交、完整 frame 列表精确推进、skippable frame。
- [ ] T2（GREEN）：以 `Decoder::with_buffer(Cursor).single_frame()` 解一个完整 frame；删除依赖 FCS 的错误 scanner/decoder。
- [ ] T3（RED）：新增 watcher 纯函数测试，覆盖 plain 增量、zstd 完整 frame + 半帧、截断重置、读取上限。
- [ ] T4（GREEN）：按 offset seek；zstd 只提交完整 frame，半帧留在磁盘等待下一轮；解压明文再交给 JSONL carry。
- [ ] T5：watcher 改持有 `Arc<Runtime>`；内部 session key 使用 `dsh:<id>` 防止与其他 provider 碰撞；事件 ingest 继续携带 provider=dsh。
- [ ] T6：在 Tauri setup 中启动 watcher；尊重 `LLMPET_NO_DSH=1`，缺目录静默。
- [ ] T7：新增可执行的 Node 源码集成 smoke（用于无 Rust toolchain 环境），先证明缺少接线，再证明接线和关键不变量存在。
- [ ] T8：重生成并验证 `SOURCE_MANIFEST.json`。
- [ ] T9：运行 17 项静态检查、dsh/Phase 1/全量 Node smoke；记录环境型失败。
- [ ] T10：若有 Cargo toolchain，运行 `cargo fmt --check`、`cargo check --locked`、`cargo test --locked`；当前容器已证实 `cargo: command not found`，不得伪报。
- [ ] T11：按 verification-before-completion 复核 diff、行数预算、无凭据、无越界改动，并更新 `migration-todo.json`/交付说明。

## 关键取舍

- 使用 zstd 解码器的真实消费位置作为压缩 frame 边界，不再手写一份容易漂移的 FCS parser。
- 半帧不复制到字符串 carry；offset 保持在该 frame 起点，下轮从磁盘重读，避免压缩字节与 JSONL carry 混用。
- 单轮读取设上限；超大 frame 不在本轮内凭空实现“跳过后恢复”，因为解码器无法在未知完整边界前安全跳过。记录错误并保留 offset，比误推进和丢日志更安全。

