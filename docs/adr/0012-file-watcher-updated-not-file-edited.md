# ADR-0012: React to `file.watcher.updated`, not `file.edited`, for re-indexing

## Status

Accepted (replace-watcher-with-hooks, 2026-09).

## Context

OpenCode exposes (at least) two distinct file-change signals a plugin
can subscribe to via its `event` hook: `file.edited` (fires only for
edits the agent itself made through its own tools, e.g. a `write`/`edit`
tool call) and `file.watcher.updated` (fires for changes from ANY
process -- external editors, `git pull`, another terminal, a build
step writing generated files).

The Docker-based watcher this plugin replaces (ADR-0001) watched the
filesystem directly, with no notion of "who" made a change -- it
re-indexed on any observed change, full stop.

## Decision

Subscribe to `file.watcher.updated`, not `file.edited`.

## Consequences

- Matches what the old watcher container actually needed to catch: a
  user editing files in their own editor outside of OpenCode, a `git
  pull`/branch switch, or any other external process touching the
  worktree, all trigger re-indexing -- not just changes the agent made
  through its own tool calls.
- If `file.edited` were used instead, external changes (the common
  case of a human editing code alongside the agent) would silently
  never re-trigger indexing, leaving the index stale relative to what's
  actually on disk without the agent (or the plugin) ever being aware.
- Combined with ADR-0003's placement of the store file OUTSIDE the
  worktree, this also means the plugin's own writes (to its SQLite
  files) never re-trigger `file.watcher.updated` on themselves --
  there's no risk of a self-triggering indexing loop.

## Alternatives considered

- **`file.edited`.** Rejected: too narrow -- would miss the exact class
  of external, non-agent-driven changes the original watcher was built
  to catch.
- **Both events.** Considered redundant: since `file.watcher.updated`
  is a superset covering everything `file.edited` would also catch (an
  agent's own edit is still a change on disk that the watcher observes
  too), listening to both would just double-fire without adding
  coverage.
