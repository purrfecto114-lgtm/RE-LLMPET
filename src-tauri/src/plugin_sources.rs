// R54 (2026-09-22): focused owner for embedded provider plugin sources.
// Extracted from hook_install.rs when the OpenCode v5 plugin (native event
// names, no cross-provider translation) pushed that file past its audited
// growth budget (maintainability-boundary-smoke: 2434 > 2400). These are
// data, not logic: the JS that runs INSIDE each provider's process. The
// translation dictionaries live in hook_client.rs; install/receipt/marker
// machinery lives in hook_install.rs.

pub(crate) fn opencode_plugin_source() -> &'static str {
    r#"// octopus-opencode-plugin-v6
// R58-1c (2026-10-02): v6 fixes two R54 regressions around child sessions:
//  1. v5 read Message.Info.parentID (which upstream sets to the parent
//     MESSAGE id on EVERY assistant message — session/prompt.ts) and
//     forwarded it as the session parent. Every top-level opencode session
//     went headless after its first completed turn, silencing ALL pet
//     events for it (SubagentStart juggling included). v6 never reads
//     message-level parentID.
//  2. OpenCode dispatches plugin events fire-and-forget (plugin/index.ts:
//     void hook["event"]?.()), so the child's session.created — the ONLY
//     parent-carrier — can arrive AFTER the child's first message frame and
//     be rejected by the same-ms rank gate. v6 learns child lineage into a
//     map and stamps every later child event, plus sends timestamp_ms so
//     the backend can anchor event time to emission, not HTTP arrival.
// R54 (2026-09-22): native event names — NO cross-provider translation.
//
// v4 (and earlier) translated OpenCode's native events into Claude Code
// spellings at the source (session.idle -> "Stop", permission.asked ->
// "Notification", tool.execute.before -> "PreToolUse", ...). That is the
// provider-name mixing this round removes: the pet pipeline received
// Claude-spelled names from an OpenCode process, provenance was unrecoverable,
// and the mapping froze against upstream changes. v5 forwards the
// provider-native `event_type` verbatim; the Rust control plane
// (hook_client::normalize_opencode_native in src-tauri/src/hook_client.rs)
// is the single translator and the single place to keep the dictionary in
// sync with upstream.
//
// Ground truth (2026-09-22, two sources):
//  1. Live smoke tap of opencode 1.18.32 driven against a mock model —
//     reports/provider-smoke/0.6.4/opencode-native-events-tap.jsonl captured
//     the raw manifest actually emitted (session.created/updated/idle/status/
//     diff, message.updated, message.part.updated/delta, permission.asked/
//     replied).
//  2. sst/opencode@1.18.32 packages/schema event manifest (cross-verified
//     by research subagent R54-c): `message.updated` is the role-discriminated
//     user/assistant lifecycle (the REAL user-prompt + turn-end events R40
//     wrongly believed absent); `session.status` union is only
//     idle|busy|retry; `session.idle` is deprecated but still published;
//     `permission.v2.*` / `question.*` are the newer ask/reply surfaces.
//
// Forwarded (native names only): session.created, session.deleted,
// session.error, session.idle, session.compacted, session.status,
// message.updated (role-gated), permission.asked/replied,
// permission.v2.asked/replied, question.asked/replied, plus the
// tool.execute.before/after hook exports.
//
// Deliberately NOT forwarded (verified upstream, no pet-state value):
// session.updated (metadata churn ~7 fires/turn), message.part.* (streaming
// deltas — the say-bubble fires at turn completion), session.diff,
// todo.updated, pty.*, file.*, tui.*, catalog.* — the Rust side drops any
// unknown event_type defensively, but the plugin avoids the traffic.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

async function send(payload) {
  try {
    const runtime = JSON.parse(await readFile(join(homedir(), ".re-llmpet", "runtime.json"), "utf8"));
    if (runtime.app !== "re-llmpet" || runtime.port < 41330 || runtime.port > 41334) return;
    await fetch(`http://127.0.0.1:${runtime.port}/state`, {
      method: "POST", headers: { "content-type": "application/json", "x-re-llmpet-token": runtime.token, "x-re-llmpet-server": "re-llmpet" },
      // R53: this plugin runs INSIDE the opencode process, so process.pid is
      // exactly the terminal process that owns the session. Reporting it lets
      // the desktop app focus that terminal when the user clicks the session
      // ("Cannot focus terminal: session did not report a source process"
      // was the reported bug for every OpenCode session — HTTP-delivered
      // events used to arrive without any pid at all).
      // R58-1c: timestamp_ms anchors event time to emission, not HTTP arrival
      // — the backend freshness gate and same-ms rank ordering both key off
      // it, and out-of-order HTTP delivery was skewing them.
      body: JSON.stringify({ provider: "opencode", source_pid: process.pid,
        timestamp_ms: Date.now(), ...payload }), signal: AbortSignal.timeout(500)
    });
  } catch {}
}
// R58-1c: child-session lineage memory. OpenCode's ONLY session-parent
// carrier is session.created's info.parentID (a SESSION id). Message.Info
// .parentID is the parent MESSAGE id (in-session threading: prompt.ts
// creates every assistant message with parentID: lastUser.id) — v5 misread
// it as a session parent and marked every top-level session headless after
// turn one. Learn children once, stamp all their later events, regardless
// of HTTP arrival order.
const childSessions = new Map(); // childSessionID -> parentSessionID
function stampParent(base) {
  const parent = childSessions.get(base.session_id);
  if (parent) { base.parent_id = parent; base.headless = true; }
}
function sidFromEvent(event, directory) {
  // R54-c: prefer the canonical properties.sessionID; properties.info.id is
  // the session-object shape (session.created/updated/deleted). Historical
  // metadata fallbacks kept for patched/older builds.
  return event?.properties?.sessionID
    || event?.properties?.info?.id
    || event?.properties?.sessionId
    || event?.sessionID
    || event?.metadata?.sessionID
    || `opencode:${directory}`;
}
function sidFromToolInput(input, directory) {
  // Current OpenCode sends { tool, sessionID, callID }; patched/older builds
  // may nest it under metadata. Prefer the canonical field, accept both.
  return input?.sessionID
    || input?.metadata?.sessionID
    || input?.sessionId
    || `opencode:${directory}`;
}
// Bounded message text: the Rust emotion sniffer needs the tail of the
// message (loved/sad/sorry keywords), never the full prompt.
const TEXT_CAP = 1500;
const clip = (text) => (typeof text === "string" ? text.slice(-TEXT_CAP) : undefined);
export const LLMPETPlugin = async ({ directory }) => ({
  event: async ({ event }) => {
    const type = event?.type;
    const properties = event?.properties ?? {};
    const base = {
      // R54: the provider-native event name travels as `event_type`. The
      // v4 field `hook_event_name` (Claude-spelled) is intentionally absent —
      // translation happens only in hook_client::normalize_opencode_native.
      event_type: type,
      session_id: sidFromEvent(event, directory),
      cwd: directory
    };
    // R50: session.created carries info.parentID for child sessions
    // (subagents). Forward it so the backend marks the row headless instead
    // of creating a top-level pseudo session.
    // R58-1c: also LEARN the mapping — session-object events (created/updated)
    // are the only trustworthy parent carriers; remember child→parent so
    // later child frames that arrive without any parent field (tool events,
    // message frames, out-of-order session.created) still get stamped.
    const info = properties.info ?? {};
    if (info.parentID) {
      base.parent_id = info.parentID;
      base.headless = true;
      if (base.session_id && base.session_id !== info.parentID) {
        childSessions.set(base.session_id, info.parentID);
      }
    }
    stampParent(base); // heals late/misordered child frames (R58-1c RC2)
    switch (type) {
      case "session.status": {
        // Upstream status union is ONLY {type:"idle"} | {type:"busy"} |
        // {type:"retry", attempt, message, next} — the v4 plugin's
        // waiting/error string branches were dead code. Extract .type for
        // old builds that sent a bare string.
        const status = properties.status ?? event?.status;
        const raw = typeof status === "string" ? status : (status?.type ?? "unknown");
        base.status_raw = raw;
        if (typeof status === "object" && status?.type === "retry") {
          base.retry = { attempt: status.attempt, message: status.message, next: status.next };
        }
        await send(base);
        return;
      }
      case "session.error": {
        // sessionID is optional upstream; bound the error text.
        const error = properties.error;
        base.error_text = (typeof error === "string" ? error : String(error ?? ""))
          .slice(0, 300);
        await send(base);
        return;
      }
      case "message.updated": {
        // R54: the role-discriminated message lifecycle. role:"user" is the
        // REAL user-prompt producer (thinking + emotion sniffing on the
        // text); role:"assistant" WITH time.completed is the REAL turn-end
        // producer (attention + token metering + say-bubble). Assistant
        // updates without time.completed are streaming noise — skipped.
        const msg = properties.info ?? {};
        const role = msg?.role;
        if (role !== "user" && role !== "assistant") return;
        base.role = role;
        // R58-1c: DO NOT read msg.parentID here — upstream Message.Info
        // .parentID is the parent MESSAGE id (session/prompt.ts sets it on
        // every assistant message: parentID: lastUser.id). v5 forwarded it as
        // a session parent, marking every top-level session headless after
        // its first completed turn and silencing all pet events for it.
        stampParent(base);
        if (role === "user") {
          base.text = clip(msg?.summary);
          if (msg?.model?.modelID) base.model = msg.model.modelID;
        } else {
          if (!msg?.time?.completed) return;
          base.completed = true;
          base.last_assistant_message = clip(msg?.summary);
          if (msg?.tokens && typeof msg.tokens === "object") base.tokens = msg.tokens;
          if (typeof msg?.cost === "number") base.cost_usd = msg.cost;
          if (msg?.modelID) base.model = msg.modelID;
        }
        await send(base);
        return;
      }
      // Plain observers: the Rust dictionary derives state.
      case "session.created":
      case "session.deleted":
      case "session.idle":
      case "session.compacted":
      case "permission.asked":
      case "permission.replied":
      // R56: the Rust dictionary has had question.v2 arms since R54; the
      // plugin never forwarded them, so a v2-mode OpenCode silently dropped
      // every question round-trip (pet stuck, no needsinput transient).
      case "permission.v2.asked":
      case "permission.v2.replied":
      case "question.asked":
      case "question.replied":
      case "question.v2.asked":
      case "question.v2.replied":
        await send(base);
        return;
      // R56: todo.updated carries the live todos board ({todos: [...]}) —
      // the sessions HUD has a todos consumer (model.rs extract_todo_snapshot
      // reads body.todos via the `direct` path) but OpenCode never had a
      // producer. tool_name "todo" keeps the row out of the TaskList shape.
      case "todo.updated": {
        const todos = Array.isArray(properties.todos) ? properties.todos : null;
        base.tool_name = "todo";
        if (todos) base.todos = todos;
        await send(base);
        return;
      }
      default:
        return;
    }
  },
  "tool.execute.before": async (input) => {
    // Native name + tool identity; whether a task/agent tool raises the
    // juggling (SubagentStart) expression is decided by the Rust dictionary
    // from tool_name — not translated here (R54).
    const tool = input?.tool || input?.toolName || "tool";
    const base = {
      event_type: "tool.execute.before",
      session_id: sidFromToolInput(input, directory),
      cwd: directory,
      tool_name: tool
    };
    // R58-1c: input.parentID reads are dead upstream (hook input is only
    // {tool, sessionID, callID}) — the lineage map is authoritative. The
    // task tool fires here with the PARENT session id, so juggling lands on
    // the parent row even before session.created arrives.
    stampParent(base);
    await send(base);
  },
  "tool.execute.after": async (input) => {
    const tool = input?.tool || input?.toolName || "tool";
    const base = {
      event_type: "tool.execute.after",
      session_id: sidFromToolInput(input, directory),
      cwd: directory,
      tool_name: tool
    };
    // R58-1c: same as above — lineage map authoritative, not input.parentID.
    stampParent(base);
    await send(base);
  }
});
// R13: also export as default for opencode plugin loader compatibility
export default LLMPETPlugin;
"#
}
