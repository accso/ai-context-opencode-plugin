import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdownHeadings, shouldUseTreeIndex, buildDocTree } from "../../src/indexing/doc-tree-builder.js";

/**
 * Unit tests for the PageIndex-style Markdown doc-tree builder
 * (plan.md, "port-doc-tree-markdown"), ported from
 * `.ai-context/watcher/doc_tree_builder.py` (heading parse + tree
 * build) and `chunker.py`'s `should_use_tree_index` (the tree-vs-chunk
 * gate). Deliberately NOT the actual PageIndex package/API -- a
 * one-time LLM summary per heading section at index time, via an
 * injectable summarizer, not per-query agentic LLM reasoning.
 */

test("parseMarkdownHeadings returns an empty list for text with no headings", () => {
  assert.deepEqual(parseMarkdownHeadings("just some text\nno headings here"), []);
});

test("parseMarkdownHeadings extracts level, title, and 1-based line boundaries", () => {
  const text = ["# Title", "intro line", "## Section A", "body a", "## Section B", "body b1", "body b2"].join("\n");
  const headings = parseMarkdownHeadings(text);
  assert.equal(headings.length, 3);
  assert.deepEqual(headings[0], { level: 1, title: "Title", startLine: 1, endLine: 2 });
  assert.deepEqual(headings[1], { level: 2, title: "Section A", startLine: 3, endLine: 4 });
  assert.deepEqual(headings[2], { level: 2, title: "Section B", startLine: 5, endLine: 7 });
});

test("parseMarkdownHeadings strips leading # markers and trims the title", () => {
  const headings = parseMarkdownHeadings("###   Spacey Title   \nbody");
  assert.equal(headings[0]!.level, 3);
  assert.equal(headings[0]!.title, "Spacey Title");
});

test("buildDocTree nests deeper headings as children of the preceding shallower heading", async () => {
  const text = ["# Root", "# Root Two", "## Child A", "### Grandchild", "## Child B"].join("\n");
  const tree = await buildDocTree(text);
  assert.equal(tree.nodes.length, 2);
  assert.equal(tree.nodes[0]!.title, "Root");
  assert.equal(tree.nodes[0]!.children.length, 0);
  const rootTwo = tree.nodes[1]!;
  assert.equal(rootTwo.title, "Root Two");
  assert.equal(rootTwo.children.length, 2);
  assert.equal(rootTwo.children[0]!.title, "Child A");
  assert.equal(rootTwo.children[0]!.children[0]!.title, "Grandchild");
  assert.equal(rootTwo.children[1]!.title, "Child B");
});

test("buildDocTree assigns zero-padded sequential node ids in document order", async () => {
  const text = ["# A", "## B", "# C"].join("\n");
  const tree = await buildDocTree(text);
  assert.equal(tree.nodes[0]!.nodeId, "0001");
  assert.equal(tree.nodes[0]!.children[0]!.nodeId, "0002");
  assert.equal(tree.nodes[1]!.nodeId, "0003");
});

test("buildDocTree keeps verbatim bodyText per node and reports the total node count", async () => {
  const text = ["# A", "line a1", "line a2", "## B", "line b1"].join("\n");
  const tree = await buildDocTree(text);
  assert.equal(tree.nodeCount, 2);
  assert.equal(tree.nodes[0]!.bodyText, "# A\nline a1\nline a2");
  assert.equal(tree.nodes[0]!.children[0]!.bodyText, "## B\nline b1");
});

test("buildDocTree returns an empty tree (no nodes, null description) for text with no headings", async () => {
  const tree = await buildDocTree("no headings in this file at all");
  assert.deepEqual(tree, { description: null, nodeCount: 0, nodes: [] });
});

test("buildDocTree leaves summary/description null when no summarizer is injected", async () => {
  const tree = await buildDocTree("# A\nbody");
  assert.equal(tree.description, null);
  assert.equal(tree.nodes[0]!.summary, null);
});

test("buildDocTree calls the injected summarizer per node and for the whole-document description", async () => {
  const calls: Array<{ text: string; kind: string }> = [];
  const summarize = async (text: string, kind: "node" | "document") => {
    calls.push({ text, kind });
    return `summary-of-${kind}`;
  };
  const tree = await buildDocTree("# A\nbody a\n## B\nbody b", { summarize });
  assert.equal(tree.description, "summary-of-document");
  assert.equal(tree.nodes[0]!.summary, "summary-of-node");
  assert.equal(tree.nodes[0]!.children[0]!.summary, "summary-of-node");
  // one document-level call + one per node (2 nodes)
  assert.equal(calls.filter((c) => c.kind === "document").length, 1);
  assert.equal(calls.filter((c) => c.kind === "node").length, 2);
});

test("buildDocTree falls back to a null summary for a node when the injected summarizer throws", async () => {
  const summarize = async (_text: string, kind: "node" | "document") => {
    if (kind === "node") throw new Error("boom");
    return "doc description";
  };
  const tree = await buildDocTree("# A\nbody", { summarize });
  assert.equal(tree.nodes[0]!.summary, null);
  assert.equal(tree.description, "doc description");
});

/**
 * Tree-vs-chunk gate (chunker.py's should_use_tree_index): decides
 * whether a file should be indexed as a doc tree instead of normal
 * Qdrant/vector-store chunking. Config-driven (tree_extensions,
 * min_headings_for_tree, always_tree_paths in the original config.yaml).
 */

test("shouldUseTreeIndex returns false when doc-index is disabled", () => {
  const text = Array.from({ length: 10 }, (_, i) => `# H${i}`).join("\n");
  assert.equal(shouldUseTreeIndex("docs/big.md", text, { enabled: false }), false);
});

test("shouldUseTreeIndex returns true for a path under always_tree_paths regardless of heading count", () => {
  const config = { enabled: true, alwaysTreePaths: ["docs/"], minHeadingsForTree: 8 };
  assert.equal(shouldUseTreeIndex("docs/short.md", "# One heading only", config), true);
});

test("shouldUseTreeIndex returns true once the heading count reaches the configured minimum", () => {
  const config = { enabled: true, minHeadingsForTree: 3 };
  const below = Array.from({ length: 2 }, (_, i) => `# H${i}`).join("\n");
  const atThreshold = Array.from({ length: 3 }, (_, i) => `# H${i}`).join("\n");
  assert.equal(shouldUseTreeIndex("notes.md", below, config), false);
  assert.equal(shouldUseTreeIndex("notes.md", atThreshold, config), true);
});

test("buildDocTree wraps heading-less text in one root node when a fallback title is given", async () => {
  const tree = await buildDocTree("plain notes\nsecond line", { fallbackTitle: "notes.md" });
  assert.equal(tree.nodeCount, 1);
  assert.equal(tree.nodes[0]!.title, "notes.md");
  assert.equal(tree.nodes[0]!.bodyText, "plain notes\nsecond line");
  assert.equal(tree.nodes[0]!.startLine, 1);
  assert.equal(tree.nodes[0]!.endLine, 2);
});

test("buildDocTree stays empty for blank text even with a fallback title", async () => {
  const tree = await buildDocTree("  \n", { fallbackTitle: "empty.md" });
  assert.equal(tree.nodeCount, 0);
});

test("shouldUseTreeIndex tree-indexes every document by default, regardless of heading count", () => {
  assert.equal(shouldUseTreeIndex("docs/short.md", "# One", { enabled: true }), true);
  assert.equal(shouldUseTreeIndex("docs/none.md", "no headings", { enabled: true }), true);
});
