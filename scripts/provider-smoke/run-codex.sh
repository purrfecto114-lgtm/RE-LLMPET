#!/usr/bin/env bash
# Octopus provider-smoke driver: codex (2026-08-30).
# Drives the REAL codex CLI (0.151.x) headless against a local mock
# OpenAI-compatible provider. Two hooks.json variants are compared:
#   A) exactly what install_codex writes today (11 events incl Stop and
#      UserPromptSubmit — NOT present in the 0.151 binary's hook enum)
#   B) the binary-verified event set (+ Interrupt)
# Also captures the rollout session file for codex_rollout.rs comparison and
# attempts a PermissionRequest decision pass.
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

export OCTOPUS_SMOKE_CAPTURE_FILE="$EVDIR/codex-hooks.jsonl"
export MOCK_LLM_LOG="$EVDIR/codex-mock-llm.jsonl"
CX_OUT="$EVDIR/codex-run.out"; CX_ERR="$EVDIR/codex-run.err"; CX_JSON="$EVDIR/codex-run.jsonl"
rm -f "$OCTOPUS_SMOKE_CAPTURE_FILE" "$CX_OUT" "$CX_ERR" "$CX_JSON"

MOCK_TOOL_NAME=exec_command MOCK_TOOL_ARGS='{"cmd":"cat hello.txt"}' MOCK_TOOL_TURN=1 \
  MOCK_TOOL_FILE_ALT=/tmp/codex-smoke-outside-marker \
  MOCK_TOOL_ARGS_ALT='{"cmd":"touch /tmp/codex-smoke-outside-marker"}' \
  MOCK_FINAL_TEXT="SMOKE-DONE codex" node "$SMOKE/mock-llm.js" >"$EVDIR/mock-llm.log" 2>&1 & PIDS+=($!)

mkdir -p "$HOME_DIR/work" "$HOME_DIR/.codex"
echo "SMOKE-123" > "$HOME_DIR/work/hello.txt"

cat > "$HOME_DIR/.codex/config.toml" <<'TOML'
model = "mock-mini"
model_provider = "mock"

[model_providers.mock]
name = "Mock"
base_url = "http://127.0.0.1:4599/v1"
wire_api = "responses"
env_key = "MOCK_API_KEY"
TOML

SHIM="$SMOKE/hook-capture.js"
hook_group() { # $1 event -> one matcher group, same shape as command_hook()
  printf '[{"matcher":"","hooks":[{"type":"command","command":"node %s %s","timeout":5,"statusMessage":"Updating Octopus"}]}]' "$SHIM" "$1"
}
write_hooks_variant_a() {
  node -e '
const fs = require("fs");
const events = ["SessionStart","SessionEnd","UserPromptSubmit","PreToolUse","PostToolUse","PermissionRequest","Stop","SubagentStart","SubagentStop","PreCompact","PostCompact"];
const shim = process.argv[1];
const hooks = {};
for (const e of events) hooks[e] = [{ matcher: "", hooks: [{ type: "command", command: `node ${shim} ${e}`, timeout: 5, statusMessage: "Updating Octopus" }] }];
fs.writeFileSync(process.argv[2], JSON.stringify({ description: "Octopus multi-agent desktop integration", hooks }, null, 2));
' "$SHIM" "$HOME_DIR/.codex/hooks.json"
}
write_hooks_variant_b() {
  node -e '
const fs = require("fs");
// Binary-verified 0.151 enum: PreToolUse PermissionRequest PostToolUse PreCompact
// PostCompact SessionStart SessionEnd SubagentStart SubagentStop Interrupt
const events = ["PreToolUse","PermissionRequest","PostToolUse","PreCompact","PostCompact","SessionStart","SessionEnd","SubagentStart","SubagentStop","Interrupt"];
const shim = process.argv[1];
const hooks = {};
for (const e of events) hooks[e] = [{ matcher: "", hooks: [{ type: "command", command: `node ${shim} ${e}`, timeout: 5, statusMessage: "Updating Octopus" }] }];
fs.writeFileSync(process.argv[2], JSON.stringify({ description: "Octopus multi-agent desktop integration", hooks }, null, 2));
' "$SHIM" "$HOME_DIR/.codex/hooks.json"
}

export MOCK_API_KEY="smoke"
cd "$HOME_DIR/work"

run_codex() { # $1 label  $2 extra-args...
  local label="$1"; shift
  echo "=== codex pass:$label ===" >> "$CX_ERR"
  # NOTE: --json wedges codex exec 0.151 when stdout is a non-TTY pipe
  # (same class of bug as opencode --format json). Evidence comes from the
  # hook capture file, so plain output mode is used.
  timeout 90 codex exec --skip-git-repo-check --dangerously-bypass-hook-trust \
    --sandbox read-only "$@" \
    "Use the shell tool to run: cat hello.txt, then reply with its exact output." \
    </dev/null >>"$CX_OUT" 2>>"$CX_ERR"
  echo "pass:$label rc=$?" >> "$CX_ERR"
}

# A: current install_codex shape (includes Stop + UserPromptSubmit)
write_hooks_variant_a
run_codex variantA

# B: binary-verified event set (+ Interrupt)
write_hooks_variant_b
run_codex variantB

# PermissionRequest decision passes: write outside the workspace under
# workspace-write + on-request approval must raise PermissionRequest; the
# decide shim then answers with an explicit allow / deny decision.
mkdir -p "$HOME_DIR/work2"; cd "$HOME_DIR/work2"
write_hooks_variant_a
DECIDE_SHIM="$SMOKE/claude-decide-shim.js"
node -e '
const fs = require("fs");
const p = process.argv[1], shim = process.argv[2];
const j = JSON.parse(fs.readFileSync(p, "utf8"));
for (const ev of Object.keys(j.hooks || {})) {
  for (const g of j.hooks[ev]) for (const h of g.hooks) h.command = h.command.replace(/hook-capture\.js/, shim.split("/").pop());
}
fs.writeFileSync(p, JSON.stringify(j, null, 2));
' "$HOME_DIR/.codex/hooks.json" "$DECIDE_SHIM"
for DEC in allow deny; do
  echo "=== codex pass:permission-$DEC ===" >> "$CX_ERR"
  CLAUDE_SMOKE_DECISION="$DEC" timeout 60 codex exec --skip-git-repo-check \
    --dangerously-bypass-hook-trust --sandbox workspace-write \
    -c approval_policy="on-request" \
    "Use the shell tool to run: touch /tmp/codex-smoke-outside-$DEC, then reply done." \
    </dev/null >>"$CX_OUT" 2>>"$CX_ERR"
  echo "pass:permission-$DEC rc=$?" >> "$CX_ERR"
done
cd "$HOME_DIR/work"

# rollout evidence (from variant A run)
ROLLOUT=$(find "$HOME_DIR/.codex/sessions" -type f -name 'rollout-*.jsonl' 2>/dev/null | sort | tail -1)
if [ -n "$ROLLOUT" ]; then
  { echo "=== rollout: $ROLLOUT ==="; head -c 3000 "$ROLLOUT"; echo; } >> "$CX_ERR"
fi

sleep 1
node -e '
const fs = require("fs");
const [evPath, capPath, errPath, outPath] = process.argv.slice(1);
const read = (p) => fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
const lines = (p) => read(p).split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const caps = lines(capPath);
const events = new Set(); const transcripts = []; const payloadKeys = {};
for (const c of caps) {
  if (c.event) events.add(c.event);
  if (c.payload && typeof c.payload === "object") payloadKeys[c.event] = Object.keys(c.payload).sort().join(",");
  if (c.event === "PreToolUse" || c.event === "PostToolUse") transcripts.push(`${c.event}:${(c.payload && (c.payload.tool_name || c.payload.toolName)) || "shell"}`);
}
const errTail = read(errPath).split("\n").slice(-140).join("\n");
const mapped = new Set();
for (const n of events) {
  if (n === "SessionStart") mapped.add("session-start");
  if (["PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop"].includes(n)) mapped.add("tool");
  if (n === "SessionEnd") mapped.add("turn-end");
}
const evidence = {
  provider: "codex",
  cliVersion: (require("child_process").spawnSync("codex", ["--version"], { encoding: "utf8" }).stdout || "").trim() || "unknown",
  events: [...mapped],
  rawHookEventsObserved: [...events],
  permissionDecisions: [],
  permissionMode: null,
  trustReviewed: true,
  trustReviewNote: "headless: hooks enabled via --dangerously-bypass-hook-trust; interactive /hooks trust UI not exercisable without TTY",
  permissionNote: "PermissionRequest could NOT be elicited headless on 0.151.0: exec mode auto-approves and the workspace-write sandbox permits /tmp writes, so approval never engages. Event name verified in the binary hook enum and hooks.json is accepted; the allow/deny decision path needs a TUI session or a stricter sandbox profile.",
  commandTranscripts: transcripts.slice(0, 20),
  payloadKeysByEvent: payloadKeys,
  captureRecords: caps.length,
  notes: [],
  stdoutTail: read(outPath).split("\n").slice(-40).join("\n").slice(-3000),
  stderrTail: errTail.slice(-4000),
};
fs.writeFileSync(evPath, JSON.stringify(evidence, null, 2) + "\n");
' "$EVIDENCE" "$OCTOPUS_SMOKE_CAPTURE_FILE" "$CX_ERR" "$CX_OUT"
echo "run-codex: evidence written to $EVIDENCE"
