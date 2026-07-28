#!/usr/bin/env python3
"""Offline structural checks for the Tauri migration.

This intentionally does not claim to replace `cargo check`. It verifies files,
configuration, JavaScript syntax, Rust delimiter/string/comment balance, asset
identity and migration contracts in environments where Rust cannot be installed.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

try:
    import yaml
except Exception:  # pragma: no cover
    yaml = None

ROOT = Path(__file__).resolve().parents[1]
FRONTEND_ASSETS = ROOT / "frontend" / "assets"
failures: list[str] = []
checks: list[str] = []


def ok(message: str) -> None:
    checks.append(f"PASS  {message}")


def fail(message: str) -> None:
    failures.append(message)
    checks.append(f"FAIL  {message}")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check_json() -> None:
    files = [
        ROOT / "package.json",
        ROOT / "package-lock.json",
        ROOT / "src-tauri" / "tauri.conf.json",
        ROOT / "src-tauri" / "tauri.linux.conf.json",
        ROOT / "src-tauri" / "tauri.macos.conf.json",
        ROOT / "src-tauri" / "tauri.windows.conf.json",
        ROOT / "src-tauri" / "capabilities" / "pet.json",
        ROOT / "src-tauri" / "capabilities" / "panel.json",
        ROOT / "migration-todo.json",
    ]
    for path in files:
        try:
            json.loads(path.read_text(encoding="utf-8"))
            ok(f"JSON parsed: {path.relative_to(ROOT)}")
        except Exception as error:
            fail(f"JSON parse failed: {path.relative_to(ROOT)}: {error}")


def check_yaml() -> None:
    if yaml is None:
        fail("PyYAML unavailable; workflow syntax not parsed")
        return
    for path in sorted((ROOT / ".github" / "workflows").glob("*.yml")):
        try:
            yaml.safe_load(path.read_text(encoding="utf-8"))
            ok(f"YAML parsed: {path.relative_to(ROOT)}")
        except Exception as error:
            fail(f"YAML parse failed: {path.relative_to(ROOT)}: {error}")


def check_js() -> None:
    paths: list[Path] = []
    for base in [ROOT / "frontend", ROOT / "scripts", ROOT / "test"]:
        paths.extend(sorted(base.rglob("*.js")))
    bad = []
    for path in paths:
        result = subprocess.run(
            ["node", "--check", str(path)],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if result.returncode:
            bad.append(f"{path.relative_to(ROOT)}: {result.stderr.strip()}")
    if bad:
        for error in bad:
            fail(f"JavaScript syntax: {error}")
    else:
        ok(f"JavaScript syntax checked: {len(paths)} files")


def rust_lexically_balanced(text: str) -> tuple[bool, str]:
    stack: list[tuple[str, int]] = []
    pairs = {")": "(", "]": "[", "}": "{"}
    i = 0
    n = len(text)
    state = "code"
    block_depth = 0
    raw_hashes = 0
    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if state == "code":
            if ch == "/" and nxt == "/":
                state = "line_comment"; i += 2; continue
            if ch == "/" and nxt == "*":
                state = "block_comment"; block_depth = 1; i += 2; continue
            if ch == '"':
                state = "string"; i += 1; continue
            if ch == "'":
                # A lifetime such as 'a is not a character literal. Treat as a
                # char only if a closing quote is nearby.
                end = i + 1
                escaped = False
                while end < min(n, i + 8):
                    if text[end] == "'" and not escaped:
                        state = "char"; break
                    escaped = text[end] == "\\" and not escaped
                    if text[end] != "\\": escaped = False
                    end += 1
                if state == "char": i += 1; continue
            if ch == "r":
                j = i + 1
                while j < n and text[j] == "#": j += 1
                if j < n and text[j] == '"':
                    raw_hashes = j - i - 1
                    state = "raw_string"; i = j + 1; continue
            if ch in "([{":
                stack.append((ch, i))
            elif ch in ")]}":
                if not stack or stack[-1][0] != pairs[ch]:
                    return False, f"unmatched {ch} at byte {i}"
                stack.pop()
            i += 1
        elif state == "line_comment":
            if ch == "\n": state = "code"
            i += 1
        elif state == "block_comment":
            if ch == "/" and nxt == "*": block_depth += 1; i += 2
            elif ch == "*" and nxt == "/":
                block_depth -= 1; i += 2
                if block_depth == 0: state = "code"
            else: i += 1
        elif state == "string":
            if ch == "\\": i += 2
            elif ch == '"': state = "code"; i += 1
            else: i += 1
        elif state == "char":
            if ch == "\\": i += 2
            elif ch == "'": state = "code"; i += 1
            else: i += 1
        elif state == "raw_string":
            if ch == '"' and text[i + 1:i + 1 + raw_hashes] == "#" * raw_hashes:
                state = "code"; i += raw_hashes + 1
            else: i += 1
    if state not in {"code", "line_comment"}:
        return False, f"unterminated lexical state: {state}"
    if stack:
        token, pos = stack[-1]
        return False, f"unclosed {token} at byte {pos}"
    return True, ""


def check_rust_lexical() -> None:
    rust_files = sorted((ROOT / "src-tauri").rglob("*.rs"))
    for path in rust_files:
        balanced, reason = rust_lexically_balanced(path.read_text(encoding="utf-8"))
        if not balanced:
            fail(f"Rust lexical balance: {path.relative_to(ROOT)}: {reason}")
    if not any(item.startswith("FAIL  Rust lexical") for item in checks):
        ok(f"Rust lexical balance checked: {len(rust_files)} files (not a compiler check)")


def asset_map(base: Path) -> dict[str, str]:
    return {
        str(path.relative_to(base)).replace(os.sep, "/"): sha256(path)
        for path in sorted(base.rglob("*")) if path.is_file()
    }


def check_assets() -> None:
    # Root assets/ duplicate was removed; verify frontend/assets/ exists and
    # has the expected file count. Byte-identity is checked by
    # asset-visual-regression.js against the pinned baseline.
    migrated = asset_map(FRONTEND_ASSETS)
    if len(migrated) >= 30:
        ok(f"Assets verified: {len(migrated)} files in frontend/assets/")
    else:
        fail(f"Too few frontend assets: {len(migrated)} (expected ≥30)")


def check_contracts() -> None:
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    deps = {**package.get("dependencies", {}), **package.get("devDependencies", {})}
    if any("electron" in name.lower() for name in deps):
        fail("Electron remains in active package dependencies")
    else:
        ok("Active package manifest contains no Electron dependency")

    lock = (ROOT / "package-lock.json").read_text(encoding="utf-8").lower()
    if "node_modules/electron" in lock:
        fail("Electron remains in package-lock")
    else:
        ok("package-lock contains no Electron package")

    config = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
    if config.get("build", {}).get("frontendDist") == "../frontend":
        ok("Tauri bundles only the migrated frontend directory")
    else:
        fail("Unexpected Tauri frontendDist")

    bridge = (ROOT / "frontend" / "renderer" / "tauri-bridge.js").read_text(encoding="utf-8")
    lib = (ROOT / "src-tauri" / "src" / "lib.rs").read_text(encoding="utf-8")
    invoked = set(re.findall(r"(?:call|send)\(['\"]([a-zA-Z0-9_:-]+)", bridge))
    generated = lib.split("tauri::generate_handler![", 1)
    if len(generated) != 2:
        fail("Rust command registry missing")
    else:
        registered = set(re.findall(r"\b([a-z][a-z0-9_]*)\b", generated[1].split("]", 1)[0]))
        missing = sorted(invoked - registered)
        if missing:
            fail(f"Bridge commands missing from Rust registry: {missing}")
        else:
            ok(f"Bridge/Rust command parity: {len(invoked)} invoked commands")

    pet = (ROOT / "frontend" / "renderer" / "pet.js").read_text(encoding="utf-8")
    if "setInterval(syncUiBusy, 700)" in pet or "setInterval(reportVisualBounds, 3000)" in pet:
        fail("Permanent 700 ms / 3 s renderer polling remains")
    elif "ResizeObserver" in pet:
        ok("Permanent 700 ms / 3 s polling removed; ResizeObserver present")
    else:
        fail("Polling removed but ResizeObserver event path missing")


def main() -> int:
    check_json()
    check_yaml()
    check_js()
    check_rust_lexical()
    check_assets()
    check_contracts()
    print("\n".join(checks))
    print(f"\nSUMMARY: {len(checks) - len(failures)} passed, {len(failures)} failed")
    if failures:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
