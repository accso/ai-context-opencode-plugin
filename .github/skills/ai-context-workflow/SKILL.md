---
name: ai-context-workflow
description: >
  Use for code context, file locations, symbol definitions, change impact or
  documentation lookups in this repository (or another allowed, indexed repo)
  before writing or modifying code. Drives the native ai-context plugin tools:
  repo_structure, semantic_search, find_symbol, analyze_impact, search_docs,
  index_status.
---

# ai-context plugin: codebase context workflow

The tools are native opencode tools provided by this plugin (no MCP server,
no Docker). Prefer them over grep/glob for conceptual questions. Details:
`docs/tools.md`.

1. `repo_structure` — first, for orientation: directories with file counts and
   languages. Narrow with `dir_path` and `depth`.
2. `semantic_search(query)` — conceptual questions about **source code**
   ("where do we retry failed requests?"). Hybrid vector + FTS5 ranking with
   re-ranking; hits include path, line range and symbol. Chunks of type
   `file-summary` describe a whole file (LLM-written when `summary_llm` is
   reachable, deterministic otherwise). Follow up with `read` on the line range.
3. `find_symbol(query, [kind])` — you know part of a class/function/method
   name. Returns definitions plus likely covering tests. For exact references
   use opencode's native `lsp` tool (1.x) or `analyze_impact` (2.x).
4. `analyze_impact(symbolName, [path], [direction], [depth])` — before
   changing, renaming or removing a symbol: callers, callees, importers and
   covering test files. Edges are name-based; ambiguous ones are flagged, so
   confirm with `lsp` (1.x) or by reading the call site (2.x).
5. `search_docs(query, [mode])` — Markdown docs, ADRs, RFCs. Documents are
   stored as heading trees (PageIndex style), never as code chunks. Modes:
   `toc_only` → `summary_only` (default) → `node_text`, drilling down.
6. `index_status` — when results are empty/partial or carry an
   `indexingNotice`; shows progress and failed files.

Other indexed repos: use the `cross-repo` skill (`ai_context_list_projects`,
`ai_context_allow_repo`, then the `project` argument).

Stop as soon as you have enough context; don't call every tool by default. If
`semantic_search` finds nothing after one rephrase, say so instead of guessing.
