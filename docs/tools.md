# Tool reference

The plugin registers native opencode tools (no MCP server, in-process
registration through the plugin `tool` map).

## Naming scheme ([ADR-0023](adr/0023-tool-naming-and-descriptions.md))

- **Research tools**, used by the agent while working, no prefix.
- **Admin tools**, used by the user on request, prefix `ai_context_`.

**OpenCode 2.x visibility.** The research tools plus `index_status` are listed directly. The
`ai_context_*` admin tools are only reachable in Code Mode: call them with `execute`
(`await tools.ai_context_rescan()`), and use `search({ query: "<name>" })` for a signature that is
not listed. On 1.x all tools are direct. See
[opencode-v2-plugin-checklist.md](opencode-v2-plugin-checklist.md).

## Research tools

| Tool | Use when | Arguments | Returns |
| --- | --- | --- | --- |
| `repo_structure` | You are new to a project or area; replaces listing directories one by one | `dir_path?`, `depth?`, `project?` (name of another allowed project, no hash) | Directories first with file count and languages, then files |
| `semantic_search` | Conceptual question about **source code** ("where do we retry failed requests?") | `query`, `limit?` | Ranked chunks: path, line range, symbol, score, `project`; follow up with `read` on the line range |
| `analyze_impact` | Before changing, renaming or removing a function/class/method | `symbolName`, `path?`, `direction?` (callers/callees/both), `depth?`, `project?` (another allowed project) | Callers/callees/importers with file and line, plus `tests` (test files that import or call the symbol); edges are name-based, ambiguous ones flagged, confirm with `lsp` (1.x) or by reading the call site (2.x) |
| `find_symbol` | You know (part of) a class/function/method name and want its definition | `query`, `kind?`, `limit?`, `project?` (another allowed project) | Matches with path, line range, kind, container, plus `tests` (test files that import or call them); exact references via native `lsp` (1.x) or `analyze_impact` (2.x) |
| `search_docs` | Docs, ADRs, RFCs, design decisions (Markdown) | `query` (keywords), `mode?` (`toc_only`, `summary_only`, `node_text`), `limit?`, `project?` (another allowed project) | Matching sections from the document trees |
| `index_status` | Empty or partial results, or an `indexingNotice` in a response | `limit?` | File/chunk counts, newest `indexed_at`, recent changes, live progress, failed files |

`semantic_search` does not cover Markdown documents (they are stored as a tree,
not chunked); use `search_docs` for them. Results are fused from vector search and FTS5 BM25 (reciprocal rank fusion) and
re-ranked by a small cross-encoder (`reranker`). Chunks of type `file-summary`
describe a whole file. Exact identifiers: `find_symbol` or `grep`.

While an index run is active, results carry an `indexingNotice` so the agent
knows they may be incomplete.

## Admin tools

| Tool | Purpose |
| --- | --- |
| `ai_context_list_projects` | List indexed projects (name, key, size); use the `name` as `project` argument |
| `ai_context_delete_project` | Remove a project's stored index |
| `ai_context_export_backup` | Write the JSONL backup into `.opencode/ai-context/backup/` now |
| `ai_context_export_index_tree` | Write `.opencode/ai-context/index-tree.md`: tree of all indexed files (language, chunks) with export date, repo, branch/commit and last index update; also refreshed after each completed indexing run |
| `ai_context_allow_repo` | Add another indexed project to this repo's cross-search allowlist (name validated against the registry; stored as name without hash under `allowed_repos` in the config YAML, so it can be shared); takes effect immediately, no restart |
| `ai_context_rescan` | Re-scan the repository now and index new, changed or deleted files (unchanged files are skipped); use after shell or git operations |
| `ai_context_telemetry_report` | Per-tool call counts, duration, approximate tokens; `view: "adoption"` shows context tools vs. grep/glob |

## Data boundary

Tool results (code, document text, summaries) are returned to the agent and from there to its model provider, which may not be local. See [data-boundary.md](data-boundary.md).

## Steering the agent

Three layers, strongest first ([ADR-0020](adr/0020-steer-agent-to-context-tools.md)):

1. **System-prompt hint** (`agent_hint`): a short rule block appended through
   `experimental.chat.system.transform` (2.x: the `context` session hook; it also tells the agent which tools are direct and how to reach the Code Mode ones). It also maps "create an ai context backup" to `ai_context_export_backup` and "which files are indexed" to `ai_context_export_index_tree`. With `enabled` off (default) no tools and no hint are provided.
2. **Tool descriptions**: what the tool covers and does not, when to use it (in the words a user would say, e.g. "create an ai context backup"), what it returns, the next step. Destructive tools (`ai_context_delete_project`) tell the agent to confirm with the user first.
3. **Bundled skills**, on demand only: `index-status` (progress and tuning) and `cross-repo` (look into other indexed projects: `ai_context_list_projects` → `ai_context_allow_repo` → `project` argument).

Measure the effect with `ai_context_telemetry_report` (`view: "adoption"`).
