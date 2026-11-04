# ADR-0001: Replace the Docker-based MCP server/watcher/LSP-bridge stack with a native OpenCode plugin

## Status

Accepted (2026-09). Implemented incrementally; see the sibling ADRs for
individual component decisions.

## Context

`.ai-context/` (the parent monorepo's original tooling) ran as a
multi-container Docker stack: a Postgres+Qdrant-backed MCP server
exposed over StreamableHTTP, a standalone file watcher container doing
continuous delta re-indexing, and an `lsp-bridge` container wrapping
several language servers (Python, Swift, clangd) behind a custom
protocol. All of this existed to give a coding agent semantic code
search, call/import-graph analysis, and long-document navigation.

By 2026, `sst/opencode` (the agent runtime this repo's users actually
run) had grown built-in equivalents for several of those
responsibilities: a native `lsp` tool with on-demand
`incomingCalls`/`outgoingCalls`/`findReferences`, native `grep`/`glob`,
a `skill` mechanism, and a first-class plugin API with `tool`,
`event`, and `config` hooks. Running a separate Docker stack alongside
an agent runtime that already covers much of the same ground meant:
extra operational surface (containers to start/keep healthy), a
network hop for every tool call (StreamableHTTP to a local server
instead of an in-process function call), and duplicate maintenance of
features OpenCode already had natively.

## Decision

Rebuild the *irreplaceable* differentiators -- hybrid semantic/keyword
code search and (opt-in) precomputed call/import-graph analysis -- as a
native OpenCode plugin (`ai-context-opencode-plugin/`), registered
directly via the plugin's `tool`/`event`/`config` hooks, with no MCP
server, no Docker, no separate watcher process. Everything OpenCode
already does well natively (`grep`, `glob`, on-demand `lsp` calls,
`skill` discovery) is deliberately NOT reimplemented; the plugin's
[`docs/architecture.md`](../architecture.md) documents this
overlap explicitly rather than leaving it implicit.

## Consequences

- No containers to run, start, or keep healthy for the core workflow;
  `npm install` + OpenCode picking up the plugin directory is the
  entire "install" step.
- Every plugin tool call is an in-process function call, not a network
  round trip -- removes an entire latency/failure-mode class (the
  StreamableHTTP transport, connection resets, "is the MCP server up"
  health checks).
- The plugin only fires while OpenCode is actually running a session
  -- there is no always-on watcher process. Re-indexing instead happens
  via (a) a one-off startup reconciliation walk when a session begins,
  and (b) `file.watcher.updated` events for the rest of the session.
  This trades "index is always fresh, even with OpenCode closed" for
  "no standing infrastructure" -- acceptable since the plugin's whole
  purpose is serving that same running OpenCode session.
- `lsp-bridge/` (the Python LSP client wrappers + its Dockerfile) was
  deleted entirely rather than ported, since its exact capability
  (on-demand call/reference lookups) is now covered natively by
  OpenCode's own `lsp` tool -- see ADR-0006.
- Losing: any capability that depended on the stack running
  independently of an active OpenCode session (e.g. a CI job querying
  the MCP server directly). None of this repo's current use cases
  needed that, so it wasn't preserved.

## Alternatives considered

- **Keep the Docker stack, add a thin plugin as a client of it.**
  Rejected: this keeps 100% of the operational overhead the rewrite
  was meant to remove, for a benefit (protocol reuse) that doesn't
  matter once nothing else consumes the MCP server directly.
- **Rewrite the MCP server in-process but keep it MCP-shaped (still a
  separate transport, just no Docker).** Rejected: OpenCode's plugin
  `tool` hook already IS the in-process registration mechanism; adding
  an MCP layer on top would be a transport nobody needs.
