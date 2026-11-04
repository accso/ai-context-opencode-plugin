# ADR-0011: OpenTelemetry API-only telemetry ("bring your own backend"), dual-written with an in-memory summary

## Status

Accepted (otel-telemetry, telemetry-hooks, 2026-09).

## Context

OpenCode's `tool.execute.before`/`tool.execute.after` plugin hooks fire
for EVERY tool call in a session -- native `grep`/`glob`/`lsp` calls
included, not just this plugin's own tools. That's automatic,
zero-self-instrumentation telemetry: unlike the originating monorepo's
`bench.js` CLI (external tooling, not part of this package, which
requires an agent to manually wrap/start/stop each action it wants
measured), these hooks see everything without the agent doing anything
special.

The question was what to DO with that telemetry: build/bundle a full
observability stack (an exporter, a local collector, a persistence
layer), or something lighter.

## Decision

Dual-write telemetry from a single recorder
(`src/telemetry/telemetry.ts`):

1. **An in-memory summary** -- zero-config, exposed via the
   `ai_context_telemetry_report` tool as JSON (per-tool call count, total/average
   duration, and approximate input/output token counts, using the same
   word/number/punctuation-run token approximation as `bench.js`, kept
   numerically consistent on purpose so results are comparable across
   both).
2. **Standard OpenTelemetry spans + a duration histogram**, via
   `@opentelemetry/api` -- **API only, no bundled SDK or exporter**.

Per the OTel API's own design, calling a tracer/meter with no SDK
registered is a safe no-op. That means this plugin never needs to
bundle, configure, or manage an actual telemetry backend itself --
"bring your own backend," the same pattern already used for the
LLM/embedding model backend (ADR-0004/0005: this plugin picks a
default, but doesn't force infrastructure choices on the user).

## Consequences

- Zero-config users get the `ai_context_telemetry_report` tool's summary with no
  setup at all.
- Users who already run an OTel collector for their OpenCode host
  process get this plugin's tool-call spans/duration histogram
  automatically, for free, with no plugin-side configuration --
  they're using the exact same global tracer/meter providers
  `@opentelemetry/api` already exposes.
- Users with no OTel SDK configured pay effectively zero cost for the
  OTel code path (confirmed no-op by the API's own design), so there's
  no reason to feature-flag it off.
- This exposes the raw signal (spans, histogram, in-memory summary) for
  any future benchmarking or evaluation harness to consume, without this
  plugin needing to implement or own any benchmarking logic itself.
  (Benchmarking this plugin's own retrieval quality was considered and
  explicitly descoped from this project's own plan -- see `plan.md` --
  but the telemetry surface remains generically useful regardless of
  who consumes it.)

## Alternatives considered

- **Bundle a full OTel SDK + exporter (e.g. always export to a local
  OTLP endpoint).** Rejected: forces an infrastructure/configuration
  decision (where does telemetry go?) onto every user, even those who
  don't want it, and duplicates whatever OTel setup the user's
  OpenCode host process may already have.
- **In-memory summary only, no OTel at all.** Rejected: would lose the
  "automatic, zero-self-instrumentation" benefit for users who DO
  already have real observability infrastructure in place and would
  want this plugin's calls to show up in it.
