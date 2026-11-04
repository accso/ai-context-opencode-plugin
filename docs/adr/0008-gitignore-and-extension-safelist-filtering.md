# ADR-0008: Enforce `.gitignore` + an extension safelist at both indexing entry points

## Status

Accepted (repo-walker-ignore-filtering, critical-review follow-up,
2026-09).

## Context

The original `.ai-context` stack's `watcher/indexer.py` combined two
filtering mechanisms before ever reading a file's content:

1. A merged `pathspec` built from the worktree's own `.gitignore` (plus
   configured extra gitignore files).
2. `config.yaml`'s `include_extensions` -- an explicit SAFELIST of
   extensions, which doubles as the binary-detection mechanism ("this
   is also what keeps binaries out -- no separate binary-detection step
   needed," per that file's own comment) rather than sniffing file
   contents.

The plugin's initial `repo-walker.ts` implementation had neither: only
a small hardcoded directory denylist (`node_modules`, `.git`, `dist`,
etc.). A critical review of the implementation flagged this as a real
gap, not a cosmetic one: without both mechanisms, every file not caught
by that small denylist -- images, archives, lockfiles, `.env`, vendored
binaries, anything a project-specific `.gitignore` excludes -- would be
read as UTF-8, chunked, embedded, and (via ADR-0007's repo-local
backup) potentially committed into git as a leaked artifact.

## Decision

`src/indexing/file-filter.ts` ports both mechanisms:

- `isIndexableExtension` -- a safelist mirroring `config.yaml`'s
  `include_extensions` (plus `INDEXABLE_FILENAMES` for the one
  extensionless entry, `Dockerfile`).
- `createIgnoreMatcher`/`loadGitignoreSync` -- real `.gitignore`
  semantics (including negation patterns like `!important.log`) via the
  `ignore` npm package, rather than hand-rolled glob matching.
- `createFileFilter` combines both into the single predicate the
  indexing pipeline needs.

Critically, this filter is wired into BOTH indexing entry points, not
just one:

1. `repo-walker.ts`'s startup full-repo walk.
2. `indexing.ts`'s `indexOneFile`, via a new optional `shouldIndexFile`
   dependency -- so `file.watcher.updated`-driven incremental changes
   (edits made during a live session) get identical filtering. Without
   this second wiring, a binary or gitignored file edited mid-session
   would bypass the startup walk's filter entirely.

The `shouldIndexFile` check runs BEFORE `readFile` in `indexOneFile`,
so a rejected file's content is never even read -- and it runs AFTER
the existing `deleteChunksForFile`/`deleteTree` calls, so a file that
becomes newly-excluded (e.g. just added to `.gitignore`) still gets its
previously-indexed chunks/tree cleaned up correctly.

## Consequences

- Binaries, secrets (`.env`), and vendored/generated files are no
  longer read, chunked, embedded, or risked in the committed backup
  (ADR-0007).
- The filter must be remembered at every future indexing entry point --
  the two-place wiring here is not incidental; any new way of feeding
  files into the pipeline needs the same `shouldIndexFile` check.
- A file that becomes newly gitignored (or newly excluded by an
  extension change) during a live session is correctly de-indexed on
  its next `file.watcher.updated` event, not just skipped going
  forward.

## Alternatives considered

- **Content-sniffing binary detection (e.g. checking for null bytes)
  instead of an extension safelist.** Rejected: diverges from the
  original stack's proven approach, and an explicit safelist is more
  predictable/auditable than heuristic content sniffing.
- **Hand-rolled `.gitignore` glob matching.** Rejected: `.gitignore`
  semantics (negation, directory-only patterns, anchoring) are
  easy to get subtly wrong; the `ignore` npm package is a small,
  zero-dependency, widely used implementation, consistent with this
  plugin's "no bundled heavy infra, keep it light" philosophy.
