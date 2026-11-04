# ADR-0017: Use `bun:sqlite` inside OpenCode, `better-sqlite3` only under Node

## Status

Accepted (2026-10).

## Context

ADR-0002 chose `better-sqlite3` as the embedded store. OpenCode runs on
Bun, and Bun only runs a package's install script when the package is in
`trustedDependencies`. `better-sqlite3` was not, so its native addon was
never built, and Bun 1.3.14 does not throw when asked to load a missing
addon: it panics (`NAPI FATAL ERROR`, exit code 133) and takes the whole
OpenCode/ACP process down at plugin start.

## Decision

All three stores open their database through `src/storage/sqlite.ts`, a
thin adapter over the few calls they use (`exec`, `prepare`
`run/get/all`, `pragma`, `transaction`, `close`). Under Bun it uses the
built-in `bun:sqlite` (nothing to install or build); under Node (unit
tests, tooling) it uses `better-sqlite3`, required lazily so Bun never
tries to load it. `install-plugin.sh` no longer installs `better-sqlite3`.

## Consequences

- No native addon to build for storage; plugin start no longer depends on
  install scripts or prebuilt binaries.
- Two SQLite implementations behind one adapter: a behavior difference
  between them would only show up in one runtime (the adapter normalises
  the known one, `get()` returning `null` vs `undefined`).
- `onnxruntime-node` and `tokenizers` are still native addons; they are
  only loaded when the embedder is first used.

## Alternatives considered

- **Add `better-sqlite3` to `trustedDependencies`.** Rejected: needs a
  compiler or a network prebuild download on every machine, and a failed
  build still ends in a process crash rather than an error.
- **`bun:sqlite` only.** Rejected: the unit tests and tooling run on Node.
