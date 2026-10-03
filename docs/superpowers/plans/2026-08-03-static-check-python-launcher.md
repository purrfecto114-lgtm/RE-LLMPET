# Static Check Python Launcher 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 `npm run check:static` 在 Windows、macOS 和 Linux 上安全选择可用的 Python 3，并记录本次全部修改、风险和恢复方法。

**架构：** `package.json` 将静态检查委托给一个小型 Node 启动器。启动器不使用 shell，按平台探测 Python 3，随后串行运行现有两个 Python 检查并传播退出码；任务结束时用项目生成器同步源码清单，并生成中文恢复记录。

**技术栈：** Node.js CommonJS、`child_process.spawnSync`、Python 3、Cargo/Rust、npm scripts。

---

## 文件结构

- 创建：`scripts/run-static-checks.js`，只负责 Python 3 解析和两个静态检查的顺序执行。
- 修改：`package.json`，将 `check:static` 指向 Node 启动器。
- 创建：`docs/TASK_RECOVERY_2026-08-03_RUST_COMPILE.md`，记录改动、风险、证据和非破坏性恢复步骤。
- 修改：`SOURCE_MANIFEST.json`，由项目生成器按最终工作树重建。

### 任务 1：实现跨平台 Python 3 启动器

**文件：**
- 创建：`scripts/run-static-checks.js`
- 修改：`package.json:27`

- [ ] **步骤 1：确认失败基线**

运行：`npm.cmd run check:static`

预期（当前 Windows 环境）：FAIL，退出码 `9009`；`python3` 命中 Microsoft Store 占位符，未执行任何项目 Python 检查。

- [ ] **步骤 2：创建最小启动器**

在 `scripts/run-static-checks.js` 写入：

```javascript
#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const candidates = process.platform === 'win32'
  ? [['py', ['-3']], ['python', []], ['python3', []]]
  : [['python3', []], ['python', []], ['py', ['-3']]];

function findPython3() {
  for (const [command, prefixArgs] of candidates) {
    const probe = spawnSync(command, [...prefixArgs, '--version'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const version = `${probe.stdout || ''}${probe.stderr || ''}`.trim();
    if (probe.status === 0 && /^Python 3(?:\.|$)/.test(version)) {
      return { command, prefixArgs };
    }
  }
  return null;
}

const python = findPython3();
if (!python) {
  console.error('check:static requires Python 3 (tried platform Python command aliases).');
  process.exit(1);
}

for (const script of ['scripts/static-check.py', 'scripts/rust-structure-smoke.py']) {
  const result = spawnSync(
    python.command,
    [...python.prefixArgs, script],
    { cwd: root, stdio: 'inherit', windowsHide: true }
  );
  if (result.error) {
    console.error(`Failed to run ${script}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}
```

- [ ] **步骤 3：切换 npm 入口**

将 `package.json` 中：

```json
"check:static": "python3 scripts/static-check.py && python3 scripts/rust-structure-smoke.py"
```

替换为：

```json
"check:static": "node scripts/run-static-checks.js"
```

- [ ] **步骤 4：验证绿灯**

运行：`npm.cmd run check:static`

预期：退出码 0，`static-check: ok (22 checks)` 与 `rust-structure-smoke: ok` 均出现。

### 任务 2：生成安全恢复记录

**文件：**
- 创建：`docs/TASK_RECOVERY_2026-08-03_RUST_COMPILE.md`

- [ ] **步骤 1：采集最终文件集合**

运行：`git status --short`、`git diff --stat`、`git diff --check`。

预期：能区分任务前已存在的两项删除和 `routine.md`，以及本次 Rust、permission、启动器、manifest、规格与计划文件。

- [ ] **步骤 2：编写恢复文档**

文档必须包含：环境与目标、任务前改动、任务拥有的逐文件修改、自动生成文件、已知负面影响、未验证范围、验证命令与结果、逐文件恢复步骤。恢复命令只允许文件级操作建议；不得建议 `git reset --hard`、修改执行策略、修改 PATH 或卸载工具链。

- [ ] **步骤 3：检查文档完整性**

运行：`rg "负面影响|未验证|恢复|PowerShell|SOURCE_MANIFEST" docs/TASK_RECOVERY_2026-08-03_RUST_COMPILE.md`

预期：所有必需章节均有匹配，且恢复步骤明确保留用户原有删除与 `routine.md`。

### 任务 3：同步清单并完成验证

**文件：**
- 修改：`SOURCE_MANIFEST.json`

- [ ] **步骤 1：重建并验证 source manifest**

运行：`node scripts/generate-source-manifest.js --generate`，随后运行 `node scripts/generate-source-manifest.js --verify`。

预期：两条命令退出码 0，文件数一致且无 hash mismatch。

- [ ] **步骤 2：复跑 Rust 门禁**

在 `src-tauri/` 运行：

```powershell
cargo fmt --check
cargo check --locked --all-targets
cargo test --lib --locked
cargo clippy --locked -- -D warnings
```

预期：全部退出码 0；Rust 单元测试 36 passed；Clippy 0 warnings。

- [ ] **步骤 3：复跑源码门禁**

在仓库根目录运行：

```powershell
npm.cmd test
npm.cmd run check:static
npm.cmd run gate:source
node scripts/generate-source-manifest.js --verify
```

预期：npm smoke 全通过，静态检查 22/22，source gate 16/16，manifest verification OK。

- [ ] **步骤 4：核对安全边界**

运行：`git diff --check` 和 `git status --short`。

预期：无空白错误；没有系统配置、全局配置、工具链或工作区外文件变更；用户原有改动仍保持原状态。
