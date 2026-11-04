import { test } from "node:test";
import assert from "node:assert/strict";
import { createIndexStatusTool } from "../../src/tools/index-status.js";

/**
 * Unit tests for index_status (plan.md,
 * "port-index-status-tools"): a single native tool combining
 * `mcp-server/src/db.ts`'s `getIndexStatus` (file/chunk counts, newest
 * indexed_at) and `getRecentChanges` (most-recently-indexed files) --
 * index-health/observability, distinct from ai_context_list_projects
 * (cross-project) and ai_context_telemetry_report (tool-call latency, not indexing
 * state). Backed by an injected `VectorStore`-shaped dependency, same
 * pattern as the other tools in src/tools/.
 */

function store(overrides: Partial<Parameters<typeof createIndexStatusTool>[0]> = {}) {
  return {
    getIndexStatus: () => ({ fileCount: 2, chunkCount: 5, newestIndexedAt: "2026-09-16T00:00:00.000Z" }),
    getRecentChanges: (_limit: number) => [
      { relativePath: "src/a.ts", indexedAt: "2026-09-16T00:00:00.000Z", chunkCount: 3 },
      { relativePath: "src/b.ts", indexedAt: "2026-09-15T00:00:00.000Z", chunkCount: 2 },
    ],
    ...overrides,
  };
}

test("index_status returns the store's index status as JSON", async () => {
  const toolDef = createIndexStatusTool(store());
  const raw = await toolDef.execute({ limit: 10 }, {} as never);
  const result = JSON.parse(raw as string);
  assert.equal(result.fileCount, 2);
  assert.equal(result.chunkCount, 5);
  assert.equal(result.newestIndexedAt, "2026-09-16T00:00:00.000Z");
});

test("index_status includes recentChanges, passing the limit argument through", async () => {
  const getRecentChanges = (limit: number) => {
    assert.equal(limit, 3);
    return [{ relativePath: "src/a.ts", indexedAt: "2026-09-16T00:00:00.000Z", chunkCount: 3 }];
  };
  const toolDef = createIndexStatusTool(store({ getRecentChanges }));
  const raw = await toolDef.execute({ limit: 3 }, {} as never);
  const result = JSON.parse(raw as string);
  assert.equal(result.recentChanges.length, 1);
  assert.equal(result.recentChanges[0].relativePath, "src/a.ts");
});

test("index_status defaults limit to 10 when not provided", async () => {
  const getRecentChanges = (limit: number) => {
    assert.equal(limit, 10);
    return [];
  };
  const toolDef = createIndexStatusTool(store({ getRecentChanges }));
  await toolDef.execute({}, {} as never);
});

import { createProgressTracker } from "../../src/indexing/index-progress.js";

test("index_status exposes live indexing progress, failures and the status file path", async () => {
  let t = 0;
  const tracker = createProgressTracker({ now: () => t });
  tracker.beginBatch(4);
  tracker.fileDone("a.ts");
  t = 1000;
  tracker.fileFailed("bad.ts", new Error("boom"));
  const toolDef = createIndexStatusTool(
    store({ getProgress: () => tracker.snapshot(), statusFilePath: "/repo/.opencode/ai-context/index-status.json" }),
  );
  const result = JSON.parse((await toolDef.execute({ limit: 10 }, {} as never)) as string);

  assert.equal(result.indexing.running, true);
  assert.equal(result.indexing.phase, "indexing");
  assert.equal(result.indexing.done, 2);
  assert.equal(result.indexing.total, 4);
  assert.equal(result.indexing.percent, 50);
  assert.equal(result.indexing.statusFile, "/repo/.opencode/ai-context/index-status.json");
  assert.deepEqual(result.indexing.failures.map((f: { file: string }) => f.file), ["bad.ts"]);
  assert.equal(result.fileCount, 2, "the existing store fields stay untouched");
});

test("index_status omits the indexing block when no progress source is wired", async () => {
  const result = JSON.parse((await createIndexStatusTool(store()).execute({ limit: 10 }, {} as never)) as string);
  assert.equal("indexing" in result, false);
});

test("index_status passes the indexing notices on to the agent", async () => {
  const tracker = createProgressTracker({ now: () => 0 });
  tracker.beginBatch(1);
  tracker.addNotice("Summary LLM answered 401: API key not set.");
  const toolDef = createIndexStatusTool(store({ getProgress: () => tracker.snapshot() }));
  const result = JSON.parse((await toolDef.execute({}, {} as never)) as string);
  assert.deepEqual(result.indexing.notices, ["Summary LLM answered 401: API key not set."]);
});

test("index_status reports watcher events and the last rescan", async () => {
  const def = createIndexStatusTool(
    store({
      getWatcher: () => ({
        eventsReceived: 0,
        lastEventAt: null,
        rescan: { runs: 2, lastRunAt: "t", lastTrigger: "bash", lastFilesOnDisk: 9 },
      }),
    }),
  );
  const out = JSON.parse((await def.execute({}, {} as never)) as string);
  assert.equal(out.watcher.eventsReceived, 0);
  assert.equal(out.watcher.rescan.lastFilesOnDisk, 9);
});
