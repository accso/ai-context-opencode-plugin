# ADR-0019: Bounded memory during indexing

Status: accepted

## Context

Indexing a repository drove the opencode host process to 16-31 GB RSS and
filled the swap. Measured cause: onnxruntime memory grows quadratically with
the token count of one input (512 tokens ~0.5 GB, 4096 ~4.5 GB), while the
chunker bounded only lines, so a single 15 000-character chunk was enough.
Contributing: two plugin bootstraps per session indexed in parallel, the ORT
arena kept the peak, and `search()` loaded every vector per query.

## Decision

- Embedder caps tokens (`embed_max_tokens`, default 512); chunks are split to
  fit (`chunk-splitter.ts`); files over `max_file_bytes` are skipped.
- ORT session: no CPU arena/mem pattern, sequential execution, `embed_threads`.
- One shared runtime per worktree (`runtime-registry.ts`): one tracker, one
  model session, one startup pass, serial batches.
- Soft guard (`memory-guard.ts`, `max_memory_mb`, default 4096): GC + wait,
  then abort the run as `failed` with a readable reason.
- `search()` reads the table in rowid pages and keeps only the top-K.
- Native OS notifications for start/finish/failure (`os_notifications`).

## Consequences

- A hard RSS cap is impossible inside a Bun process; the guard is best effort,
  the token cap is the actual bound.
- Very long chunks are split, so retrieval granularity changes slightly.
- Skipped files are visible in `index-status.json` and retried on change.
