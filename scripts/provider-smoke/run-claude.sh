#!/usr/bin/env bash
# Octopus provider-smoke driver: claude (2026-08-30).
# Drives the REAL Claude Code CLI headless against a local mock Anthropic
# Messages API (ANTHROPIC_BASE_URL) so a genuine session runs a tool and
# finishes a turn. Four passes:
#   1) observer  — hooks only record (no decision output)
#   2) allow     — PreToolUse emits permissionDecision allow
#   3) deny      — PreToolUse emits permissionDecision deny (tool must NOT run)
#   4) ask       — PreToolUse emits permissionDecision ask (observe behavior)
# Evidence is derived only from what actually reached the capture file.
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

export OCTOPUS_SMOKE_CAPTURE_FILE="$EVDIR/claude-hooks.jsonl"
export MOCK_LLM_LOG="$EVDIR/claude-mock-anthropic.jsonl"
CL_OUT="$EVDIR/claude-run.out"; CL_ERR="$EVDIR/claude-run.err"
rm -f "$OCTOPUS_SMOKE_CAPTURE_FILE" "$CL_OUT" "$CL_ERR"

node "$SMOKE/mock-anthropic.js" >"$EVDIR/mock-anthropic.log" 2>&1 & PIDS+=($!)

mkdir -p "$HOME_DIR/work" "$HOME_DIR/.claude"
echo "SMOKE-123" > "$HOME_DIR/work/hello.txt"
echo "OUTSIDE-456" > "$HOME_DIR/outside.txt"

# hook settings — same shape install_claude writes (matcher/groups/command),
# command points at our recording shim instead of the octopus-hook binary.
SHIM="$SMOKE/claude-decide-shim.js"
hook_entry() {
  printf '"%s":[{"matcher":"","hooks":[{"type":"command","command":"node %s %s","timeout":15,"statusMessage":"Updating Octopus"}]}]' "$1" "$SHIM" "$1"
}
cat > "$HOME_DIR/.claude/settings.json" <<JSON
{
  "env": { "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "DISABLE_TELEMETRY": "1" },
  "hasCompletedOnboarding": true,
  "hooks": {
    $(hook_entry SessionStart),
    $(hook_entry SessionEnd),
    $(hook_entry UserPromptSubmit),
    $(hook_entry PreToolUse),
    $(hook_entry PostToolUse),
    $(hook_entry Notification),
    $(hook_entry Stop)
  }
}
JSON
# minimal onboarding state so -p mode does not wait for interactive setup
cat > "$HOME_DIR/.claude.json" <<'JSON'
{ "hasCompletedOnboarding": true, "theme": "dark", "verbose": false }
JSON

export ANTHROPIC_BASE_URL="http://127.0.0.1:4598"
export ANTHROPIC_AUTH_TOKEN="smoke-token"
export ANTHROPIC_API_KEY=""
export MOCK_TOOL_FILE="$HOME_DIR/work/hello.txt"

run_pass() { # $1 label, $2 decision env value
  echo "=== pass:$1 decision:${2:-none} ===" >> "$CL_ERR"
  CLAUDE_SMOKE_DECISION="$2" timeout 60 claude -p --model claude-sonnet-4-5 \
    "Use the Read tool to read hello.txt in the current directory, then reply with its exact content." \
    </dev/null >>"$CL_OUT" 2>>"$CL_ERR"
  echo "pass:$1 rc=$?" >> "$CL_ERR"
}

cd "$HOME_DIR/work"
run_pass observer ""
run_pass allow allow
run_pass deny deny
run_pass ask ask

sleep 1
node -e '
const fs = require("fs");
const [evPath, capPath, errPath, outPath] = process.argv.slice(1);
const read = (p) => fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
const lines = (p) => read(p).split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const caps = lines(capPath);
const events = new Set(); const decisions = new Set(); const transcripts = [];
let sessionIds = new Set(); let payloadKeys = {};
for (const c of caps) {
  if (c.event) events.add(c.event);
  if (c.payload && c.payload.session_id) sessionIds.add(c.payload.session_id);
  if (c.payload && typeof c.payload === "object") {
    payloadKeys[c.event] = Object.keys(c.payload).sort().join(",");
  }
  if (c.decision) decisions.add(c.decision);
  if (c.event === "PreToolUse" || c.event === "PostToolUse") {
    const t = c.payload && c.payload.tool_name;
    transcripts.push(`${c.event}${c.decision ? ":" + c.decision : ""}:${t || "tool"}`);
  }
}
const errTail = read(errPath).split("\n").slice(-100).join("\n");
const outTail = read(outPath).split("\n").slice(-30).join("\n");
const mapped = new Set();
for (const n of events) {
  if (n === "SessionStart") mapped.add("session-start");
  if (["PreToolUse", "PostToolUse"].includes(n)) mapped.add("tool");
  if (n === "Stop") mapped.add("turn-end");
}
const evidence = {
  provider: "claude",
  cliVersion: require("child_process").spawnSync("claude", ["--version"], { encoding: "utf8" }).stdout.trim() || "unknown",
  events: [...mapped],
  rawHookEventsObserved: [...events],
  permissionDecisions: [...decisions],
  commandTranscripts: transcripts.slice(0, 20),
  sessionIds: [...sessionIds].slice(0, 4),
  payloadKeysByEvent: payloadKeys,
  captureRecords: caps.length,
  notes: [],
  stdoutTail: outTail.slice(-2000),
  stderrTail: errTail.slice(-4000),
};
fs.writeFileSync(evPath, JSON.stringify(evidence, null, 2) + "\n");
' "$EVIDENCE" "$OCTOPUS_SMOKE_CAPTURE_FILE" "$CL_ERR" "$CL_OUT"
echo "run-claude: evidence written to $EVIDENCE"
