import { test } from "node:test";
import assert from "node:assert/strict";
import { searchDocTrees, buildToc } from "../../src/search/doc-tree-search.js";
import { createDocTreeStore } from "../../src/storage/doc-tree-store.js";
import type { DocTree } from "../../src/indexing/doc-tree-builder.js";

/**
 * Unit tests for doc-tree search (plan.md, "port-doc-tree-markdown"),
 * ported from mcp-server/src/doc_tree.ts's `searchDocTrees`/`buildToc`/
 * `selectNodesByKeyword` -- simple, local keyword-based node scoring (no
 * external LLM/ColBERT reasoning from the TS side, matching the
 * original's own "Simple keyword-based node selection" comment).
 * Simplified vs. the original: a `limit` (max files) replaces its
 * `tokenBudget` accounting, since that budget existed for an
 * orchestrator (`assembleContext`) this repo's plan.md already decided
 * not to port.
 */

function tree(overrides: Partial<DocTree> = {}): DocTree {
  return {
    description: "how retries and webhooks work",
    nodeCount: 2,
    nodes: [
      {
        nodeId: "0001",
        title: "Retry logic",
        startLine: 1,
        endLine: 3,
        summary: "explains the retry backoff strategy",
        bodyText: "# Retry logic\ndetails about retrying http requests",
        children: [],
      },
      {
        nodeId: "0002",
        title: "Webhooks",
        startLine: 4,
        endLine: 6,
        summary: "explains webhook signature verification",
        bodyText: "# Webhooks\nverify the signature header",
        children: [],
      },
    ],
    ...overrides,
  };
}

test("buildToc formats the document description and a flattened, indented node list", () => {
  const toc = buildToc("docs/a.md", tree());
  assert.match(toc, /^# docs\/a\.md/);
  assert.match(toc, /how retries and webhooks work/);
  assert.match(toc, /\[0001\] Retry logic \(lines 1–3\): "explains the retry backoff strategy"/);
  assert.match(toc, /\[0002\] Webhooks \(lines 4–6\)/);
});

test("searchDocTrees (toc_only) returns every stored file's TOC without needing a query match", () => {
  const store = createDocTreeStore({ path: ":memory:" });
  store.upsertTree("docs/a.md", tree());
  const results = searchDocTrees(store, "anything", "toc_only", 10);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.relativePath, "docs/a.md");
  assert.equal(results[0]!.relevantNodes.length, 0);
  assert.match(results[0]!.toc, /Retry logic/);
  store.close();
});

test("searchDocTrees (summary_only) ranks nodes by keyword hits in title+summary, without bodyText", () => {
  const store = createDocTreeStore({ path: ":memory:" });
  store.upsertTree("docs/a.md", tree());
  const results = searchDocTrees(store, "webhook signature", "summary_only", 10);
  assert.equal(results[0]!.relevantNodes[0]!.title, "Webhooks");
  assert.equal(results[0]!.relevantNodes[0]!.text, undefined);
  store.close();
});

test("searchDocTrees (node_text) includes each matched node's verbatim bodyText", () => {
  const store = createDocTreeStore({ path: ":memory:" });
  store.upsertTree("docs/a.md", tree());
  const results = searchDocTrees(store, "retry http", "node_text", 10);
  assert.equal(results[0]!.relevantNodes[0]!.title, "Retry logic");
  assert.match(results[0]!.relevantNodes[0]!.text!, /retrying http requests/);
  store.close();
});

test("searchDocTrees (node_text) omits a file entirely when none of its nodes match the query", () => {
  const store = createDocTreeStore({ path: ":memory:" });
  store.upsertTree("docs/a.md", tree());
  const results = searchDocTrees(store, "completely unrelated gibberish", "node_text", 10);
  assert.equal(results.length, 0);
});

test("searchDocTrees respects the limit argument (max number of files returned)", () => {
  const store = createDocTreeStore({ path: ":memory:" });
  store.upsertTree("docs/a.md", tree());
  store.upsertTree("docs/b.md", tree());
  store.upsertTree("docs/c.md", tree());
  const results = searchDocTrees(store, "anything", "toc_only", 2);
  assert.equal(results.length, 2);
  store.close();
});

test("toc_only lists docs below dir_path, path matches first, and pages with offset", () => {
  const store = createDocTreeStore({ path: ":memory:" });
  for (const p of ["docs/a/1.md", "docs/a/2.md", "docs/b/glossary.md", "docs/b/other.md", "readme.md"]) store.upsertTree(p, tree());
  const all = searchDocTrees(store, "x", "toc_only", 50).map((r) => r.relativePath);
  assert.equal(all.length, 5);
  assert.deepEqual(searchDocTrees(store, "x", "toc_only", 50, { dirPath: "docs/b" }).map((r) => r.relativePath), ["docs/b/glossary.md", "docs/b/other.md"]);
  assert.deepEqual(searchDocTrees(store, "x", "toc_only", 2, { offset: 1 }).map((r) => r.relativePath), all.slice(1, 3));
  assert.equal(searchDocTrees(store, "glossary", "toc_only", 1)[0]!.relativePath, "docs/b/glossary.md");
});

test("summary_only ranks all docs before applying the limit and drops non-matching docs", () => {
  const store = createDocTreeStore({ path: ":memory:" });
  for (let i = 0; i < 6; i++) store.upsertTree(`docs/n${i}.md`, tree({ nodes: [{ nodeId: "1", title: "Unrelated", startLine: 1, endLine: 2, summary: null, bodyText: "", children: [] }], nodeCount: 1 }));
  store.upsertTree("docs/z-last.md", tree());
  const res = searchDocTrees(store, "retry backoff", "summary_only", 2);
  assert.deepEqual(res.map((r) => r.relativePath), ["docs/z-last.md"]);
});
