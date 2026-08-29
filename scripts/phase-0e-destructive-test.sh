#!/usr/bin/env bash
# R44 Phase 0E — Real-machine destructive test script.
#
# This script is NOT run by CI. It is a manual checklist for testing
# Phase 0C+0D on a real Windows/macOS/Linux machine with the actual
# provider CLIs installed. The user requirement was:
#   "不要破坏原本 hooks（创建备份，注意备份的数量）"
#
# Run with: bash scripts/phase-0e-destructive-test.sh
#
# Prerequisites:
#   - RE-LLMPET 0.5.38+ installed
#   - At least one of: Claude Code, CodeWhale, Codex, OpenCode, Aider
#   - Backup of any provider config you care about (this script
#     deliberately tests destructive paths)
set -euo pipefail

echo "=== R44 Phase 0E: Destructive Test Script ==="
echo "WARNING: this script will install and uninstall RE-LLMPET hooks"
echo "into your real provider config files. Proceed only on a machine"
echo "where that is acceptable."
echo
read -p "Continue? (yes/no): " yn
[[ "$yn" == "yes" ]] || { echo "Aborted."; exit 0; }

RECEIPTS_DIR="$HOME/.re-llmpet/receipts"
PROVIDERS=("claude" "codewhale" "codex" "opencode" "aider")

# ──────────────────────────────────────────────────────────────────────────
# Test 1: Fresh install creates receipt + backup
# ──────────────────────────────────────────────────────────────────────────
echo
echo "=== Test 1: Fresh install creates receipt + backup ==="
echo "Action: In the RE-LLMPET panel, enable ONE provider (e.g. claude)."
echo "Expected:"
echo "  - ~/.claude/settings.json now contains re-llmpet hook entries"
echo "  - ~/.claude/.settings.re-llmpet-bak-<ts>.json does NOT exist (first install, no prior config)"
echo "  - $RECEIPTS_DIR/claude-<ts>.json exists with fields:"
echo "      provider, version, installed_at, path, backup_path (null),"
echo "      events, drift_signature"
read -p "Done? (yes): " _

echo
echo "=== Test 2: Re-install creates backup ==="
echo "Action: Manually edit ~/.claude/settings.json (add a comment line)."
echo "Then in RE-LLMPET panel, toggle claude off and on again."
echo "Expected:"
echo "  - ~/.claude/.settings.re-llmpet-bak-<ts>.json now EXISTS"
echo "  - Receipt's backup_path field points to that file"
echo "  - Drift signature in new receipt matches the new file state"
read -p "Done? (yes): " _

echo
echo "=== Test 3: Backup retention cap (5) ==="
echo "Action: Toggle claude off/on 7 times (each time the file changes)."
echo "Expected: at most 5 backup files in ~/.claude/ matching"
echo "  .settings.re-llmpet-bak-*.json"
echo "Count:"
ls -1 ~/.claude/.settings.re-llmpet-bak-*.json 2>/dev/null | wc -l
read -p "Verify count <= 5? (yes): " _

echo
echo "=== Test 4: Receipt retention cap (20) ==="
echo "Action: Toggle claude off/on 25 times."
echo "Expected: at most 20 receipts in $RECEIPTS_DIR matching claude-*.json"
echo "Count:"
ls -1 "$RECEIPTS_DIR"/claude-*.json 2>/dev/null | wc -l
read -p "Verify count <= 20? (yes): " _

echo
echo "=== Test 5: Uninstall surfaces priorReceipt + drift ==="
echo "Action: In RE-LLMPET tray, click 'Uninstall Claude hooks'."
echo "Expected response (visible in pet.log or via get_install_receipts):"
echo "  - priorReceipt: { provider: 'claude', installed_at: <ts>, ... }"
echo "  - installedAt: <ts>"
echo "  - backupPath: <path or null>"
echo "  - driftDetected: false (we just installed, no manual edit)"
echo "  - message: '...user config preserved'"
read -p "Done? (yes): " _

echo
echo "=== Test 6: Drift detection triggers when user edits config ==="
echo "Action: Re-install claude. Then MANUALLY edit ~/.claude/settings.json"
echo "(add any line outside the re-llmpet block). Then uninstall."
echo "Expected:"
echo "  - driftDetected: true"
echo "  - message: 'WARNING: config was modified after install — verify backup'"
read -p "Done? (yes): " _

echo
echo "=== Test 7: Backup failure is fail-closed ==="
echo "Action: Make ~/.claude/ read-only: chmod 555 ~/.claude/"
echo "Then try to re-install claude in RE-LLMPET panel."
echo "Expected:"
echo "  - Install FAILS with 'backup failed for ... Install aborted to"
echo "    protect existing config.'"
echo "  - ~/.claude/settings.json is UNCHANGED"
echo "  - No new receipt written"
echo "Cleanup: chmod 755 ~/.claude/"
read -p "Done? (yes): " _

echo
echo "=== Test 8: All-provider uninstall (0.5.39 bulk pipeline) ==="
echo "Action: Enable 3 providers. Then in tray, choose 'Uninstall all hooks'."
echo "Expected (0.5.39 response):"
echo "  - All 3 providers' hooks removed (or reported as NotFound/Unowned if not installed)"
echo "  - config.providers cleared"
echo "  - Response carries results[] with each provider's CleanupResult"
echo "    (status: removed/notFound/unowned/etc.) + driftDetected per provider"
echo "  - allHooksVerifiedAbsent: true only if every provider is Removed or NotFound"
echo "  - allHooksRemoved: backward-compat alias for allHooksVerifiedAbsent"
echo "  - failures[] lists hard failures (Unreadable/ManualActionRequired)"
read -p "Done? (yes): " _

echo
echo "=== Test 9: IPC commands (0.5.39) ==="
echo "Action: Open devtools on the panel (right-click -> Inspect Element,"
echo "or run with DEBUG=re-llmpet env var if devtools is gated)."
echo "In the console, run:"
echo "  await window.__TAURI__.core.invoke('get_install_receipts')"
echo "Expected: JSON object keyed by provider id, each value is the"
echo "latest receipt. Empty object if no providers installed by 0.5.38+."
echo ""
echo "Also test the new 0.5.39 config-state IPC:"
echo "  await window.__TAURI__.core.invoke('get_config_state')"
echo "Expected: { state: 'healthy', quarantined: false, writesAllowed: true }"
echo ""
echo "To test quarantine: corrupt ~/.re-llmpet/config.json (write '{bad'),"
echo "restart the app, then call get_config_state again. Expected:"
echo "  { state: 'parseError', quarantined: true, writesAllowed: false, message: '...' }"
echo "Recovery: await window.__TAURI__.core.invoke('backup_and_reset_config')"
read -p "Done? (yes): " _

echo
echo "=== Test 10: Backward compat with 0.5.37-installed hooks ==="
echo "Action: If you have an old 0.5.37 install with -re-llmpet-backup-*"
echo "files, install 0.5.39 and verify the legacy sweep removes old"
echo "backups beyond the 5-cap. (0.5.39 still sweeps legacy-named backups.)"
echo "Pre-state (legacy-named backups in ~/.codewhale/):"
ls -1 ~/.codewhale/*re-llmpet-backup* 2>/dev/null | wc -l
echo "Post-state should be <= 5."
read -p "Verify legacy backups pruned? (yes/skip): " _

echo
echo "=== Test 11: SHA-256 drift detection (0.5.39 §5) ==="
echo "Action: Install claude. Note the receipt's drift_signature (64-char hex)."
echo "Manually edit ~/.claude/settings.json — change a single character"
echo "inside the re-llmpet block (NOT adding a line — actually modify bytes)."
echo "Then uninstall claude."
echo "Expected:"
echo "  - driftDetected: true (SHA-256 detected the byte change)"
echo "  - message: 'WARNING: config was modified after install — verify backup'"
echo "  - priorReceipt.drift_signature differs from current file's SHA-256"
read -p "Done? (yes): " _

echo
echo "=== Test 12: CleanupResult variants (0.5.39 §3) ==="
echo "Action: Test each variant:"
echo "  a) NotFound: uninstall a provider that was never installed."
echo "     Expected: status='notFound', message='No RE-LLMPET hooks found...'"
echo "  b) Unowned: create ~/.codex/hooks.json with content that does NOT"
echo "     contain 're-llmpet'. Uninstall codex."
echo "     Expected: status='unowned', file unchanged."
echo "  c) Residue: manually add a 're-llmpet' string to ~/.claude/settings.json"
echo "     in a place remove_all_ours won't find (e.g. inside a non-hook field)."
echo "     Uninstall claude."
echo "     Expected: status='residue', detail explains marker still present."
read -p "Done? (yes): " _

echo
echo "=== All tests complete ==="
echo "If any test failed, file an issue with:"
echo "  - The test number"
echo "  - The observed vs expected behavior"
echo "  - The relevant receipt file: $RECEIPTS_DIR/<provider>-<ts>.json"
echo "  - The relevant backup file: ~/<provider-dir>/.<stem>.re-llmpet-bak-<ts>.<ext>"
echo "  - The RE-LLMPET log: ~/.re-llmpet/re-llmpet.log"
