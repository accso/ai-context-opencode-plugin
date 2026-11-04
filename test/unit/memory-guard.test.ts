import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryGuard,
  MemoryLimitError,
} from "../../src/indexing/memory-guard.js";
import { createIndexer } from "../../src/indexing/indexing.js";
import { createVectorStore } from "../../src/storage/vector-store.js";

const MB = 1024 * 1024;

test("below the limit, ensure() resolves without relief actions", async () => {
  let collected = 0;
  const guard = createMemoryGuard({
    limitMb: 1000,
    getRss: () => 500 * MB,
    collect: () => void collected++,
    sleep: async () => {},
  });
  await guard.ensure();
  assert.equal(collected, 0);
});

test("above the limit, it collects, pauses and recovers when the RSS drops", async () => {
  const readings = [2000 * MB, 1500 * MB, 800 * MB];
  let collected = 0;
  const guard = createMemoryGuard({
    limitMb: 1000,
    getRss: () => readings.shift() ?? 800 * MB,
    collect: () => void collected++,
    sleep: async () => {},
  });
  await guard.ensure();
  assert.ok(collected >= 1);
});

test("if the RSS stays above the limit after all retries, ensure() throws a clear MemoryLimitError", async () => {
  const guard = createMemoryGuard({
    limitMb: 1000,
    getRss: () => 2048 * MB,
    collect: () => {},
    sleep: async () => {},
    retries: 3,
  });
  await assert.rejects(
    () => guard.ensure(),
    (error: unknown) => {
      assert.ok(error instanceof MemoryLimitError);
      assert.match((error as Error).message, /2048 MB.*max_memory_mb=1000/);
      return true;
    },
  );
});

test("limitMb <= 0 disables the guard", async () => {
  const guard = createMemoryGuard({
    limitMb: 0,
    getRss: () => 99999 * MB,
    collect: () => {},
    sleep: async () => {},
  });
  await guard.ensure();
});

test("indexer stops the batch on MemoryLimitError and reports the failure instead of grinding on", async () => {
  const processed: string[] = [];
  const events: string[] = [];
  const indexer = createIndexer({
    vectorStore: createVectorStore({ path: ":memory:" }),
    embedDocument: async () => [1, 2],
    readFile: async (f) => (processed.push(f), "const a = 1;\n"),
    shouldIndexFile: () => true,
    memoryGuard: {
      ensure: async () => {
        if (processed.length >= 1) throw new MemoryLimitError(2048, 1000);
      },
    },
    progress: {
      beginBatch: () => events.push("begin"),
      fileDone: (f) => events.push(`done ${f}`),
      fileFailed: (f) => events.push(`failed ${f}`),
      endBatch: () => events.push("end"),
      abort: (e) => events.push(`abort ${(e as Error).message.slice(0, 20)}`),
    },
  });
  await indexer.indexFiles(
    ["a.ts", "b.ts", "c.ts"].map((file) => ({ file, event: "add" as const })),
  );
  assert.deepEqual(processed, ["a.ts"]);
  assert.equal(events.filter((e) => e.startsWith("abort")).length, 1);
  assert.ok(!events.some((e) => e.includes("b.ts") || e.includes("c.ts")));
});
