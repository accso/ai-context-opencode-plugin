# ADR-0016: Current upstream grammar packages + `web-tree-sitter` 0.27 instead of `tree-sitter-wasms`

## Status

Accepted (2026-10). Refines ADR-0013 (WASM over native bindings stays).

## Context

`tree-sitter-wasms` 0.1.13 bundles grammars built with tree-sitter CLI
0.20 from old grammar versions (C# 0.20, Java 0.20, Kotlin 0.3,
Python 0.21, TypeScript/JavaScript 0.20) and pinned `web-tree-sitter` to
0.20.8. Modern syntax (C# 12+, Java 21, Python 3.12, TS 5.x, Kotlin 2.x)
produced ERROR nodes -- unacceptable for the symbol/import/call-graph
extraction that blast-radius analysis needs.

## Decision

- Depend on `web-tree-sitter` ^0.27 and the upstream grammar packages
  (`tree-sitter-c-sharp`, `-java`, `-python`, `-typescript` (also TSX),
  `-javascript`, `@tree-sitter-grammars/tree-sitter-kotlin`), each of
  which ships a prebuilt `.wasm`. No grammar is built from source.
- Also load `tree-sitter-go`, `-rust`, `-ruby`, `-c` and `-cpp` the same
  way, so the symbol/import/call graph can cover those languages too.
  They are parser-loader entries only; chunking for them stays on the
  regex tier until graph extraction needs more.
- `parser-loader.ts` maps grammar names to `<package>/<file>.wasm` and
  resolves them with `createRequire`; `web-tree-sitter` is an esbuild
  external (it loads its own runtime `.wasm` from `node_modules`).
- `test/unit/grammar-modern-syntax.test.ts` guards each language with
  current-version syntax and asserts no ERROR nodes.

## Consequences

- Grammars track their languages; the unused `tree-sitter-wasms` grammars
  PHP and Swift are gone from the loader (Go, Rust, Ruby, C and C++
  are back via their upstream packages). Adding a
  language now means adding its upstream package + one map entry.
- Grammar packages must be installed next to the bundle (same as the
  other externals; see `scripts/install-plugin.sh`).
- Grammar ABI must stay compatible with the runtime (currently 14/15,
  supported by 0.27).
