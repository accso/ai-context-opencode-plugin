import { test } from "node:test";
import assert from "node:assert/strict";
import { createTelemetryRecorder } from "../../src/telemetry/telemetry.js";

/**
 * Unit tests for the in-process telemetry recorder that backs the
 * plugin's `tool.execute.before`/`tool.execute.after` hooks (see
 * plan.md, "overlap-benchmark-spike" -- telemetry endpoints). Unlike the
 * existing `.github/skills/benchmark/scripts/bench.js`, which requires
 * the agent to manually wrap/start/stop every action it takes, these
 * hooks fire automatically for EVERY tool call OpenCode makes --
 * including native `grep`/`glob`/`lsp`, not just this plugin's own tools
 * -- so no self-instrumentation is required.
 */

test("createTelemetryRecorder pairs a recordStart/recordEnd call by callID into one completed entry", () => {
  let nowMs = 1000;
  const recorder = createTelemetryRecorder({ now: () => nowMs });

  recorder.recordStart({ tool: "grep", sessionID: "s1", callID: "c1", args: { pattern: "foo" } });
  nowMs = 1250;
  recorder.recordEnd({ tool: "grep", sessionID: "s1", callID: "c1", output: "3 matches" });

  const entries = recorder.getEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.tool, "grep");
  assert.equal(entries[0]!.sessionID, "s1");
  assert.equal(entries[0]!.callID, "c1");
  assert.equal(entries[0]!.durationMs, 250);
});

test("createTelemetryRecorder ignores an end event with no matching start (defensive against hook ordering surprises)", () => {
  const recorder = createTelemetryRecorder({ now: () => 5000 });
  recorder.recordEnd({ tool: "glob", sessionID: "s1", callID: "unknown", output: "[]" });
  assert.equal(recorder.getEntries().length, 0);
});

test("createTelemetryRecorder.getSummary() aggregates call count and total/avg duration per tool", () => {
  let nowMs = 0;
  const recorder = createTelemetryRecorder({ now: () => nowMs });

  recorder.recordStart({ tool: "grep", sessionID: "s1", callID: "c1" });
  nowMs = 100;
  recorder.recordEnd({ tool: "grep", sessionID: "s1", callID: "c1" });

  recorder.recordStart({ tool: "grep", sessionID: "s1", callID: "c2" });
  nowMs = 300;
  recorder.recordEnd({ tool: "grep", sessionID: "s1", callID: "c2" });

  recorder.recordStart({ tool: "semantic_search", sessionID: "s1", callID: "c3" });
  nowMs = 500;
  recorder.recordEnd({ tool: "semantic_search", sessionID: "s1", callID: "c3" });

  const summary = recorder.getSummary();
  const grepRow = summary.find((row) => row.tool === "grep");
  const searchRow = summary.find((row) => row.tool === "semantic_search");

  assert.ok(grepRow);
  assert.equal(grepRow!.callCount, 2);
  assert.equal(grepRow!.totalDurationMs, 300); // 100 + 200
  assert.equal(grepRow!.avgDurationMs, 150);

  assert.ok(searchRow);
  assert.equal(searchRow!.callCount, 1);
  assert.equal(searchRow!.totalDurationMs, 200);
});

test("createTelemetryRecorder.reset() clears all recorded entries", () => {
  const recorder = createTelemetryRecorder({ now: () => 1 });
  recorder.recordStart({ tool: "grep", sessionID: "s1", callID: "c1" });
  recorder.recordEnd({ tool: "grep", sessionID: "s1", callID: "c1" });
  assert.equal(recorder.getEntries().length, 1);

  recorder.reset();
  assert.equal(recorder.getEntries().length, 0);
  assert.equal(recorder.getSummary().length, 0);
});

test("createTelemetryRecorder still reports an in-flight call started but not yet ended (durationMs undefined)", () => {
  const recorder = createTelemetryRecorder({ now: () => 42 });
  recorder.recordStart({ tool: "lsp", sessionID: "s1", callID: "c1" });

  const entries = recorder.getEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.durationMs, undefined);
  // In-flight calls should not skew getSummary()'s duration aggregates.
  const summary = recorder.getSummary();
  assert.equal(summary.length, 0);
});

/**
 * Token-count tests (2026-09-14, overlap-benchmark-spike's 4th
 * "opencode-native" arm). This recorder is the ONLY thing that can
 * observe args/output for tools invoked via OpenCode's tool-calling
 * mechanism (not a shell command), which is exactly the situation the
 * 4th benchmark arm is in for `grep`/`glob`/`lsp` -- so getSummary() must
 * carry per-tool token totals too, or that arm would still need manual
 * bench.js-style instrumentation despite having this recorder available.
 * Uses the same word/number/punctuation-run approximation `bench.js`
 * uses (not chars/4) so numbers stay comparable across arms.
 */

test("createTelemetryRecorder counts approximate input/output tokens from args/output", () => {
  const recorder = createTelemetryRecorder({ now: () => 0 });
  recorder.recordStart({ tool: "grep", sessionID: "s1", callID: "c1", args: { pattern: "applyPendingBuchungen" } });
  recorder.recordEnd({ tool: "grep", sessionID: "s1", callID: "c1", output: "src/a.ts:12: match one" });

  const entry = recorder.getEntries()[0]!;
  assert.ok(entry.inputTokens! > 0);
  assert.ok(entry.outputTokens! > 0);
});

test("createTelemetryRecorder.getSummary() aggregates input/output/total tokens per tool", () => {
  const recorder = createTelemetryRecorder({ now: () => 0 });
  recorder.recordStart({ tool: "grep", sessionID: "s1", callID: "c1", args: "foo" });
  recorder.recordEnd({ tool: "grep", sessionID: "s1", callID: "c1", output: "bar baz" });
  recorder.recordStart({ tool: "grep", sessionID: "s1", callID: "c2", args: "foo" });
  recorder.recordEnd({ tool: "grep", sessionID: "s1", callID: "c2", output: "bar baz" });

  const row = recorder.getSummary().find((r) => r.tool === "grep")!;
  assert.ok(row.totalInputTokens > 0);
  assert.ok(row.totalOutputTokens > 0);
  assert.equal(row.totalTokens, row.totalInputTokens + row.totalOutputTokens);
  // Two identical calls -> input/output token totals are each even (exactly double a single call's).
  assert.equal(row.totalInputTokens % 2, 0);
  assert.equal(row.totalOutputTokens % 2, 0);
});

test("createTelemetryRecorder treats missing args/output as zero tokens without throwing", () => {
  const recorder = createTelemetryRecorder({ now: () => 0 });
  assert.doesNotThrow(() => {
    recorder.recordStart({ tool: "grep", sessionID: "s1", callID: "c1" });
    recorder.recordEnd({ tool: "grep", sessionID: "s1", callID: "c1" });
  });
  const row = recorder.getSummary().find((r) => r.tool === "grep")!;
  assert.equal(row.totalInputTokens, 0);
  assert.equal(row.totalOutputTokens, 0);
});

/**
 * OpenTelemetry wiring tests (user-directed, 2026-09-14). The recorder
 * dual-writes: it keeps its own in-memory summary (for the zero-config
 * `ai_context_telemetry_report` tool) AND emits standard OTel spans + a duration
 * histogram via the injected tracer/meter, so anyone with an OTel
 * collector already configured (Jaeger, Prometheus, etc.) gets this
 * plugin's tool-call telemetry for free, without the plugin bundling or
 * managing any exporter itself -- same "bring your own backend"
 * philosophy as the LLM/embedding model backend decision.
 */

function createFakeOtel() {
  const spans: { name: string; attributes: Record<string, unknown>; ended: boolean }[] = [];
  const histogramRecords: { value: number; attributes: Record<string, unknown> }[] = [];

  const tracer = {
    startSpan(name: string, options?: { attributes?: Record<string, unknown> }) {
      const span = { name, attributes: options?.attributes ?? {}, ended: false };
      spans.push(span);
      return {
        end: () => {
          span.ended = true;
        },
      };
    },
  };
  const histogram = {
    record(value: number, attributes?: Record<string, unknown>) {
      histogramRecords.push({ value, attributes: attributes ?? {} });
    },
  };
  const meter = {
    createHistogram: () => histogram,
  };

  return { tracer, meter, spans, histogramRecords };
}

test("createTelemetryRecorder starts an OTel span on recordStart with tool/session/call attributes", () => {
  const { tracer, meter, spans } = createFakeOtel();
  const recorder = createTelemetryRecorder({ now: () => 0, tracer, meter });

  recorder.recordStart({ tool: "grep", sessionID: "s1", callID: "c1" });

  assert.equal(spans.length, 1);
  assert.match(spans[0]!.name, /grep/);
  assert.equal(spans[0]!.attributes["tool"], "grep");
  assert.equal(spans[0]!.attributes["sessionID"], "s1");
  assert.equal(spans[0]!.attributes["callID"], "c1");
  assert.equal(spans[0]!.ended, false);
});

test("createTelemetryRecorder ends the matching OTel span and records a duration histogram on recordEnd", () => {
  let nowMs = 0;
  const { tracer, meter, spans, histogramRecords } = createFakeOtel();
  const recorder = createTelemetryRecorder({ now: () => nowMs, tracer, meter });

  recorder.recordStart({ tool: "grep", sessionID: "s1", callID: "c1" });
  nowMs = 120;
  recorder.recordEnd({ tool: "grep", sessionID: "s1", callID: "c1" });

  assert.equal(spans[0]!.ended, true);
  assert.equal(histogramRecords.length, 1);
  assert.equal(histogramRecords[0]!.value, 120);
  assert.equal(histogramRecords[0]!.attributes["tool"], "grep");
  assert.equal(histogramRecords[0]!.attributes["sessionID"], undefined); // opt-in only
});

test("createTelemetryRecorder does not record a histogram value for an end event with no matching start", () => {
  const { tracer, meter, histogramRecords } = createFakeOtel();
  const recorder = createTelemetryRecorder({ now: () => 5000, tracer, meter });

  recorder.recordEnd({ tool: "glob", sessionID: "s1", callID: "unknown" });

  assert.equal(histogramRecords.length, 0);
});

test("createTelemetryRecorder works without an OTel SDK configured (default global no-op API, safe by design)", () => {
  // No tracer/meter injected -- falls back to @opentelemetry/api's real
  // global no-op providers. Must not throw even though nothing is
  // actually collecting/exporting these spans/metrics anywhere.
  const recorder = createTelemetryRecorder({ now: () => 1 });
  assert.doesNotThrow(() => {
    recorder.recordStart({ tool: "grep", sessionID: "s1", callID: "c1" });
    recorder.recordEnd({ tool: "grep", sessionID: "s1", callID: "c1" });
  });
  assert.equal(recorder.getEntries()[0]!.durationMs, 0);
});
