# R4 Tauri 宿主门禁 PoC

在**桌面会话**运行（工具/CI 会话无 GUI）：

```bash
cd poc/tauri-gate
cargo run --release
```

| 门禁 | 判定方式 |
|---|---|
| G1 点击穿透+回传 | 点击橙框外空白→焦点应落到下层应用；按 R 切穿透后悬停橙框移动鼠标，控制台 mousemove 计数持续增长=PASS（tao 无 forward 等价，若断流则需 Rust 层 WM_NCHITTEST/钩子方案——即本 PoC 要验证的核心风险） |
| G2 透明置顶 | 自动打印 PASS |
| G3 托盘 | 自动打印 PASS/FAIL |
| G4 setBounds 动画 | 自动测速，≥60fps=PASS |
| G5 打包体积 | `target/release/*.exe` <15MB（含 node sidecar 后复测） |

五门禁全过 → 立项 `host-tauri/` 正式宿主；任一不过 → Electron 留守一年复评。
