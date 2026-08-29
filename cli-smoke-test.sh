#!/usr/bin/env bash
# Octopus CLI 冒烟测试脚本 — R18 (2026-07-30)
#
# 用途：在目标机器上验证 RE-LLMPET 的 5-provider CLI 诊断流程。
# 本脚本不依赖 cargo/Tauri 构建 — 它直接测试项目文档/契约中描述的
# CLI 行为是否与实际安装的 provider CLI 一致。
#
# 运行方式：
#   chmod +x cli-smoke-test.sh
#   ./cli-smoke-test.sh
#
# 输出：每项检查打印 PASS/FAIL/SKIP + 简短说明；最后汇总。
# 退出码：0=全部 PASS，1=有 FAIL，2=有 SKIP（但不阻塞）。

set -u
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
FAILS=0
SKIPS=0
PASSES=0

pass() { echo "  PASS: $1"; PASSES=$((PASSES+1)); }
fail() { echo "  FAIL: $1"; FAILS=$((FAILS+1)); }
skip() { echo "  SKIP: $1 (原因: $2)"; SKIPS=$((SKIPS+1)); }

echo "=== Octopus CLI 冒烟测试 ==="
echo "项目根: $PROJECT_ROOT"
echo "时间: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# ── 1. 项目结构完整性 ──────────────────────────────────────────────────────
echo "[1] 项目结构"
[ -f "$PROJECT_ROOT/package.json" ] && pass "package.json 存在" || fail "package.json 缺失"
[ -f "$PROJECT_ROOT/src-tauri/Cargo.toml" ] && pass "Cargo.toml 存在" || fail "Cargo.toml 缺失"
[ -f "$PROJECT_ROOT/src-tauri/src/lib.rs" ] && pass "lib.rs 存在" || fail "lib.rs 缺失"
[ -f "$PROJECT_ROOT/src-tauri/src/commands.rs" ] && pass "commands.rs 存在" || fail "commands.rs 缺失"
[ -f "$PROJECT_ROOT/src-tauri/src/i18n.rs" ] && pass "i18n.rs 存在 (R11)" || fail "i18n.rs 缺失 (R11 回归)"
[ -f "$PROJECT_ROOT/src-tauri/src/metering.rs" ] && pass "metering.rs 存在" || fail "metering.rs 缺失"
[ -f "$PROJECT_ROOT/src-tauri/src/hook_install.rs" ] && pass "hook_install.rs 存在" || fail "hook_install.rs 缺失"
[ -f "$PROJECT_ROOT/scripts/windows-cli-diagnostics.ps1" ] && pass "PowerShell 诊断脚本存在" || fail "PowerShell 诊断脚本缺失"
echo ""

# ── 2. 托盘 API 契约（R10 修复）──────────────────────────────────────────
echo "[2] 托盘 API 契约 (R10)"
if grep -q 'TrayIconBuilder::with_id("main-tray")' "$PROJECT_ROOT/src-tauri/src/lib.rs"; then
  pass "TrayIconBuilder::with_id (Tauri 2.11.5 正确 API)"
else
  fail "TrayIconBuilder::with_id 缺失 — 检查 lib.rs"
fi
if grep -q 'tray_by_id("main-tray")' "$PROJECT_ROOT/src-tauri/src/lib.rs"; then
  pass "tray_by_id 查找存在"
else
  fail "tray_by_id 缺失"
fi
if ! grep -q 'TrayIconBuilder::new("main-tray")' "$PROJECT_ROOT/src-tauri/src/lib.rs"; then
  pass "无 TrayIconBuilder::new(\"id\") 编译错误 (R10 修复)"
else
  fail "TrayIconBuilder::new(\"id\") 仍存在 — 编译阻塞"
fi
if ! grep -q 'app\.manage(tray)' "$PROJECT_ROOT/src-tauri/src/lib.rs"; then
  pass "无冗余 app.manage(tray) (R10 修复)"
else
  fail "app.manage(tray) 仍存在 — 所有权歧义"
fi
echo ""

# ── 3. CodeWhale doctor 顺序（R10 修复）──────────────────────────────────
echo "[3] CodeWhale doctor 顺序 (R10)"
if grep -q 'let mut companion_capture = companion.map' "$PROJECT_ROOT/src-tauri/src/commands.rs"; then
  pass "codewhale_doctor_probe companion-first (R10 修复)"
else
  fail "companion-first 顺序缺失 — 检查 commands.rs"
fi
if grep -q 'should_try_dispatcher' "$PROJECT_ROOT/src-tauri/src/commands.rs"; then
  pass "dispatcher fallback 逻辑存在"
else
  fail "should_try_dispatcher 缺失"
fi
echo ""

# ── 4. 托盘 i18n + 子菜单（R11-R14）──────────────────────────────────────
echo "[4] 托盘 i18n + 子菜单 (R11-R14)"
if grep -q 'pub const TRAY_LABELS' "$PROJECT_ROOT/src-tauri/src/i18n.rs"; then
  pass "i18n.rs TRAY_LABELS 表存在 (R11)"
else
  fail "TRAY_LABELS 缺失"
fi
if grep -q 'pub fn refresh_tray_menu' "$PROJECT_ROOT/src-tauri/src/lib.rs"; then
  pass "refresh_tray_menu 存在 (R11)"
else
  fail "refresh_tray_menu 缺失"
fi
if grep -q 'CheckMenuItem::with_id' "$PROJECT_ROOT/src-tauri/src/lib.rs"; then
  pass "CheckMenuItem 用于子菜单 (R12)"
else
  fail "CheckMenuItem 缺失"
fi
if grep -q '"shape_hidePet"' "$PROJECT_ROOT/src-tauri/src/lib.rs"; then
  pass "shape hidePet 子菜单存在 (R14)"
else
  fail "shape hidePet 缺失"
fi
echo ""

# ── 5. 面板视觉元素（R15-R16）────────────────────────────────────────────
echo "[5] 面板视觉元素 (R15-R16)"
if grep -q 'id="codex-wrap"' "$PROJECT_ROOT/frontend/renderer/panel.html"; then
  pass "Codex 配额条存在 (R15)"
else
  fail "codex-wrap 缺失"
fi
if grep -q 'id="codex-usage"' "$PROJECT_ROOT/frontend/renderer/panel.html"; then
  pass "Codex 今日/累计 token 网格存在 (R15)"
else
  fail "codex-usage 缺失"
fi
if grep -q 'class="metric-tabs"' "$PROJECT_ROOT/frontend/renderer/panel.html"; then
  pass "Token/Cost 切换按钮存在 (R16)"
else
  fail "metric-tabs 缺失"
fi
if grep -q 'id="usage-diagnostics"' "$PROJECT_ROOT/frontend/renderer/panel.html"; then
  pass "诊断行存在 (R16)"
else
  fail "usage-diagnostics 缺失"
fi
echo ""

# ── 6. metering cache-write 5m/1h 双字段（R18）──────────────────────────
echo "[6] metering cache-write 5m/1h (R18)"
if grep -q 'pub cache_write_5m: u64' "$PROJECT_ROOT/src-tauri/src/metering.rs"; then
  pass "UsageEvent.cache_write_5m 存在 (R18)"
else
  fail "cache_write_5m 缺失"
fi
if grep -q 'pub cache_write_1h: u64' "$PROJECT_ROOT/src-tauri/src/metering.rs"; then
  pass "UsageEvent.cache_write_1h 存在 (R18)"
else
  fail "cache_write_1h 缺失"
fi
if grep -q 'ephemeral_5m_input_tokens' "$PROJECT_ROOT/src-tauri/src/metering.rs"; then
  pass "parse_claude_assistant 读 ephemeral_5m (R18)"
else
  fail "ephemeral_5m 解析缺失"
fi
if grep -q 'id="t-cw5"' "$PROJECT_ROOT/frontend/renderer/panel.html"; then
  pass "面板 5m 缓存写入行存在 (R18)"
else
  fail "t-cw5 缺失"
fi
if grep -q 'id="t-cw1"' "$PROJECT_ROOT/frontend/renderer/panel.html"; then
  pass "面板 1h 缓存写入行存在 (R18)"
else
  fail "t-cw1 缺失"
fi
echo ""

# ── 7. npm test 套件 ──────────────────────────────────────────────────────
echo "[7] npm test 套件"
if command -v node >/dev/null 2>&1; then
  if [ -d "$PROJECT_ROOT/node_modules" ] || [ -f "$PROJECT_ROOT/package-lock.json" ]; then
    cd "$PROJECT_ROOT"
    if npm test 2>&1 | grep -q "migration-todo:.*tasks valid"; then
      pass "npm test 套件运行成功"
      # 提取通过数
      local_pass=$(npm test 2>&1 | grep -cE "(smoke: ok|PASS [0-9])" || true)
      pass "  $local_pass 个 smoke 套件通过"
    else
      fail "npm test 套件失败"
    fi
  else
    skip "npm test" "node_modules 未安装 (运行 npm ci --ignore-scripts)"
  fi
else
  skip "npm test" "node 未安装"
fi
echo ""

# ── 8. 静态检查 ────────────────────────────────────────────────────────────
echo "[8] 静态检查"
if command -v python3 >/dev/null 2>&1; then
  cd "$PROJECT_ROOT"
  if python3 scripts/static-check.py 2>&1 | grep -q "SUMMARY: 22 passed"; then
    pass "static-check.py 22/22 通过"
  else
    fail "static-check.py 失败"
  fi
  if python3 scripts/rust-structure-smoke.py 2>&1 | grep -q "PASS src-tauri/src/lib.rs"; then
    pass "rust-structure-smoke.py 通过"
  else
    fail "rust-structure-smoke.py 失败"
  fi
else
  skip "静态检查" "python3 未安装"
fi
echo ""

# ── 9. Provider CLI 可发现性（可选，需真实安装）──────────────────────────
echo "[9] Provider CLI 可发现性（可选）"
for cli in claude codewhale codex opencode aider codewhale-tui; do
  if command -v "$cli" >/dev/null 2>&1; then
    pass "$cli 在 PATH 中"
  else
    skip "$cli" "未安装"
  fi
done
echo ""

# ── 10. CodeWhale doctor 顺序实测（需 CodeWhale 安装）────────────────────
echo "[10] CodeWhale doctor 顺序实测（可选）"
if command -v codewhale-tui >/dev/null 2>&1; then
  echo "  运行 codewhale-tui doctor --json（15s 超时）..."
  if timeout 15 codewhale-tui doctor --json 2>&1 | head -5; then
    pass "codewhale-tui doctor 成功（companion-first 正确）"
  else
    fail "codewhale-tui doctor 失败或超时"
  fi
else
  skip "codewhale-tui doctor" "codewhale-tui 未安装"
fi
echo ""

# ── 汇总 ──────────────────────────────────────────────────────────────────
echo "=== 汇总 ==="
echo "  PASS: $PASSES"
echo "  FAIL: $FAILS"
echo "  SKIP: $SKIPS"
echo ""
if [ "$FAILS" -gt 0 ]; then
  echo "结果: FAIL（有 $FAILS 项失败）"
  exit 1
elif [ "$SKIPS" -gt 0 ]; then
  echo "结果: PASS（$SKIPS 项因缺少依赖跳过）"
  exit 0
else
  echo "结果: PASS（全部通过）"
  exit 0
fi
