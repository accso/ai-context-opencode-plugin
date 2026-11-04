# ADR-0020: Steer the agent to the context tools

Status: accepted

## Context

The agent preferred opencode's built-in grep/glob/read over this plugin's
tools. The `semantic_search` description even said "Prefer grep/glob first".
Skills are loaded on demand only, so they are the weakest lever.

## Decision

- Rewrite tool descriptions: `semantic_search` is used first for concept
  questions; grep/glob only for exact identifiers.
- Append a short rule block to the system prompt via the
  `experimental.chat.system.transform` hook (runs server-side, also under
  ACP). Config `agent_hint: false` disables it.
- New tool `repo_structure`: directory tree from the index (dirs first with
  file count and languages), `dir_path`, `depth`, and `project` to inspect
  another allowed project (cross-repo allowlist). Structure only, no
  summaries, so no extra model or RAM.
- `ai_context_telemetry_report` gets `view: "adoption"`: share of context-tool calls
  vs grep/glob, overall and per session, to measure whether steering works.
- No separate `list_recent_changes` tool: `index_status` already
  returns the most recently indexed files.

## Consequences

- The hook is marked experimental in opencode; if inactive, only the
  descriptions apply.
- The hint costs a few hundred tokens per request.
- Cross-project reads open the other project's SQLite store; `repo_structure`
  reads only file paths, not vectors.

## Alternatives considered

- Skill only: loaded on demand, rarely triggered.
- Nudge appended to broad grep results (`tool.execute.after`): deferred until
  the adoption numbers show it is needed.

## Amendment: admin tools

The hint and the descriptions of the admin tools now also carry the phrases a
user says: "create an ai context backup" maps to `ai_context_export_backup`,
"which files are indexed" to `ai_context_export_index_tree`, and the
descriptions of the project list, telemetry report and delete tools name their
trigger. `ai_context_delete_project` tells the agent to confirm with the user
first. Without these lines the agent never matched such requests to a tool.
