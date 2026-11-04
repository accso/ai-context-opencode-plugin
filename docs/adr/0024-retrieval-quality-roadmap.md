# ADR-0024: Retrieval quality roadmap (no vector DB, symbol lookup, deterministic summaries)

## Status

Accepted (2026-10-06). Implemented: FTS5 BM25 + RRF, cross-encoder reranker,
path/symbol embed prefix, `find_symbol`, file summaries (deterministic, optional
OpenAI-compatible LLM) and best-effort enabling of the native `lsp` tool
(`OPENCODE_EXPERIMENTAL_LSP_TOOL`, only effective if the host reads flags after
plugin load). Not done: baseline benchmark, ANN index.

## Context

Open questions: is a vector DB needed for better search, and how do we cover
the original stack's L1 summaries, routing and `resolve_symbol` without Docker?

- Brute-force cosine is exact; an ANN index only makes search faster, not
  better (and slightly lossy). Measured: ~110 ms at 2k, ~580 ms at 10k,
  ~1.75 s at 30k chunks.
- Routing: the original stack already removed its routing LLM; the calling
  agent drives retrieval.
- L1 summaries in the original come from an LLM server (LM Studio).
- `resolve_symbol` in the original is LSP definition/references/hover, which
  opencode's native `lsp` tool provides.

## Decision (plan, in order)

1. **Baseline benchmark** on two indexed projects (fixed query set, recall@k),
   before changing ranking.
2. **FTS5 BM25 + reciprocal rank fusion** replacing the keyword boost; then a
   small ONNX **cross-encoder reranker** in the shared worker.
3. **Embed context**: prefix chunk text with path and symbol name.
4. **`find_symbol` tool** on the existing symbol index (name/prefix to file,
   line, kind, signature); keep the native `lsp` tool for compiler-grade
   answers and mention it in the agent hint. Verify the `lsp` tool is enabled
   in the installed opencode version first.
5. **Deterministic file summaries** from AST/graph (exports, signatures, doc
   comments, imports), embedded as a file-level vector. An LLM-generated
   variant stays optional and opt-in.
6. **ANN index** (e.g. hnswlib/usearch, inside the worker) only above roughly
   20-30k chunks per project; before that, `embed_dims` truncation and a
   vector cache in the worker.

Each step is test-first and gated by the benchmark from step 1.

## Consequences

- No vector database, no Docker, no LLM server required.
- No ported `resolve_symbol`; the lookup tool is lighter and the `lsp` tool
  covers the rest.
- Quality gains are measured, not assumed.
