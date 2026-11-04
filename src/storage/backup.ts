import fs from "node:fs";
import path from "node:path";
import type { VectorStore, VectorStoreChunk } from "./vector-store.js";
import type { GraphStore, FileGraph } from "./graph-store.js";
import type { DocTreeStore, DocTreeRecord } from "./doc-tree-store.js";
import { decodeVector16, encodeVector16 } from "./float16.js";

/**
 * Repo-local, versionable vector-store backup (plan.md,
 * "repo-local-backup", user-directed 2026-09-15): "allow backups of
 * the database for the repository to the same repository to allow the
 * team get the indexed files without self indexing the whole repo
 * again". Deliberately the OPPOSITE placement from the live store
 * itself: `project-key.ts`'s `deriveProjectKey` puts the live SQLite
 * file OUTSIDE the worktree (so the plugin's own writes never trigger
 * `file.watcher.updated` on itself); this backup file lives INSIDE the
 * worktree, at `.opencode/ai-context/backup/index.jsonl`, specifically
 * so it can be committed to the repo and shared with the team.
 *
 * Format is JSON Lines, one chunk per line, sorted by `id` -- NOT a
 * copy of the raw SQLite file. A binary SQLite blob wouldn't diff or
 * merge meaningfully in git; a stable-sorted JSONL file does (an
 * unchanged store re-exports byte-for-byte identical, so `git diff`
 * only shows what actually changed).
 */

export function resolveBackupFilePath(worktree: string): string {
  return path.join(
    worktree,
    ".opencode",
    "ai-context",
    "backup",
    "index.jsonl",
  );
}

export interface BackupResult {
  count: number;
}

const DEFAULT_PAGE_SIZE = 500;
/** Target upper bound per shard file; far below host push limits (GitHub: 100 MB). */
export const DEFAULT_MAX_SHARD_BYTES = 10 * 1024 * 1024;

const SHARD_PATTERN = /^(.+)-(\d{4})\.jsonl$/;

function stemOf(filePath: string): string {
  return path.basename(filePath).replace(/\.jsonl$/, "");
}

/** Existing shard files (`<stem>-NNNN.jsonl`) next to `filePath`, sorted by name. */
export function shardFiles(filePath: string): string[] {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) return [];
  const stem = stemOf(filePath);
  return fs
    .readdirSync(dir)
    .filter((name) => SHARD_PATTERN.exec(name)?.[1] === stem)
    .sort()
    .map((name) => path.join(dir, name));
}

/** FNV-1a: a stable path -> shard mapping, so a change only rewrites the shard of its file. */
function bucketOf(relativePath: string, shardCount: number): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(relativePath, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash & (shardCount - 1);
}

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Writes every chunk in `store` as JSON Lines (float16 vectors, ADR-0028),
 * sorted by id inside `<stem>-NNNN.jsonl` shard files next to `filePath`.
 * The shard count is a power of two derived from the estimated size, so it
 * changes rarely and unchanged shards stay byte-identical. Streams page by
 * page so memory stays bounded. Removes the legacy single file and old shards.
 */
export function exportBackup(
  store: VectorStore,
  filePath: string,
  options: { pageSize?: number; maxShardBytes?: number } = {},
): BackupResult {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxShardBytes = options.maxShardBytes ?? DEFAULT_MAX_SHARD_BYTES;
  const dir = path.dirname(filePath);
  const stem = stemOf(filePath);
  fs.mkdirSync(dir, { recursive: true });
  for (const old of [filePath, ...shardFiles(filePath)]) fs.rmSync(old, { force: true });

  const total = store.getIndexStatus().chunkCount;
  const fds = new Map<number, number>();
  let shardCount = 1;
  let count = 0;
  try {
    let afterId: string | null = null;
    for (;;) {
      const page = store.getChunksPage(afterId, pageSize);
      if (page.length === 0) break;
      const lines = page.map((chunk) => JSON.stringify(backupRow(chunk)) + "\n");
      if (count === 0) {
        const avgBytes = lines.reduce((sum, l) => sum + Buffer.byteLength(l), 0) / lines.length;
        shardCount = nextPowerOfTwo(Math.ceil((Math.max(total, page.length) * avgBytes) / maxShardBytes));
      }
      const perShard = new Map<number, string>();
      page.forEach((chunk, i) => {
        const bucket = bucketOf(chunk.relativePath, shardCount);
        perShard.set(bucket, (perShard.get(bucket) ?? "") + lines[i]);
      });
      for (const [bucket, text] of perShard) {
        let fd = fds.get(bucket);
        if (fd === undefined) {
          fd = fs.openSync(path.join(dir, `${stem}-${String(bucket).padStart(4, "0")}.jsonl`), "w");
          fds.set(bucket, fd);
        }
        fs.writeSync(fd, text);
      }
      count += page.length;
      afterId = page[page.length - 1]!.id;
    }
  } finally {
    for (const fd of fds.values()) fs.closeSync(fd);
  }
  return { count };
}

/**
 * Repopulates `store` from the legacy single file at `filePath` (float
 * arrays, if present) and every `<stem>-NNNN.jsonl` shard next to it. A
 * no-op (returns `{count: 0}`) if neither exists -- e.g. a repo that hasn't
 * opted into committing a backup.
 *
 * Fault-tolerant per row (critical-review finding
 * "validate-backup-import-schema"): a committed backup file is
 * ordinary repo content, so it can arrive corrupted the same way any
 * other tracked file can -- most commonly an unresolved git merge
 * conflict (`<<<<<<<`/`=======`/`>>>>>>>` marker lines break
 * `JSON.parse` entirely), but also a hand-edited or partially-written
 * row missing a required field or with a wrong-typed one. Rather than
 * letting one bad line abort the entire import (losing every OTHER
 * valid row too), each line is parsed and shape-checked independently;
 * a row that fails either step is silently skipped and the rest of the
 * file still imports.
 */
export function importBackup(
  store: VectorStore,
  filePath: string,
  options: { batchSize?: number } = {},
): BackupResult {
  const files = [...(fs.existsSync(filePath) ? [filePath] : []), ...shardFiles(filePath)];
  if (files.length === 0) return { count: 0 };
  const batchSize = options.batchSize ?? DEFAULT_PAGE_SIZE;
  let batch: VectorStoreChunk[] = [];
  let count = 0;
  const flush = () => {
    if (batch.length === 0) return;
    store.upsertChunks(batch);
    count += batch.length;
    batch = [];
  };
  for (const file of files) {
    forEachLine(file, (line) => {
      const row = restoreRow(tryParseJson(line));
      if (!row) return;
      batch.push(row);
      if (batch.length >= batchSize) flush();
    });
  }
  flush();
  return { count };
}

/** Reads a file line by line in 1 MiB blocks (synchronously) instead of loading it whole. */
function forEachLine(filePath: string, onLine: (line: string) => void): void {
  const fd = fs.openSync(filePath, "r");
  try {
    const block = Buffer.alloc(1 << 20);
    let pending = Buffer.alloc(0);
    let read: number;
    while ((read = fs.readSync(fd, block, 0, block.length, null)) > 0) {
      pending = Buffer.concat([pending, block.subarray(0, read)]);
      let newline: number;
      while ((newline = pending.indexOf(0x0a)) !== -1) {
        const line = pending.subarray(0, newline).toString("utf8").trim();
        pending = pending.subarray(newline + 1);
        if (line) onLine(line);
      }
    }
    const rest = pending.toString("utf8").trim();
    if (rest) onLine(rest);
  } finally {
    fs.closeSync(fd);
  }
}

function tryParseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function hasChunkFields(r: Record<string, unknown>): boolean {
  return (
    typeof r.id === "string" &&
    typeof r.relativePath === "string" &&
    typeof r.language === "string" &&
    typeof r.text === "string" &&
    typeof r.startLine === "number" &&
    typeof r.endLine === "number" &&
    typeof r.chunkType === "string"
  );
}

/** A stored row (float16 `vector16`, or legacy float `vector`) as a chunk; undefined when invalid. */
function restoreRow(row: unknown): VectorStoreChunk | undefined {
  if (row === null || typeof row !== "object") return undefined;
  const r = row as Record<string, unknown>;
  if (!hasChunkFields(r)) return undefined;
  let vector: number[];
  if (typeof r.vector16 === "string") {
    try {
      vector = decodeVector16(r.vector16);
    } catch {
      return undefined;
    }
    if (vector.length === 0) return undefined;
  } else if (Array.isArray(r.vector)) {
    vector = r.vector as number[];
  } else {
    return undefined;
  }
  const { vector16: _ignored, ...rest } = r;
  void _ignored;
  return { ...(rest as unknown as VectorStoreChunk), vector };
}

// Stable key order so re-exporting an unchanged store is byte-for-byte
// identical regardless of property insertion order.
function backupRow(chunk: VectorStoreChunk) {
  return {
    id: chunk.id,
    relativePath: chunk.relativePath,
    language: chunk.language,
    text: chunk.text,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    symbol: chunk.symbol,
    chunkType: chunk.chunkType,
    vector16: encodeVector16(chunk.vector),
  };
}

/**
 * Doc-tree backup (critical-review finding "doc-tree-backup", plan.md):
 * a sibling JSONL file to the chunk backup above, covering
 * `DocTreeStore`'s PageIndex-style Markdown trees (see doc-tree-
 * store.ts / doc-tree-builder.ts). Without this, restoring a clone
 * from the committed chunk backup got code search back but every
 * tree-indexed doc (docs/, ADRs, wikis...) had to be rebuilt locally --
 * silently defeating the "get the indexed files without re-indexing
 * the whole repo" goal for doc-heavy repos. Same JSONL/stable-sort/
 * no-op-if-missing shape as `exportBackup`/`importBackup`, kept as its
 * own file (not merged into index.jsonl) so the two backups stay
 * independently diffable and one can exist without the other (e.g. a
 * repo with no tree-indexed Markdown never gets an empty doc-trees
 * file created).
 */

export function resolveDocTreeBackupFilePath(worktree: string): string {
  return path.join(
    worktree,
    ".opencode",
    "ai-context",
    "backup",
    "doc-trees.jsonl",
  );
}

/** Writes every tree in `store` to `filePath` as sorted (by relativePath) JSON Lines. */
export function exportDocTreeBackup(
  store: DocTreeStore,
  filePath: string,
): BackupResult {
  const trees = [...store.getAllTrees()].sort((a, b) =>
    a.relativePath < b.relativePath
      ? -1
      : a.relativePath > b.relativePath
        ? 1
        : 0,
  );
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = trees.map((tree) => JSON.stringify(sortedDocTree(tree)));
  fs.writeFileSync(filePath, lines.length > 0 ? lines.join("\n") + "\n" : "");
  return { count: trees.length };
}

/**
 * Repopulates `store` from a previously exported `filePath`. A no-op
 * (returns `{count: 0}`) if no backup file exists yet -- e.g. a repo
 * with no tree-indexed Markdown, or one that hasn't opted into
 * committing a backup.
 *
 * Fault-tolerant per row, same rationale as `importBackup` above
 * (critical-review finding "validate-backup-import-schema").
 */
export function importDocTreeBackup(
  store: DocTreeStore,
  filePath: string,
): BackupResult {
  if (!fs.existsSync(filePath)) return { count: 0 };
  const content = fs.readFileSync(filePath, "utf8").trim();
  if (content.length === 0) return { count: 0 };
  const records = content
    .split("\n")
    .map((line) => tryParseJson(line))
    .filter((row): row is DocTreeRecord => isValidDocTreeRow(row));
  for (const { relativePath, ...tree } of records) {
    store.upsertTree(relativePath, tree);
  }
  return { count: records.length };
}

function isValidDocTreeRow(row: unknown): row is DocTreeRecord {
  if (row === null || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.relativePath === "string" &&
    (r.description === null || typeof r.description === "string") &&
    typeof r.nodeCount === "number" &&
    Array.isArray(r.nodes)
  );
}

// Stable key order, same rationale as sortedChunk above.
function sortedDocTree(tree: DocTreeRecord): DocTreeRecord {
  const { relativePath, description, nodeCount, nodes } = tree;
  return { relativePath, description, nodeCount, nodes };
}

/**
 * Graph backup: symbols, imports and calls per file, as a sibling JSONL
 * file with the same placement, stable-sort and per-row fault tolerance
 * as the chunk and doc-tree backups. Edges are stored already resolved, so
 * a restored clone can answer `analyze_impact` without re-indexing.
 */

export function resolveGraphBackupFilePath(worktree: string): string {
  return path.join(
    worktree,
    ".opencode",
    "ai-context",
    "backup",
    "graph.jsonl",
  );
}

interface GraphBackupRow extends FileGraph {
  relativePath: string;
}

/** Writes every file's graph in `store` to `filePath` as JSON Lines sorted by path. */
export function exportGraphBackup(
  store: GraphStore,
  filePath: string,
): BackupResult {
  const lines: string[] = [];
  for (const relativePath of store.listFiles()) {
    const graph = store.getFileGraph(relativePath);
    if (!graph) continue;
    const { language, symbols, imports, calls } = graph;
    lines.push(
      JSON.stringify({ relativePath, language, symbols, imports, calls }),
    );
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.length > 0 ? lines.join("\n") + "\n" : "");
  return { count: lines.length };
}

/** Repopulates `store` from `filePath`; no-op when missing. Bad rows are skipped, see `importBackup`. */
export function importGraphBackup(
  store: GraphStore,
  filePath: string,
): BackupResult {
  if (!fs.existsSync(filePath)) return { count: 0 };
  const content = fs.readFileSync(filePath, "utf8").trim();
  if (content.length === 0) return { count: 0 };
  let count = 0;
  for (const line of content.split("\n")) {
    const row = tryParseJson(line);
    if (!isValidGraphRow(row)) continue;
    try {
      const { relativePath, ...graph } = row;
      store.replaceFile(relativePath, graph);
      count++;
    } catch {
      // a row the store rejects is skipped like any other malformed row
    }
  }
  return { count };
}

const isObjectArray = (
  v: unknown,
  check: (o: Record<string, unknown>) => boolean,
): boolean =>
  Array.isArray(v) &&
  v.every(
    (o) =>
      o !== null &&
      typeof o === "object" &&
      check(o as Record<string, unknown>),
  );

function isValidGraphRow(row: unknown): row is GraphBackupRow {
  if (row === null || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.relativePath === "string" &&
    typeof r.language === "string" &&
    isObjectArray(
      r.symbols,
      (s) =>
        typeof s.name === "string" &&
        typeof s.kind === "string" &&
        typeof s.startLine === "number" &&
        typeof s.endLine === "number",
    ) &&
    isObjectArray(
      r.imports,
      (i) => typeof i.specifier === "string" && typeof i.line === "number",
    ) &&
    isObjectArray(
      r.calls,
      (c) => typeof c.calleeName === "string" && typeof c.line === "number",
    )
  );
}
