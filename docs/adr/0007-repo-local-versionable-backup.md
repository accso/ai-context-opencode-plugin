# ADR-0007: Commit-able, repo-local JSONL backup instead of a database dump/service

## Status

Amended by [ADR-0028](0028-compact-sharded-backup.md): the chunk backup is now sharded `index-NNNN.jsonl` files with float16 vectors.

Accepted (repo-local-backup; extended by doc-tree-backup and
validate-backup-import-schema, 2026-09).

## Context

Per-project data (ADR-0003) lives outside the project's own worktree,
in the user's local data directory -- which means a fresh clone of a
repo (or a new teammate's machine) starts with an EMPTY index and has
to pay the full re-indexing cost (chunking + embedding every file)
before `semantic_search`/`search_docs` become useful. The
original stack's Postgres+Qdrant pair had no equivalent "ship the
index with the repo" story either -- an out-of-band export was outside
its normal operating mode.

## Decision

`src/storage/backup.ts` exports the vector store as sorted JSON Lines
to `.opencode/ai-context/backup/index.jsonl` **inside the worktree**
(the opposite placement from the live per-project store) -- making it
commit-able and git-diffable (stable key order per row, sorted by
`relativePath`, so re-exporting an unchanged store produces a
byte-identical diff). A sibling `doc-trees.jsonl` in the same directory
covers `DocTreeStore`'s PageIndex-style Markdown trees (ADR-0009) the
same way, as a separate file so the two backups stay independently
diffable and a repo with no tree-indexed Markdown never gets an empty
doc-trees file created.

On plugin startup, if the current machine's local store (chunks, or
doc trees, checked independently) is empty, the corresponding backup
file is auto-imported -- never overwriting a store that already has
local data. The `ai_context_export_backup` tool triggers a fresh
export of both backups on demand, e.g. before committing.

## Consequences

- A fresh clone (or new teammate) gets a working, populated index
  immediately after `git pull`, with no re-indexing wait, as long as
  someone committed a reasonably fresh backup.
- Both backup files are ordinary git-tracked text files -- diffable,
  mergeable in the git sense. A committed backup can also arrive
  corrupted the same way any tracked file can (most commonly an
  unresolved git merge conflict, or a hand-edited/partially-written
  row) -- `importBackup`/`importDocTreeBackup` parse and shape-validate
  each row independently and silently skip any row that fails either
  step (a `JSON.parse` failure, a missing required field, or a
  wrong-typed field such as `vector`/`nodes` not being an array),
  rather than letting one bad line abort the entire import
  (validate-backup-import-schema, closed).
- This is an entirely manual, on-demand action (the tool), not an
  automatic side effect of every indexing event -- committing an index
  snapshot is a deliberate "share this with the team" decision, not
  background noise on every save.
- Because doc-tree and chunk backups are separate files with
  independent empty-store checks, a repo can have one without the
  other (e.g. all code, no long-form Markdown) without an artifact
  being created for the unused half.

## Alternatives considered

- **A single merged backup file covering both chunks and doc trees.**
  Rejected: would force every backup update to touch one file
  regardless of which half actually changed, and would create an
  artifact for doc trees even in repos with no long-form Markdown.
- **No backup at all; re-index on every fresh clone.** Rejected as the
  default: acceptable for a single active developer, but every new
  clone/teammate/CI checkout would otherwise pay the full re-indexing
  cost from zero, with no way to share that cost across a team.
