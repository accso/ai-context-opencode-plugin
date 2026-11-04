import { trace, metrics } from "@opentelemetry/api";

/**
 * In-process telemetry recorder backing the plugin's
 * `tool.execute.before`/`tool.execute.after` hooks (see plan.md,
 * "overlap-benchmark-spike"). These OpenCode hooks fire for EVERY tool
 * call in a session -- native `grep`/`glob`/`lsp` calls included, not
 * just this plugin's own tools -- so wiring them up gives automatic,
 * zero-self-instrumentation latency telemetry, unlike the existing
 * `.github/skills/benchmark/scripts/bench.js` CLI, which requires the
 * agent to manually wrap/start/stop each action it wants measured.
 *
 * Entries are paired by `callID` (unique per tool invocation, per
 * OpenCode's hook contract) so out-of-order or missing events degrade
 * gracefully instead of throwing.
 *
 * Dual-writes telemetry: an in-memory summary (for the zero-config
 * `ai_context_telemetry_report` tool, no external dependency required) AND standard
 * OpenTelemetry spans + a duration histogram (user-directed, 2026-09-14)
 * via the injected tracer/meter, defaulting to `@opentelemetry/api`'s
 * global providers. Per OTel API design, calling a tracer/meter with no
 * SDK registered is a safe no-op -- so this plugin never needs to bundle
 * or manage an exporter itself (same "bring your own backend" pattern as
 * the LLM/embedding model backend decision); anyone who already has an
 * OTel collector configured for their OpenCode host process gets this
 * plugin's tool-call telemetry for free.
 */

const INSTRUMENTATION_NAME = "ai-context-opencode-plugin";

/**
 * Same word/number/punctuation-run approximation as
 * `.github/skills/benchmark/scripts/bench.js`'s `approxTokens` (not
 * chars/4) -- deliberately duplicated rather than shared, since the two
 * live in different packages/module systems (CommonJS script vs. this
 * ESM library), but kept numerically consistent so a benchmark session
 * can compare this recorder's token counts against `bench.js`-instrumented
 * arms without a systematic bias from a different counting method.
 */
function approxTokens(text: unknown): number {
  if (text === null || text === undefined) return 0;
  const str = typeof text === "string" ? text : JSON.stringify(text);
  if (!str) return 0;
  const matches = str.match(/[A-Za-z]+|[0-9]+|[^ \t\n\rA-Za-z0-9]/g);
  return matches ? matches.length : str.length > 0 ? 1 : 0;
}

/** Narrow subset of OTel's Span interface -- only what this module needs. */
export interface OtelSpanLike {
  end(): void;
}

/** Narrow subset of OTel's Tracer interface -- only what this module needs. */
export interface OtelTracerLike {
  startSpan(name: string, options?: { attributes?: Record<string, unknown> }): OtelSpanLike;
}

/** Narrow subset of OTel's Histogram interface -- only what this module needs. */
export interface OtelHistogramLike {
  record(value: number, attributes?: Record<string, unknown>): void;
}

/** Narrow subset of OTel's Meter interface -- only what this module needs. */
export interface OtelMeterLike {
  createHistogram(name: string, options?: { unit?: string; description?: string }): OtelHistogramLike;
}

export interface TelemetryStartEvent {
  tool: string;
  sessionID: string;
  callID: string;
  args?: unknown;
}

export interface TelemetryEndEvent {
  tool: string;
  sessionID: string;
  callID: string;
  output?: unknown;
}

export interface TelemetryEntry {
  tool: string;
  sessionID: string;
  callID: string;
  startedAt: number;
  endedAt?: number;
  /** Undefined while the call is still in flight (recordEnd not yet observed). */
  durationMs?: number;
  /** Approximate token count of the call's args (0 if none given). */
  inputTokens?: number;
  /** Approximate token count of the call's output (undefined until recordEnd). */
  outputTokens?: number;
}

export interface TelemetrySummaryRow {
  tool: string;
  callCount: number;
  totalDurationMs: number;
  avgDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
}

export interface TelemetryRecorderOptions {
  /** Clock injection for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /** Defaults to @opentelemetry/api's global tracer (no-op without an SDK). */
  tracer?: OtelTracerLike;
  /** Defaults to @opentelemetry/api's global meter (no-op without an SDK). */
  meter?: OtelMeterLike;
  /** Added as the `project` attribute on every duration record. */
  project?: string;
  /** Also attach `sessionID` to metric attributes (high cardinality; default off). Spans always carry it. */
  includeSessionId?: boolean;
}

export interface TelemetryRecorder {
  recordStart(event: TelemetryStartEvent): void;
  recordEnd(event: TelemetryEndEvent): void;
  getEntries(): TelemetryEntry[];
  getSummary(): TelemetrySummaryRow[];
  reset(): void;
}

export function createTelemetryRecorder(
  options: TelemetryRecorderOptions = {},
): TelemetryRecorder {
  const now = options.now ?? Date.now;
  const tracer: OtelTracerLike = options.tracer ?? trace.getTracer(INSTRUMENTATION_NAME);
  const meter: OtelMeterLike = options.meter ?? metrics.getMeter(INSTRUMENTATION_NAME);
  const durationHistogram = meter.createHistogram("opencode.tool.duration", {
    unit: "ms",
    description: "Duration of OpenCode tool calls observed via tool.execute.before/after hooks.",
  });

  const entries = new Map<string, TelemetryEntry>();
  const spans = new Map<string, OtelSpanLike>();

  return {
    recordStart({ tool, sessionID, callID, args }) {
      entries.set(callID, {
        tool,
        sessionID,
        callID,
        startedAt: now(),
        inputTokens: approxTokens(args),
      });
      spans.set(
        callID,
        tracer.startSpan(`tool.execute:${tool}`, { attributes: { tool, sessionID, callID } }),
      );
    },
    recordEnd({ callID, output }) {
      const entry = entries.get(callID);
      const span = spans.get(callID);
      spans.delete(callID);
      span?.end();
      if (!entry) return; // no matching start -- ignore defensively
      entry.endedAt = now();
      entry.durationMs = entry.endedAt - entry.startedAt;
      entry.outputTokens = approxTokens(output);
      const attributes: Record<string, unknown> = { tool: entry.tool };
      if (options.project) attributes["project"] = options.project;
      if (options.includeSessionId) attributes["sessionID"] = entry.sessionID;
      durationHistogram.record(entry.durationMs, attributes);
    },
    getEntries() {
      return Array.from(entries.values());
    },
    getSummary() {
      const byTool = new Map<
        string,
        { callCount: number; totalDurationMs: number; totalInputTokens: number; totalOutputTokens: number }
      >();
      for (const entry of entries.values()) {
        if (entry.durationMs === undefined) continue; // skip in-flight calls
        const row = byTool.get(entry.tool) ?? {
          callCount: 0,
          totalDurationMs: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
        };
        row.callCount += 1;
        row.totalDurationMs += entry.durationMs;
        row.totalInputTokens += entry.inputTokens ?? 0;
        row.totalOutputTokens += entry.outputTokens ?? 0;
        byTool.set(entry.tool, row);
      }
      return Array.from(byTool.entries()).map(([tool, row]) => ({
        tool,
        callCount: row.callCount,
        totalDurationMs: row.totalDurationMs,
        avgDurationMs: row.totalDurationMs / row.callCount,
        totalInputTokens: row.totalInputTokens,
        totalOutputTokens: row.totalOutputTokens,
        totalTokens: row.totalInputTokens + row.totalOutputTokens,
      }));
    },
    reset() {
      entries.clear();
      spans.clear();
    },
  };
}
