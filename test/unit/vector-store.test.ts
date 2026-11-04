import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createVectorStore } from "../../src/storage/vector-store.js";

/**
 * Unit tests for the embedded vector store spike (plan.md,
 * "storage-spike"). Backed by `better-sqlite3` (in-memory for tests,
 * file-backed in real use) -- no Docker, no server process, replacing
 * the Postgres+Qdrant pairing `watcher/db.py` uses today for the
 * common-size-repo/default path. Mirrors that module's chunk shape
 * (relativePath, language, text, startLine, endLine, symbol, chunkType)
 * and its stable-id-based delta-upsert semantics
 * (stable_chunk_id/upsert_chunks_delta/get_chunk_ids_for_file), and its
 * `search_chunks` cosine-similarity query.
 */

function chunk(
  overrides: Partial<
    Parameters<ReturnType<typeof createVectorStore>["upsertChunks"]>[0][number]
  > = {},
) {
  return {
    id: "c1",
    relativePath: "src/a.ts",
    language: "typescript",
    text: "export function a() {}",
    startLine: 1,
    endLine: 1,
    symbol: "a",
    chunkType: "function",
    vector: [1, 0, 0],
    ...overrides,
  };
}

test("createVectorStore.getAllChunks returns every stored chunk, including its vector", () => {
  const store = createVectorStore({ path: ":memory:" });
  store.upsertChunks([
    chunk({ id: "c1", vector: [1, 0, 0] }),
    chunk({ id: "c2", relativePath: "src/b.ts", vector: [0, 1, 0] }),
  ]);
  const all = store.getAllChunks();
  assert.equal(all.length, 2);
  const ids = all.map((c) => c.id).sort();
  assert.deepEqual(ids, ["c1", "c2"]);
  const c1 = all.find((c) => c.id === "c1")!;
  assert.deepEqual(c1.vector, [1, 0, 0]);
  store.close();
});

test("createVectorStore upserts chunks and returns them via search ranked by cosine similarity", () => {
  const store = createVectorStore({ path: ":memory:" });
  store.upsertChunks([
    chunk({ id: "c1", text: "alpha", vector: [1, 0, 0] }),
    chunk({ id: "c2", text: "beta", vector: [0, 1, 0] }),
    chunk({ id: "c3", text: "gamma", vector: [0.9, 0.1, 0] }),
  ]);

  const results = store.search([1, 0, 0], 2);
  assert.equal(results.length, 2);
  assert.equal(results[0]!.id, "c1"); // exact match, highest cosine similarity
  assert.equal(results[1]!.id, "c3"); // close second
  assert.ok(results[0]!.score >= results[1]!.score);
  store.close();
});

test("createVectorStore.getChunkIdsForFile returns only ids stored for that file", () => {
  const store = createVectorStore({ path: ":memory:" });
  store.upsertChunks([
    chunk({ id: "c1", relativePath: "src/a.ts" }),
    chunk({ id: "c2", relativePath: "src/b.ts" }),
  ]);

  const ids = store.getChunkIdsForFile("src/a.ts");
  assert.deepEqual(ids, new Set(["c1"]));
  store.close();
});

test("createVectorStore.deleteChunksForFile removes all chunks for that file only", () => {
  const store = createVectorStore({ path: ":memory:" });
  store.upsertChunks([
    chunk({ id: "c1", relativePath: "src/a.ts" }),
    chunk({ id: "c2", relativePath: "src/b.ts" }),
  ]);

  store.deleteChunksForFile("src/a.ts");

  assert.deepEqual(store.getChunkIdsForFile("src/a.ts"), new Set());
  assert.deepEqual(store.getChunkIdsForFile("src/b.ts"), new Set(["c2"]));
  store.close();
});

test("createVectorStore.upsertChunks replaces a chunk with the same id (re-embed / metadata refresh)", () => {
  const store = createVectorStore({ path: ":memory:" });
  store.upsertChunks([chunk({ id: "c1", text: "old", vector: [1, 0, 0] })]);
  store.upsertChunks([chunk({ id: "c1", text: "new", vector: [0, 1, 0] })]);

  const results = store.search([0, 1, 0], 5);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.text, "new");
  store.close();
});

test("createVectorStore creates missing parent directories for a nested file path", () => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/ai-context-vector-store-test-${Date.now()}/nested/deep`;
  const path = `${dir}/index.sqlite`;
  const store = createVectorStore({ path });
  store.upsertChunks([chunk({ id: "c1" })]);
  assert.deepEqual(store.getChunkIdsForFile("src/a.ts"), new Set(["c1"]));
  store.close();
  fs.rmSync(dir.split("/nested")[0]!, { recursive: true, force: true });
});

test("createVectorStore persists across store instances when given a real file path", () => {
  const path = `${process.env.TMPDIR ?? "/tmp"}/ai-context-vector-store-test-${Date.now()}.sqlite`;
  const store1 = createVectorStore({ path });
  store1.upsertChunks([chunk({ id: "c1" })]);
  store1.close();

  const store2 = createVectorStore({ path });
  assert.deepEqual(store2.getChunkIdsForFile("src/a.ts"), new Set(["c1"]));
  store2.close();

  fs.rmSync(path, { force: true });
});

/**
 * Index-status observability (port-index-status-tools, plan.md): mirrors
 * `mcp-server/src/db.ts`'s `getIndexStatus`/`getRecentChanges` -- but
 * since this store keeps one row per chunk (not a `file_index` table
 * with one row per file), "per-file" stats are derived by grouping
 * chunks by `relativePath`. `now` is injectable (defaults to
 * `Date.now`) so tests don't depend on wall-clock time.
 */

test("createVectorStore.getIndexStatus reports file/chunk counts and the newest indexed timestamp", () => {
  let clock = 1000;
  const store = createVectorStore({
    path: ":memory:",
    now: () => new Date(clock++).toISOString(),
  });
  store.upsertChunks([
    chunk({ id: "c1", relativePath: "src/a.ts" }),
    chunk({ id: "c2", relativePath: "src/a.ts" }),
  ]);
  store.upsertChunks([chunk({ id: "c3", relativePath: "src/b.ts" })]);

  const status = store.getIndexStatus();
  assert.equal(status.fileCount, 2);
  assert.equal(status.chunkCount, 3);
  assert.equal(status.newestIndexedAt, new Date(1002).toISOString());
  store.close();
});

test("createVectorStore.getIndexStatus reports zero counts and a null timestamp for an empty store", () => {
  const store = createVectorStore({ path: ":memory:" });
  const status = store.getIndexStatus();
  assert.equal(status.fileCount, 0);
  assert.equal(status.chunkCount, 0);
  assert.equal(status.newestIndexedAt, null);
  store.close();
});

test("createVectorStore.upsertChunks re-stamps indexed_at (and re-groups file stats) when a chunk is re-embedded", () => {
  let clock = 1000;
  const store = createVectorStore({
    path: ":memory:",
    now: () => new Date(clock++).toISOString(),
  });
  store.upsertChunks([chunk({ id: "c1", relativePath: "src/a.ts" })]);
  const firstStatus = store.getIndexStatus();
  store.upsertChunks([
    chunk({ id: "c1", relativePath: "src/a.ts", text: "changed" }),
  ]);
  const secondStatus = store.getIndexStatus();
  assert.ok(secondStatus.newestIndexedAt! > firstStatus.newestIndexedAt!);
  store.close();
});

test("createVectorStore.getRecentChanges returns per-file rows ordered by most-recently-indexed first", () => {
  let clock = 1000;
  const store = createVectorStore({
    path: ":memory:",
    now: () => new Date(clock++).toISOString(),
  });
  store.upsertChunks([
    chunk({ id: "c1", relativePath: "src/a.ts" }),
    chunk({ id: "c2", relativePath: "src/a.ts" }),
  ]); // indexed_at 1000/1001, file a.ts has 2 chunks
  store.upsertChunks([chunk({ id: "c3", relativePath: "src/b.ts" })]); // indexed_at 1002

  const changes = store.getRecentChanges(10);
  assert.equal(changes.length, 2);
  assert.equal(changes[0]!.relativePath, "src/b.ts");
  assert.equal(changes[0]!.chunkCount, 1);
  assert.equal(changes[1]!.relativePath, "src/a.ts");
  assert.equal(changes[1]!.chunkCount, 2);
  store.close();
});

test("createVectorStore.getRecentChanges respects the limit argument", () => {
  const store = createVectorStore({ path: ":memory:" });
  store.upsertChunks([
    chunk({ id: "c1", relativePath: "src/a.ts" }),
    chunk({ id: "c2", relativePath: "src/b.ts" }),
    chunk({ id: "c3", relativePath: "src/c.ts" }),
  ]);
  assert.equal(store.getRecentChanges(2).length, 2);
  store.close();
});

test("search pages through the table and returns the same ranking as an unpaged scan", () => {
  const paged = createVectorStore({ path: ":memory:", searchPageSize: 3 });
  const whole = createVectorStore({ path: ":memory:", searchPageSize: 10_000 });
  const chunks = Array.from({ length: 11 }, (_, i) =>
    chunk({
      id: `c${i}`,
      text: `t${i}`,
      vector: [Math.cos(i / 3), Math.sin(i / 3), (i % 4) / 4],
    }),
  );
  paged.upsertChunks(chunks);
  whole.upsertChunks(chunks);

  const query = [0.3, 0.9, 0.1];
  assert.deepEqual(
    paged.search(query, 4).map((r) => r.id),
    whole.search(query, 4).map((r) => r.id),
  );
  paged.close();
  whole.close();
});

test("search never materialises the whole table in one statement", () => {
  const store = createVectorStore({ path: ":memory:", searchPageSize: 2 });
  store.upsertChunks(
    Array.from({ length: 5 }, (_, i) =>
      chunk({ id: `c${i}`, vector: [1, i, 0] }),
    ),
  );
  assert.equal(store.search([1, 0, 0], 10).length, 5);
  assert.equal(store.search([1, 0, 0], 2).length, 2);
  store.close();
});

test("createVectorStore.listFiles returns one row per file with language and chunk count, sorted, without vectors", () => {
  const store = createVectorStore({ path: ":memory:" });
  store.upsertChunks([
    chunk({ id: "c1", relativePath: "src/b.ts" }),
    chunk({ id: "c2", relativePath: "src/a.py", language: "python" }),
    chunk({ id: "c3", relativePath: "src/b.ts" }),
  ]);
  assert.deepEqual(store.listFiles(), [
    { relativePath: "src/a.py", language: "python", chunkCount: 1 },
    { relativePath: "src/b.ts", language: "typescript", chunkCount: 2 },
  ]);
  store.close();
});

test("createVectorStore.getChunksPage pages through chunks ordered by id (keyset)", () => {
  const store = createVectorStore({ path: ":memory:" });
  store.upsertChunks(["c", "a", "d", "b"].map((id) => chunk({ id })));
  const first = store.getChunksPage(null, 3);
  assert.deepEqual(first.map((c) => c.id), ["a", "b", "c"]);
  assert.deepEqual(first[0]!.vector, [1, 0, 0]);
  assert.deepEqual(store.getChunksPage("c", 3).map((c) => c.id), ["d"]);
  assert.deepEqual(store.getChunksPage("d", 3), []);
  store.close();
});
