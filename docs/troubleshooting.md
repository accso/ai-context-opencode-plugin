# Troubleshooting

## The plugin does nothing / no tools in a repository

The plugin is opt-in per repository (ADR-0029). Check
`.opencode/ai-context.config.yaml`: `enabled` must be `true` (a missing key or a
malformed file counts as off), then restart opencode. `AI_CONTEXT_PLUGIN_ENABLED`
overrides the file in both directions.

## Indexing seems stuck, fan is loud

Read `.opencode/ai-context/index-status.json` or call `index_status`.
`phase`: `idle | scanning | loading-model | indexing | done | failed`.
`loading-model` is the one-time model load. Lower `embed_threads`, exclude
generated code with `exclude:`, lower `embed_max_tokens` / `max_file_bytes`.
Live view: the bundled `index-status` skill ships `watch-index-status.sh`.

## Summaries are plain text and a popup says "API key not set"

The summary LLM answered HTTP 401. Export the key and restart opencode:
`export AI_CONTEXT_SUMMARY_LLM_API_KEY=<your key>` (or the variable named by
`api_key_env`). Then set `reindex_summaries: true` to rewrite the fallback
summaries now (they are also redone automatically on the next start). The same
hint is in `notices` of `index_status`.

## A second session starts indexing again

Since ADR-0025 only one process indexes a project (`index.lock` in the project
data directory); other sessions wait and skip files that are already indexed.
Sessions running an older plugin version ignore the lock: restart them.
A leftover lock of a crashed process is taken over after at most 45 s.

## Indexing failed with a memory message

The `max_memory_mb` guard stopped the run. Lower `embed_max_tokens` and
`max_file_bytes`, or raise `max_memory_mb`. See
[ADR-0019](adr/0019-bounded-memory-during-indexing.md).

## `ACP process exited unexpectedly. Exit code: 137` / `database is locked` in `Cache.db`

Exit 137 is an out-of-memory kill. The SQLite lock messages come from the
macOS HTTP cache of the host and are a symptom of memory pressure, not of this
plugin's stores. Look for stale `opencode acp` processes with high RSS
(`ps -axo pid,rss,command | grep opencode`) and end old ones by PID.
Expected: one `opencode acp` per session plus one embedding worker.

## Tool results are empty or partial

Indexing may still be running (`indexingNotice` in the response). Check
`index_status`. For Markdown documents use `search_docs`, not `semantic_search`.

## Agent still prefers grep

Check `agent_hint` is not disabled and look at the adoption view:
`ai_context_telemetry_report` with `view: "adoption"`. The system hook is
experimental in opencode; without it only tool descriptions apply.

## Shared worker problems

Log: `<data_dir>/embed-worker.log`. Socket: `<data_dir>/embed-worker.sock`.
Disable with `shared_worker: false` or `AI_CONTEXT_SHARED_WORKER=0`; the
plugin falls back to in-process embedding. A stale socket is replaced on the
next start.

## Old tool names

`ai_context_search_docs`, `ai_context_index_status` and `telemetry_report`
were renamed (ADR-0023) without aliases; update prompts and skills.

## Reset a project

`ai_context_delete_project` removes the stored index; it is rebuilt on the next
start (or restored from `.opencode/ai-context/backup/`).

## `Unknown or not allowed project`

A tool was called with `project: "<name>"` for a repo that is not on this
repo's allowlist. Use the `cross-repo` skill: `ai_context_list_projects` for the
exact `name` (no hash; a hashed key is not accepted), then
`ai_context_allow_repo`. It applies immediately. If the name is
missing from the list, that repo was never indexed with this plugin.
