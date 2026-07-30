#!/usr/bin/env bash
# RE-LLMPET Windows 构建脚本 — R21 (2026-07-30)
#
# 本脚本在具备完整 mingw-w64 工具链的环境上产生 Windows .exe 产物。
# 沙箱环境（无 sudo/mingw）已用 cargo check 验证编译通过（0 errors, 0 warnings），
# 但无法产生真实 exe。本脚本封装了正确的构建命令。
#
# 前置要求：
#   - Rust stable 1.85+ (rustup install stable)
#   - mingw-w64 (sudo apt-get install mingw-w64)
#   - Windows target (rustup target add x86_64-pc-windows-gnu)
#
# 用法：
#   chmod +x build-windows.sh
#   ./build-windows.sh           # debug build
#   ./build-windows.sh --release # release build (推荐)
#   ./build-windows.sh --nsis    # NSIS 安装程序 (需 cargo tauri)

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$PROJECT_ROOT/src-tauri"
MODE="debug"
EXTRA_ARGS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release) MODE="release"; EXTRA_ARGS="--release"; shift ;;
    --nsis)    NSIS=1; shift ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

echo "=== RE-LLMPET Windows 构建 ==="
echo "项目根: $PROJECT_ROOT"
echo "模式: $MODE"
echo "时间: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# ── 1. 环境检查 ──────────────────────────────────────────────────────────────
echo "[1] 环境检查"
command -v cargo >/dev/null 2>&1 || { echo "FAIL: cargo 未安装 (rustup install stable)"; exit 1; }
command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1 || { echo "FAIL: mingw-w64 未安装 (sudo apt-get install mingw-w64)"; exit 1; }
command -v x86_64-w64-mingw32-windres >/dev/null 2>&1 || { echo "FAIL: windres 未安装"; exit 1; }
command -v x86_64-w64-mingw32-dlltool >/dev/null 2>&1 || { echo "FAIL: dlltool 未安装"; exit 1; }
rustup target list --installed | grep -q x86_64-pc-windows-gnu || { echo "FAIL: Windows target 未安装 (rustup target add x86_64-pc-windows-gnu)"; exit 1; }
echo "  cargo: $(cargo --version)"
echo "  mingw: $(x86_64-w64-mingw32-gcc --version | head -1)"
echo "  target: x86_64-pc-windows-gnu"
echo ""

# ── 2. 冒烟测试 ──────────────────────────────────────────────────────────────
echo "[2] 冒烟测试 (npm test)"
cd "$PROJECT_ROOT"
if npm test 2>&1 | grep -q "migration-todo:.*tasks valid"; then
  echo "  PASS: npm test 套件通过"
else
  echo "  FAIL: npm test 失败 — 先修复测试再构建"
  exit 1
fi
echo ""

# ── 3. cargo check ──────────────────────────────────────────────────────────
echo "[3] cargo check (Windows target)"
if cargo check --manifest-path "$SRC_DIR/Cargo.toml" --target x86_64-pc-windows-gnu --locked 2>&1 | grep -q "Finished"; then
  echo "  PASS: cargo check 通过 (0 errors)"
else
  echo "  FAIL: cargo check 失败"
  exit 1
fi
echo ""

# ── 4. 构建 ──────────────────────────────────────────────────────────────────
echo "[4] 构建 Windows 产物"
BUILD_CMD="cargo build --manifest-path $SRC_DIR/Cargo.toml --target x86_64-pc-windows-gnu --locked $EXTRA_ARGS"
echo "  运行: $BUILD_CMD"
if $BUILD_CMD; then
  echo "  PASS: 构建成功"
else
  echo "  FAIL: 构建失败"
  exit 1
fi
echo ""

# ── 5. 产物清单 ──────────────────────────────────────────────────────────────
echo "[5] 产物清单"
TARGET_DIR="$SRC_DIR/target/x86_64-pc-windows-gnu/$MODE"
echo "  目标目录: $TARGET_DIR"
echo ""
echo "  二进制文件:"
for bin in octopus.exe octopus-hook.exe; do
  if [ -f "$TARGET_DIR/$bin" ]; then
    SIZE=$(du -h "$TARGET_DIR/$bin" | cut -f1)
    echo "    ✅ $bin ($SIZE)"
  else
    echo "    ❌ $bin (缺失)"
  fi
done
echo ""

# ── 6. NSIS 安装程序（可选）──────────────────────────────────────────────
if [ "${NSIS:-0}" = "1" ]; then
  echo "[6] NSIS 安装程序"
  command -v cargo-tauri >/dev/null 2>&1 || { echo "  SKIP: cargo-tauri 未安装 (cargo install tauri-cli --version '^2.11.0' --locked)"; exit 0; }
  echo "  运行: cargo tauri build --target x86_64-pc-windows-gnu --bundles nsis"
  if cargo tauri build --target x86_64-pc-windows-gnu --bundles nsis 2>&1 | tail -5; then
    echo "  PASS: NSIS 安装程序生成"
  else
    echo "  FAIL: NSIS 打包失败"
    exit 1
  fi
fi

echo ""
echo "=== 构建完成 ==="
echo "产物位置: $TARGET_DIR"
echo ""
echo "注意：完整 Windows 签名需要 TAURI_SIGNING_PRIVATE_KEY + WINDOWS_CERTIFICATE"
echo "      密钥配置在 GitHub Settings → Secrets，本地构建可跳过签名。"
