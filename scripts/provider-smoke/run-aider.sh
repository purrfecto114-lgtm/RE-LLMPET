#!/usr/bin/env bash
# Octopus provider-smoke driver: aider (2026-08-30).
# Drives the REAL aider CLI headless against the local mock OpenAI-compatible
# server and verifies the notifications_command bridge (turn-end) end to end.
# Aider contract: turn-end only, permissionMode native-only.
set -u
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SMOKE="$REPO_ROOT/scripts/provider-smoke"
HOME_DIR="${HOME:?real-provider-smoke must set isolated HOME}"
EVIDENCE="${OCTOPUS_PROVIDER_EVIDENCE:?missing evidence path}"
EVDIR="$(dirname "$EVIDENCE")"
mkdir -p "$EVDIR"

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done; }
trap cleanup EXIT

export OCTOPUS_SMOKE_CAPTURE_FILE="$EVDIR/aider-notify.jsonl"
export MOCK_LLM_LOG="$EVDIR/aider-mock-llm.jsonl"
A_OUT="$EVDIR/aider-run.out"; A_ERR="$EVDIR/aider-run.err"
rm -f "$OCTOPUS_SMOKE_CAPTURE_FILE" "$A_OUT" "$A_ERR"

# notifications capture shim: aider appends the message as an argument and
# does NOT close stdin promptly, so read defensively with a short timeout.
cat > "$EVDIR/aider-notify.sh" <<SH
#!/bin/bash
echo "\$(date -u +%FT%TZ) argv=\$*" >> "$OCTOPUS_SMOKE_CAPTURE_FILE"
timeout 2 head -c 4096 > "$EVDIR/aider-notify-stdin.bin" 2>/dev/null || true
exit 0
SH
chmod +x "$EVDIR/aider-notify.sh"

MOCK_TOOL_TURN=0 MOCK_FINAL_TEXT="SMOKE-DONE aider" \
  node "$SMOKE/mock-llm.js" >"$EVDIR/mock-llm.log" 2>&1 & PIDS+=($!)

mkdir -p "$HOME_DIR/work"; cd "$HOME_DIR/work" || exit 1
git init -q . 2>/dev/null || true
echo "SMOKE-123" > hello.txt
git add hello.txt 2>/dev/null; git -c user.email=smoke@t -c user.name=smoke commit -qm init 2>/dev/null || true

# R51: aider >= 0.8x uses configargparse YAMLConfigFileParser, which turns the
# yaml key verbatim into a CLI flag. The flag is --notifications-command
# (dashes), so the yaml key MUST use dashes; the underscore spelling makes
# aider exit(2) with "unrecognized arguments".
cat > "$HOME_DIR/.aider.conf.yml" <<YAML
notifications: true
notifications-command: $EVDIR/aider-notify.sh
YAML

# ring_bell() fires on the NEXT prompt_ask after an LLM turn, so a single
# --message run can never trigger it. Feed two piped prompts instead: turn 1
# sets bell_on_next_input, the second prompt fires the notifications command,
# turn 2 completes and EOF exits cleanly.
printf 'Reply with exactly: SMOKE-ONE\nReply with exactly: SMOKE-TWO\n' | \
OPENAI_API_BASE="http://127.0.0.1:4599/v1" \
OPENAI_API_KEY="smoke" \
  timeout 150 /home/z/aider-venv/bin/aider \
    --model openai/mock-mini \
    --openai-api-base "http://127.0.0.1:4599/v1" \
    --yes-always --no-auto-commits --no-gitignore --no-suggest-shell-commands \
    >"$A_OUT" 2>"$A_ERR"
RC=$?
echo "aider rc=$RC" >> "$A_ERR"

sleep 1
node -e '
const fs = require("fs");
const [evPath, capPath, stdinPath, errPath, outPath, rcRaw] = process.argv.slice(1);
const read = (p) => fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
const capLines = read(capPath).split("\n").filter(Boolean);
const events = new Set();
const transcripts = [];
for (const line of capLines) {
  events.add("turn-end");
  transcripts.push(line.slice(0, 200));
}
if (read(stdinPath).trim()) transcripts.push("stdin:" + read(stdinPath).trim().slice(0, 200));
const evidence = {
  provider: "aider",
  cliVersion: require("child_process").spawnSync("/home/z/aider-venv/bin/aider", ["--version"], { encoding: "utf8" }).stdout.trim() || "unknown",
  events: [...events],
  rawHookEventsObserved: [...events],
  permissionDecisions: [],
  permissionMode: "native-only",
  commandTranscripts: transcripts.slice(0, 10),
  captureRecords: capLines.length,
  notes: capLines.length === 0 ? ["notifications_command never fired — check aider version behavior in stderrTail"] : [],
  exitCode: Number(rcRaw),
  stdoutTail: read(outPath).split("\n").slice(-25).join("\n").slice(-2500),
  stderrTail: read(errPath).split("\n").slice(-40).join("\n").slice(-3500),
};
fs.writeFileSync(evPath, JSON.stringify(evidence, null, 2) + "\n");
' "$EVIDENCE" "$OCTOPUS_SMOKE_CAPTURE_FILE" "$EVDIR/aider-notify-stdin.bin" "$A_ERR" "$A_OUT" "$RC"
echo "run-aider: evidence written to $EVIDENCE"
