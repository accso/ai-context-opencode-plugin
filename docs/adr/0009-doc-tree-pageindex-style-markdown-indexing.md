# ADR-0009: PageIndex-style hierarchical indexing for long-form Markdown, mutually exclusive with chunking

## Status

Accepted (port-doc-tree-markdown, 2026-09).

## Context

The original stack (`watcher/doc_tree_builder.py` + `mcp-server/src/
doc_tree.ts`) treated long-form Markdown (docs, ADRs, wikis) differently
from source code: instead of paragraph/semantic chunking, it parsed the
document's heading structure into a tree and let an agent navigate it
top-down (table of contents -> node summary -> full node text) --
inspired by the PageIndex approach
(https://github.com/VectifyAI/PageIndex) of reasoning-based retrieval
over a document's own hierarchical structure, rather than flat
similarity search over arbitrary-sized chunks. `chunker.py` gated which
files got this treatment vs. ordinary chunking.

## Decision

Port this as its own path, not a chunker variant:

- `src/indexing/doc-tree-builder.ts` -- `parseMarkdownHeadings` /
  `buildDocTree` / `shouldUseTreeIndex` (the gate deciding whether a
  file is tree-indexed instead of chunked -- mutually exclusive per
  file, matching the original's gate).
- `src/storage/doc-tree-store.ts` -- persists trees in their own SQLite
  file, sibling to the vector store, same per-project directory
  (ADR-0003's isolation applies here too).
- `src/search/doc-tree-search.ts` -- ports `buildToc`/`searchDocTrees`
  (keyword-based node scoring); a `limit` on files returned replaces
  the original's `tokenBudget`, since that fed the original's
  `assembleContext` orchestrator, which this plugin never wired up (no
  equivalent orchestration layer exists here).
- `src/tools/search-docs.ts` exposes it as `search_docs`
  with three modes (`toc_only`/`summary_only`/`node_text`), letting the
  agent progressively drill down instead of getting a flat text blob.

## Consequences

- Long-form docs get structure-aware retrieval (agent can ask for just
  the TOC, then a specific node's summary, then its full text) instead
  of being chunked into arbitrary paragraph-sized pieces that lose the
  document's own organization.
- Because tree-indexing and chunking are mutually exclusive per file,
  every Markdown file is either fully tree-indexed or fully chunked --
  never both -- avoiding duplicate/conflicting representations of the
  same content.
- The doc-tree backup gap (a file separate from the chunk backup not
  covering doc trees at all) was a real critical-review finding, since
  fixed -- see ADR-0007's description of the sibling `doc-trees.jsonl`
  file.
- pandoc-based conversion of non-Markdown document formats (`.docx`
  etc.) into this same tree-indexing pipeline was discussed as a
  future extension but is NOT implemented -- today only Markdown files
  get tree-indexed; other formats are either chunked (if
  extension-safelisted, see ADR-0008) or skipped entirely.

## Update (2026-10-08)

- Every `.md` file is tree-indexed; the former 8-heading threshold is gone
  (`minHeadingsForTree` now defaults to 0), so documents are never chunked.
  A file without headings becomes one root node titled with its path.
- Node and document summaries are written at index time by the `summary_llm`
  server (same client and failure handling as file summaries, own prompt).
  Without a reachable server they stay `null` and ranking uses titles only.

## Alternatives considered

- **Treat Markdown as just another chunkable file type.** Rejected:
  loses the document's own hierarchical structure, which is
  specifically valuable for docs/ADRs/wikis where an agent benefits
  from navigating top-down rather than getting arbitrary paragraph
  chunks ranked by similarity alone.
- **Full PageIndex-style LLM-driven tree construction (using an LLM to
  decide the tree structure, per the original PageIndex project).**
  Not adopted: the ported version uses the document's own heading
  structure directly (deterministic, no extra LLM calls needed), which
  is sufficient for well-structured Markdown docs and keeps this
  feature free of an additional LLM-call dependency.
