# R4 · Electron 去除长期路线（规格）

日期：2026-08-23　前置：P1 重置发版完成、P2 架构拆分完成（main.js 457 行薄壳 + app/* 四模块 + backend 纯 Node）

## 核心洞察

LLMPET 的业务逻辑**已经是纯 Node**（backend/shared/hook 共 34 模块，零 electron import），渲染端是纯 Web。Electron 只承担「窗口宿主」角色。因此去除 Electron ≠ 重写应用，而是**替换宿主**：

```
现在：  Electron(Chromium+Node) ── ipcMain/ipcRenderer ── renderer(pet.html)
目标：  Tauri v2(Rust 宿主) ── JSON-RPC over stdio ── node sidecar(现 backend 原样运行)
                      └─ WebView2/WKWebView ── renderer(pet.html 原样)
```

Rust 层只做窗口/托盘/穿透胶水；业务 JS 零迁移。这把「全套重写」压缩为「宿主适配层」。

## 五道验收门禁（PoC 决策依据，全过才立项迁移）

| # | 门禁 | 通过标准 | 已知风险 |
|---|---|---|---|
| G1 | 点击穿透+事件回传 | 透明区点击落到下层应用；鼠标移动仍持续回报给 webview 用于命中测试 | Tauri 无 `forward:true` 等价（#6164）；Windows 需 WM_NCHITTEST=HTTRANSPARENT 或低级钩子 |
| G2 | 三平台透明置顶窗 | macOS 不用私有 API；Win/Linux 正常 | macOS 透明需 macos-private-api feature |
| G3 | 托盘+右键菜单 | 与现托盘功能对齐 | tauri v2 内建 |
| G4 | setBounds 平滑动画 | 320×340→520×544 连续过渡 ≥60fps 无撕裂 | tao set_outer_position 性能待测 |
| G5 | 打包体积 | 安装包 <15MB（含 node sidecar） | sidecar 需 pkg/nexe 冻结或要求用户装 Node |

## 分阶段执行

- **A（本次执行）**：宿主纯净审计脚本 + `poc/tauri-gate` Rust 工程脚手架（G1-G4 可在桌面运行的自检序列，`cargo check` 本地过）+ 本规格
- **B（需桌面人工）**：桌面跑 PoC → 记录五门禁结果 → 全过立项；任一不过 → Electron 留守一年后复评
- **C（立项后）**：`host-tauri/` 正式宿主开发；sidecar 打包方案定型；renderer 改走 HTTP/WS transport（server.js 已具备 HTTP 能力）
- **D**：删除 Electron 依赖与 preload，CI 切换打包链

## 明确不做

- 不用 Rust 重写任何 backend 业务模块
- 不引入前端框架/bundler（保持无构建渲染端）
