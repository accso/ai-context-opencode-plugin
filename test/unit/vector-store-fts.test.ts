import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../../src/storage/sqlite.js";
import { createVectorStore, type VectorStoreChunk } from "../../src/storage/vector-store.js";

function chunk(id: string, text: string, extra: Partial<VectorStoreChunk> = {}): VectorStoreChunk {
  return {
    id,
    relativePath: `src/${id}.ts`,
    language: "typescript",
    text,
    startLine: 1,
    endLine: 1,
    chunkType: "function",
    vector: [1, 0],
    ...extra,
  };
}

test("searchText finds chunks by literal term, best bm25 first", () => {
  const store = createVectorStore({ path: ":memory:" });
  store.upsertChunks([
    chunk("a", "function parsePayload() { return 1 }"),
    chunk("b", "function other() { retry retry retry }"),
    chunk("c", "unrelated text about nothing"),
  ]);
  const hits = store.searchText("retry", 5);
  assert.deepEqual(hits.map((h) => h.id), ["b"]);
  assert.ok(hits[0]!.score > 0);
});

test("searchText matches camelCase parts of identifiers and the symbol column", () => {
  const store = createVectorStore({ path: ":memory:" });
  store.upsertChunks([
    chunk("a", "const x = retryHttpRequest(url)"),
    chunk("b", "nothing here", { symbol: "FooBarService" }),
  ]);
  assert.deepEqual(store.searchText("http", 5).map((h) => h.id), ["a"]);
  assert.deepEqual(store.searchText("FooBarService", 5).map((h) => h.id), ["b"]);
});

test("searchText matches words of the file path", () => {
  const store = createVectorStore({ path: ":memory:" });
  store.upsertChunks([chunk("a", "x", { relativePath: "src/billing/invoice_renderer.ts" })]);
  assert.deepEqual(store.searchText("invoice", 5).map((h) => h.id), ["a"]);
});

test("searchText ignores deleted and replaced chunks", () => {
  const store = createVectorStore({ path: ":memory:" });
  store.upsertChunks([chunk("a", "alpha token")]);
  store.upsertChunks([chunk("a", "beta token")]);
  assert.deepEqual(store.searchText("alpha", 5), []);
  assert.deepEqual(store.searchText("beta", 5).map((h) => h.id), ["a"]);
  store.deleteChunksForFile("src/a.ts");
  assert.deepEqual(store.searchText("beta", 5), []);
});

test("searchText returns [] for queries without usable terms", () => {
  const store = createVectorStore({ path: ":memory:" });
  store.upsertChunks([chunk("a", "alpha")]);
  assert.deepEqual(store.searchText("a b", 5), []);
  assert.deepEqual(store.searchText('"" ( ) OR', 5), []);
});

test("a store created before FTS existed is backfilled on open", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fts-"));
  const file = path.join(dir, "i.sqlite");
  const first = createVectorStore({ path: file });
  first.upsertChunks([chunk("a", "legacy content here")]);
  first.close();
  // simulate an old store: drop the FTS table
  const db = openDatabase(file);
  db.exec("DROP TABLE chunks_fts");
  db.close();
  const reopened = createVectorStore({ path: file });
  assert.deepEqual(reopened.searchText("legacy", 5).map((h) => h.id), ["a"]);
  reopened.close();
});

test("a different embedFormat clears stored chunks so they are re-embedded", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmt-"));
  const file = path.join(dir, "i.sqlite");
  const v1 = createVectorStore({ path: file, embedFormat: 1 });
  v1.upsertChunks([chunk("a", "text")]);
  v1.close();
  const same = createVectorStore({ path: file, embedFormat: 1 });
  assert.equal(same.getIndexStatus().chunkCount, 1);
  same.close();
  const v2 = createVectorStore({ path: file, embedFormat: 2 });
  assert.equal(v2.getIndexStatus().chunkCount, 0);
  assert.deepEqual(v2.searchText("text", 5), []);
  v2.close();
});

test("a store without embedFormat never clears anything", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmt-"));
  const file = path.join(dir, "i.sqlite");
  const a = createVectorStore({ path: file, embedFormat: 1 });
  a.upsertChunks([chunk("a", "text")]);
  a.close();
  const b = createVectorStore({ path: file });
  assert.equal(b.getIndexStatus().chunkCount, 1);
  b.close();
});

test("file fingerprints are stored per file and dropped with the file's chunks", () => {
  const store = createVectorStore({ path: ":memory:" });
  assert.equal(store.getFileFingerprint("a.ts"), null);
  store.setFileFingerprint("a.ts", "10:5");
  assert.equal(store.getFileFingerprint("a.ts"), "10:5");
  store.deleteChunksForFile("a.ts");
  assert.equal(store.getFileFingerprint("a.ts"), null);
});

test("fingerprints are cleared together with the chunks when the embed format changes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-fp-"));
  const file = path.join(dir, "v.sqlite");
  const first = createVectorStore({ path: file, embedFormat: 1 });
  first.setFileFingerprint("a.ts", "1:1");
  first.close();
  assert.equal(createVectorStore({ path: file, embedFormat: 1 }).getFileFingerprint("a.ts"), "1:1");
  assert.equal(createVectorStore({ path: file, embedFormat: 2 }).getFileFingerprint("a.ts"), null);
});
