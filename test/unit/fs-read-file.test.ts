import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFsReadFile, createIndexer } from "../../src/indexing/indexing.js";
import { createVectorStore } from "../../src/storage/vector-store.js";

async function worktree(files: Record<string, string>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-context-read-"));
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
  }
  return dir;
}

test("createFsReadFile reads files within the size limit", async () => {
  const dir = await worktree({ "a.ts": "hello" });
  assert.equal(await createFsReadFile(dir, { maxBytes: 100 })("a.ts"), "hello");
});

test("createFsReadFile still returns null for a missing file", async () => {
  const dir = await worktree({});
  assert.equal(await createFsReadFile(dir, { maxBytes: 100 })("nope.ts"), null);
});

test("createFsReadFile refuses a file over the limit without reading it, with an actionable message", async () => {
  const dir = await worktree({ "bundle.js": "x".repeat(500) });
  await assert.rejects(() => createFsReadFile(dir, { maxBytes: 100 })("bundle.js"), /500 bytes.*max_file_bytes.*100/);
});

test("a too-large file is skipped and reported as a failure while the rest of the batch is indexed", async () => {
  const dir = await worktree({ "big.js": "x".repeat(500), "small.ts": "ok" });
  const failures: string[] = [];
  const indexer = createIndexer({
    vectorStore: createVectorStore({ path: ":memory:" }),
    embedDocument: async () => [1, 2],
    readFile: createFsReadFile(dir, { maxBytes: 100 }),
    progress: {
      beginBatch() {},
      endBatch() {},
      fileDone() {},
      fileFailed: (file, error) => void failures.push(`${file}: ${(error as Error).message}`),
    },
  });
  await indexer.indexFiles([
    { file: "big.js", event: "add" },
    { file: "small.ts", event: "add" },
  ]);
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /^big\.js: .*max_file_bytes/);
});
