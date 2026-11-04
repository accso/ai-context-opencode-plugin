# ADR-0021: Shared embedding worker outside opencode

Status: accepted

## Context

Every opencode instance (and every ACP session) loaded its own ONNX model
inside the host process. The model session, its memory arena and quadratic
attention peaks made the host grow to GBs, and a memory kill (exit 137)
took the whole opencode down. Several instances also duplicated the model.

## Decision

- The embedding model runs in ONE background process per user, started on
  demand by the first plugin instance and shared by all others.
- Transport: newline-delimited JSON over a unix socket
  (`<data dir>/embed-worker.sock`, or `$TMPDIR` if the path would exceed the
  socket path limit). The worker is the arbiter: a second worker finding a
  live socket exits, a stale socket file is replaced.
- The worker script `ai-context-worker.mjs` is installed next to (not in)
  `~/.config/opencode/plugins/`, since opencode loads every file there as a
  plugin. It resolves native deps from `~/.config/opencode/node_modules`.
- It is started with the host binary and `BUN_BE_BUN=1` (opencode is a
  compiled Bun; the variable makes it run a script like `bun`; verified with
  opencode 1.18.34). Plain node/bun ignore the variable.
- Lifecycle: exits after 10 min without clients, or after a request once its
  RSS exceeds `max_memory_mb`; clients then reconnect and respawn (one retry).
  Inference runs one request at a time across all clients.
- If the worker cannot start, the client falls back to in-process embedding
  (with a problem report). `shared_worker: false` or
  `AI_CONTEXT_SHARED_WORKER=0` disables it.
- Log: `<data dir>/embed-worker.log`.

## Consequences

- The host stays small; a runaway model only costs the worker.
- The first instance's embedding settings (threads, max tokens, model cache,
  dims) win for the worker's lifetime.
- Needs `ai-context-worker.mjs` installed (`scripts/install-plugin.sh`);
  without it the plugin embeds in-process as before.
- A detached process must exit reliably; idle exit and SIGTERM cleanup cover
  this.

## Alternatives considered

- Moving indexing (not only embedding) into the worker: larger change, the
  SQLite writes are cheap; may follow.
- Requiring `node`/`bun` on PATH: not guaranteed for ACP users.
