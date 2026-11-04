import { test } from "node:test";
import assert from "node:assert/strict";
import { createSearchDocsTool } from "../../src/tools/search-docs.js";

/**
 * Unit tests for search_docs (plan.md,
 * "port-doc-tree-markdown"): the retrieval-side native tool exposing
 * doc-tree search, decided as a SEPARATE tool from semantic_search (not
 * a mode within it) since its args (mode: toc_only/summary_only/
 * node_text) and result shape (TOC + node list) are meaningfully
 * different from code-chunk search results.
 */

function store(overrides: Partial<Parameters<typeof createSearchDocsTool>[0]> = {}) {
  return {
    searchDocTrees: (_query: string, _mode: string, _limit: number) => [
      { relativePath: "docs/a.md", toc: "# docs/a.md\n[0001] Intro", relevantNodes: [] },
    ],
    ...overrides,
  };
}

test("search_docs returns the store's search results as JSON", async () => {
  const toolDef = createSearchDocsTool(store());
  const raw = await toolDef.execute({ query: "anything" }, {} as never);
  const results = JSON.parse(raw as string);
  assert.equal(results.length, 1);
  assert.equal(results[0].relativePath, "docs/a.md");
});

test("search_docs defaults mode to summary_only and limit to 5, forwarding query", async () => {
  const searchDocTrees = (query: string, mode: string, limit: number) => {
    assert.equal(query, "how do retries work");
    assert.equal(mode, "summary_only");
    assert.equal(limit, 5);
    return [];
  };
  const toolDef = createSearchDocsTool(store({ searchDocTrees }));
  await toolDef.execute({ query: "how do retries work" }, {} as never);
});

test("search_docs forwards an explicit mode and limit", async () => {
  const searchDocTrees = (_query: string, mode: string, limit: number) => {
    assert.equal(mode, "node_text");
    assert.equal(limit, 2);
    return [];
  };
  const toolDef = createSearchDocsTool(store({ searchDocTrees }));
  await toolDef.execute({ query: "x", mode: "node_text", limit: 2 }, {} as never);
});

test("search_docs wraps results with an indexingNotice while indexing is running", async () => {
  const toolDef = createSearchDocsTool(store({ getIndexingNotice: () => "still indexing" }));
  const out = JSON.parse((await toolDef.execute({ query: "x" }, {} as never)) as string);
  assert.equal(out.indexingNotice, "still indexing");
  assert.equal(out.results[0].relativePath, "docs/a.md");
});

test("search_docs keeps the plain array shape when no notice is active", async () => {
  const toolDef = createSearchDocsTool(store({ getIndexingNotice: () => null }));
  assert.ok(Array.isArray(JSON.parse((await toolDef.execute({ query: "x" }, {} as never)) as string)));
});

test("search_docs can search another allowed project via `project`", async () => {
  const toolDef = createSearchDocsTool(
    store({
      crossRepoDocs: [
        {
          key: "lib-1",
          searchDocTrees: () => [{ relativePath: "docs/lib.md", toc: "t", relevantNodes: [] }],
        },
      ],
    } as never),
  );
  const found = JSON.parse((await toolDef.execute({ query: "q", project: "lib-1" } as never, {} as never)) as string);
  assert.equal(found[0].relativePath, "docs/lib.md");
  const unknown = JSON.parse((await toolDef.execute({ query: "q", project: "nope" } as never, {} as never)) as string);
  assert.match(unknown.error, /Unknown or not allowed project "nope"\. Allowed: lib-1/);
});
