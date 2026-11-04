# ADR-0018: Report indexing progress via a status file and tool responses

## Status

Accepted (2026-10).

## Context

The first index of a repository embeds every file and runs for minutes.
Under JetBrains AI Assistant (ACP) the user saw nothing but CPU, RAM and
fan noise: the indexer reported no progress, and the channels that could
carry it are dead ends over ACP (`docs/observability.md`: TUI toasts and
injected chat messages never reach the client; `client.app.log` only lands
in opencode's log file). A failing file also aborted the whole batch, so
one unreadable file silently left the rest of a batch unindexed.

## Decision

- An in-memory progress tracker (`src/indexing/index-progress.ts`) is the
  single source of truth: phase, done/total, rate/ETA, and the files whose
  indexing failed.
- It is mirrored to `.opencode/ai-context/index-status.json`
  (`src/indexing/status-file.ts`): atomic write (tmp file + rename),
  throttled to one write per 2 s, except phase changes and newly failed
  files, which are written immediately. The file stays after the run
  (`phase: "done"`) so the last result remains inspectable.
- `index_status` returns the same data in an `indexing` block,
  including the status file path.
- `semantic_search`, `search_docs` and `analyze_impact` attach
  an `indexingNotice` while a run is active, so the agent tells the user
  that a missing hit may only mean "not indexed yet". Array results are
  wrapped as `{ indexingNotice, results }` only in that case.
- A file that fails to index is skipped and recorded (error, attempt
  count). The next watcher event for it, or the next startup pass, retries
  it; a success removes the entry, another failure increments `attempts`.
- `.opencode/ai-context/` is never indexed (`file-filter.ts`), otherwise
  every status write would come back as `file.watcher.updated`.

## Consequences

- Users can follow indexing with `while true; do clear; cat .opencode/ai-context/index-status.json; sleep 1; done`
  from any frontend, and the agent can relay progress in chat.
- The status file lives in the worktree and changes constantly. Add
  `.opencode/ai-context/index-status.json` to the project's `.gitignore`
  (the backup in the same directory is meant to be committed, this file
  is not). The plugin cannot enforce that.
- Two plugin instances (opencode bootstraps plugins twice) write the same
  file; the last write wins, which is harmless for a progress mirror.
- Failures are only held in memory for the current process; a restart
  re-attempts every file anyway.
- `semantic_search` output changes shape (array -> object) while indexing.

## Alternatives considered

- **TUI toasts / injected chat messages / `permission.ask`.** Rejected:
  confirmed not to reach ACP clients.
- **OS notifications for progress.** Rejected for per-step progress (too
  noisy); still an option for start/finish.
- **Status file under `data_dir` (outside the worktree).** Rejected: the
  user wants an easily accessible file, and excluding the directory in the
  filter removes the feedback-loop risk.
- **Aborting the batch on error (previous behavior).** Rejected: one bad
  file must not hide the rest of the repository from search.
