import { test } from "node:test";
import assert from "node:assert/strict";
import { fuseRankings, hybridSearch } from "../../src/search/hybrid.js";
import { createVectorStore, type VectorSearchResult } from "../../src/storage/vector-store.js";

function hit(id: string, score = 1): VectorSearchResult {
  return { id, relativePath: `${id}.ts`, language: "typescript", text: id, startLine: 1, endLine: 1, chunkType: "function", score };
}

test("fuseRankings rewards items ranked well in several lists (RRF)", () => {
  const fused = fuseRankings([[hit("a"), hit("b"), hit("c")], [hit("c"), hit("b"), hit("d")]], 10);
  assert.deepEqual(fused.map((h) => h.id), ["c", "b", "a", "d"]);
});

test("fuseRankings uses 1/(k+rank) scores and honours the limit", () => {
  const fused = fuseRankings([[hit("a"), hit("b")]], 1, 60);
  assert.equal(fused.length, 1);
  assert.ok(Math.abs(fused[0]!.score - 1 / 61) < 1e-12);
});

test("fuseRankings of nothing is empty", () => {
  assert.deepEqual(fuseRankings([], 5), []);
  assert.deepEqual(fuseRankings([[], []], 5), []);
});

test("hybridSearch surfaces an exact keyword hit that vectors rank low", () => {
  const store = createVectorStore({ path: ":memory:" });
  store.upsertChunks([
    { id: "sem", relativePath: "sem.ts", language: "typescript", text: "generic handler", startLine: 1, endLine: 1, chunkType: "function", vector: [1, 0] },
    { id: "lex", relativePath: "lex.ts", language: "typescript", text: "function zephyrQuota() {}", startLine: 1, endLine: 1, chunkType: "function", vector: [0, 1] },
  ]);
  const hits = hybridSearch(store, { query: "zephyrQuota", vector: [1, 0], limit: 2 });
  assert.deepEqual(hits.map((h) => h.id).sort(), ["lex", "sem"]);
});
