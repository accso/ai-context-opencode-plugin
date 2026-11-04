# ADR-0025: Resumable indexing and cross-process index lease

## Status

Accepted (2026-10-06).

## Context

Every ACP session is its own opencode process. Each ran the startup pass and
re-embedded **every** file (no change detection), all writing to the same
SQLite files: duplicated CPU/RAM, lock contention, and no way to continue where
a previous run stopped. The in-process guard (ADR-0021 runtime registry) does
not span processes.

## Decision

1. **Fingerprints:** after a file is fully indexed, the vector store records
   `size:mtime` (`file_state` table). Files whose fingerprint matches (and that
   have chunks) are skipped, so a restart, a second session or an interrupted
   run continues with the remaining files. Failed files have no fingerprint and
   are retried. A changed `EMBED_FORMAT_VERSION` clears fingerprints with the chunks.
2. **Stale files:** the startup pass removes indexed files that are gone from the
   walk (deleted or newly excluded).
3. **Lease:** `index.lock` next to the project database (`pid` + heartbeat every
   10 s). Indexing batches run while holding it; another process waits (polls
   every 3 s) and then only finds the unfinished files. A lease of a dead
   process or without heartbeat for 45 s is taken over.

## Consequences

- One indexing process per project at a time; later sessions are fast.
- A waiting process shows phase `scanning` and may overwrite
  `index-status.json` until it gets the lease.
- Restored backups carry no fingerprints, so the first pass re-indexes once.
- Processes running an older plugin version do not honour the lease.
