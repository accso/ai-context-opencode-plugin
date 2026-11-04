# ADR-0028: Compact, sharded backup (float16 vectors, hash shards)

## Status

Accepted (2026-10-08). Amends [ADR-0007](0007-repo-local-versionable-backup.md).

## Context

The chunk backup was one `index.jsonl` with vectors as JSON float arrays: 63 MB
for 3,711 chunks (17 KB per vector), close to GitHub's 100 MB push limit and
growing with the repo. Git cannot delta-compress float noise, so every changed
copy also bloated history.

## Decision

- Vectors are stored as base64 float16 (`vector16`, 2 bytes per dimension,
  about 2 KB instead of 17 KB). Precision loss is below 1e-3 relative; export
  after import is byte-stable because the values are already half precision.
- Rows go to `index-NNNN.jsonl` shards chosen by a stable FNV-1a hash of the
  file path, `maxShardBytes` (default 10 MiB) bounds the target size. The shard
  count is a power of two estimated from chunk count and average row size, so
  it changes rarely, a file's chunks stay together and a change rewrites one
  shard. Rows stay sorted by id inside a shard.
- Export deletes the legacy `index.jsonl` and stale shards first. Import reads
  the legacy file (float arrays) and all shards; per-row validation and
  skipping of broken rows is unchanged. Doc-tree and graph backups are small
  and unchanged.

## Consequences

- The measured backup shrinks from 63 MB to 10.8 MB (two shards).
- Old committed backups stay importable; the next export migrates them.
- Restored vectors differ from the originals by half-precision rounding; with
  brute-force cosine search this is negligible, but a benchmark would confirm.
- Beyond roughly 50k chunks a further 2x is possible with int8 vectors behind
  a new row key; not needed yet.
