# Architecture Decision Records

This folder records the significant, hard-to-reverse decisions made while
building `ai-context-opencode-plugin` -- the *why*, not just the *what*.
Each ADR is a snapshot of the reasoning at the time it was written; if a
later decision supersedes one, the older ADR is marked `Superseded by
ADR-00NN` rather than deleted or rewritten, so the history of *why we
changed our minds* stays intact.

This package is being developed inside the `ai-context` monorepo but is
written and documented as a standalone, independently extractable
project (see the root `README.md` and `NOTICE`) -- these ADRs are
self-contained and don't assume familiarity with the parent repo,
though several explicitly contrast a decision against what
`.ai-context/`'s older Docker-based stack used to do, since that's the
system this plugin replaces.

## Index

| ADR | Decision |
| --- | --- |
| [0001](0001-replace-docker-stack-with-native-opencode-plugin.md) | Replace the Docker-based MCP server/watcher/LSP-bridge stack with a native OpenCode plugin |
| [0002](0002-embedded-sqlite-vector-store-over-postgres-qdrant.md) | Embedded SQLite + brute-force cosine search instead of Postgres/Qdrant |
| [0003](0003-per-project-sqlite-file-isolation.md) | One SQLite file per project instead of a shared store with a project-key column |
| [0004-embedding-backend-onnxruntime-node-manual-wiring.md](0004-embedding-backend-onnxruntime-node-manual-wiring.md) | Hand-rolled `onnxruntime-node` embedding pipeline instead of the npm `fastembed` package |
| [0005](0005-shared-huggingface-model-cache-directory.md) | Download the embedding model into Hugging Face's shared cache, not a plugin-private directory |
| [0006](0006-analyze-impact-opt-in-heavy-mode.md) | `analyze_impact` backed by a precomputed symbol/import/call graph, always on |
| [0007](0007-repo-local-versionable-backup.md) | Commit-able, repo-local JSONL backup instead of a database dump/service |
| [0008](0008-gitignore-and-extension-safelist-filtering.md) | Enforce `.gitignore` + an extension safelist at both indexing entry points |
| [0009](0009-doc-tree-pageindex-style-markdown-indexing.md) | PageIndex-style hierarchical indexing for long-form Markdown, mutually exclusive with chunking |
| [0010](0010-no-skill-md-self-describing-tool-descriptions.md) | Self-describing tool descriptions instead of a `SKILL.md` file |
| [0011](0011-otel-bring-your-own-backend-telemetry.md) | OpenTelemetry API-only telemetry ("bring your own backend"), dual-written with an in-memory summary |
| [0012](0012-file-watcher-updated-not-file-edited.md) | React to `file.watcher.updated`, not `file.edited`, for re-indexing |
| [0013](0013-web-tree-sitter-wasm-for-chunking.md) | `web-tree-sitter` (WASM) grammars for per-language chunking, not native bindings |
| [0014](0014-project-config-file-precedence.md) | Team-shared `.opencode/ai-context.config.yaml` with env-var override (amended by 0029, 0030) |
| [0015](0015-single-bundled-plugin-file.md) | Single esbuild-bundled plugin file, installed to OpenCode's global plugin directory |
| [0016](0016-upstream-grammar-packages-current-web-tree-sitter.md) | Current upstream tree-sitter grammar packages + `web-tree-sitter` 0.27 instead of `tree-sitter-wasms` |
| [0017](0017-bun-sqlite-inside-opencode.md) | Use `bun:sqlite` inside OpenCode, `better-sqlite3` only under Node |
| [0018](0018-indexing-progress-via-status-file-and-tool-responses.md) | Report indexing progress via a status file and tool responses |
| [0019](0019-bounded-memory-during-indexing.md) | Bounded memory during indexing: token cap, shared runtime, memory guard, paged search |
| [0020](0020-steer-agent-to-context-tools.md) | Steer the agent to the context tools: hint, repo_structure, adoption report |
| [0021](0021-shared-embedding-worker.md) | Shared embedding worker outside opencode |
| [0022](0022-indexer-in-worker.md) | Move the indexer into the shared worker (proposed) |
| [0023](0023-tool-naming-and-descriptions.md) | Tool naming scheme and description rules |
| [0024](0024-retrieval-quality-roadmap.md) | Retrieval quality roadmap: FTS5 + reranker, symbol lookup, deterministic summaries (proposed) |
| [0025](0025-resumable-indexing-and-index-lease.md) | Resumable indexing (file fingerprints) and cross-process index lease |
| [0026](0026-cross-repo-tools-and-parallel-indexing.md) | `project` argument on all research tools, live allowlist, parallel indexing |
| [0027](0027-self-healing-reindex.md) | Self-healing re-index: representation-stamped fingerprints, health checks, doc-tree orphan cleanup |
| [0028](0028-compact-sharded-backup.md) | Compact backup: float16 vectors and hash-sharded `index-NNNN.jsonl` files (amends 0007) |
| [0029](0029-opt-in-enabled-flag-and-default-template.md) | Opt-in per repository via `enabled`, config file generated with default values |
| [0030](0030-allowlist-in-config-yaml.md) | Cross-repo allowlist moves into the config YAML as `allowed_repos` (amends 0014, 0026) |
| [0031](0031-opencode-2x-entry-and-search-steering.md) | OpenCode 2.x entry (`setup`) next to 1.x (`server`), no LSP switching, grep/glob steering (amends 0015, 0020) |

## Format

Each ADR follows a short fixed shape: **Status**, **Context**, **Decision**,
**Consequences**, and (where relevant) **Alternatives considered**. Keep
new ADRs in that shape so they stay skimmable.
