# Status

Last updated: 2026-11-03. Implementation state per feature. Decisions and their
reasoning live in the [ADRs](adr/README.md); the roadmap is at the end.

Legend: **done** = implemented and unit-tested, **partial** = works with known
limits, **planned** = not started.

## Feature matrix

| Area | Feature | State | Notes / ADR |
| --- | --- | --- | --- |
| Tools | `semantic_search` (vector + FTS5 BM25 fused with RRF, optional cross-encoder rerank) | done | [ADR-0024](adr/0024-retrieval-quality-roadmap.md); was [ADR-0004](adr/0004-embedding-backend-onnxruntime-node-manual-wiring.md) |
| Tools | `repo_structure` (directory tree from the index) | done | [ADR-0020](adr/0020-steer-agent-to-context-tools.md) |
| Tools | `analyze_impact` (callers/callees/importers, name-based edges) | done | [ADR-0006](adr/0006-analyze-impact-opt-in-heavy-mode.md) |
| Tools | `search_docs` (PageIndex-style doc tree for every Markdown file, LLM node summaries via `summary_llm`, keyword scoring) | done | [ADR-0009](adr/0009-doc-tree-pageindex-style-markdown-indexing.md) |
| Tools | `index_status` | done | [ADR-0018](adr/0018-indexing-progress-via-status-file-and-tool-responses.md) |
| Tools | `ai_context_list_projects`, `_delete_project`, `_export_backup`, `_export_index_tree`, `_rescan`, `_allow_repo`, `_telemetry_report` | done | [ADR-0023](adr/0023-tool-naming-and-descriptions.md) |
| Tools | `find_symbol` (name lookup in the symbol index; replaces `resolve_symbol`; exact LSP answers: planned, [lsp-roadmap](lsp-roadmap.md)) | done | [ADR-0024](adr/0024-retrieval-quality-roadmap.md) |
| Hooks | Compaction keeps the code locations found by the context tools (`experimental.session.compacting`, off with `agent_hint: false`) | done | [ADR-0024](adr/0024-retrieval-quality-roadmap.md) |
| Index | File summaries (one chunk per multi-chunk file; deterministic or via OpenAI-compatible LLM) | done | [ADR-0024](adr/0024-retrieval-quality-roadmap.md) |
| Index | Tree-sitter chunking TS/TSX/Java/C# | done | [ADR-0013](adr/0013-web-tree-sitter-wasm-for-chunking.md), [ADR-0016](adr/0016-upstream-grammar-packages-current-web-tree-sitter.md) |
| Index | Regex chunking Kotlin/JS/JSX/Python/Swift/Go/Rust/Ruby/PHP/C/C++ | done | tree-sitter for these is an open scope decision |
| Index | Vue/SQL/YAML/TOML splitters, paragraph fallback | done | |
| Index | Decorator re-attachment, dispatch sub-chunking | done | |
| Index | `.gitignore` + extension safelist + `exclude:` | done | [ADR-0008](adr/0008-gitignore-and-extension-safelist-filtering.md) |
| Index | Symbol/import/call graph (TS/JS, Python, Java, Kotlin, C#, Go, Rust, Ruby, C, C++, JSX, Angular DI) | done | edges are name-based |
| Index | Delta indexing on `file.watcher.updated` + startup reconciliation; on 2.x targeted/full rescans after file-changing tool calls and throttled on `session.idle` | done | [ADR-0012](adr/0012-file-watcher-updated-not-file-edited.md) |
| Storage | One SQLite file per project, brute-force cosine | done | [ADR-0002](adr/0002-embedded-sqlite-vector-store-over-postgres-qdrant.md), [ADR-0003](adr/0003-per-project-sqlite-file-isolation.md) |
| Storage | `bun:sqlite` in opencode, `better-sqlite3` under Node | done | [ADR-0017](adr/0017-bun-sqlite-inside-opencode.md) |
| Storage | Repo-local JSONL backup (paged export/import; float16 vectors, ~10 MB hash shards) | done | [ADR-0007](adr/0007-repo-local-versionable-backup.md), [ADR-0028](adr/0028-compact-sharded-backup.md) |
| Storage | Cross-repo allowlist (stores project names without hash, so it is shareable; stored as `allowed_repos` in the config YAML, read live; legacy JSON file imported once) | done | [ADR-0030](adr/0030-allowlist-in-config-yaml.md) |
| Hook | System-prompt block lists linked repos by name (re-read per request) and tells the agent to call `ai_context_list_projects` before assuming a library is not indexed | done | |
| Tools | `project` argument on `repo_structure`, `find_symbol`, `analyze_impact`, `search_docs` (`semantic_search` merges allowed repos); allowlist applied live | done | [ADR-0026](adr/0026-cross-repo-tools-and-parallel-indexing.md) |
| Indexing | Parallel indexing (`embed_concurrency`, worker inference slots), summary overlapped with embedding | done | [ADR-0026](adr/0026-cross-repo-tools-and-parallel-indexing.md) |
| Skills | `cross-repo` skill | done | |
| Index | Self-healing re-index (stamped fingerprints, health checks, doc-tree orphan cleanup) | done | [ADR-0027](adr/0027-self-healing-reindex.md) |
| Runtime | Progress file, `indexingNotice`, OS notifications | done | [ADR-0018](adr/0018-indexing-progress-via-status-file-and-tool-responses.md) |
| Runtime | Token cap, thread cap, file-size cap, memory guard | done | [ADR-0019](adr/0019-bounded-memory-during-indexing.md) |
| Runtime | Shared embedding worker process | done | [ADR-0021](adr/0021-shared-embedding-worker.md) |
| Runtime | Indexer in the shared worker | planned | [ADR-0022](adr/0022-indexer-in-worker.md) (proposed) |
| Observability | Opt-in `tool_log` / `tool_log_full_responses` → `tool.log.md` | done | |
| Agent | System-prompt hint (`agent_hint`) | done, experimental hook | [ADR-0020](adr/0020-steer-agent-to-context-tools.md) |
| Agent | Bundled `index-status` skill | done | |
| Host | OpenCode 2.x entry (`setup`) next to 1.x (`server`); six tools direct, `ai_context_*` in Code Mode; grep/glob steering | done | [ADR-0031](adr/0031-opencode-2x-entry-and-search-steering.md), [checklist](opencode-v2-plugin-checklist.md) |
| Telemetry | In-memory summary + OpenTelemetry API, adoption view | done | [ADR-0011](adr/0011-otel-bring-your-own-backend-telemetry.md) |

## Differences to the original `.ai-context` stack

| Original | Plugin |
| --- | --- |
| Postgres + Qdrant, Docker | SQLite files, no Docker |
| ColBERT re-rank (inference service) | Small cross-encoder re-rank (`reranker`) on FTS5 + vector fusion, no always-on service |
| MCP server + LSP bridge + watcher container | Native opencode tools; LSP bridge planned ([lsp-roadmap](lsp-roadmap.md)) |
| `resolve_symbol` (LSP bridge) | `find_symbol` (symbol index); LSP part planned; provenance trace and structural roles not ported |
| L1 file summaries (local LLM) | File summaries: deterministic, or written by a local OpenAI-compatible LLM (`summary_llm`, default oMLX); routing LLM not ported; fallback summaries are redone once the LLM answers, `reindex_chunks`/`reindex_summaries` force a re-index ([ADR-0027](adr/0027-self-healing-reindex.md)) |

## Behaviour change: opt-in per repository

Since ADR-0029 the plugin is off in every repository whose
`.opencode/ai-context.config.yaml` lacks `enabled: true`. Existing config files
are not migrated; add the key by hand.

## Known limitations

- Brute-force search: ~110 ms at 2k chunks, ~580 ms at 10k, ~1.75 s at 30k
  chunks (768 dims, measured during the storage spike). Very large repos will
  need an ANN index or `embed_dims` truncation.
- `analyze_impact` edges are name-based; ambiguous edges are flagged, confirm
  by reading the call site (LSP bridge: [lsp-roadmap](lsp-roadmap.md)).
- `semantic_search` covers source code only; Markdown documents are reachable
  through `search_docs`.
- The memory guard is a soft ceiling checked between files; the hard bound is
  `embed_max_tokens`.
- `experimental.chat.system.transform` (2.x: the `context` hook) is experimental in opencode; without it
  only the tool descriptions steer the agent.
- Not yet verified: long-running sessions with many ACP instances; the exact
  per-instance RSS after the startup memory fix.
- `heavy_mode` has no functional effect (kept as plumbing).

## Roadmap

Retrieval quality plan: [ADR-0024](adr/0024-retrieval-quality-roadmap.md).

1. Evaluate adoption (`ai_context_telemetry_report`, `view: "adoption"`) after
   a few days; add a grep nudge only if needed.
2. ADR-0022 phase 1: move the indexer into the shared worker.
3. Worker PID in `index_status`; configurable `repo_structure` entry cap.
4. Optional tree-sitter chunking for the regex-only languages.
