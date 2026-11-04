# ADR-0022: Move the indexer into the shared worker

Status: proposed (plan only, not implemented)

## Context

ADR-0021 moved the embedding model out of opencode. The rest of indexing
still runs inside every opencode instance: directory walk, file reads,
Tree-sitter WASM parsing, chunking, graph extraction and the SQLite writes.
That costs CPU and memory per instance and needs a per-process guard
(`runtime-registry.ts`) so the two bootstraps of one session do not index
in parallel. Two instances on the same worktree still run two indexers.

## Decision (proposed)

The worker also indexes. The plugin sends `index { worktree, paths | "all" }`
and gets progress events back; the worker owns Tree-sitter parsers, chunker,
graph extraction and the writes to the project's SQLite files.

- One indexing queue per worktree in the worker, so concurrent instances
  never index the same project twice and never hit `database is locked`.
- Progress events feed the existing tracker and `index-status.json`
  (ADR-0018); the plugin keeps the status file and OS notifications.
- Memory guard and `max_memory_mb` apply to the worker; opencode stays small.
- Search, tools and hooks stay in the plugin (read-only on the stores,
  WAL allows readers during writes).
- The worker needs config per request (exclude patterns, `max_file_bytes`,
  chunk limits), sent with each `index` call rather than fixed at spawn.
- Fallback stays: if the worker is unreachable, index in-process as today.

## Phases

1. Protocol: `index`/`progress`/`done`/`failed` messages, worker-side queue
   per worktree (tests with a fake indexer, like `worker.test.ts`).
2. Move `createIndexer` + walker + graph indexer behind an interface the
   worker implements; plugin calls it through the client.
3. Wire progress into the tracker; keep in-process fallback.
4. Measure RSS and CPU per instance before and after.

## Consequences

- Lower per-instance memory and a single indexer per project.
- The worker becomes a larger piece to keep stable; a crash interrupts
  indexing (the existing delta reconciliation resumes it).
- Bundling Tree-sitter WASM and grammars into the worker bundle must be
  checked (they are external packages resolved from the config dir).

## Alternatives considered

- Keep indexing in-process and only bound it further: simpler, but each
  instance still pays the parser and file-content memory.
- One worker per project: more processes, no gain over one queue per project.
