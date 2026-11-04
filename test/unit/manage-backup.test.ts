import { test } from "node:test";
import assert from "node:assert/strict";
import { createExportBackupTool } from "../../src/tools/manage-backup.js";
import { createVectorStore } from "../../src/storage/vector-store.js";

/**
 * Unit tests for the native `ai_context_export_backup` tool (plan.md,
 * "repo-local-backup") -- lets the agent/user trigger writing the
 * current vector store to the repo-local, versionable backup file on
 * demand (e.g. right before committing), rather than on every single
 * indexing event.
 */

import { createDocTreeStore } from "../../src/storage/doc-tree-store.js";

test("ai_context_export_backup writes the store to the given file path and reports the count", async () => {
  const store = createVectorStore({ path: ":memory:" });
  store.upsertChunks([
    { id: "c1", relativePath: "src/a.ts", language: "typescript", text: "alpha", startLine: 1, endLine: 1, chunkType: "function", vector: [1, 0] },
  ]);
  let exportedFilePath = "";
  const exportBackup = (_store: unknown, filePath: string) => {
    exportedFilePath = filePath;
    return { count: 1 };
  };
  const toolDef = createExportBackupTool({ vectorStore: store, backupFilePath: "/repo/.opencode/ai-context/backup/index.jsonl", exportBackup });
  const raw = await toolDef.execute({}, {} as never);
  const result = JSON.parse(raw as string);
  assert.equal(result.count, 1);
  assert.equal(exportedFilePath, "/repo/.opencode/ai-context/backup/index.jsonl");
  store.close();
});

/**
 * Doc-tree backup wiring (critical-review finding "doc-tree-backup",
 * plan.md): when a docTreeStore is injected, the same on-demand export
 * action also writes the doc-tree backup, so a single tool call keeps
 * both repo-local backups (chunks + doc trees) in sync.
 */

test("ai_context_export_backup also exports the doc-tree store when one is given", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const docTreeStore = createDocTreeStore({ path: ":memory:" });
  docTreeStore.upsertTree("docs/a.md", { description: "a", nodeCount: 1, nodes: [] });

  let exportedDocTreeFilePath = "";
  const exportDocTreeBackup = (_store: unknown, filePath: string) => {
    exportedDocTreeFilePath = filePath;
    return { count: 1 };
  };
  const toolDef = createExportBackupTool({
    vectorStore: store,
    backupFilePath: "/repo/.opencode/ai-context/backup/index.jsonl",
    exportBackup: () => ({ count: 0 }),
    docTreeStore,
    docTreeBackupFilePath: "/repo/.opencode/ai-context/backup/doc-trees.jsonl",
    exportDocTreeBackup,
  });
  const raw = await toolDef.execute({}, {} as never);
  const result = JSON.parse(raw as string);
  assert.equal(result.docTreeCount, 1);
  assert.equal(result.docTreePath, "/repo/.opencode/ai-context/backup/doc-trees.jsonl");
  assert.equal(exportedDocTreeFilePath, "/repo/.opencode/ai-context/backup/doc-trees.jsonl");
  store.close();
  docTreeStore.close();
});

test("ai_context_export_backup lists the shard files it wrote, not the legacy single file", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-tool-"));
  try {
    const store = createVectorStore({ path: ":memory:" });
    store.upsertChunks([
      { id: "c1", relativePath: "src/a.ts", language: "typescript", text: "alpha", startLine: 1, endLine: 1, chunkType: "function", vector: [1, 0] },
    ]);
    const toolDef = createExportBackupTool({ vectorStore: store, backupFilePath: path.join(dir, "index.jsonl") });
    const result = JSON.parse((await toolDef.execute({}, {} as never)) as string);
    assert.deepEqual(result.files, ["index-0000.jsonl"]);
    assert.equal(result.path, undefined);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
