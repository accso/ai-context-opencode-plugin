# ADR-0013: `web-tree-sitter` (WASM) grammars for per-language chunking, not native bindings

## Status

Accepted (2026-09-16), for the `port-tree-sitter-chunker` follow-up.

## Context

`src/lib/chunker.ts` currently only ports the paragraph-based fallback
from the original stack's `watcher/chunker.py`; the ~1100 remaining
lines of that file are per-language, tree-sitter-boundary-aware chunking
for ~13 languages (Kotlin, TS/TSX, JS/JSX, Python, C#, Java, Swift, Go,
Rust, Ruby, PHP, C/C++, Vue) plus dedicated Markdown/SQL/YAML handling.
Bringing that over requires a real tree-sitter dependency, and there are
two ways to get one in Node:

1. **`node-tree-sitter` + native `tree-sitter-<lang>` npm packages** --
   the reference/most mature ecosystem, but each language package is a
   native addon requiring either a prebuilt binary for the exact
   OS/arch/Node-ABI combination or a local compile toolchain
   (`node-gyp`, a C compiler, Python) at install time.
2. **`web-tree-sitter`** -- tree-sitter's official WASM binding; each
   grammar ships as a `.wasm` file loaded at runtime, no native
   compilation step anywhere in the install path.

This plugin's install story so far has been "one native dependency,
already accepted and isolated" (`onnxruntime-node`, ADR-0004) -- adding
13 more native language-grammar packages on top of that would multiply
exactly the kind of install-time fragility (per-OS/arch/Node-ABI
prebuilt-binary mismatches, CI/sandboxed-environment compile failures)
the plugin has otherwise deliberately avoided by choosing SQLite over
Postgres/Qdrant (ADR-0002) and a hand-rolled embedding pipeline over a
heavier framework (ADR-0004).

## Decision

Use `web-tree-sitter` (WASM) for the per-language chunking grammars, not
native `tree-sitter-<lang>` bindings.

The known cost is per-file parse overhead: WASM tree-sitter parsing is
typically ~1.2-2x slower than the native binding, which is negligible
per-file but accumulates across a full initial index of a very large
repo. This plugin already has an explicit relief valve for that case --
"heavy mode" (`AI_CONTEXT_PLUGIN_HEAVY_MODE`, ADR-0006) hands very large
repos back to the original Docker stack's brute-force-at-scale
architecture -- so accepting a modest WASM indexing-time cost for
typical repo sizes, in exchange for install reliability across
platforms/CI/sandboxes, is consistent with that existing design rather
than a new tradeoff being introduced.

Each grammar's `.wasm` file is loaded lazily per language, mirroring the
lazy-load pattern already used for the embedding model (ADR-0004) --
parse trees for a given language are only needed once a file of that
language is actually chunked, not at plugin startup.

## Consequences

- No native compile step or prebuilt-binary matrix to maintain across
  ~13 additional language packages -- `npm install` stays reliable
  cross-platform, matching the existing `onnxruntime-node`-is-the-one-
  exception posture from ADR-0004.
- Modest per-file/aggregate parse-time cost vs. native bindings, most
  visible during a large repo's first full index -- acceptable given
  "heavy mode" already exists as the escape hatch for repos at that
  scale.
- Official prebuilt `.wasm` grammars don't exist (or aren't current)
  for every one of the ~13 target languages; a few may need building
  from source via `tree-sitter build --wasm` as part of this work,
  vendored alongside the plugin rather than fetched at runtime.
- `chunker.ts`'s existing paragraph-based `chunkText()` fallback remains
  the fallback for any language/file type without a wired-up grammar --
  this decision only changes how tree-sitter itself is obtained, not the
  fallback behavior.

## Alternatives considered

- **`node-tree-sitter` + native per-language npm packages.** Rejected:
  faster and a more complete/mature grammar ecosystem, but reintroduces
  exactly the native-dependency install fragility (per-OS/arch/Node-ABI
  prebuilt binaries or a local compile toolchain) this plugin has
  otherwise avoided; a real risk for CI and restricted/sandboxed
  environments specifically.
- **Skip tree-sitter chunking entirely, keep only the paragraph
  fallback.** Rejected: the whole point of AST-boundary-aware chunking
  (splitting on function/class boundaries rather than arbitrary
  paragraph breaks) is retrieval-quality-sensitive -- the original
  stack's `chunker.py` exists precisely because paragraph-only chunking
  produces worse `semantic_search` results for source code.
