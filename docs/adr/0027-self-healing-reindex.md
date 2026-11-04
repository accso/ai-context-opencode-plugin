# ADR-0027: Self-healing re-index on startup

## Status

Accepted (2026-10-08).

## Context

The startup pass skips a file whose `size:mtime` fingerprint is unchanged. That
made changes to *how* files are indexed invisible: documents chunked by an
older version stayed chunks, doc trees without summaries (LLM offline) stayed
empty, and tree-indexed documents were re-read on every start because the skip
test required code chunks. Trees of deleted documents were never removed,
since the stale-file scan only looked at chunks.

## Decision

- The stored fingerprint carries a representation suffix: `#doc<DOC_INDEX_VERSION>`
  for tree-indexed document types; for code `#code<N>` only when
  `CODE_INDEX_VERSION > 1`, and `#nosum` while file summaries are off. Switching
  summaries on, or bumping a version, re-indexes only the affected file kind;
  stores written before this ADR stay valid for code. `EMBED_FORMAT_VERSION`
  remains the full-store reset.
- An unchanged file is skipped only if its index is healthy: code needs chunks;
  a document needs a tree and no chunks (documents are trees only), and a tree
  without any summary is rebuilt while a summarizer is configured (cheap: no
  embedding; the LLM is skipped after three failures).
- The stale-file scan includes doc-tree paths (`DocTreeStore.listPaths`).
- Fallback summaries (amendment, 2026-10-12): when `summary_llm` is configured
  but a code file's summary had to be the deterministic text, the fingerprint
  gets a `detsum` flag (`<fp>#detsum`, or `+detsum` after other suffixes). On a
  later start with an LLM configured, a flagged file gets only its summary chunk
  rewritten (reason `summaries`, no re-embedding of the other chunks); the flag
  is dropped when the LLM answered, kept otherwise. Without a configured LLM the
  flag is ignored.
- Forced re-index (amendment, 2026-10-12): the config keys `reindex_chunks` and
  `reindex_summaries` make the next startup pass ignore fingerprints (reason
  `upgrade`). Chunks only: files are re-chunked and re-embedded, the stored
  summary chunk is kept. Summaries only: just the summary chunk is rewritten
  (documents are rebuilt as a whole, their summaries live in the tree). Both:
  full re-index. After a run without failed files or abort the plugin sets the
  flags back to `false` by editing only those lines of the config file; an
  incomplete run keeps them on so it is repeated.

- Visibility: the indexer classifies every file before the run
  (`new`, `changed`, `removed`, `upgrade` = new index format, `repair`,
  `summaries`) and reports only files that need work. Up-to-date files are
  not counted, so a normal start no longer announces "Indexing started: N
  files". `index-status.json` carries `reasons` (counts per reason). Healing
  (`upgrade`/`repair`/`summaries`) pops up even for a few files: "Updating
  index: 42 files (40 new index format, 2 repaired)" and "Index update
  finished"; plain new/changed runs keep the old popups and the 20-file
  threshold.

## Consequences

- A flagged file is retried on every start while the LLM stays down (one cheap
  attempt, no re-embedding).
- Upgrading re-indexes documents once; code files are untouched.
- When the summary server is permanently down, documents are re-parsed on each
  start (three quick failed calls, then none).
- Changing the chunker or doc-tree builder now requires bumping the matching
  version constant in `src/indexing/indexing.ts`.
