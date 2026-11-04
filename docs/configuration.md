# Configuration

Precedence, highest first: explicit function option (tests only) > env var >
`.opencode/ai-context.config.yaml` (team-shared, committable) > built-in
default ([ADR-0014](adr/0014-project-config-file-precedence.md)). The file is
auto-created on first start with every key and its default value; restart
opencode after editing it. The generated file is the reference for every
setting (default, effect, environment variable); there is no separate example file. The plugin is **opt-in per repository**
([ADR-0029](adr/0029-opt-in-enabled-flag-and-default-template.md)): the
generated file has `enabled: false`, and while it is off (or the key is missing)
the plugin only keeps the file and does nothing else. Set `enabled: true` to
switch it on.

## Keys

| YAML key | Env var | Default | Effect |
| --- | --- | --- | --- |
| `enabled` | `AI_CONTEXT_PLUGIN_ENABLED` (`1`/`0`) | `false` | Master switch. Off: no index, no indexing, no worker, no tools, no agent hint, no skills/`.gitignore` writing, no popups; only the config file is provided. A missing key counts as off. |
| `data_dir` | `AI_CONTEXT_PLUGIN_DATA_DIR` | `~/.local/share/ai-context-opencode-plugin` (an existing `~/.local/share/opencode-ai-context-plugin` from before the rename keeps being used until you move it) | Per-project SQLite stores. Must be outside the worktree (else the plugin's writes re-trigger indexing). |
| `model_cache_dir` | `AI_CONTEXT_PLUGIN_MODEL_CACHE_DIR` | shared HF cache | Private model cache (air-gapped setups). |
| `embed_dims` | `AI_CONTEXT_PLUGIN_EMBED_DIMS` | unset (768) | Matryoshka truncation, 1..768; faster search, slightly lower quality. Changing it requires a re-index. |
| `heavy_mode` | `AI_CONTEXT_PLUGIN_HEAVY_MODE` | `false` | No functional effect today. |
| `max_memory_mb` | | `6144` | Soft RSS ceiling of the host while indexing; over it the indexer GCs, waits, then stops with a readable error. |
| `embed_threads` | | `6` | onnxruntime threads. Lower = less CPU/fan. |
| `embed_concurrency` | | `3` | Files indexed in parallel and inferences the shared worker runs at once. `1` = sequential. |
| `embed_max_tokens` | | `512` | Hard cap per embedded text; chunks are split to fit. Attention memory grows quadratically. |
| `max_file_bytes` | | `1048576` | Larger files are skipped and listed in the status file; retried when they change. |
| `os_notifications` | `AI_CONTEXT_OS_NOTIFICATIONS=0` | `true` | OS popups for start, finish and failure. |
| `allowed_repos` | | `[]` | Names (no hash) of other indexed projects this repo may search; written by `ai_context_allow_repo`, applied without restart. A legacy `ai-context/config/allowed-repos.json` is imported once. |
| `exclude` | | `[]` | gitignore-style patterns never indexed (on top of `.gitignore`); excluded directories are not descended into. |
| `install_skills` | `AI_CONTEXT_INSTALL_SKILLS=0` | `true` | Install the bundled skills (`index-status`, `cross-repo`) into `.opencode/skills/`. |
| `agent_hint` | | `true` | Append the tool-preference rule block to the system prompt. |
| `tool_log` | | `false` | Write every tool call (time, tool, session, arguments truncated to 200 chars, response summary: size, counts, first paths, error, empty) to `.opencode/ai-context/tool.log.md`. Git-ignored; at 5 MB the file is rotated to `tool.<time>.log.md` and the newest 10 rotated files are kept. |
| `tool_log_full_responses` | | `false` | With `tool_log`: no truncation at all: complete arguments and complete response text. Code of this repo and of linked repos then lands in the log; see [data boundary](data-boundary.md). |
| `reranker` | - | `true` | Cross-encoder re-ranking of search results. |
| `file_summaries` | - | `true` | One summary chunk per multi-chunk file. |
| `summary_llm` | - | oMLX `http://127.0.0.1:8000/v1`, `Qwen2.5-Coder-3B-Instruct-MLX-4bit` | Block `base_url`, `model` (exact name), `api_key_env?`, `timeout_ms?`; `false` disables the LLM. The API key is never read from the file (a literal `api_key` is ignored with a warning): export it as `AI_CONTEXT_SUMMARY_LLM_API_KEY` or the variable named by `api_key_env`; without one no key is sent. On HTTP 401 the user gets an OS popup and an `index_status` notice ("API key not set. Set it with: export AI_CONTEXT_SUMMARY_LLM_API_KEY=<your key> and restart opencode"). Failures fall back to deterministic summaries, which are flagged (`detsum` in the stored fingerprint) and rewritten, summary only, on a later start once the LLM answers; Markdown doc-tree summaries are skipped. Also writes the doc-tree node summaries. Requests carry `tool_choice: "none"` (retried without it on HTTP 400) so servers that inject global MCP tools answer with prose; answers that are JSON tool calls are rejected. File content is sent to `base_url`; keep it local ([data boundary](data-boundary.md)). |
| `reindex_chunks` / `reindex_summaries` | - | `false` | One-off, reset to `false` by the plugin after a finished run. `reindex_chunks` re-chunks and re-embeds every file (stored summaries kept), `reindex_summaries` rewrites the file summaries only, both `true` re-index everything. A failed or aborted run keeps the flags on. |
| `shared_worker` | `AI_CONTEXT_SHARED_WORKER=0` | `true` | Run embeddings in one shared background process. |

`AI_CONTEXT_PROJECT_FILES=0` disables writing project files (config, skill,
gitignore); used by the unit tests.

At startup the plugin sets `OPENCODE_EXPERIMENTAL_FILEWATCHER=true` (best effort) so OpenCode 1.x runs its file watcher, unless you set `OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER` to anything other than `0`/`false`. OpenCode 2.x ignores the flag; see the README for how indexing stays fresh there.

## Files the plugin writes

| Path | Purpose | Commit? |
| --- | --- | --- |
| `.opencode/ai-context.config.yaml` | settings | yes |
| `.opencode/ai-context/index-status.json` | live progress | no (auto-ignored) |
| `.opencode/ai-context/index-tree.md`, `error.log.md`, `tool.log.md` | indexed-file tree, failures, tool-call log (`tool_log`) | no |
| `.opencode/ai-context/backup/index-NNNN.jsonl` (+ `doc-trees.jsonl`, `graph.jsonl`) | versionable index backup, shards of about 10 MB | optional |
| `.opencode/skills/index-status/`, `.opencode/skills/cross-repo/` | bundled skills (`managed-by` marker; remove the marker to own one) | optional |
| `.opencode/.gitignore` | ignores the volatile status file; existing lines are kept | yes |
| `<data_dir>/projects/<key>/index.sqlite` (+ doc trees, graph) | live index | no |
| `<data_dir>/embed-worker.sock`, `embed-worker.log` | shared worker | no |

## Excluding noise

```yaml
exclude:
  - legacy/
  - "*.generated.ts"
```

Stored chunks of newly excluded files are removed when the file changes or is
re-indexed.
