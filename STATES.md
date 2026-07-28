# Runtime state model

The authoritative implementation is `src-tauri/src/model.rs`; renderer aggregation is in `frontend/renderer/pet.js`.

## Normalized states

| State | Meaning | Typical native events |
|---|---|---|
| `waiting` | A blocking permission card is pending | PermissionRequest / CodeWhale tool_call_before |
| `needsinput` | Structured user input or notification is required | AskUserQuestion, Elicitation, Notification |
| `sweeping` | Context compaction or session cleanup | PreCompact, SessionEnd |
| `juggling` | Subagent or parallel work | SubagentStart / spawn |
| `working` | Tool execution | PreToolUse, PostToolUse |
| `thinking` | Model planning/reasoning | UserPromptSubmit, PostCompact |
| `loafing` | Agent/subagent idle signal | TeammateIdle |
| `error` | Native failure | StopFailure, PostToolUseFailure, on_error |
| `idle` | No higher-priority active state | Stop or resolved interaction |

Provider-native event names are retained for diagnostics; normalization does not imply that every provider supports the same lifecycle or permission controls.

## Ordering and staleness

Lifecycle updates use timestamp, optional sequence, terminal rank, and event identity. A late lower-rank event cannot overwrite a newer terminal state. SessionEnd entries expire after the bounded retention interval.

## Parallel permissions

Every distinct permission is keyed by its own `permId`. Multiple cards may share one session. Only an exact provider + session + tool + input signature is treated as a retry and shares a decision. Resolving one card leaves the session in `waiting` while any other card remains.

## UI priority

The pet gives blocking interaction precedence over transient animation, errors, needs-input, cleanup, work, thinking, and idle states. The panel continues to list all sessions and all pending choices independently.
