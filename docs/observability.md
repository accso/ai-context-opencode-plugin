# Observability

This plugin exposes telemetry through two complementary channels, and
separately has to solve a harder problem: getting **any** status
information in front of a user at all when the plugin runs under a
frontend that isn't OpenCode's own TUI -- notably **JetBrains AI
Assistant via ACP** (Agent Client Protocol), one of this plugin's
actual deployment targets. Those are two different problems addressed
in the two sections below.

## 1. Tool-call telemetry (OpenTelemetry + in-memory summary)

See [ADR-0011](adr/0011-otel-bring-your-own-backend-telemetry.md) for
the full decision record. Summary:

- `tool.execute.before`/`tool.execute.after` plugin hooks
  (`src/telemetry/telemetry.ts`) observe **every** tool call in a
  session -- native `grep`/`glob` included, not just this
  plugin's own tools.
- Every observed call is dual-written to:
  - an **in-memory summary**, exposed via the `ai_context_telemetry_report` native
    tool as JSON (per-tool call count, total/average duration,
    approximate input/output token counts) -- zero configuration
    required;
  - a standard **OpenTelemetry span** (`tool.execute:<toolName>`) and a
    **duration histogram** (`opencode.tool.duration`, ms), via
    `@opentelemetry/api`'s global tracer/meter.
- The OTel path is **API-only** -- this plugin does not bundle an SDK
  or exporter. Per the OTel API's own design, calling a tracer/meter
  with no SDK registered is a safe no-op. If the OpenCode host process
  (or the user's environment more broadly) already has an OTel SDK +
  exporter configured, this plugin's spans/metrics show up there
  automatically, with zero plugin-side configuration. If not, the calls
  cost effectively nothing and produce no output.

### Built-in OTLP metrics export (opt-in)

Off by default. When enabled, the plugin creates its own `MeterProvider`
(not registered globally, so the host's OTel setup is untouched) and
pushes `opencode.tool.duration` over OTLP/HTTP to `<endpoint>/v1/metrics`.
A collector that is down only produces one warning; tool calls are never
affected.

| Env var | `.opencode/ai-context.config.yaml` | Default |
|---|---|---|
| `AI_CONTEXT_OTEL_ENABLED` | `otel_enabled` | off |
| `AI_CONTEXT_OTEL_ENDPOINT` | `otel_endpoint` | `http://127.0.0.1:4318` |
| `AI_CONTEXT_OTEL_FLUSH_MS` | `otel_flush_ms` | `5000` |
| `AI_CONTEXT_PROJECT` | `project` | the worktree directory name (no hash) |
| `AI_CONTEXT_OTEL_SESSION_ID` | - | off (adds high-cardinality `sessionID` label) |

Metric: `opencode.tool.duration`, unit `ms`, histogram. Labels: `tool`,
`project` (also on the resource, with `service.name=ai-context`).
Prometheus-style backends expose it as
`opencode_tool_duration_milliseconds_{bucket,count,sum}` (or similar).

### How to actually see the OTel data

This plugin does not provide a collector or dashboard. To see spans/
metrics, register an SDK + exporter in the SAME process OpenCode itself
runs in (typically via `NODE_OPTIONS`/an OpenCode startup hook that
loads `@opentelemetry/sdk-node`, or whatever mechanism the OpenCode
host process already supports for its own instrumentation) pointed at
any OTLP-compatible backend (Jaeger, an OTel Collector, etc.). This
plugin's `trace.getTracer("ai-context-opencode-plugin")`/
`metrics.getMeter("ai-context-opencode-plugin")` calls will then be
picked up by that SDK like any other instrumented library in the
process.

### Instrumentation name and signals

| Signal | Name | Notes |
| --- | --- | --- |
| Span | `tool.execute:<toolName>` | Attributes: `tool`, `sessionID`, `callID` |
| Histogram | `opencode.tool.duration` | Unit `ms`; attributes `tool`, `sessionID` |
| `ai_context_telemetry_report` tool output | per-tool `callCount`, `totalDurationMs`, `avgDurationMs`, `totalInputTokens`, `totalOutputTokens`, `totalTokens` | In-memory only, resets when the process restarts |

## 2. Getting plugin status in front of a user across frontends (TUI vs. ACP)

opencode plugins run under multiple frontends: opencode's own TUI, and
**ACP-based clients** (Zed, **JetBrains AI Assistant** -- one of this
plugin's real deployment targets) that talk to opencode over the Agent
Client Protocol. Status mechanisms that work in one do **not** work in
the other, and this matters directly for this plugin: if it ever needs
to surface a user-visible status ("model download in progress," "index
backup restored," a warning about a malformed backup file, etc.), the
mechanism has to work under JetBrains AI Assistant's ACP bridge, not
just opencode's own TUI.

The full investigation, with source-level citations against opencode's
actual code (not just its type definitions/docs), lives in
[`opencode-plugin-workarounds.md`](opencode-plugin-workarounds.md) --
this section is the short version; read that file for the "why" and
the copy-pasteable implementation.

### Quick reference: what actually reaches the user, by frontend

| Mechanism | opencode TUI | ACP (JetBrains AI Assistant, Zed) |
| --- | --- | --- |
| `client.tui.showToast(...)` | ✅ Works | ❌ Confirmed dead end -- opencode's ACP event bridge has no `tui.toast.show` case |
| `client.app.log(...)` | ✅ Always lands in the log file | ✅ Always lands in the log file | 
| Injected chat message (`session.prompt` with `noReply: true`) | N/A | ❌ Confirmed dead end -- built as a `user`-role message; the ACP bridge only forwards `assistant`-role parts |
| `"permission.ask"` hook | Likely unwired even in the TUI -- see the workarounds doc | Likely unwired -- no `plugin.trigger(...)` call site found in opencode's permission path |
| **Native OS notification** (`osascript` / `notify-send`, spawned directly) | ✅ Works | ✅ **Works** -- entirely bypasses opencode's hook/event system, so it's frontend-agnostic by construction |

**Practical takeaway for this plugin**: `client.app.log(...)` is fine as
a cheap, always-available secondary channel (nobody's watching it by
default, but it's there for debugging). For anything a user actually
needs to notice under JetBrains AI Assistant/ACP, use a native OS
notification -- see the workarounds doc's §1e for the ready-to-use
`notifyOs()` implementation, including the injectable-runner pattern
needed to keep unit tests from spawning real `osascript`/`notify-send`
processes (§3 of that doc).

### Known opencode-side quirk: double bootstrap

opencode invokes plugin bootstrap **twice** per session (confirmed via
opencode's own logs showing the same `run=<id>` with two independent,
near-simultaneous bootstrap cycles) -- this is opencode-side, not
something a plugin can fix. Any one-shot, user-visible side effect
(e.g. a "plugin loaded" OS notification) needs a time-windowed dedup
gate in front of it, or the user sees it fire twice for what feels like
one session start. See the workarounds doc §2 for the `OsNotifyGate`
pattern (`createOsNotifyGate`) this plugin should use if/when it adds
any bootstrap-time user-visible notification.

### Current status in this plugin

The plugin emits native OS notifications (plugin started; large indexing
run started/finished; indexing failed; `os_notifications: false` or
`AI_CONTEXT_OS_NOTIFICATIONS=0` silences them) but no chat-visible status
messages. Indexing progress (see
[ADR-0018](adr/0018-indexing-progress-via-status-file-and-tool-responses.md))
reaches the user through channels that work under ACP. `total` counts only files that need work; `reasons` says why (`new`, `changed`, `removed`, `upgrade`, `repair`, `summaries`; a forced `reindex_chunks`/`reindex_summaries` run counts as `upgrade`). Self-healing runs (`upgrade`/`repair`/`summaries`) always get an "Updating index" popup naming the reason, see [ADR-0027](adr/0027-self-healing-reindex.md):

Further files sit next to the status file (both git-ignored, written only when the plugin is enabled):

- **`index-tree.md`**: tree of every indexed file with language and chunk count, plus export date, repository, git branch/commit and last index update, and the files that failed. Written by `ai_context_export_index_tree` and after each completed indexing run.
- **`tool.log.md`** (opt-in, `tool_log: true`): one entry per tool call with time, tool, session/call id and arguments, followed by a `↳` entry with the duration and a response summary (size, result counts, first paths, error text, "empty result"). `tool_log_full_responses: true` logs complete arguments and the complete response text, without any truncation. At 5 MB the file is rotated to `tool.<time>.log.md` (newest 10 kept). Use it to see why an agent chose or misused a tool.
- **`error.log.md`**: persistent log of everything that went wrong (every problem that also becomes an OS popup, each failed file with its error, a failed run). Newest entries last, capped at 256 KB (oldest dropped). Unlike popups it is not deduplicated, so it shows how often something fails.

1. **Status file** `.opencode/ai-context/index-status.json`, rewritten at
   most every 2 s (immediately on phase changes and new failures):

   ```json
   {
     "version": 1,
     "running": true,
     "phase": "indexing",
     "done": 412,
     "total": 1900,
     "percent": 21,
     "reasons": { "new": 12, "upgrade": 400 },
     "failed": 1,
     "failures": [
       { "file": "src/big.ts", "error": "EACCES", "attempts": 1, "lastFailedAt": "2026-10-05T08:10:02.000Z" }
     ],
     "currentFile": "src/app/foo.ts",
     "filesPerSec": 6.2,
     "etaSeconds": 240,
     "startedAt": "2026-10-05T08:05:00.000Z",
     "updatedAt": "2026-10-05T08:10:02.000Z",
     "finishedAt": null,
     "lastError": null,
     "notices": []
   }
   ```

   Phases: `idle`, `scanning`, `loading-model` (first-time model
   download), `indexing`, `done`, `failed`. Follow it with
   `while true; do clear; cat .opencode/ai-context/index-status.json; sleep 1; done`. Add the file to
   the project's `.gitignore` (the backup next to it is meant to be
   committed, this file is not).
2. **`index_status`** returns the same data in its `indexing`
   block, including `statusFile`.
3. **`indexingNotice`** in `semantic_search`, `search_docs`
   and `analyze_impact` results while a run is active (arrays are
   wrapped as `{ indexingNotice, results }` only then).

Files that fail to index are skipped and listed under `failures`; a later
change event (file watcher) retries them, success removes the entry,
another failure increments `attempts`.

For anything else that must reach a user outside a tool response (e.g. a
startup warning), follow the table above and update this section with
the mechanism that was actually wired in.
