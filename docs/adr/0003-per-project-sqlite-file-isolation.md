# ADR-0003: One SQLite file per project instead of a shared store with a project-key column

## Status

Accepted (multi-repo-isolation, 2026-09).

## Context

The original stack used one Qdrant *collection* per project as its
physical isolation boundary -- separate projects' vectors were never
comingled at the storage layer, regardless of application-level query
filtering. Moving to embedded SQLite (ADR-0002) needed an equivalent
isolation story: OpenCode plugins run against a single `worktree` per
session, but the same plugin installation is reused across every repo
a user opens with OpenCode.

## Decision

`src/storage/project-key.ts`'s `deriveProjectKey` derives a stable,
project-scoped key from the session's `worktree`, and each project
gets its **own SQLite file** under
`~/.local/share/ai-context-opencode-plugin/projects/<key>/index.sqlite`
(with a sibling `doc-trees.sqlite` for doc-tree data -- see ADR-0009).
There is no shared table with a `project_key` column that every query
must remember to filter by.

## Consequences

- Isolation is structural, not query-discipline-dependent: a bug that
  forgets a `WHERE project_key = ?` clause is architecturally
  impossible here, because there is no other project's data reachable
  from an open handle to one project's file.
- Cross-repo search (an explicit, opt-in exception -- see ADR-0007's
  sibling `cross-repo-allowlist` feature) has to explicitly open
  *multiple* store handles and merge results in application code,
  rather than adding a query filter -- a deliberate trade-off: the
  common case (single-repo isolation) is free of a whole bug class, at
  the cost of cross-repo search being slightly more code.
- `src/storage/project-registry.ts` + the `ai_context_list_projects`/
  `ai_context_delete_project` tools exist because, unlike a shared
  store, deleting a project's data is now "delete a directory," which
  nothing does automatically when a repo falls out of use --
  reclaiming disk space is a manual, explicit action.
- The store's file path always lives OUTSIDE the project's own
  worktree (under the user's local data dir, not inside the repo) --
  this is also why the plugin's own writes never re-trigger its own
  `file.watcher.updated` indexing (see ADR-0012): OpenCode only watches
  the worktree, and the store file isn't in it.

## Alternatives considered

- **A single shared SQLite file with a `project_key` column on every
  row.** Rejected: reintroduces exactly the "every query must
  remember to filter" risk this decision exists to avoid, for a
  marginal simplicity gain (one file to manage instead of N) that
  doesn't matter much given SQLite files are cheap and self-contained.
