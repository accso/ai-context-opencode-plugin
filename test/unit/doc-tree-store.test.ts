import { test } from "node:test";
import assert from "node:assert/strict";
import { createDocTreeStore } from "../../src/storage/doc-tree-store.js";
import type { DocTree } from "../../src/indexing/doc-tree-builder.js";

/**
 * Unit tests for the doc-tree store (plan.md, "port-doc-tree-markdown"),
 * a sibling to vector-store.ts: one row per Markdown file (not one row
 * per chunk), storing the whole nested tree as JSON so retrieval never
 * needs to re-read the file from disk (mirrors mcp-server/src/doc_tree.ts's
 * `doc_trees` Postgres table).
 */

function tree(overrides: Partial<DocTree> = {}): DocTree {
  return {
    description: "a doc about things",
    nodeCount: 1,
    nodes: [
      {
        nodeId: "0001",
        title: "Intro",
        startLine: 1,
        endLine: 3,
        summary: "an intro section",
        bodyText: "# Intro\nsome text",
        children: [],
      },
    ],
    ...overrides,
  };
}

test("createDocTreeStore.upsertTree + getTree round-trips a tree for a file", () => {
  const store = createDocTreeStore({ path: ":memory:" });
  store.upsertTree("docs/a.md", tree());
  const got = store.getTree("docs/a.md");
  assert.ok(got);
  assert.equal(got!.description, "a doc about things");
  assert.equal(got!.nodeCount, 1);
  assert.equal(got!.nodes[0]!.title, "Intro");
  store.close();
});

test("createDocTreeStore.getTree returns null for a file with no stored tree", () => {
  const store = createDocTreeStore({ path: ":memory:" });
  assert.equal(store.getTree("docs/missing.md"), null);
  store.close();
});

test("createDocTreeStore.upsertTree replaces an existing tree for the same file path", () => {
  const store = createDocTreeStore({ path: ":memory:" });
  store.upsertTree("docs/a.md", tree());
  store.upsertTree("docs/a.md", tree({ nodeCount: 2 }));
  assert.equal(store.getTree("docs/a.md")!.nodeCount, 2);
  assert.equal(store.getAllTrees().length, 1);
  store.close();
});

test("createDocTreeStore.deleteTree removes a file's stored tree", () => {
  const store = createDocTreeStore({ path: ":memory:" });
  store.upsertTree("docs/a.md", tree());
  store.deleteTree("docs/a.md");
  assert.equal(store.getTree("docs/a.md"), null);
  store.close();
});

test("createDocTreeStore.countTrees counts stored trees without loading them", () => {
  const store = createDocTreeStore({ path: ":memory:" });
  assert.equal(store.countTrees(), 0);
  store.upsertTree("a.md", { description: "", nodeCount: 0, nodes: [] } as never);
  assert.equal(store.countTrees(), 1);
  store.close();
});

test("createDocTreeStore.getAllTrees returns every stored file's tree, with its relativePath", () => {
  const store = createDocTreeStore({ path: ":memory:" });
  store.upsertTree("docs/a.md", tree());
  store.upsertTree("docs/b.md", tree({ description: "another doc" }));
  const all = store.getAllTrees();
  assert.equal(all.length, 2);
  const paths = all.map((t) => t.relativePath).sort();
  assert.deepEqual(paths, ["docs/a.md", "docs/b.md"]);
  store.close();
});

test("listPaths returns the stored paths without loading the trees", () => {
  const store = createDocTreeStore({ path: ":memory:" });
  store.upsertTree("b.md", tree());
  store.upsertTree("a.md", tree());
  assert.deepEqual(store.listPaths(), ["a.md", "b.md"]);
  store.close();
});
