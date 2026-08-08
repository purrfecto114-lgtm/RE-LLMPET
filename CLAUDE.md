# Octopus (RE-LLMPET) — AI Development Guide

> 本文件是 AI agent（Claude Code / Codex / Hermes 等）在本仓库工作时的引导文档。
> 开发环境可运行 `npx superpowers-zh` 安装 20 个 AI 编程方法论 skills 到 `.claude/skills/`。

## 项目概览

**Octopus** 是一个低占用 Tauri 2 / Rust 桌面宠物，监控 5 个 coding agent（Claude Code / CodeWhale / Codex / OpenCode / Aider）的生命周期、权限、会话和 token 花费。

- **版本**: 0.5.46 prerelease（→ 0.6.0 stable）
- **技术栈**: Tauri 2 + Rust（edition 2021）+ 原生 JS（无框架、无打包器、无运行时依赖）
- **数据目录**: `~/.re-llmpet`（不可改名）
- **二进制**: `octopus`（GUI）+ `octopus-hook`（hook 入口，legacy 别名 `re-llmpet-hook`）

## 关键约束（不可违反）

1. **不改仓库名 / Cargo package name / lib name**（`octopus` / `octopus_lib`）
2. **不改数据目录** `~/.re-llmpet`
3. **保留** `LEGACY_MARKER` / `LEGACY_HOOK_OWNER` 常量和 `re-llmpet-hook` 二进制入口
4. **签名是 TODO**（无证书），release 保持 prerelease 直到 0.6.0
5. **无运行时 npm 依赖**（`dependencies: {}`）—— 不要引入 npm 包
6. **无 bundler** —— 前端是原生 `<script>` 引入，不要引入 React/Vue/打包器
7. **行数预算**: `pet.js` ≤ 2500, `panel.js` ≤ 1650, `commands.rs` ≤ 3250, `hook_install.rs` ≤ 2300

## 开发环境

```
容器内不可用: cargo check / cargo build（缺 GTK 库）
可用验证手段:
  node --check <file.js>                    # JS 语法
  node scripts/run-static-checks.js         # 22 项（JSON/YAML 解析 + Rust 词素平衡 + Bridge 命令对等）
  npm test                                  # 全链 smoke（~70 个测试）
  node scripts/generate-source-manifest.js  # 重生成 SOURCE_MANIFEST.json
```

**修改任何 .rs 文件后必须跑 `generate-source-manifest.js`**，否则 manifest hash 不匹配会导致 `tauri-r401-carpet-audit-closure-smoke` 失败。

## 架构速览

```
agent CLIs ──► hook_client.rs (octopus-hook bin)
                    │ stdin → TCP loopback
                    ▼
              http_server.rs (port 41330-41334, token auth)
                    │
                    ▼ Tauri events
              model.rs (AppState, Runtime, Sessions)
                    │
                    ▼
              commands.rs (50 #[tauri::command])
                    │ Tauri IPC
                    ▼
              frontend/ (pet.js + panel.js, 原生 JS)
```

**20 个 Rust 模块** | **50 个 Tauri 命令** | **6 个前端 JS 模块**

## Skills 使用指南

本仓库推荐使用 [superpowers-zh](https://github.com/jnMetaCode/superpowers-zh) skills 框架。安装：

```bash
npx superpowers-zh          # 项目级安装到 .claude/skills/
npx superpowers-zh --global # 全局安装到 ~/.claude/skills/
```

安装后 20 个 skills 会自动在 SessionStart 时加载。以下是推荐的使用场景：

| 场景 | 推荐 Skill | 调用方式 |
|------|-----------|---------|
| 新功能设计 | `brainstorming` | 自动触发（SessionStart hook） |
| 实施计划 | `writing-plans` → `executing-plans` | 自动 |
| 修 bug | `systematic-debugging` | 自动 |
| 代码审查 | `requesting-code-review` | 自动 |
| 提交前验证 | `verification-before-completion` | 自动 |
| 并行任务 | `dispatching-parallel-agents` | 自动 |
| 中文提交规范 | `chinese-commit-conventions` | `/chinese-commit-conventions` |
| 中文代码审查 | `chinese-code-review` | `/chinese-code-review` |

## 开发流程

1. **开工前**：读 `worklog.md` 了解当前轮次状态和未解决问题
2. **修 bug**：每修一个文件前先 Read 确认行号（行号会因前序修复漂移）
3. **验证**：`node --check`（JS）→ `run-static-checks.js`（22 项）→ `npm test` → `generate-source-manifest.js`
4. **注释**：修复带 finding ID（如 `// P5-4 fix (R2): ...`）方便追溯
5. **收尾**：更新 `worklog.md`，重写下一轮建议提示词

## 文件索引

| 文件 | 用途 |
|------|------|
| `worklog.md` | 轮次交接文档（每轮 agent 必读） |
| `ROADMAP.md` | 产品路线图（0.6.0 → 0.7.0 方向） |
| `DEEP_BUG_CHECK_0.5.46.md` | 深度审计报告（88 条发现） |
| `migration-todo.json` | 62 个迁移任务状态跟踪 |
| `docs/RE-LLMPET-Roadmap-v5.md` | 原始 v5 路线图（0.5.38 → 0.6.0） |
| `SOURCE_MANIFEST.json` | 326 文件 hash 清单（修改 .rs 后必须重生成） |

## 自主修复 Cron Job

项目运行一个 30 分钟轮次的自主修复 cron job（ID 313478）。每轮：
1. 读 `worklog.md` 的「Round N 建议提示词」段落
2. 按优先级修复该段落列出的 bug
3. 派并行审计 agent 检查未审计区域
4. 更新 `worklog.md`，重写下一轮提示词

**提示词每轮由上一轮 agent 自行编写**，避免上下文膨胀。
