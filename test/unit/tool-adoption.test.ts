import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAdoption } from "../../src/telemetry/adoption.js";
import { createTelemetryReportTool } from "../../src/tools/telemetry-report.js";

const e = (tool: string, sessionID = "s1") => ({ tool, sessionID, callID: Math.random().toString(), startedAt: 0 });

test("computeAdoption counts context-tool vs native-search calls and the share", () => {
  const r = computeAdoption([
    e("semantic_search"),
    e("repo_structure"),
    e("analyze_impact"),
    e("grep"),
    e("glob"),
    e("read"),
    e("bash"),
  ]);
  assert.equal(r.contextCalls, 3);
  assert.equal(r.nativeSearchCalls, 2);
  assert.equal(r.contextShare, 0.6);
  assert.deepEqual(r.contextByTool, { analyze_impact: 1, repo_structure: 1, semantic_search: 1 });
});

test("computeAdoption reports per session and handles no calls", () => {
  const r = computeAdoption([e("grep", "a"), e("semantic_search", "b"), e("grep", "b")]);
  assert.deepEqual(r.bySession.find((s) => s.sessionID === "a"), {
    sessionID: "a", contextCalls: 0, nativeSearchCalls: 1, contextShare: 0,
  });
  assert.equal(r.bySession.find((s) => s.sessionID === "b")!.contextShare, 0.5);
  assert.equal(computeAdoption([]).contextShare, null);
});

test("ai_context_telemetry_report keeps the summary array by default and returns adoption on request", async () => {
  const recorder = {
    getSummary: () => [],
    getEntries: () => [e("semantic_search"), e("grep")],
  } as never;
  const t = createTelemetryReportTool(recorder);
  assert.deepEqual(JSON.parse((await t.execute({}, {} as never)) as string), []);
  const adoption = JSON.parse((await t.execute({ view: "adoption" }, {} as never)) as string);
  assert.equal(adoption.contextShare, 0.5);
});
