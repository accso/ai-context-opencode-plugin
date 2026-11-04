import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createVectorStore } from "../../src/storage/vector-store.js";
import { createDocTreeStore } from "../../src/storage/doc-tree-store.js";
import { shardFiles } from "../../src/storage/backup.js";
import {
  resolveBackupFilePath,
  exportBackup,
  importBackup,
  resolveDocTreeBackupFilePath,
  exportDocTreeBackup,
  importDocTreeBackup,
} from "../../src/storage/backup.js";

/**
 * Unit tests for the repo-local, versionable vector-store backup
 * (plan.md, "repo-local-backup", user-directed 2026-09-15): teammates
 * should be able to get the indexed data from a fresh clone without
 * re-indexing the whole repo themselves, by committing a backup file
 * that lives INSIDE the repo (unlike the store itself, which
 * deliberately lives outside the worktree -- see project-key.ts).
 *
 * Format is JSON Lines (one JSON object per chunk, sorted by id) --
 * NOT the raw SQLite file -- specifically so it's git-diffable/
 * versionable: a small doc-comment change produces a small, readable
 * diff instead of an opaque binary blob diff or an unresolvable merge
 * conflict.
 */

function tmpWorktree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-context-backup-test-"));
}

test("resolveBackupFilePath points inside .opencode/ai-context/backup within the worktree", () => {
  const worktree = "/repo/project";
  const filePath = resolveBackupFilePath(worktree);
  assert.equal(filePath, path.join("/repo/project", ".opencode", "ai-context", "backup", "index.jsonl"));
});

test("exportBackup writes one sorted JSON line per chunk, git-diff friendly", () => {
  const worktree = tmpWorktree();
  const store = createVectorStore({ path: ":memory:" });
  store.upsertChunks([
    { id: "b", relativePath: "src/b.ts", language: "typescript", text: "beta", startLine: 1, endLine: 1, chunkType: "function", vector: [0, 1] },
    { id: "a", relativePath: "src/a.ts", language: "typescript", text: "alpha", startLine: 1, endLine: 1, chunkType: "function", vector: [1, 0] },
  ]);

  const result = exportBackup(store, resolveBackupFilePath(worktree));

  assert.equal(result.count, 2);
  const filePath = path.join(path.dirname(resolveBackupFilePath(worktree)), "index-0000.jsonl");
  assert.ok(fs.existsSync(filePath));
  const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  // sorted by id, so re-exporting an unchanged store produces an
  // identical file byte-for-byte (stable diffs).
  assert.equal(JSON.parse(lines[0]!).id, "a");
  assert.equal(JSON.parse(lines[1]!).id, "b");

  store.close();
  fs.rmSync(worktree, { recursive: true, force: true });
});

test("importBackup repopulates an empty store from a previously exported file", () => {
  const worktree = tmpWorktree();
  const sourceStore = createVectorStore({ path: ":memory:" });
  sourceStore.upsertChunks([
    { id: "c1", relativePath: "src/a.ts", language: "typescript", text: "alpha", startLine: 1, endLine: 2, symbol: "alpha", chunkType: "function", vector: [1, 0, 0] },
  ]);
  const filePath = resolveBackupFilePath(worktree);
  exportBackup(sourceStore, filePath);
  sourceStore.close();

  const targetStore = createVectorStore({ path: ":memory:" });
  const result = importBackup(targetStore, filePath);

  assert.equal(result.count, 1);
  const restored = targetStore.getAllChunks();
  assert.equal(restored.length, 1);
  assert.equal(restored[0]!.id, "c1");
  assert.equal(restored[0]!.symbol, "alpha");
  assert.deepEqual(restored[0]!.vector, [1, 0, 0]);

  targetStore.close();
  fs.rmSync(worktree, { recursive: true, force: true });
});

test("importBackup is a no-op returning count 0 when no backup file exists", () => {
  const worktree = tmpWorktree();
  const store = createVectorStore({ path: ":memory:" });
  const result = importBackup(store, resolveBackupFilePath(worktree));
  assert.equal(result.count, 0);
  assert.deepEqual(store.getAllChunks(), []);
  store.close();
  fs.rmSync(worktree, { recursive: true, force: true });
});

/**
 * Backup import schema validation (critical-review finding
 * "validate-backup-import-schema", plan.md): `importBackup` previously
 * blindly cast `JSON.parse(line)` to `VectorStoreChunk` with no shape
 * check at all -- a malformed or merge-conflicted committed backup
 * file (e.g. a git merge leaving a `<<<<<<< HEAD` line, truncated
 * JSON, or a row missing a required field) would throw and crash the
 * plugin at startup for every teammate who pulls it, rather than just
 * failing to restore that one row.
 */

test("importBackup skips malformed JSON lines (e.g. a git merge conflict marker) instead of crashing", () => {
  const worktree = tmpWorktree();
  const filePath = resolveBackupFilePath(worktree);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const validChunk = { id: "c1", relativePath: "src/a.ts", language: "typescript", text: "alpha", startLine: 1, endLine: 1, chunkType: "function", vector: [1, 0] };
  fs.writeFileSync(filePath, [
    "<<<<<<< HEAD",
    JSON.stringify(validChunk),
    "=======",
    ">>>>>>> branch",
  ].join("\n") + "\n");

  const store = createVectorStore({ path: ":memory:" });
  const result = importBackup(store, filePath);

  assert.equal(result.count, 1, "should import only the one genuinely valid row");
  assert.equal(store.getAllChunks().length, 1);
  assert.equal(store.getAllChunks()[0]!.id, "c1");

  store.close();
  fs.rmSync(worktree, { recursive: true, force: true });
});

test("importBackup skips rows missing required fields instead of crashing", () => {
  const worktree = tmpWorktree();
  const filePath = resolveBackupFilePath(worktree);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const validChunk = { id: "c1", relativePath: "src/a.ts", language: "typescript", text: "alpha", startLine: 1, endLine: 1, chunkType: "function", vector: [1, 0] };
  const missingId = { relativePath: "src/b.ts", language: "typescript", text: "beta", startLine: 1, endLine: 1, chunkType: "function", vector: [0, 1] };
  const wrongVectorType = { id: "c3", relativePath: "src/c.ts", language: "typescript", text: "gamma", startLine: 1, endLine: 1, chunkType: "function", vector: "not-an-array" };
  fs.writeFileSync(filePath, [validChunk, missingId, wrongVectorType].map((row) => JSON.stringify(row)).join("\n") + "\n");

  const store = createVectorStore({ path: ":memory:" });
  const result = importBackup(store, filePath);

  assert.equal(result.count, 1);
  assert.equal(store.getAllChunks().length, 1);
  assert.equal(store.getAllChunks()[0]!.id, "c1");

  store.close();
  fs.rmSync(worktree, { recursive: true, force: true });
});


/**
 * Doc-tree backup (critical-review finding "doc-tree-backup", plan.md):
 * the repo-local backup previously only covered vectorStore chunks --
 * a restored clone got code search back but every Markdown doc tree
 * had to be rebuilt locally, silently defeating the "get the indexed
 * files without re-indexing the whole repo" goal for doc-heavy repos.
 * Mirrors the chunk backup's own JSONL/sort/no-op-if-missing shape,
 * as a sibling file so the two backups stay independently diffable.
 */

test("resolveDocTreeBackupFilePath points at a sibling doc-trees.jsonl inside the same backup directory", () => {
  const worktree = "/repo/project";
  const filePath = resolveDocTreeBackupFilePath(worktree);
  assert.equal(filePath, path.join("/repo/project", ".opencode", "ai-context", "backup", "doc-trees.jsonl"));
});

test("exportDocTreeBackup writes one sorted JSON line per tree, git-diff friendly", () => {
  const worktree = tmpWorktree();
  const store = createDocTreeStore({ path: ":memory:" });
  store.upsertTree("docs/b.md", { description: "b", nodeCount: 1, nodes: [] });
  store.upsertTree("docs/a.md", { description: "a", nodeCount: 1, nodes: [] });

  const result = exportDocTreeBackup(store, resolveDocTreeBackupFilePath(worktree));

  assert.equal(result.count, 2);
  const filePath = resolveDocTreeBackupFilePath(worktree);
  const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]!).relativePath, "docs/a.md");
  assert.equal(JSON.parse(lines[1]!).relativePath, "docs/b.md");

  store.close();
  fs.rmSync(worktree, { recursive: true, force: true });
});

test("importDocTreeBackup restores every exported tree into a fresh store", () => {
  const worktree = tmpWorktree();
  const sourceStore = createDocTreeStore({ path: ":memory:" });
  sourceStore.upsertTree("docs/adr.md", {
    description: "ADRs",
    nodeCount: 1,
    nodes: [{ nodeId: "0001", title: "ADR 1", startLine: 1, endLine: 3, summary: null, bodyText: "text", children: [] }],
  });
  const filePath = resolveDocTreeBackupFilePath(worktree);
  exportDocTreeBackup(sourceStore, filePath);
  sourceStore.close();

  const targetStore = createDocTreeStore({ path: ":memory:" });
  const result = importDocTreeBackup(targetStore, filePath);

  assert.equal(result.count, 1);
  const restored = targetStore.getTree("docs/adr.md");
  assert.ok(restored);
  assert.equal(restored!.description, "ADRs");
  assert.equal(restored!.nodes[0]!.title, "ADR 1");

  targetStore.close();
  fs.rmSync(worktree, { recursive: true, force: true });
});

test("importDocTreeBackup is a no-op returning count 0 when no backup file exists", () => {
  const worktree = tmpWorktree();
  const store = createDocTreeStore({ path: ":memory:" });
  const result = importDocTreeBackup(store, resolveDocTreeBackupFilePath(worktree));
  assert.equal(result.count, 0);
  store.close();
  fs.rmSync(worktree, { recursive: true, force: true });
});

test("importDocTreeBackup skips malformed/incomplete rows instead of crashing (validate-backup-import-schema)", () => {
  const worktree = tmpWorktree();
  const filePath = resolveDocTreeBackupFilePath(worktree);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const validTree = { relativePath: "docs/a.md", description: "a", nodeCount: 1, nodes: [] };
  const missingRelativePath = { description: "b", nodeCount: 1, nodes: [] };
  const wrongNodesType = { relativePath: "docs/c.md", description: "c", nodeCount: 1, nodes: "not-an-array" };
  fs.writeFileSync(
    filePath,
    ["<<<<<<< HEAD", JSON.stringify(validTree), "=======", JSON.stringify(missingRelativePath), JSON.stringify(wrongNodesType), ">>>>>>> branch"].join("\n") + "\n",
  );

  const store = createDocTreeStore({ path: ":memory:" });
  const result = importDocTreeBackup(store, filePath);

  assert.equal(result.count, 1, "should import only the one genuinely valid row");
  assert.ok(store.getTree("docs/a.md"));
  assert.equal(store.getTree("docs/c.md"), null);

  store.close();
  fs.rmSync(worktree, { recursive: true, force: true });
});


test("exportBackup streams the store page by page and never calls getAllChunks", () => {
  const worktree = tmpWorktree();
  const store = createVectorStore({ path: ":memory:" });
  const rows = ["e", "b", "d", "a", "c"].map((id) => ({
    id, relativePath: `src/${id}.ts`, language: "typescript", text: id, startLine: 1, endLine: 1, chunkType: "function", vector: [1],
  }));
  store.upsertChunks(rows);
  store.getAllChunks = () => {
    throw new Error("export must not load every chunk at once");
  };
  const result = exportBackup(store, resolveBackupFilePath(worktree), { pageSize: 2 });
  assert.equal(result.count, 5);
  const ids = shardFiles(resolveBackupFilePath(worktree)).flatMap((f) => fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l).id)).sort();
  assert.deepEqual(ids, ["a", "b", "c", "d", "e"]);
  store.close();
  fs.rmSync(worktree, { recursive: true, force: true });
});

test("importBackup upserts in bounded batches while skipping corrupt lines", () => {
  const worktree = tmpWorktree();
  const filePath = resolveBackupFilePath(worktree);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const row = (id: string) => JSON.stringify({ id, relativePath: "a.ts", language: "typescript", text: id, startLine: 1, endLine: 1, chunkType: "function", vector: [1] });
  fs.writeFileSync(filePath, [row("1"), "<<<<<<< HEAD", row("2"), row("3"), row("4"), row("5")].join("\n") + "\n");
  const batches: number[] = [];
  const store = createVectorStore({ path: ":memory:" });
  const upsert = store.upsertChunks.bind(store);
  store.upsertChunks = (chunks) => {
    batches.push(chunks.length);
    upsert(chunks);
  };
  const result = importBackup(store, filePath, { batchSize: 2 });
  assert.equal(result.count, 5);
  assert.deepEqual(batches, [2, 2, 1]);
  store.close();
  fs.rmSync(worktree, { recursive: true, force: true });
});

/**
 * Compact, sharded format (ADR-0028): float16 vectors, rows spread over
 * `index-NNNN.jsonl` files by a stable hash of the path, each kept small
 * enough for a commit/push.
 */

function chunk(id: string, relativePath: string, vector: number[]) {
  return { id, relativePath, language: "typescript", text: `text ${id}`, startLine: 1, endLine: 1, chunkType: "function", vector };
}

test("exportBackup stores vectors as float16 base64 instead of float arrays", () => {
  const worktree = tmpWorktree();
  const store = createVectorStore({ path: ":memory:" });
  store.upsertChunks([chunk("a", "a.ts", [0.5, -0.25, 0.125])]);
  exportBackup(store, resolveBackupFilePath(worktree));
  const [file] = shardFiles(resolveBackupFilePath(worktree));
  const row = JSON.parse(fs.readFileSync(file!, "utf8").trim());
  assert.equal(row.vector, undefined);
  assert.equal(typeof row.vector16, "string");
  store.close();
  fs.rmSync(worktree, { recursive: true, force: true });
});

test("a float16 backup restores vectors within half precision", () => {
  const worktree = tmpWorktree();
  const source = createVectorStore({ path: ":memory:" });
  const vector = Array.from({ length: 64 }, (_, i) => Math.cos(i) / 5);
  source.upsertChunks([chunk("a", "a.ts", vector)]);
  exportBackup(source, resolveBackupFilePath(worktree));
  const target = createVectorStore({ path: ":memory:" });
  assert.equal(importBackup(target, resolveBackupFilePath(worktree)).count, 1);
  const restored = target.getAllChunks()[0]!.vector;
  vector.forEach((v, i) => assert.ok(Math.abs(restored[i]! - v) < 1e-3));
  source.close();
  target.close();
  fs.rmSync(worktree, { recursive: true, force: true });
});

test("exportBackup splits large stores into several shards, keeps every row once and a path in one shard", () => {
  const worktree = tmpWorktree();
  const store = createVectorStore({ path: ":memory:" });
  const rows = [];
  for (let f = 0; f < 40; f++) for (let c = 0; c < 5; c++) rows.push(chunk(`f${f}.ts:${c}`, `f${f}.ts`, Array.from({ length: 64 }, (_, i) => i / 64)));
  store.upsertChunks(rows);
  const filePath = resolveBackupFilePath(worktree);
  const result = exportBackup(store, filePath, { maxShardBytes: 8_000 });
  assert.equal(result.count, 200);
  const files = shardFiles(filePath);
  assert.ok(files.length > 1, "expected several shards");
  const pathToShard = new Map<string, string>();
  let total = 0;
  for (const file of files) {
    assert.ok(fs.statSync(file).size < 16_000, `${file} too large`);
    for (const line of fs.readFileSync(file, "utf8").trim().split("\n")) {
      const row = JSON.parse(line);
      total++;
      assert.equal(pathToShard.get(row.relativePath) ?? file, file);
      pathToShard.set(row.relativePath, file);
    }
  }
  assert.equal(total, 200);
  const target = createVectorStore({ path: ":memory:" });
  assert.equal(importBackup(target, filePath).count, 200);
  store.close();
  target.close();
  fs.rmSync(worktree, { recursive: true, force: true });
});

test("re-exporting an unchanged store is byte-identical and a change touches only its own shard", () => {
  const worktree = tmpWorktree();
  const store = createVectorStore({ path: ":memory:" });
  const rows = [];
  for (let f = 0; f < 40; f++) rows.push(chunk(`f${f}.ts:0`, `f${f}.ts`, Array.from({ length: 64 }, (_, i) => i / 64)));
  store.upsertChunks(rows);
  const filePath = resolveBackupFilePath(worktree);
  const read = () => Object.fromEntries(shardFiles(filePath).map((f) => [path.basename(f), fs.readFileSync(f, "utf8")]));
  exportBackup(store, filePath, { maxShardBytes: 8_000 });
  const first = read();
  exportBackup(store, filePath, { maxShardBytes: 8_000 });
  assert.deepEqual(read(), first);
  store.upsertChunks([chunk("f3.ts:0", "f3.ts", Array.from({ length: 64 }, () => 0.9))]);
  exportBackup(store, filePath, { maxShardBytes: 8_000 });
  const changed = Object.keys(first).filter((k) => read()[k] !== first[k]);
  assert.equal(changed.length, 1);
  store.close();
  fs.rmSync(worktree, { recursive: true, force: true });
});

test("exportBackup removes the legacy single file and stale shards", () => {
  const worktree = tmpWorktree();
  const filePath = resolveBackupFilePath(worktree);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "legacy\n");
  fs.writeFileSync(path.join(path.dirname(filePath), "index-0007.jsonl"), "stale\n");
  const store = createVectorStore({ path: ":memory:" });
  store.upsertChunks([chunk("a", "a.ts", [1, 0])]);
  exportBackup(store, filePath);
  assert.equal(fs.existsSync(filePath), false);
  assert.deepEqual(shardFiles(filePath).map((f) => path.basename(f)), ["index-0000.jsonl"]);
  store.close();
  fs.rmSync(worktree, { recursive: true, force: true });
});

test("importBackup still reads a legacy single-file backup with float arrays", () => {
  const worktree = tmpWorktree();
  const filePath = resolveBackupFilePath(worktree);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(chunk("a", "a.ts", [1, 0])) + "\n");
  const store = createVectorStore({ path: ":memory:" });
  assert.equal(importBackup(store, filePath).count, 1);
  assert.deepEqual(store.getAllChunks()[0]!.vector, [1, 0]);
  store.close();
  fs.rmSync(worktree, { recursive: true, force: true });
});

test("importBackup skips a shard row whose float16 payload is broken", () => {
  const worktree = tmpWorktree();
  const filePath = resolveBackupFilePath(worktree);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const { vector, ...rest } = chunk("a", "a.ts", [1]);
  void vector;
  fs.writeFileSync(path.join(path.dirname(filePath), "index-0000.jsonl"), JSON.stringify({ ...rest, vector16: "AAAA" }) + "\n");
  const store = createVectorStore({ path: ":memory:" });
  assert.equal(importBackup(store, filePath).count, 0);
  store.close();
  fs.rmSync(worktree, { recursive: true, force: true });
});
