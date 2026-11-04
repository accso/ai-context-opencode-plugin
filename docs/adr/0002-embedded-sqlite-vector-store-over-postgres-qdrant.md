# ADR-0002: Embedded SQLite + brute-force cosine search instead of Postgres/Qdrant

## Status

Accepted (storage-spike, 2026-09).

## Context

The original stack used Postgres (structured metadata) + Qdrant (vector
search) as separate always-on services. Replacing the Docker
infrastructure (ADR-0001) meant the storage layer needed a genuinely
embedded, zero-server alternative -- something that lives inside the
plugin's own Node process with no separate service to start, healthy,
or connect to.

A storage spike measured `better-sqlite3` (synchronous, in-process,
file-backed) storing 768-dim vectors as BLOBs, with a v1 brute-force JS
cosine similarity scan (no ANN index) over all stored chunks per query.

## Decision

Use `better-sqlite3` as the sole storage backend
(`src/storage/vector-store.ts`), with brute-force cosine similarity in
JS for v1 -- no HNSW/IVF index, no separate vector database.

Measured search latency (768-dim vectors, brute-force scan):

| Chunk count | Latency |
| --- | --- |
| ~2,000 | ~110ms |
| ~10,000 | ~580ms |
| ~30,000 | ~1.75s |

This informs a tentative ~8,000-chunk threshold as a candidate cutover
point to a "heavy mode" Qdrant-backed path for very large monorepos --
**not yet implemented or validated against a real repo**; today the
plugin only has the SQLite path.

## Consequences

- Zero operational surface for storage: the `.sqlite` file lives under
  `~/.local/share/ai-context-opencode-plugin/projects/<key>/index.sqlite`,
  created/opened lazily by the plugin process itself.
- Search latency degrades linearly with chunk count since there's no
  ANN index -- acceptable for small/medium repos (the plugin's primary
  target), a real risk for very large monorepos once past roughly
  10-30k chunks.
- No externally-imposed schema/connection-pool/auth complexity that a
  real Postgres+Qdrant pair would require even for a single-user local
  tool.
- Left open, deliberately: a real "heavy mode" storage cutover (e.g.
  reintroducing Qdrant only past a measured chunk-count threshold) is
  future work, not yet built. `AI_CONTEXT_PLUGIN_HEAVY_MODE` currently
  has no effect on storage at all (see ADR-0006's note on the flag's
  scope).

## Alternatives considered

- **Keep Qdrant, run it out-of-process.** Rejected outright by ADR-0001
  -- reintroduces the exact operational overhead being removed.
  Remains a candidate for a future "heavy mode" storage tier, not a
  wholesale replacement.
- **An embedded vector index library (e.g. an HNSW binding) instead of
  brute-force.** Deferred rather than rejected: added complexity
  (another native binding, index-rebuild-on-write semantics) wasn't
  justified until real usage shows brute-force scanning is actually a
  problem for this plugin's typical repo sizes.
