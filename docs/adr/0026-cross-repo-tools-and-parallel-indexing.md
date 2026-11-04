# ADR-0026: Cross-repo tools and parallel indexing

## Status

Accepted (2026-10-06). Amended by [ADR-0030](0030-allowlist-in-config-yaml.md): the allowlist is stored in the config YAML (still read live).

## Context

1. Only `semantic_search` and `repo_structure` could look into other allowed
   projects; `find_symbol`, `analyze_impact` and `search_docs` were limited to
   the current repo, and a repo added with `ai_context_allow_repo` took effect
   only after a restart (the allowlist was read once at startup).
2. Indexing was slow: the shared worker ran one inference at a time, the
   indexer handled one file at a time, and the file-summary LLM call blocked
   the embedding of the same file.

## Decision

1. **Cross-repo:** all research tools accept an optional `project` key (from
   `ai_context_list_projects`). `find_symbol` and `analyze_impact` use the
   other project's `graph.sqlite`, `search_docs` its `doc-trees.sqlite`. Unknown
   or not allowed keys return an error listing the allowed ones. A graph/doc
   file that does not exist is never created in the other project's folder.
   `ai_context_allow_repo` opens the stores immediately.
2. **Skill:** the bundled `cross-repo` skill describes the sequence
   `ai_context_list_projects` → `ai_context_allow_repo` → tool with `project`.
3. **Parallel indexing:** `embed_concurrency` (default 3) sets both the number
   of files indexed in parallel (`fileConcurrency`) and the inference slots of
   the worker (`concurrency`, default 1 when unset). The summary LLM request is
   started before the file's chunks are embedded and awaited afterwards.
   Defaults raised to `embed_threads: 6`, `max_memory_mb: 6144`.

## Consequences

- Faster indexing at the cost of CPU and transient RAM; `embed_concurrency: 1`
  restores sequential behaviour.
- Paths in cross-repo results are relative to the other repo; `read` only works
  inside the current project.
- The same file appearing twice in one batch could be indexed concurrently;
  startup batches contain each file once, so this is accepted.
- Not measured yet: real speed-up on a fresh index (see `docs/status.md`).
