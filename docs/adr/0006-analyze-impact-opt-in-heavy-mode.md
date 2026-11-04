# ADR-0006: `analyze_impact` backed by a precomputed symbol/import/call graph, always on

## Status

Accepted, revised (2026-09). Supersedes the earlier "opt-in heavy mode,
then un-register until real" decisions recorded below under History.

## Context

The original stack's MCP server exposed `analyze_impact`: a precomputed,
repo-wide call/import graph. Slimming the plugin first gated it behind
`AI_CONTEXT_PLUGIN_HEAVY_MODE`, then (critical-review finding
"analyze-impact-honest-stub") un-registered it, because its `execute()`
always threw "not implemented yet" -- there was no graph behind it, and a
visible tool that always fails is worse than an absent one.

Those decisions assumed the graph needed heavy infrastructure. It does
not: with tree-sitter already in the plugin (ADR-0013, ADR-0016) and an
embedded SQLite store (ADR-0002), a static graph is cheap to build during
the normal indexing pass.

## Decision

`analyze_impact` is **always registered** and answers from a graph kept
in its own SQLite file (`graph.sqlite`, next to the vector store):

- **Tables** (`storage/graph-store.ts`): `graph_files`, `symbols`,
  `import_edges`, `call_edges`.
- **Extraction** (`indexing/graph/`): one tree-sitter parse per file
  yields symbols, imports and calls for TypeScript/JavaScript, Python,
  Java, Kotlin, C#, Go, Rust, Ruby, C and C++.
- **Resolution** (`import-resolver.ts`, `call-resolver.ts`): imports are
  resolved to repo files; calls are matched by name and narrowed by
  same-file, imported-file, receiver and directory evidence.
- **Indexing** (`graph-indexer.ts`, hooked into `createIndexer`): files
  are stored raw per update and edges are re-resolved once per batch,
  only for what the batch could have changed. Graph failures never block
  chunk indexing.
- **Framework edges** (`framework-extractor.ts`, TS/JS only), reported
  with an edge `kind`: React JSX component usage (`jsx`), Angular
  constructor/`@Inject`/`inject()` references (`inject`), NgModule and
  standalone-component metadata arrays (`decorator`), and selector usage
  in inline templates (`template`). `selector:` values become `selector`
  symbols on their class; a template edge keeps the raw tag in
  `qualifier` and is re-pointed at the owning class whenever selectors
  change, so the component's callers include the templates using it.
  Templates in `templateUrl` files are not analysed.
- **Backup**: `.opencode/ai-context/backup/graph.jsonl`, exported by
  `ai_context_export_backup`, restored on startup when the graph is empty.
- **Ambiguity**: edges that cannot be tied to one definition are flagged
  `ambiguous`. The tool's `hint` tells the agent to confirm them with the
  native `lsp` tool (`goToDefinition` at the call site, `findReferences`
  at the definition), with file:line locations.

`heavyMode` / `isHeavyModeEnabled()` no longer gates anything and has no
functional effect; it stays as plumbing for a future heavy-mode feature.

## Consequences

- Framework edges are heuristic: JSX tags are matched by name, and
  template attributes only when camelCase (to skip `class`, `id`, ...).
- The graph is static and name-based: no type information, no
  tsconfig `paths`, Gradle source roots, Cargo workspaces or Go module
  names in import resolution, and calls inside anonymous callbacks have no
  named caller. Precision is bounded by that; `lsp` remains the exact
  answer, and the tool says so.
- Indexing does slightly more work per file (one extra parse), and the
  graph adds one more file to the per-project data directory.
- The native `lsp` tool is still what callers should use for exact,
  type-aware results; `analyze_impact` saves round trips, it does not
  replace it.
- `.ai-context/lsp-bridge/` stays deleted: the native `lsp` tool covers
  its capability.

## Alternatives considered

- **Keep it opt-in behind heavy mode.** Rejected: the graph is cheap and
  an agent benefits on any repo size.
- **Keep it unregistered and rely on `lsp` only.** Rejected: many
  sequential `lsp` queries are slow for "what does changing X affect".
- **Type-aware resolution via LSP at index time.** Rejected for now:
  needs language servers running during indexing; instead ambiguity is
  surfaced and left to the agent's on-demand `lsp` calls.

## History

- Initial: gate `analyze_impact` behind `AI_CONTEXT_PLUGIN_HEAVY_MODE`
  (`slim-analyze-impact-drop-lspbridge`).
- Revised: un-register entirely because `execute()` was a stub
  (`analyze-impact-honest-stub`).
- Revised (this version): real implementation, always on.
