import { test } from "node:test";
import assert from "node:assert/strict";
import { createIndexer } from "../../src/indexing/indexing.js";
import { createVectorStore } from "../../src/storage/vector-store.js";
import type { FileChangeBatchEntry } from "../../src/indexing/index-scheduler.js";

/**
 * Unit tests for the document-side indexing pipeline: file content ->
 * chunker.ts -> embedDocument -> VectorStore.upsertChunks/
 * deleteChunksForFile. Ties together the pieces built earlier in this
 * increment (chunker.ts, model-runtime.ts's embedDocument, vector-store.ts)
 * behind the `IndexScheduler`'s `indexFiles(batch)` contract so it can
 * replace `plugin.ts`'s no-op `defaultIndexFiles`.
 */

function fakeEmbedDocument(text: string): Promise<number[]> {
  // Deterministic fake vector derived from text length, just needs to be
  // stored/retrieved faithfully -- no real model in unit tests.
  return Promise.resolve([text.length, text.length * 2]);
}

test("indexFiles chunks, embeds, and upserts a new file's content", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const readFile = async (relativePath: string) =>
    relativePath === "src/a.ts" ? "hello world\n\nsecond paragraph" : null;
  const indexer = createIndexer({ vectorStore: store, embedDocument: fakeEmbedDocument, readFile });

  const batch: FileChangeBatchEntry[] = [{ file: "src/a.ts", event: "add" }];
  await indexer.indexFiles(batch);

  const chunks = store.getAllChunks();
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]!.relativePath, "src/a.ts");
  assert.equal(chunks[0]!.text, "hello world");
  assert.equal(chunks[1]!.text, "second paragraph");
  // embedded text is "File: src/a.ts\n\nhello world" (27 chars), see embed-input.ts
  assert.deepEqual(chunks[0]!.vector, [27, 54]);
});

test("indexFiles replaces a changed file's chunks rather than accumulating them", async () => {
  const store = createVectorStore({ path: ":memory:" });
  let content = "one\n\ntwo\n\nthree";
  const readFile = async () => content;
  const indexer = createIndexer({ vectorStore: store, embedDocument: fakeEmbedDocument, readFile });

  await indexer.indexFiles([{ file: "a.ts", event: "add" }]);
  assert.equal(store.getAllChunks().length, 3);

  content = "only one paragraph now";
  await indexer.indexFiles([{ file: "a.ts", event: "change" }]);

  const chunks = store.getAllChunks();
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.text, "only one paragraph now");
});

test("indexFiles uses tree-sitter symbol-aware boundaries for a real TypeScript file (port-tree-sitter-chunker)", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const content = ["export class Foo {", "  method() {}", "}", "", "export function bar() {}", ""].join("\n");
  const readFile = async () => content;
  const indexer = createIndexer({ vectorStore: store, embedDocument: fakeEmbedDocument, readFile });

  await indexer.indexFiles([{ file: "src/a.ts", event: "add" }]);

  const chunks = store.getAllChunks();
  assert.deepEqual(
    chunks.map((c) => c.symbol),
    ["Foo", "bar"],
  );
  assert.deepEqual(
    chunks.map((c) => c.chunkType),
    ["class", "function"],
  );
});

test("indexFiles reattaches an Angular decorator to its class chunk (port-tree-sitter-chunker-followups)", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const content = ["@Component({})", "export class Foo {}", ""].join("\n");
  const readFile = async () => content;
  const indexer = createIndexer({ vectorStore: store, embedDocument: fakeEmbedDocument, readFile });

  await indexer.indexFiles([{ file: "src/foo.component.ts", event: "add" }]);

  const chunks = store.getAllChunks();
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.symbol, "Foo");
  assert.ok(chunks[0]!.text.startsWith("@Component({})"));
});

test("indexFiles splits a >=3-arm switch into case sub-chunks (port-tree-sitter-chunker-followups)", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const content = [
    "export function handle(x) {",
    "  switch (x) {",
    '    case "a":',
    "      return 1;",
    '    case "b":',
    "      return 2;",
    '    case "c":',
    "      return 3;",
    "  }",
    "}",
    "",
  ].join("\n");
  const readFile = async () => content;
  const indexer = createIndexer({ vectorStore: store, embedDocument: fakeEmbedDocument, readFile });

  await indexer.indexFiles([{ file: "src/handle.ts", event: "add" }]);

  const chunks = store.getAllChunks();
  assert.deepEqual(
    chunks.map((c) => c.chunkType),
    ["function", "case", "case", "case"],
  );
  assert.deepEqual(
    chunks.slice(1).map((c) => c.symbol),
    ["a", "b", "c"],
  );
});

test("indexFiles uses regex-based symbol-aware boundaries for a Python file (port-tree-sitter-chunker-followups, item 3a)", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const content = ["class Foo:", "    def method(self):", "        pass", "", "", "def bar():", "    pass", ""].join(
    "\n",
  );
  const readFile = async () => content;
  const indexer = createIndexer({ vectorStore: store, embedDocument: fakeEmbedDocument, readFile });

  await indexer.indexFiles([{ file: "src/a.py", event: "add" }]);

  const chunks = store.getAllChunks();
  assert.deepEqual(
    chunks.map((c) => c.symbol),
    ["Foo", "bar"],
  );
  assert.deepEqual(
    chunks.map((c) => c.chunkType),
    ["class", "function"],
  );
});

test("indexFiles splits a Python >=3-arm match into case sub-chunks (port-tree-sitter-chunker-followups, item 3a)", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const content = [
    "def handle(x):",
    "    match x:",
    '        case "a":',
    "            return 1",
    '        case "b":',
    "            return 2",
    '        case "c":',
    "            return 3",
    "",
  ].join("\n");
  const readFile = async () => content;
  const indexer = createIndexer({ vectorStore: store, embedDocument: fakeEmbedDocument, readFile });

  await indexer.indexFiles([{ file: "src/handle.py", event: "add" }]);

  const chunks = store.getAllChunks();
  assert.deepEqual(
    chunks.map((c) => c.chunkType),
    ["function", "case", "case", "case"],
  );
  assert.deepEqual(
    chunks.slice(1).map((c) => c.symbol),
    ["a", "b", "c"],
  );
});

test("indexFiles uses the bespoke Vue SFC splitter for a .vue file (port-tree-sitter-chunker-followups, item 4)", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const content = ["<template>", "  <div />", "</template>", "", "<script>", "export default {}", "</script>", ""].join(
    "\n",
  );
  const readFile = async () => content;
  const indexer = createIndexer({ vectorStore: store, embedDocument: fakeEmbedDocument, readFile });

  await indexer.indexFiles([{ file: "src/Widget.vue", event: "add" }]);

  const chunks = store.getAllChunks();
  assert.deepEqual(
    chunks.map((c) => c.chunkType),
    ["component", "function"],
  );
  assert.deepEqual(
    chunks.map((c) => c.symbol),
    ["<template>", "<script>"],
  );
});

test("indexFiles uses the bespoke SQL statement splitter for a .sql file (port-tree-sitter-chunker-followups, item 4)", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const content = "CREATE TABLE users (id INTEGER);\nINSERT INTO users (id) VALUES (1);\n";
  const readFile = async () => content;
  const indexer = createIndexer({ vectorStore: store, embedDocument: fakeEmbedDocument, readFile });

  await indexer.indexFiles([{ file: "db/migration.sql", event: "add" }]);

  const chunks = store.getAllChunks();
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.symbol, "CREATE TABLE users");
  assert.equal(chunks[0]!.chunkType, "statement");
});

test("indexFiles uses the bespoke YAML top-level-key splitter for a .yaml file (port-tree-sitter-chunker-followups, item 4)", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const content = "name: demo\nversion: 1.0.0\n";
  const readFile = async () => content;
  const indexer = createIndexer({ vectorStore: store, embedDocument: fakeEmbedDocument, readFile });

  await indexer.indexFiles([{ file: "config.yaml", event: "add" }]);

  const chunks = store.getAllChunks();
  assert.deepEqual(
    chunks.map((c) => c.symbol),
    ["name", "version"],
  );
});

test("indexFiles removes all chunks for an unlinked file", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const readFile = async () => "some content";
  const indexer = createIndexer({ vectorStore: store, embedDocument: fakeEmbedDocument, readFile });

  await indexer.indexFiles([{ file: "a.ts", event: "add" }]);
  assert.equal(store.getAllChunks().length, 1);

  await indexer.indexFiles([{ file: "a.ts", event: "unlink" }]);
  assert.equal(store.getAllChunks().length, 0);
});

test("indexFiles skips a file that no longer exists (race between event and read)", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const readFile = async () => null;
  const indexer = createIndexer({ vectorStore: store, embedDocument: fakeEmbedDocument, readFile });

  await indexer.indexFiles([{ file: "gone.ts", event: "add" }]);
  assert.equal(store.getAllChunks().length, 0);
});

/**
 * File filtering (critical-review finding "repo-walker-ignore-
 * filtering", plan.md): repo-walker.ts's startup walk applies
 * file-filter.ts's extension safelist + .gitignore matching, but
 * file.watcher.updated-driven changes go through the indexer directly,
 * bypassing that walk entirely -- so the SAME filter must also be
 * enforced here, or a binary/gitignored file edited during a live
 * session would still get chunked and embedded.
 */

test("indexFiles never reads, chunks, or embeds a file shouldIndexFile rejects", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const readFile = async () => {
    throw new Error("readFile should not be called for a rejected file");
  };
  const embedDocument = async () => {
    throw new Error("embedDocument should not be called for a rejected file");
  };
  const indexer = createIndexer({
    vectorStore: store,
    embedDocument,
    readFile,
    shouldIndexFile: () => false,
  });

  await indexer.indexFiles([{ file: "logo.png", event: "add" }]);
  assert.equal(store.getAllChunks().length, 0);
});

test("indexFiles deletes a previously-indexed file's chunks once shouldIndexFile starts rejecting it", async () => {
  const store = createVectorStore({ path: ":memory:" });
  let reject = false;
  const readFile = async () => "some content";
  const indexer = createIndexer({
    vectorStore: store,
    embedDocument: fakeEmbedDocument,
    readFile,
    shouldIndexFile: () => !reject,
  });

  await indexer.indexFiles([{ file: "a.ts", event: "add" }]);
  assert.equal(store.getAllChunks().length, 1);

  reject = true; // e.g. the file was just added to .gitignore
  await indexer.indexFiles([{ file: "a.ts", event: "change" }]);
  assert.equal(store.getAllChunks().length, 0);
});

test("indexFiles indexes normally when shouldIndexFile is omitted (backward-compatible default)", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const readFile = async () => "content";
  const indexer = createIndexer({ vectorStore: store, embedDocument: fakeEmbedDocument, readFile });

  await indexer.indexFiles([{ file: "a.ts", event: "add" }]);
  assert.equal(store.getAllChunks().length, 1);
});

test("indexFiles derives a language guess from the file extension", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const readFile = async () => "print('hi')";
  const indexer = createIndexer({ vectorStore: store, embedDocument: fakeEmbedDocument, readFile });

  await indexer.indexFiles([{ file: "script.py", event: "add" }]);
  assert.equal(store.getAllChunks()[0]!.language, "python");
});

test("indexFiles assigns stable chunk ids derived from path and line range", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const readFile = async () => "alpha\n\nbeta";
  const indexer = createIndexer({ vectorStore: store, embedDocument: fakeEmbedDocument, readFile });

  await indexer.indexFiles([{ file: "src/a.ts", event: "add" }]);
  const ids = store.getChunkIdsForFile("src/a.ts");
  assert.equal(ids.size, 2);
  for (const id of ids) {
    assert.match(id, /^src\/a\.ts:\d+-\d+$/);
  }
});

/**
 * Doc-tree wiring (plan.md, "port-doc-tree-markdown"): a Markdown file
 * that qualifies for tree-indexing (per shouldUseTreeIndex) is stored as
 * a doc tree instead of being chunked into the vector store -- the two
 * are mutually exclusive per file, mirroring chunker.py's
 * `chunk_file`/`should_use_tree_index` gate.
 */

test("indexFiles stores a qualifying Markdown file as a doc tree instead of chunking it", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const { createDocTreeStore } = await import("../../src/storage/doc-tree-store.js");
  const docTreeStore = createDocTreeStore({ path: ":memory:" });
  const content = "# Doc\nintro\n" + Array.from({ length: 8 }, (_, i) => `# H${i}\nbody`).join("\n");
  const readFile = async () => content;
  const indexer = createIndexer({
    vectorStore: store,
    embedDocument: fakeEmbedDocument,
    readFile,
    docTreeStore,
    docTreeConfig: { enabled: true, extensions: [".md"], minHeadingsForTree: 3 },
  });

  await indexer.indexFiles([{ file: "docs/big.md", event: "add" }]);

  assert.equal(store.getAllChunks().length, 0, "tree-indexed files must not also be chunked");
  const tree = docTreeStore.getTree("docs/big.md");
  assert.ok(tree);
  assert.ok(tree!.nodeCount >= 8);
  docTreeStore.close();
});

test("indexFiles tree-indexes every Markdown file by default, never chunking it", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const { createDocTreeStore } = await import("../../src/storage/doc-tree-store.js");
  const docTreeStore = createDocTreeStore({ path: ":memory:" });
  const contents: Record<string, string> = {
    "docs/small.md": "# Short doc\njust one heading",
    "docs/plain.md": "no headings here\nat all",
  };
  const indexer = createIndexer({
    vectorStore: store,
    embedDocument: fakeEmbedDocument,
    readFile: async (p) => contents[p] ?? null,
    docTreeStore,
  });

  await indexer.indexFiles([
    { file: "docs/small.md", event: "add" },
    { file: "docs/plain.md", event: "add" },
  ]);

  assert.equal(store.getAllChunks().length, 0, "documents must never become code chunks");
  assert.equal(docTreeStore.getTree("docs/small.md")!.nodeCount, 1);
  assert.equal(docTreeStore.getTree("docs/plain.md")!.nodes[0]!.title, "docs/plain.md");
  docTreeStore.close();
});

test("indexFiles passes the injected summarizer through to the doc tree", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const { createDocTreeStore } = await import("../../src/storage/doc-tree-store.js");
  const docTreeStore = createDocTreeStore({ path: ":memory:" });
  const indexer = createIndexer({
    vectorStore: store,
    embedDocument: fakeEmbedDocument,
    readFile: async () => "# A\nbody",
    docTreeStore,
    summarize: async (_text, kind) => `${kind} summary`,
  });

  await indexer.indexFiles([{ file: "docs/a.md", event: "add" }]);

  const tree = docTreeStore.getTree("docs/a.md")!;
  assert.equal(tree.description, "document summary");
  assert.equal(tree.nodes[0]!.summary, "node summary");
  docTreeStore.close();
});

test("indexFiles removes a stored doc tree when its file is unlinked", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const { createDocTreeStore } = await import("../../src/storage/doc-tree-store.js");
  const docTreeStore = createDocTreeStore({ path: ":memory:" });
  const content = Array.from({ length: 8 }, (_, i) => `# H${i}\nbody`).join("\n");
  const readFile = async () => content;
  const indexer = createIndexer({
    vectorStore: store,
    embedDocument: fakeEmbedDocument,
    readFile,
    docTreeStore,
    docTreeConfig: { enabled: true, extensions: [".md"], minHeadingsForTree: 3 },
  });

  await indexer.indexFiles([{ file: "docs/big.md", event: "add" }]);
  assert.ok(docTreeStore.getTree("docs/big.md"));

  await indexer.indexFiles([{ file: "docs/big.md", event: "unlink" }]);
  assert.equal(docTreeStore.getTree("docs/big.md"), null);
  docTreeStore.close();
});

test("indexFiles never tree-indexes when no docTreeStore is injected (default behavior unchanged)", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const content = Array.from({ length: 12 }, (_, i) => `# H${i}\nbody`).join("\n");
  const readFile = async () => content;
  const indexer = createIndexer({ vectorStore: store, embedDocument: fakeEmbedDocument, readFile });

  await indexer.indexFiles([{ file: "docs/big.md", event: "add" }]);
  assert.ok(store.getAllChunks().length > 0);
});

/**
 * Graph wiring: symbol/import/call extraction rides along with chunk
 * indexing via an optional `graphIndexer` dependency.
 */
function recordingGraphIndexer(options: { failUpdate?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    update: async (file: string, content: string | null) => {
      calls.push(`update:${file}:${content === null ? "null" : "content"}`);
      if (options.failUpdate) throw new Error("graph boom");
    },
    finishBatch: () => {
      calls.push("finish");
    },
  };
}

test("indexFiles feeds file content to the graph indexer and finishes the batch once", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const graph = recordingGraphIndexer();
  const indexer = createIndexer({
    vectorStore: store,
    embedDocument: fakeEmbedDocument,
    readFile: async () => "export const a = 1;\n",
    graphIndexer: graph,
  });
  await indexer.indexFiles([
    { file: "a.ts", event: "add" },
    { file: "b.ts", event: "change" },
  ]);
  assert.deepEqual(graph.calls, ["update:a.ts:content", "update:b.ts:content", "finish"]);
});

test("indexFiles tells the graph indexer about unlinked, unreadable and filtered-out files (null content)", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const graph = recordingGraphIndexer();
  const indexer = createIndexer({
    vectorStore: store,
    embedDocument: fakeEmbedDocument,
    readFile: async (p) => (p === "gone.ts" ? null : "x\n"),
    shouldIndexFile: (p) => p !== "ignored.ts",
    graphIndexer: graph,
  });
  await indexer.indexFiles([
    { file: "old.ts", event: "unlink" },
    { file: "gone.ts", event: "change" },
    { file: "ignored.ts", event: "change" },
  ]);
  assert.deepEqual(graph.calls, ["update:old.ts:null", "update:gone.ts:null", "update:ignored.ts:null", "finish"]);
});

test("a failing graph indexer never blocks chunk indexing", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const graph = recordingGraphIndexer({ failUpdate: true });
  const indexer = createIndexer({
    vectorStore: store,
    embedDocument: fakeEmbedDocument,
    readFile: async () => "hello\n",
    graphIndexer: graph,
  });
  await indexer.indexFiles([{ file: "a.ts", event: "add" }]);
  assert.equal(store.getAllChunks().length, 1);
});

test("indexFiles builds a real cross-file graph end to end", async () => {
  const { createGraphStore } = await import("../../src/storage/graph-store.js");
  const { createGraphIndexer } = await import("../../src/indexing/graph/graph-indexer.js");
  const store = createVectorStore({ path: ":memory:" });
  const graphStore = createGraphStore({ path: ":memory:" });
  const files: Record<string, string> = {
    "src/a.ts": 'import { b } from "./b";\nexport function a() { b(); }\n',
    "src/b.ts": "export function b() {}\n",
  };
  const indexer = createIndexer({
    vectorStore: store,
    embedDocument: fakeEmbedDocument,
    readFile: async (p) => files[p] ?? null,
    graphIndexer: createGraphIndexer({ store: graphStore }),
  });
  await indexer.indexFiles([
    { file: "src/a.ts", event: "add" },
    { file: "src/b.ts", event: "add" },
  ]);
  const callers = graphStore.traverseCalls({ symbol: "b", direction: "callers", depth: 1 }).edges;
  assert.deepEqual(callers.map((e) => [e.callerSymbol, e.calleePath]), [["a", "src/b.ts"]]);

  await indexer.indexFiles([{ file: "src/b.ts", event: "unlink" }]);
  assert.equal(graphStore.getFileGraph("src/b.ts"), null);
});

/** Records every progress callback in order, so tests can assert the exact sequence. */
function recordingProgress() {
  const events: string[] = [];
  return {
    events,
    progress: {
      beginBatch: (n: number) => void events.push(`begin:${n}`),
      fileDone: (f: string) => void events.push(`done:${f}`),
      fileFailed: (f: string, e: unknown) => void events.push(`failed:${f}:${(e as Error).message}`),
      endBatch: () => void events.push("end"),
    },
  };
}

test("indexFiles reports batch start, one result per file, and batch end to the progress reporter", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const { events, progress } = recordingProgress();
  const indexer = createIndexer({ vectorStore: store, embedDocument: fakeEmbedDocument, readFile: async () => "x", progress });

  await indexer.indexFiles([
    { file: "a.ts", event: "add" },
    { file: "b.ts", event: "unlink" },
  ]);

  assert.deepEqual(events, ["begin:2", "done:a.ts", "done:b.ts", "end"]);
});

test("a file that fails to index is skipped and reported, and the rest of the batch still runs", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const { events, progress } = recordingProgress();
  const readFile = async (p: string) => {
    if (p === "bad.ts") throw new Error("unreadable");
    return "content";
  };
  const indexer = createIndexer({ vectorStore: store, embedDocument: fakeEmbedDocument, readFile, progress });

  await indexer.indexFiles([
    { file: "bad.ts", event: "add" },
    { file: "good.ts", event: "add" },
  ]);

  assert.deepEqual(events, ["begin:2", "failed:bad.ts:unreadable", "done:good.ts", "end"]);
  assert.deepEqual([...new Set(store.getAllChunks().map((c) => c.relativePath))], ["good.ts"]);
});

test("a failing embedder is also isolated per file", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const { events, progress } = recordingProgress();
  const embedDocument = async (text: string) => {
    if (text.includes("poison")) throw new Error("embed failed");
    return [1, 2];
  };
  const readFile = async (p: string) => (p === "bad.ts" ? "poison" : "fine");
  const indexer = createIndexer({ vectorStore: store, embedDocument, readFile, progress });

  await indexer.indexFiles([
    { file: "bad.ts", event: "add" },
    { file: "good.ts", event: "add" },
  ]);

  assert.deepEqual(events, ["begin:2", "failed:bad.ts:embed failed", "done:good.ts", "end"]);
});

test("without a progress reporter a failing file is still skipped instead of aborting the batch", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const readFile = async (p: string) => {
    if (p === "bad.ts") throw new Error("unreadable");
    return "content";
  };
  const indexer = createIndexer({ vectorStore: store, embedDocument: fakeEmbedDocument, readFile });
  await indexer.indexFiles([
    { file: "bad.ts", event: "add" },
    { file: "good.ts", event: "add" },
  ]);
  assert.equal(store.getAllChunks().length, 1);
});

test("a retry through a later batch clears the earlier failure (watcher re-index)", async () => {
  const { createProgressTracker } = await import("../../src/indexing/index-progress.js");
  const tracker = createProgressTracker({ now: () => 0 });
  let broken = true;
  const readFile = async () => {
    if (broken) throw new Error("locked");
    return "ok";
  };
  const indexer = createIndexer({ vectorStore: createVectorStore({ path: ":memory:" }), embedDocument: fakeEmbedDocument, readFile, progress: tracker });

  await indexer.indexFiles([{ file: "f.ts", event: "add" }]);
  assert.equal(tracker.snapshot().failures.length, 1);
  broken = false;
  await indexer.indexFiles([{ file: "f.ts", event: "change" }]);
  assert.equal(tracker.snapshot().failures.length, 0);
});

test("a chunk larger than the embedding budget is split into several embedded chunks with unique ids", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const embedded: number[] = [];
  const embedDocument = async (text: string) => {
    embedded.push(text.length);
    return [1, 2];
  };
  const bigLine = "z".repeat(900);
  const content = [bigLine, bigLine, bigLine].join("\n"); // one paragraph chunk of ~2700 chars
  const indexer = createIndexer({ vectorStore: store, embedDocument, readFile: async () => content, maxChunkChars: 1000 });
  await indexer.indexFiles([{ file: "big.ts", event: "add" }]);

  assert.ok(embedded.length >= 3);
  assert.ok(embedded.every((n) => n <= 1000), `largest embedded text: ${Math.max(...embedded)}`);
  const ids = store.getAllChunks().map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "chunk ids must stay unique");
});

test("a single minified line is split into parts that get distinct ids", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const indexer = createIndexer({
    vectorStore: store,
    embedDocument: async () => [1, 2],
    readFile: async () => "q".repeat(2500),
    maxChunkChars: 1000,
  });
  await indexer.indexFiles([{ file: "min.js", event: "add" }]);
  const ids = store.getAllChunks().map((c) => c.id);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3);
});

test("indexFiles stores a file-summary chunk for multi-chunk files when summarizeFile is set", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const seen: unknown[] = [];
  const indexer = createIndexer({
    vectorStore: store,
    embedDocument: fakeEmbedDocument,
    readFile: async () => "one\n\ntwo",
    summarizeFile: async (input) => {
      seen.push(input);
      return "Summary of a.ts";
    },
  });
  await indexer.indexFiles([{ file: "a.ts", event: "add" }]);
  const chunks = store.getAllChunks();
  assert.equal(chunks.length, 3);
  const summary = chunks.find((c) => c.chunkType === "file-summary")!;
  assert.equal(summary.text, "Summary of a.ts");
  assert.equal(summary.id, "a.ts:summary");
  assert.equal(summary.relativePath, "a.ts");
  assert.equal((seen[0] as { relativePath: string }).relativePath, "a.ts");
});

test("the summary request starts before the file's chunks are embedded (runs in parallel)", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const order: string[] = [];
  const indexer = createIndexer({
    vectorStore: store,
    embedDocument: async (t) => {
      order.push("embed");
      return fakeEmbedDocument(t);
    },
    readFile: async () => "one\n\ntwo",
    summarizeFile: async () => {
      order.push("summary");
      return "S";
    },
  });
  await indexer.indexFiles([{ file: "a.ts", event: "add" }]);
  assert.equal(order[0], "summary");
  assert.equal(store.getAllChunks().length, 3);
});

test("indexFiles skips the summary for single-chunk files and when summarizeFile is missing or fails", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const single = createIndexer({
    vectorStore: store,
    embedDocument: fakeEmbedDocument,
    readFile: async () => "just one",
    summarizeFile: async () => "never",
  });
  await single.indexFiles([{ file: "a.ts", event: "add" }]);
  assert.equal(store.getAllChunks().length, 1);

  const failing = createIndexer({
    vectorStore: store,
    embedDocument: fakeEmbedDocument,
    readFile: async () => "one\n\ntwo",
    summarizeFile: async () => {
      throw new Error("boom");
    },
  });
  await failing.indexFiles([{ file: "b.ts", event: "add" }]);
  assert.equal(store.getAllChunks().filter((c) => c.relativePath === "b.ts").length, 2);
});

test("indexFiles skips unchanged files by fingerprint and resumes after a failure", async () => {
  const store = createVectorStore({ path: ":memory:" });
  let reads = 0;
  const contents: Record<string, string | Error> = { "a.ts": "one", "b.ts": new Error("boom") as never };
  const indexer = createIndexer({
    vectorStore: store,
    embedDocument: fakeEmbedDocument,
    readFile: async (f) => {
      reads++;
      const c = contents[f]!;
      if (c instanceof Error) throw c;
      return c;
    },
    fingerprint: async () => "same",
  });
  const batch: FileChangeBatchEntry[] = [
    { file: "a.ts", event: "add" },
    { file: "b.ts", event: "add" },
  ];
  await indexer.indexFiles(batch);
  assert.equal(store.getFileFingerprint("a.ts"), "same#code2+nosum");
  assert.equal(store.getFileFingerprint("b.ts"), null);
  reads = 0;
  contents["b.ts"] = "now fine";
  await indexer.indexFiles(batch);
  assert.equal(reads, 1, "only the failed file is read again");
  assert.equal(store.getFileFingerprint("b.ts"), "same#code2+nosum");
});

test("indexFiles re-indexes a file whose fingerprint changed", async () => {
  const store = createVectorStore({ path: ":memory:" });
  let fp = "v1";
  let content = "old";
  const indexer = createIndexer({
    vectorStore: store,
    embedDocument: fakeEmbedDocument,
    readFile: async () => content,
    fingerprint: async () => fp,
  });
  await indexer.indexFiles([{ file: "a.ts", event: "add" }]);
  fp = "v2";
  content = "new";
  await indexer.indexFiles([{ file: "a.ts", event: "change" }]);
  assert.equal(store.getAllChunks()[0]!.text, "new");
  assert.equal(store.getFileFingerprint("a.ts"), "v2#code2+nosum");
});

test("fileConcurrency indexes several files at once, default stays sequential", async () => {
  for (const [fileConcurrency, expected] of [[undefined, 1], [3, 3]] as const) {
    const store = createVectorStore({ path: ":memory:" });
    let now = 0;
    let max = 0;
    const done: string[] = [];
    const indexer = createIndexer({
      vectorStore: store,
      embedDocument: async (t) => {
        now++;
        max = Math.max(max, now);
        await new Promise((r) => setTimeout(r, 10));
        now--;
        return fakeEmbedDocument(t);
      },
      readFile: async () => "content",
      fileConcurrency,
      progress: {
        beginBatch() {},
        fileDone: (f) => done.push(f),
        fileFailed() {},
        endBatch() {},
      },
    });
    const files = ["a", "b", "c", "d", "e", "f"].map((f) => ({ file: `${f}.ts`, event: "add" as const }));
    await indexer.indexFiles(files);
    assert.equal(max, expected);
    assert.equal(done.length, 6);
    assert.equal(new Set(store.getAllChunks().map((c) => c.relativePath)).size, 6);
  }
});

/**
 * Self-healing (ADR-0027): an unchanged fingerprint only skips a file when the
 * stored representation is still the expected one.
 */

async function docHealingSetup(overrides: Record<string, unknown> = {}) {
  const store = createVectorStore({ path: ":memory:" });
  const { createDocTreeStore } = await import("../../src/storage/doc-tree-store.js");
  const docTreeStore = createDocTreeStore({ path: ":memory:" });
  let reads = 0;
  const deps = {
    vectorStore: store,
    embedDocument: fakeEmbedDocument,
    readFile: async () => (reads++, "# A\nbody"),
    fingerprint: async () => "same",
    docTreeStore,
    ...overrides,
  };
  return { store, docTreeStore, deps, reads: () => reads, resetReads: () => (reads = 0) };
}

test("an unchanged tree-indexed document is not re-indexed on the next pass", async () => {
  const { deps, reads, resetReads, docTreeStore } = await docHealingSetup();
  const indexer = createIndexer(deps);
  await indexer.indexFiles([{ file: "d.md", event: "add" }]);
  resetReads();
  await indexer.indexFiles([{ file: "d.md", event: "add" }]);
  assert.equal(reads(), 0);
  docTreeStore.close();
});

test("a document chunked by an older version is re-indexed as a tree although its fingerprint is unchanged", async () => {
  const { deps, store, docTreeStore } = await docHealingSetup();
  store.upsertChunks([
    { id: "d.md:1-2", relativePath: "d.md", language: "markdown", text: "# A\nbody", startLine: 1, endLine: 2, chunkType: "paragraph", vector: [1, 2] },
  ]);
  store.setFileFingerprint("d.md", "same");
  await createIndexer(deps).indexFiles([{ file: "d.md", event: "add" }]);
  assert.equal(store.getAllChunks().length, 0);
  assert.ok(docTreeStore.getTree("d.md"));
  docTreeStore.close();
});

test("a document with both chunks and a tree is healed to a tree only", async () => {
  const { deps, store, docTreeStore } = await docHealingSetup();
  await createIndexer(deps).indexFiles([{ file: "d.md", event: "add" }]);
  store.upsertChunks([
    { id: "d.md:1-2", relativePath: "d.md", language: "markdown", text: "x", startLine: 1, endLine: 2, chunkType: "paragraph", vector: [1, 2] },
  ]);
  await createIndexer(deps).indexFiles([{ file: "d.md", event: "add" }]);
  assert.equal(store.getAllChunks().length, 0);
  docTreeStore.close();
});

test("a missing doc tree is rebuilt although the fingerprint is unchanged", async () => {
  const { deps, docTreeStore } = await docHealingSetup();
  const indexer = createIndexer(deps);
  await indexer.indexFiles([{ file: "d.md", event: "add" }]);
  docTreeStore.deleteTree("d.md");
  await indexer.indexFiles([{ file: "d.md", event: "add" }]);
  assert.ok(docTreeStore.getTree("d.md"));
  docTreeStore.close();
});

test("a doc tree without summaries is rebuilt once a summarizer is configured and answers", async () => {
  const { deps, docTreeStore } = await docHealingSetup();
  await createIndexer(deps).indexFiles([{ file: "d.md", event: "add" }]);
  assert.equal(docTreeStore.getTree("d.md")!.description, null);
  await createIndexer({ ...deps, summarize: async () => "sum" }).indexFiles([{ file: "d.md", event: "add" }]);
  assert.equal(docTreeStore.getTree("d.md")!.description, "sum");
  docTreeStore.close();
});

test("a code file indexed without summaries is re-indexed once file summaries are switched on", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const base = {
    vectorStore: store,
    embedDocument: fakeEmbedDocument,
    readFile: async () => "function a() {}\n\nfunction b() {}",
    fingerprint: async () => "same",
  };
  await createIndexer(base).indexFiles([{ file: "a.ts", event: "add" }]);
  assert.equal(store.getAllChunks().filter((c) => c.chunkType === "file-summary").length, 0);
  await createIndexer({ ...base, summarizeFile: async () => "about a and b" }).indexFiles([{ file: "a.ts", event: "add" }]);
  assert.equal(store.getAllChunks().filter((c) => c.chunkType === "file-summary").length, 1);
});

test("a code file with unchanged fingerprint, schema and summary mode is not re-read", async () => {
  const store = createVectorStore({ path: ":memory:" });
  let reads = 0;
  const indexer = createIndexer({
    vectorStore: store,
    embedDocument: fakeEmbedDocument,
    readFile: async () => (reads++, "one"),
    fingerprint: async () => "same",
    summarizeFile: async () => "s",
  });
  await indexer.indexFiles([{ file: "a.ts", event: "add" }]);
  await indexer.indexFiles([{ file: "a.ts", event: "add" }]);
  assert.equal(reads, 1);
});

/**
 * Progress only counts files that are really (re)indexed, each with a reason,
 * so the user can tell new/changed files from self-healing (ADR-0027).
 */

function reasonProgress() {
  const calls: { n: number; reasons: Record<string, number> | undefined }[] = [];
  const done: string[] = [];
  return {
    calls,
    done,
    progress: {
      beginBatch: (n: number, reasons?: Record<string, number>) => void calls.push({ n, reasons }),
      fileDone: (f: string) => void done.push(f),
      fileFailed: () => {},
      endBatch: () => {},
    },
  };
}

test("up-to-date files are neither counted nor reported by the progress tracker", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const fps: Record<string, string> = { "a.ts": "1", "b.ts": "1" };
  const base = { vectorStore: store, embedDocument: fakeEmbedDocument, readFile: async () => "x", fingerprint: async (f: string) => fps[f]! };
  await createIndexer(base).indexFiles([{ file: "a.ts", event: "add" }, { file: "b.ts", event: "add" }]);
  fps["b.ts"] = "2";
  const { calls, done, progress } = reasonProgress();
  await createIndexer({ ...base, progress }).indexFiles([{ file: "a.ts", event: "add" }, { file: "b.ts", event: "add" }]);
  assert.deepEqual(calls, [{ n: 1, reasons: { changed: 1 } }]);
  assert.deepEqual(done, ["b.ts"]);
});

test("new, removed and healed files are announced with their reason", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const { createDocTreeStore } = await import("../../src/storage/doc-tree-store.js");
  const docTreeStore = createDocTreeStore({ path: ":memory:" });
  const base = { vectorStore: store, docTreeStore, embedDocument: fakeEmbedDocument, readFile: async () => "# A\nbody", fingerprint: async () => "same" };
  await createIndexer(base).indexFiles([{ file: "kept.md", event: "add" }, { file: "gone.ts", event: "add" }]);
  // old representation: stored without the doc stamp, as chunks
  store.setFileFingerprint("kept.md", "same");
  const { calls, progress } = reasonProgress();
  await createIndexer({ ...base, progress }).indexFiles([
    { file: "kept.md", event: "add" },
    { file: "fresh.ts", event: "add" },
    { file: "gone.ts", event: "unlink" },
  ]);
  assert.deepEqual(calls, [{ n: 3, reasons: { upgrade: 1, new: 1, removed: 1 } }]);
  docTreeStore.close();
});

test("a repaired tree and a summary backfill get their own reasons", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const { createDocTreeStore } = await import("../../src/storage/doc-tree-store.js");
  const docTreeStore = createDocTreeStore({ path: ":memory:" });
  const base = { vectorStore: store, docTreeStore, embedDocument: fakeEmbedDocument, readFile: async () => "# A\nbody", fingerprint: async () => "same" };
  await createIndexer(base).indexFiles([{ file: "a.md", event: "add" }, { file: "b.md", event: "add" }]);
  docTreeStore.deleteTree("a.md");
  const { calls, progress } = reasonProgress();
  await createIndexer({ ...base, progress, summarize: async () => "s" }).indexFiles([{ file: "a.md", event: "add" }, { file: "b.md", event: "add" }]);
  assert.deepEqual(calls, [{ n: 2, reasons: { repair: 1, summaries: 1 } }]);
  docTreeStore.close();
});

/**
 * Deterministic summaries written while an LLM is configured are flagged in the
 * stored fingerprint and redone (summary only) once the LLM answers again.
 */

function summaryRig(overrides: Record<string, unknown> = {}) {
  const store = createVectorStore({ path: ":memory:" });
  let embeds = 0;
  let summaryAnswer: string | { text: string; fallback: boolean } = { text: "File a.ts. Defines: x.", fallback: true };
  const base = {
    vectorStore: store,
    embedDocument: (t: string) => (embeds++, fakeEmbedDocument(t)),
    readFile: async () => "one\n\ntwo",
    fingerprint: async () => "same",
    summaryLlmConfigured: true,
    summarizeFile: async () => summaryAnswer,
    ...overrides,
  };
  const summaryText = () => store.getAllChunks().find((c) => c.chunkType === "file-summary")?.text;
  return {
    store,
    base,
    embeds: () => embeds,
    summaryText,
    answer: (a: string | { text: string; fallback: boolean }) => void (summaryAnswer = a),
  };
}

test("a fallback summary is flagged and replaced once the LLM answers, without re-embedding the chunks", async () => {
  const rig = summaryRig();
  const indexer = createIndexer(rig.base);
  await indexer.indexFiles([{ file: "a.ts", event: "add" }]);
  assert.equal(rig.store.getFileFingerprint("a.ts"), "same#code2+detsum");
  const embedsBefore = rig.embeds();
  rig.answer("LLM summary");
  const { calls, progress } = reasonProgress();
  await createIndexer({ ...rig.base, progress }).indexFiles([{ file: "a.ts", event: "add" }]);
  assert.equal(rig.summaryText(), "LLM summary");
  assert.equal(rig.embeds(), embedsBefore + 1);
  assert.equal(rig.store.getFileFingerprint("a.ts"), "same#code2");
  assert.deepEqual(calls, [{ n: 1, reasons: { summaries: 1 } }]);
});

test("a flagged file stays untouched when no LLM is configured", async () => {
  const rig = summaryRig();
  await createIndexer(rig.base).indexFiles([{ file: "a.ts", event: "add" }]);
  const { calls, progress } = reasonProgress();
  await createIndexer({ ...rig.base, summaryLlmConfigured: false, progress }).indexFiles([{ file: "a.ts", event: "add" }]);
  assert.deepEqual(calls, [{ n: 0, reasons: {} }]);
});

test("a flagged file keeps its flag when the LLM is still failing", async () => {
  const rig = summaryRig();
  await createIndexer(rig.base).indexFiles([{ file: "a.ts", event: "add" }]);
  await createIndexer(rig.base).indexFiles([{ file: "a.ts", event: "add" }]);
  assert.equal(rig.store.getFileFingerprint("a.ts"), "same#code2+detsum");
});

test("a fallback summary without a configured LLM is not flagged", async () => {
  const rig = summaryRig({ summaryLlmConfigured: false });
  await createIndexer(rig.base).indexFiles([{ file: "a.ts", event: "add" }]);
  assert.equal(rig.store.getFileFingerprint("a.ts"), "same#code2");
});

test("a changed file whose summary fell back is re-indexed normally and stays flagged", async () => {
  const rig = summaryRig();
  let fp = "1";
  const base = { ...rig.base, fingerprint: async () => fp };
  await createIndexer(base).indexFiles([{ file: "a.ts", event: "add" }]);
  fp = "2";
  await createIndexer(base).indexFiles([{ file: "a.ts", event: "change" }]);
  assert.equal(rig.store.getFileFingerprint("a.ts"), "2#code2+detsum");
});

/** Config-triggered re-indexing (reindex_chunks / reindex_summaries). */

test("reindex summaries only rewrites the summary chunk and leaves the others alone", async () => {
  const rig = summaryRig();
  rig.answer("old");
  await createIndexer(rig.base).indexFiles([{ file: "a.ts", event: "add" }]);
  const embedsBefore = rig.embeds();
  rig.answer("fresh");
  const { calls, progress } = reasonProgress();
  const result = await createIndexer({ ...rig.base, progress }).indexFiles([{ file: "a.ts", event: "add" }], {
    reindex: { chunks: false, summaries: true },
  });
  assert.equal(rig.summaryText(), "fresh");
  assert.equal(rig.embeds(), embedsBefore + 1);
  assert.deepEqual(calls, [{ n: 1, reasons: { upgrade: 1 } }]);
  assert.equal(result?.complete, true);
});

test("reindex chunks only re-embeds the chunks and keeps the stored summary", async () => {
  const rig = summaryRig();
  await createIndexer(rig.base).indexFiles([{ file: "a.ts", event: "add" }]);
  rig.answer("must not be asked");
  const embedsBefore = rig.embeds();
  await createIndexer(rig.base).indexFiles([{ file: "a.ts", event: "add" }], { reindex: { chunks: true, summaries: false } });
  assert.equal(rig.summaryText(), "File a.ts. Defines: x.");
  assert.equal(rig.embeds(), embedsBefore + 2);
  assert.equal(rig.store.getFileFingerprint("a.ts"), "same#code2+detsum");
});

test("both reindex flags redo chunks and summaries", async () => {
  const rig = summaryRig();
  await createIndexer(rig.base).indexFiles([{ file: "a.ts", event: "add" }]);
  rig.answer("fresh");
  const embedsBefore = rig.embeds();
  await createIndexer(rig.base).indexFiles([{ file: "a.ts", event: "add" }], { reindex: { chunks: true, summaries: true } });
  assert.equal(rig.summaryText(), "fresh");
  assert.equal(rig.embeds(), embedsBefore + 3);
  assert.equal(rig.store.getFileFingerprint("a.ts"), "same#code2");
});

test("indexFiles reports an incomplete run when a file failed", async () => {
  const rig = summaryRig({ readFile: async () => { throw new Error("boom"); } });
  const result = await createIndexer(rig.base).indexFiles([{ file: "a.ts", event: "add" }]);
  assert.equal(result?.complete, false);
});
