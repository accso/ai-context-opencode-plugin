import { test } from "node:test";
import assert from "node:assert/strict";
import { initOtelMetrics, resolveOtelSettings } from "../../src/telemetry/otel-sdk.js";
import { createTelemetryRecorder } from "../../src/telemetry/telemetry.js";
import type { PushMetricExporter, ResourceMetrics } from "@opentelemetry/sdk-metrics";

function fakeExporter() {
  const batches: ResourceMetrics[] = [];
  const exporter: PushMetricExporter = {
    export(m, done) {
      batches.push(m);
      done({ code: 0 });
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  return { exporter, batches };
}

test("resource carries project and service.name; histogram has project label, sessionID only when opted in", async () => {
  for (const includeSessionId of [false, true]) {
    const { exporter, batches } = fakeExporter();
    const handle = initOtelMetrics({ project: "demo", exporter, flushMs: 60_000 });
    let now = 0;
    const rec = createTelemetryRecorder({ now: () => now, meter: handle.meter, project: "demo", includeSessionId });
    rec.recordStart({ tool: "grep", sessionID: "s1", callID: "c1" });
    now = 50;
    rec.recordEnd({ tool: "grep", sessionID: "s1", callID: "c1" });
    await handle.shutdown(); // flushes
    const rm = batches[0]!;
    assert.equal(rm.resource.attributes["service.name"], "ai-context");
    assert.equal(rm.resource.attributes["project"], "demo");
    const metric = rm.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === "opencode.tool.duration")!;
    const attrs = metric.dataPoints[0]!.attributes;
    assert.equal(attrs["tool"], "grep");
    assert.equal(attrs["project"], "demo");
    assert.equal(attrs["sessionID"], includeSessionId ? "s1" : undefined);
  }
});

test("settings: disabled by default, env overrides file, project precedence", () => {
  assert.equal(resolveOtelSettings("fallback", {}, {}).enabled, false);
  const s = resolveOtelSettings("fallback", { otelEnabled: true, otelFlushMs: 1000 }, {});
  assert.equal(s.enabled, true);
  assert.equal(s.flushMs, 1000);
  assert.equal(s.project, "fallback");
  assert.equal(s.endpoint, "http://127.0.0.1:4318");
  const e = resolveOtelSettings("fallback", { otelEnabled: true, project: "file" }, {
    AI_CONTEXT_OTEL_ENABLED: "0",
    AI_CONTEXT_PROJECT: "env",
    AI_CONTEXT_OTEL_FLUSH_MS: "250",
  });
  assert.equal(e.enabled, false);
  assert.equal(e.project, "env");
  assert.equal(e.flushMs, 250);
});

test("unreachable endpoint does not throw and warns once", async () => {
  const warnings: string[] = [];
  const handle = initOtelMetrics({
    project: "demo",
    endpoint: "http://127.0.0.1:1",
    flushMs: 50,
    onWarn: (m) => warnings.push(m),
  });
  const rec = createTelemetryRecorder({ meter: handle.meter, project: "demo" });
  rec.recordStart({ tool: "t", sessionID: "s", callID: "c" });
  rec.recordEnd({ tool: "t", sessionID: "s", callID: "c" });
  await new Promise((r) => setTimeout(r, 300));
  await assert.doesNotReject(handle.shutdown());
  assert.equal(warnings.length, 1);
});
