#!/usr/bin/env bash
# Octopus provider-smoke driver: opencode (2026-08-30).
# Drives a REAL opencode CLI end-to-end in the isolated HOME provided by
# scripts/real-provider-smoke.js: installs the EXACT plugin source shipped in
# src-tauri/src/hook_install.rs (extracted at runtime), points its runtime
# bridge at a local collector, and uses a local mock OpenAI-compatible model
# server so the CLI genuinely creates a session, executes a tool and finishes
# a turn. Evidence is derived ONLY from what the collector/tap actually saw.
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

# --- capture files -------------------------------------------------------
export OCTOPUS_SMOKE_EVENTS_FILE="$EVDIR/opencode-collector.jsonl"
export OCTOPUS_SMOKE_CAPTURE_FILE="$EVDIR/opencode-hooks.jsonl"
export MOCK_LLM_LOG="$EVDIR/opencode-mock-llm.jsonl"
TAP_LOG="$EVDIR/opencode-raw-events.jsonl"
OC_OUT="$EVDIR/opencode-run.out"; OC_ERR="$EVDIR/opencode-run.err"
rm -f "$OCTOPUS_SMOKE_EVENTS_FILE" "$OCTOPUS_SMOKE_CAPTURE_FILE" "$TAP_LOG"

# --- services ------------------------------------------------------------
node "$SMOKE/collector.js" >"$EVDIR/collector.log" 2>&1 & PIDS+=($!)
MOCK_TOOL_FILE="$HOME_DIR/work/hello.txt" MOCK_TOOL_FILE_ALT="$HOME_DIR/outside.txt" MOCK_TOOL_TURN=1 MOCK_FINAL_TEXT="SMOKE-DONE opencode" \
  node "$SMOKE/mock-llm.js" >"$EVDIR/mock-llm.log" 2>&1 & PIDS+=($!)
for i in $(seq 1 40); do
  if node -e "fetch('http://127.0.0.1:41330/__ping').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; then break; fi
  sleep 0.25
done

# --- workspace -----------------------------------------------------------
mkdir -p "$HOME_DIR/work"; echo "SMOKE-123" > "$HOME_DIR/work/hello.txt"; echo "OUTSIDE-456" > "$HOME_DIR/outside.txt"

# --- opencode config: mock provider + plugin (exact shipped source) -------
OC_CFG="${XDG_CONFIG_HOME:-$HOME_DIR/.config}/opencode"
mkdir -p "$OC_CFG/plugins"
cat > "$OC_CFG/opencode.json" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "model": "mock/mini",
  "autoupdate": false,
  "provider": {
    "mock": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:4599/v1", "apiKey": "smoke" },
      "models": { "mini": { "name": "Mock Mini" } }
    }
  },
  "permission": { "edit": "ask", "bash": "ask", "webfetch": "deny" }
}
JSON
node -e '
const fs = require("fs");
const src = fs.readFileSync(process.argv[1], "utf8");
const m = src.match(/fn opencode_plugin_source\(\) -> &.static str \{\s*r#"(.*?)"#\s*\}/s);
if (!m) { console.error("plugin source not found"); process.exit(1); }
fs.writeFileSync(process.argv[2], m[1]);
' "$REPO_ROOT/src-tauri/src/hook_install.rs" "$OC_CFG/plugins/llmpet-hook.js" || exit 1

# Independent raw-event tap (drift analysis only; does not touch the bridge)
cat > "$OC_CFG/plugins/octopus-raw-tap.js" <<'TAP'
// octopus smoke raw tap (analysis only)
import { appendFile } from "node:fs/promises";
export const OctopusRawTap = async () => ({
  event: async ({ event }) => {
    try {
      await appendFile(process.env.OCTOPUS_TAP_LOG || "/tmp/opencode-raw-events.jsonl",
        JSON.stringify({ ts: new Date().toISOString(), type: event?.type,
          propertyKeys: event?.properties ? Object.keys(event.properties) : [],
          infoKeys: event?.properties?.info ? Object.keys(event.properties.info) : [] }) + "\n");
    } catch {}
  }
});
export default OctopusRawTap;
TAP
export OCTOPUS_TAP_LOG="$TAP_LOG"

# --- runtime bridge -> collector -----------------------------------------
mkdir -p "$HOME_DIR/.re-llmpet"
cat > "$HOME_DIR/.re-llmpet/runtime.json" <<JSON
{ "app": "re-llmpet", "port": 41330, "token": "smoke-token" }
JSON

# --- run -----------------------------------------------------------------
# run 1: tool inside project dir -> auto-allowed, full success chain
# (PostToolUse + session.idle). Plain flags only: a 2026-08-30 probe showed
# `--format json` can wedge headless runs of 1.18.25 when output is piped.
cd "$HOME_DIR/work"
timeout 120 opencode run --model mock/mini \
  "Use the read tool to read hello.txt in the current directory, then reply with its exact content." \
  >"$OC_OUT" 2>"$OC_ERR"
RC=$?
echo "opencode run1 rc=$RC" >> "$OC_ERR"

# run 2: tool outside project dir with permission=ask -> non-interactive
# auto-deny, which still exercises permission.asked -> Notification bridge
timeout 120 opencode run --model mock/mini \
  "Use the read tool to read $HOME_DIR/outside.txt, then reply with its exact content." \
  >>"$OC_OUT" 2>>"$OC_ERR"
RC2=$?
echo "opencode run2 rc=$RC2" >> "$OC_ERR"

# --- evidence ------------------------------------------------------------
sleep 1
node -e '
const fs = require("fs");
const [evPath, collPath, tapPath, errPath, outPath, rc1, rc2] = process.argv.slice(1);
const read = (p) => fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
const lines = (p) => read(p).split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const coll = lines(collPath);
const tap = lines(tapPath);
const errTail = read(errPath).split("\n").slice(-120).join("\n");
const outTail = read(outPath).split("\n").slice(-40).join("\n");

const events = new Set(); const transcripts = []; const rawTypes = new Set();
let sawTokenHeader = false; let sawPathState = false;
for (const r of coll) {
  sawPathState = sawPathState || r.url === "/state";
  sawTokenHeader = sawTokenHeader || Boolean(r.token);
  const n = r.body && r.body.hook_event_name;
  if (n) {
    events.add(n);
    if (n === "PreToolUse" || n === "PostToolUse" || n === "SubagentStart" || n === "SubagentStop") {
      transcripts.push(`${n}:${(r.body.tool_name || "?")}`);
    }
  }
}
for (const t of tap) rawTypes.add(t.type);
const mapped = new Set();
for (const n of events) {
  if (n === "SessionStart") mapped.add("session-start");
  if (["PreToolUse","PostToolUse","SubagentStart","SubagentStop"].includes(n)) mapped.add("tool");
  if (n === "Stop") mapped.add("turn-end");
}
const evidence = {
  provider: "opencode",
  cliVersion: require("child_process").spawnSync("opencode", ["--version"], { encoding: "utf8" }).stdout.trim() || "unknown",
  events: [...mapped],
  rawHookEventsObserved: [...events],
  rawOpencodeEventTypes: [...rawTypes],
  permissionDecisions: [],
  permissionMode: "native-only",
  commandTranscripts: transcripts.slice(0, 20),
  collectorRecords: coll.length,
  bridgeAuthSeen: sawTokenHeader,
  bridgePathState: sawPathState,
  exitCodes: [Number(rc1), Number(rc2)],
  notes: [],
  stdoutTail: outTail.slice(-2000),
  stderrTail: errTail.slice(-4000),
};
if (coll.length === 0) evidence.notes.push("collector received nothing — plugin load or runtime.json discovery failed; see stderrTail");
if (!sawTokenHeader && coll.length > 0) evidence.notes.push("X-Re-Llmpet-Token header missing on bridge posts");
if (!evidence.permissionMode) evidence.permissionMode = null;
fs.writeFileSync(evPath, JSON.stringify(evidence, null, 2) + "\n");
' "$EVIDENCE" "$OCTOPUS_SMOKE_EVENTS_FILE" "$TAP_LOG" "$OC_ERR" "$OC_OUT" "$RC" "$RC2"
echo "run-opencode: evidence written to $EVIDENCE"
