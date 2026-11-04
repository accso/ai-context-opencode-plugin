import { test } from "node:test";
import assert from "node:assert/strict";
import { createSemanticSearchTool } from "../../src/tools/semantic-search.js";
import { createVectorStore } from "../../src/storage/vector-store.js";

/**
 * Unit tests for the wired-up (no longer stubbed) semantic_search tool
 * (plan.md, "port-semantic-search-tool"). The vector store is a real
 * in-memory `better-sqlite3` instance (fast, no mocking needed --
 * matches this repo's existing `vector-store.test.ts` style); the
 * query-side embedding step is injected as `embedQuery`, since that's
 * the piece backed by the real onnxruntime-node model (see
 * `embedder.test.ts` for the embedding math itself).
 */

function seededStore() {
  const store = createVectorStore({ path: ":memory:" });
  store.upsertChunks([
    {
      id: "c1",
      relativePath: "src/http.ts",
      language: "typescript",
      text: "retries failed requests with exponential backoff",
      startLine: 1,
      endLine: 10,
      symbol: "retryRequest",
      chunkType: "function",
      vector: [1, 0, 0],
    },
    {
      id: "c2",
      relativePath: "src/webhook.ts",
      language: "typescript",
      text: "validates the incoming webhook signature",
      startLine: 1,
      endLine: 8,
      symbol: "verifySignature",
      chunkType: "function",
      vector: [0, 1, 0],
    },
  ]);
  return store;
}

test("semantic_search embeds the query and returns the vector store's top matches as JSON", async () => {
  const store = seededStore();
  const embedQuery = async (text: string) => {
    assert.equal(text, "how do we retry http requests?");
    return [1, 0, 0]; // matches c1 exactly
  };
  const toolDef = createSemanticSearchTool({ vectorStore: store, embedQuery });
  const raw = await toolDef.execute(
    { query: "how do we retry http requests?", limit: 5 },
    {} as never,
  );
  const results = JSON.parse(raw as string);
  assert.equal(results[0].id, "c1");
  assert.equal(results[0].relativePath, "src/http.ts");
  assert.ok(typeof results[0].score === "number");
});

test("semantic_search respects the limit argument", async () => {
  const store = seededStore();
  const embedQuery = async () => [0.5, 0.5, 0];
  const toolDef = createSemanticSearchTool({ vectorStore: store, embedQuery });
  const raw = await toolDef.execute({ query: "anything", limit: 1 }, {} as never);
  const results = JSON.parse(raw as string);
  assert.equal(results.length, 1);
});

/**
 * Cross-repo allow-list search (plan.md, "cross-repo-allowlist",
 * user-directed 2026-09-15): results from other allowed repos are
 * merged in and tagged with their project key, so the agent/user can
 * tell where a result actually came from -- this repo's own results
 * are untagged (project: undefined) to keep the common case's JSON
 * unchanged.
 */

test("semantic_search merges in results from allowed cross-repo stores, tagged with their project key", async () => {
  const ownStore = createVectorStore({ path: ":memory:" });
  ownStore.upsertChunks([
    { id: "own1", relativePath: "src/a.ts", language: "typescript", text: "own repo chunk", startLine: 1, endLine: 1, chunkType: "function", vector: [1, 0] },
  ]);
  const libStore = createVectorStore({ path: ":memory:" });
  libStore.upsertChunks([
    { id: "lib1", relativePath: "src/b.ts", language: "typescript", text: "library chunk", startLine: 1, endLine: 1, chunkType: "function", vector: [1, 0] },
  ]);
  const embedQuery = async () => [1, 0];
  const toolDef = createSemanticSearchTool({
    vectorStore: ownStore,
    embedQuery,
    crossRepoStores: [{ key: "libfoo-abc12345", store: libStore }],
  });
  const raw = await toolDef.execute({ query: "anything", limit: 10 }, {} as never);
  const results = JSON.parse(raw as string);
  assert.equal(results.length, 2);
  const own = results.find((r: any) => r.id === "own1");
  const lib = results.find((r: any) => r.id === "lib1");
  assert.equal(own.project, undefined);
  assert.equal(lib.project, "libfoo-abc12345");
  ownStore.close();
  libStore.close();
});

test("semantic_search still respects limit when merging cross-repo results", async () => {
  const ownStore = createVectorStore({ path: ":memory:" });
  ownStore.upsertChunks([
    { id: "own1", relativePath: "src/a.ts", language: "typescript", text: "own", startLine: 1, endLine: 1, chunkType: "function", vector: [1, 0] },
  ]);
  const libStore = createVectorStore({ path: ":memory:" });
  libStore.upsertChunks([
    { id: "lib1", relativePath: "src/b.ts", language: "typescript", text: "lib", startLine: 1, endLine: 1, chunkType: "function", vector: [1, 0] },
  ]);
  const toolDef = createSemanticSearchTool({
    vectorStore: ownStore,
    embedQuery: async () => [1, 0],
    crossRepoStores: [{ key: "libfoo-abc12345", store: libStore }],
  });
  const raw = await toolDef.execute({ query: "anything", limit: 1 }, {} as never);
  assert.equal(JSON.parse(raw as string).length, 1);
  ownStore.close();
  libStore.close();
});

test("semantic_search wraps results with an indexingNotice while the index is still being built", async () => {
  const toolDef = createSemanticSearchTool({
    vectorStore: seededStore(),
    embedQuery: async () => [1, 0, 0],
    getIndexingNotice: () => "Index is still being built (1/2 files)",
  });
  const out = JSON.parse((await toolDef.execute({ query: "retry", limit: 5 }, {} as never)) as string);
  assert.equal(out.indexingNotice, "Index is still being built (1/2 files)");
  assert.equal(out.results[0].id, "c1");
});

test("semantic_search keeps the plain array shape when no notice is active", async () => {
  const toolDef = createSemanticSearchTool({
    vectorStore: seededStore(),
    embedQuery: async () => [1, 0, 0],
    getIndexingNotice: () => null,
  });
  const out = JSON.parse((await toolDef.execute({ query: "retry", limit: 5 }, {} as never)) as string);
  assert.ok(Array.isArray(out));
});

test("semantic_search fuses vector and keyword channels (exact identifier wins even if the vector misses)", async () => {
  const store = seededStore();
  const tool = createSemanticSearchTool({ vectorStore: store, embedQuery: async () => [0, 0, 1] });
  const out = JSON.parse((await tool.execute({ query: "verifySignature", limit: 1 }, {} as never)) as string);
  assert.equal(out[0].symbol, "verifySignature");
});

test("semantic_search reorders the fused candidates with the reranker", async () => {
  const store = seededStore();
  const seen: { query: string; texts: string[] }[] = [];
  const tool = createSemanticSearchTool({
    vectorStore: store,
    embedQuery: async () => [1, 0, 0],
    rerank: async (query, texts) => {
      seen.push({ query, texts });
      return texts.map((t) => (t.includes("webhook") ? 5 : 1));
    },
  });
  const out = JSON.parse((await tool.execute({ query: "anything", limit: 2 }, {} as never)) as string);
  assert.equal(out[0].relativePath, "src/webhook.ts");
  assert.equal(out[0].score, 5);
  assert.equal(seen[0]!.query, "anything");
  assert.ok(seen[0]!.texts.every((t) => t.startsWith("File: ")));
});

test("semantic_search falls back to the fused order when the reranker fails", async () => {
  const store = seededStore();
  const tool = createSemanticSearchTool({
    vectorStore: store,
    embedQuery: async () => [1, 0, 0],
    rerank: async () => {
      throw new Error("model unavailable");
    },
  });
  const out = JSON.parse((await tool.execute({ query: "retry", limit: 2 }, {} as never)) as string);
  assert.equal(out[0].relativePath, "src/http.ts");
});

import { createPathFilter } from "../../src/tools/semantic-search.js";

test("createPathFilter matches folder prefixes and globs", () => {
  assert.equal(createPathFilter(undefined), undefined);
  const dir = createPathFilter(["src/api/"])!;
  assert.equal(dir("src/api/a.ts"), true);
  assert.equal(dir("src/apix/a.ts"), false);
  const glob = createPathFilter(["docs/**/*.yaml"])!;
  assert.equal(glob("docs/a.yaml"), true);
  assert.equal(glob("docs/x/y/a.yaml"), true);
  assert.equal(glob("docs/a.md"), false);
  const ext = createPathFilter(["*.ts"])!;
  assert.equal(ext("src/deep/a.ts"), true);
  assert.equal(ext("a.py"), false);
});

test("semantic_search applies paths and min_score", async () => {
  const store = seededStore();
  const toolDef = createSemanticSearchTool({ vectorStore: store, embedQuery: async () => [1, 1, 0] });
  const only = JSON.parse((await toolDef.execute({ query: "retries webhook", limit: 5, paths: ["src/webhook.ts"] }, {} as never)) as string);
  assert.deepEqual(only.map((r: { relativePath: string }) => r.relativePath), ["src/webhook.ts"]);
  const none = JSON.parse((await toolDef.execute({ query: "retries webhook", limit: 5, min_score: 1e9 }, {} as never)) as string);
  assert.deepEqual(none, []);
});
