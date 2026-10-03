# LLMPET R3 架构拆分 实现计划（P2）

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** main.js(1138行) 与 renderer/pet.js(2500行) 按职责拆为小模块，**运行时形态不变、25/25 测试零改动通过**。
**架构：** 渲染端「有序清单拼接」构建（src/renderer/pet/*.js → scripts/build-renderer.js → renderer/pet.js）；主进程直接 CJS require 拆分（app/*.js，main.js 成薄壳）。每步门禁：`node --check` + 全量测试 + verify-surgery。
**技术栈：** 纯 Node CJS；无 bundler。

**通用门禁命令（每个任务结束必跑）：**
```bash
node scripts/build-renderer.js && node --check main.js && node --check renderer/pet.js && node test/state-smoke.js && node test/smoke.js && node scripts/verify-surgery.js
```

---

### 任务 1：渲染端机械切分基础设施
**文件：** 创建 `scripts/build-renderer.js`、`src/renderer/pet/manifest.json`
- [ ] 写 `build-renderer.js`：读 manifest 的有序文件数组，按序拼接写入 `renderer/pet.js`（UTF-8 无 BOM，末尾补 `\n`）
```js
#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/renderer/pet/manifest.json'), 'utf8'));
const out = manifest.files.map(f => fs.readFileSync(path.join(ROOT, 'src/renderer/pet', f))).join('');
fs.writeFileSync(path.join(ROOT, 'renderer/pet.js'), out.endsWith('\n') ? out : out + '\n');
console.log('built renderer/pet.js from', manifest.files.length, 'chunks');
```
- [ ] 用行号切分脚本把现 pet.js 原样切为 10 个 chunk（按函数组边界：00-boot/10-skin/20-state/30-sesslist/40-ask/50-radial/60-todopop/70-geometry-drag/80-events-stats/90-init-wiring），生成 manifest.json
- [ ] 校验：`git hash-object renderer/pet.js` 切分前后一致（byte-identical）；全量测试绿
- [ ] Commit `refactor(renderer): mechanical split into ordered chunks (no behavior change)`

### 任务 2：渲染端 chunk 语义化整理（重命名/微调注释边界）
- [ ] 按上表命名调整 chunk 文件名并同步 manifest（内容不动）
- [ ] 门禁通过 → Commit `refactor(renderer): semantic chunk names`

### 任务 3：主进程 stats.js 抽出
**文件：** 创建 `app/stats.js`；修改 `main.js`
- [ ] 迁移 `filterSnapshot/buildStats/petStats/emitStats/scheduleEmit/recordOp/recentOps/lastStats` 至 `app/stats.js`，导出工厂：
```js
module.exports = function createStats(deps) { /* deps: core,metering,codexMetering,permissions,runtimeMonitor,adapter */ }
```
main.js 改为 `const stats = createStats({...})` 并解构使用。
- [ ] 门禁 → Commit `refactor(main): extract app/stats.js`

### 任务 4：主进程 windows.js 抽出
- [ ] 迁移 `makePetWindow/createPetWindows/openPanel/closePanel/openArchive/hardenWindow/applyPetSize/setRequestedPetSize 相关窗口几何` 至 `app/windows.js`（deps 注入 config/screen/BrowserWindow 等）
- [ ] 门禁 → Commit `refactor(main): extract app/windows.js`

### 任务 5：主进程 tray.js 抽出
- [ ] 迁移 `buildTray/refreshTrayMenu/applyMode/applySkin/applyLang/setAgentStartup/runAgentStartup`
- [ ] 门禁 → Commit `refactor(main): extract app/tray.js`

### 任务 6：主进程 ipc.js 抽出
- [ ] `registerIpc()` 全部 handler 迁至 `app/ipc.js`（deps 注入各管理器）
- [ ] 门禁 → Commit `refactor(main): extract app/ipc.js`

### 任务 7：main.js 薄壳化收尾
- [ ] main.js 仅剩：requires + 常量 + boot 编排 + before-quit（≤150 行）
- [ ] 最终门禁：全量 26 测试 + verify-surgery + `wc -l` 各文件报告
- [ ] Commit `refactor(main): thin shell orchestration`

### 任务 8：推送 + 收尾
- [ ] push main → 确认 CI workflow_dispatch 触发的 CI 绿（或 push 自动触发）
- [ ] 更新 README 目录结构段中 main.js/renderer 描述两行
