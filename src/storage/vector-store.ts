import { openDatabase } from "./sqlite.js";
import { extractTerms } from "../search/keyword-rerank.js";
import fs from "node:fs";
import path from "node:path";

/**
 * Embedded vector store spike (plan.md, "storage-spike"). Backed by
 * `better-sqlite3` -- an in-process, file-backed SQLite database with no
 * server process and no Docker dependency, standing in for the
 * Postgres+Qdrant pairing `watcher/db.py` uses today, for the
 * default/common-size-repo path (the full Docker stack remains available
 * as an opt-in "heavy mode" for very large repos, per plan.md).
 *
 * v1 design: cosine similarity is computed in JS over ALL stored vectors
 * on every `search()` call (brute force, no ANN index). This is
 * deliberately the simplest thing that could work -- fine for
 * common-size repos (thousands, not millions, of chunks) and avoids
 * pulling in a native ANN extension (e.g. sqlite-vec) before the spike
 * has real numbers justifying the added complexity. Revisit if
 * benchmarking shows brute force doesn't scale for the intended repo
 * sizes.
 *
 * Mirrors `watcher/db.py`'s chunk shape and operations:
 *   - `stable_chunk_id` -> caller-supplied `id` (kept as a separate
 *     concern here; chunking/id-derivation stays in the indexing
 *     pipeline, not the store)
 *   - `upsert_chunks_delta`/`upsert_chunks` -> `upsertChunks` (id is the
 *     primary key, so re-upserting an id replaces it -- covers both the
 *     "new chunk" and "re-embed changed chunk" cases)
 *   - `get_chunk_ids_for_file` -> `getChunkIdsForFile`
 *   - `delete_file_chunks` -> `deleteChunksForFile`
 *   - `search_chunks` -> `search`
 */

export interface VectorStoreChunk {
  id: string;
  relativePath: string;
  language: string;
  text: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  chunkType: string;
  vector: number[];
}

export interface VectorSearchResult extends Omit<VectorStoreChunk, "vector"> {
  score: number;
}

export interface VectorStoreOptions {
  /** SQLite file path, or ":memory:" for an ephemeral in-process store (tests). */
  path: string;
  /** Rows loaded per page by `search()`; bounds peak memory (JSON vectors are parsed page by page). Default 500. */
  searchPageSize?: number;
  /**
   * Clock used to stamp `indexed_at` on every upsert (port-index-status-
   * tools, plan.md -- mirrors `file_index.last_indexed_at` in the
   * original Postgres schema). Injectable so tests don't depend on
   * wall-clock time; defaults to the real clock.
   */
  now?: () => string;
  /**
   * Version of the text format the stored vectors were embedded from (see
   * indexing/embed-input.ts). A store written with another version is
   * emptied on open so everything is re-embedded; omit to skip the check.
   */
  embedFormat?: number;
}

export interface IndexStatus {
  fileCount: number;
  chunkCount: number;
  newestIndexedAt: string | null;
}

export interface RecentChange {
  relativePath: string;
  indexedAt: string;
  chunkCount: number;
}

export interface IndexedFile {
  relativePath: string;
  language: string;
  chunkCount: number;
}

export interface VectorStore {
  /** One row per indexed file (no vectors loaded), sorted by path. */
  listFiles(): IndexedFile[];
  upsertChunks(chunks: VectorStoreChunk[]): void;
  deleteChunksForFile(relativePath: string): void;
  /** "size:mtime" recorded once a file was fully indexed; null if unknown. Dropped with the file's chunks. */
  getFileFingerprint(relativePath: string): string | null;
  setFileFingerprint(relativePath: string, fingerprint: string): void;
  getChunkIdsForFile(relativePath: string): Set<string>;
  getChunk(id: string): VectorStoreChunk | null;
  getAllChunks(): VectorStoreChunk[];
  /** Chunks with id > `afterId` (null = from the start), ordered by id; for streaming exports. */
  getChunksPage(afterId: string | null, limit: number): VectorStoreChunk[];
  search(queryVector: number[], topK: number): VectorSearchResult[];
  /** BM25 full-text search over text, symbol and path words (SQLite FTS5); [] if FTS5 is unavailable. */
  searchText(query: string, topK: number): VectorSearchResult[];
  /** file/chunk counts + newest indexed_at, across the whole store. */
  getIndexStatus(): IndexStatus;
  /** Most-recently-indexed files (one row per file), newest first. */
  getRecentChanges(limit: number): RecentChange[];
  close(): void;
}

interface ChunkRow {
  id: string;
  relative_path: string;
  language: string;
  text: string;
  start_line: number;
  end_line: number;
  symbol: string | null;
  chunk_type: string;
  vector: string;
}

function toChunk(row: ChunkRow): VectorStoreChunk {
  return {
    id: row.id,
    relativePath: row.relative_path,
    language: row.language,
    text: row.text,
    startLine: row.start_line,
    endLine: row.end_line,
    symbol: row.symbol ?? undefined,
    chunkType: row.chunk_type,
    vector: JSON.parse(row.vector),
  };
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Words hidden inside identifiers (camelCase), appended so FTS can match `http` in `retryHttpRequest`. */
function identifierWords(text: string): string {
  const words = new Set<string>();
  for (const token of text.match(/[A-Za-z][A-Za-z0-9]{2,}/g) ?? []) {
    const parts = token.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
    if (parts.length > 1) for (const p of parts) words.add(p.toLowerCase());
  }
  return [...words].join(" ");
}

function ftsQuery(query: string): string | null {
  const terms = extractTerms(query);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

export function createVectorStore(options: VectorStoreOptions): VectorStore {
  if (options.path !== ":memory:") {
    // better-sqlite3 doesn't create missing parent directories itself --
    // required for the real per-project path under the plugin's data dir
    // (see project-key.ts), which won't exist on first run.
    fs.mkdirSync(path.dirname(options.path), { recursive: true });
  }
  const db = openDatabase(options.path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL,
      language TEXT NOT NULL,
      text TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      symbol TEXT,
      chunk_type TEXT NOT NULL,
      vector TEXT NOT NULL,
      indexed_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_relative_path ON chunks(relative_path);
  `);
  // Migration for stores created before indexed_at existed (port-index-
  // status-tools): add the column if an older on-disk file is opened.
  const hasIndexedAt = (
    db.pragma("table_info(chunks)") as { name: string }[]
  ).some((col) => col.name === "indexed_at");
  if (!hasIndexedAt) {
    db.exec(
      `ALTER TABLE chunks ADD COLUMN indexed_at TEXT NOT NULL DEFAULT ''`,
    );
  }

  db.exec(
    `CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS file_state (relative_path TEXT PRIMARY KEY, fingerprint TEXT NOT NULL)`,
  );
  if (options.embedFormat !== undefined) {
    const stored = db
      .prepare(`SELECT value FROM store_meta WHERE key = 'embed_format'`)
      .get() as { value: string } | undefined;
    if (stored?.value !== String(options.embedFormat)) {
      // Vectors from another text format are not comparable with new ones.
      db.exec(`DELETE FROM chunks`);
      db.exec(`DELETE FROM file_state`);
      db.prepare(
        `INSERT INTO store_meta (key, value) VALUES ('embed_format', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(String(options.embedFormat));
    }
  }

  // FTS5 index keyed by the chunk's rowid (fast deletes). Missing FTS5 only
  // disables keyword search; vector search keeps working.
  let ftsAvailable = true;
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        path, symbol, body, tokenize = 'unicode61 remove_diacritics 2'
      )
    `);
  } catch {
    ftsAvailable = false;
  }
  const ftsDeleteForFile = ftsAvailable
    ? db.prepare(
        `DELETE FROM chunks_fts WHERE rowid IN (SELECT rowid FROM chunks WHERE relative_path = ?)`,
      )
    : null;
  const ftsDeleteRow = ftsAvailable
    ? db.prepare(`DELETE FROM chunks_fts WHERE rowid = ?`)
    : null;
  const ftsInsert = ftsAvailable
    ? db.prepare(
        `INSERT INTO chunks_fts (rowid, path, symbol, body) VALUES (?, ?, ?, ?)`,
      )
    : null;
  const rowidOfStmt = db.prepare(`SELECT rowid AS rid FROM chunks WHERE id = ?`);
  function ftsIndexRow(
    rowid: number,
    relativePath: string,
    symbol: string | null | undefined,
    text: string,
  ) {
    ftsDeleteRow!.run(rowid);
    ftsInsert!.run(
      rowid,
      relativePath,
      symbol ?? "",
      `${text}\n${identifierWords(`${symbol ?? ""} ${text}`)}`,
    );
  }
  if (ftsAvailable) {
    const chunkCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get() as { n: number }
    ).n;
    const ftsCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM chunks_fts`).get() as { n: number }
    ).n;
    if (chunkCount > 0 && ftsCount !== chunkCount) {
      const backfill = db.transaction(() => {
        db.exec(`DELETE FROM chunks_fts`);
        let last = 0;
        const page = db.prepare(
          `SELECT rowid AS rid, relative_path, symbol, text FROM chunks WHERE rowid > ? ORDER BY rowid LIMIT 500`,
        );
        for (;;) {
          const rows = page.all(last) as {
            rid: number;
            relative_path: string;
            symbol: string | null;
            text: string;
          }[];
          if (rows.length === 0) break;
          for (const r of rows) ftsIndexRow(r.rid, r.relative_path, r.symbol, r.text);
          last = rows[rows.length - 1]!.rid;
        }
      });
      backfill();
    }
  }

  const now = options.now ?? (() => new Date().toISOString());

  const upsertStmt = db.prepare(`
    INSERT INTO chunks (id, relative_path, language, text, start_line, end_line, symbol, chunk_type, vector, indexed_at)
    VALUES (@id, @relativePath, @language, @text, @startLine, @endLine, @symbol, @chunkType, @vector, @indexedAt)
    ON CONFLICT(id) DO UPDATE SET
      relative_path = excluded.relative_path,
      language = excluded.language,
      text = excluded.text,
      start_line = excluded.start_line,
      end_line = excluded.end_line,
      symbol = excluded.symbol,
      chunk_type = excluded.chunk_type,
      vector = excluded.vector,
      indexed_at = excluded.indexed_at
  `);

  const deleteStateStmt = db.prepare(`DELETE FROM file_state WHERE relative_path = ?`);
  const getStateStmt = db.prepare(`SELECT fingerprint FROM file_state WHERE relative_path = ?`);
  const setStateStmt = db.prepare(
    `INSERT INTO file_state (relative_path, fingerprint) VALUES (?, ?)
     ON CONFLICT(relative_path) DO UPDATE SET fingerprint = excluded.fingerprint`,
  );
  const deleteForFileStmt = db.prepare(
    `DELETE FROM chunks WHERE relative_path = ?`,
  );
  const idsForFileStmt = db.prepare(
    `SELECT id FROM chunks WHERE relative_path = ?`,
  );
  const allStmt = db.prepare(`SELECT * FROM chunks`);
  const byIdStmt = db.prepare(`SELECT * FROM chunks WHERE id = ?`);
  const idPageStmt = db.prepare(
    `SELECT * FROM chunks WHERE id > ? ORDER BY id LIMIT ?`,
  );
  const pageStmt = db.prepare(
    `SELECT rowid AS rid, * FROM chunks WHERE rowid > ? ORDER BY rowid LIMIT ?`,
  );
  const searchPageSize = Math.max(1, options.searchPageSize ?? 500);
  const indexStatusStmt = db.prepare(`
    SELECT
      COUNT(DISTINCT relative_path) AS file_count,
      COUNT(*) AS chunk_count,
      MAX(indexed_at) AS newest_indexed_at
    FROM chunks
  `);
  const recentChangesStmt = db.prepare(`
    SELECT relative_path, MAX(indexed_at) AS indexed_at, COUNT(*) AS chunk_count
    FROM chunks
    GROUP BY relative_path
    ORDER BY indexed_at DESC
    LIMIT ?
  `);

  const listFilesStmt = db.prepare(`
    SELECT relative_path, MIN(language) AS language, COUNT(*) AS chunk_count
    FROM chunks
    GROUP BY relative_path
    ORDER BY relative_path
  `);

  return {
    listFiles() {
      return (
        listFilesStmt.all() as {
          relative_path: string;
          language: string;
          chunk_count: number;
        }[]
      ).map((row) => ({
        relativePath: row.relative_path,
        language: row.language,
        chunkCount: row.chunk_count,
      }));
    },

    upsertChunks(chunks) {
      const insertMany = db.transaction((rows: VectorStoreChunk[]) => {
        for (const row of rows) {
          upsertStmt.run({
            id: row.id,
            relativePath: row.relativePath,
            language: row.language,
            text: row.text,
            startLine: row.startLine,
            endLine: row.endLine,
            symbol: row.symbol ?? null,
            chunkType: row.chunkType,
            vector: JSON.stringify(row.vector),
            indexedAt: now(),
          });
          if (ftsAvailable) {
            const { rid } = rowidOfStmt.get(row.id) as { rid: number };
            ftsIndexRow(rid, row.relativePath, row.symbol, row.text);
          }
        }
      });
      insertMany(chunks);
    },

    deleteChunksForFile(relativePath) {
      ftsDeleteForFile?.run(relativePath);
      deleteForFileStmt.run(relativePath);
      deleteStateStmt.run(relativePath);
    },

    getFileFingerprint(relativePath) {
      const row = getStateStmt.get(relativePath) as { fingerprint: string } | undefined;
      return row?.fingerprint ?? null;
    },

    setFileFingerprint(relativePath, fingerprint) {
      setStateStmt.run(relativePath, fingerprint);
    },

    getChunkIdsForFile(relativePath) {
      const rows = idsForFileStmt.all(relativePath) as { id: string }[];
      return new Set(rows.map((r) => r.id));
    },

    getChunk(id) {
      const row = byIdStmt.get(id) as ChunkRow | undefined;
      return row ? toChunk(row) : null;
    },

    getChunksPage(afterId, limit) {
      return (idPageStmt.all(afterId ?? "", limit) as ChunkRow[]).map(toChunk);
    },

    getAllChunks() {
      return (allStmt.all() as ChunkRow[]).map(toChunk);
    },

    search(queryVector, topK) {
      // Page by rowid and keep only the current top-K: a full `SELECT *` plus
      // JSON.parse of every vector was a large per-query memory spike.
      let best: VectorSearchResult[] = [];
      let lastRowId = 0;
      for (;;) {
        const rows = pageStmt.all(lastRowId, searchPageSize) as {
          rid: number;
          id: string;
          relative_path: string;
          language: string;
          text: string;
          start_line: number;
          end_line: number;
          symbol: string | null;
          chunk_type: string;
          vector: string;
        }[];
        if (rows.length === 0) break;
        lastRowId = rows[rows.length - 1]!.rid;
        const scored = rows.map((row) => ({
          id: row.id,
          relativePath: row.relative_path,
          language: row.language,
          text: row.text,
          startLine: row.start_line,
          endLine: row.end_line,
          symbol: row.symbol ?? undefined,
          chunkType: row.chunk_type,
          score: cosineSimilarity(queryVector, JSON.parse(row.vector)),
        }));
        best = [...best, ...scored]
          .sort((a, b) => b.score - a.score)
          .slice(0, topK);
        if (rows.length < searchPageSize) break;
      }
      return best;
    },

    searchText(query, topK) {
      const match = ftsAvailable ? ftsQuery(query) : null;
      if (!match) return [];
      const rows = db
        .prepare(
          `SELECT c.id, c.relative_path, c.language, c.text, c.start_line, c.end_line,
                  c.symbol, c.chunk_type, bm25(chunks_fts, 1.0, 3.0, 1.0) AS rank
           FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid
           WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(match, topK) as {
        id: string;
        relative_path: string;
        language: string;
        text: string;
        start_line: number;
        end_line: number;
        symbol: string | null;
        chunk_type: string;
        rank: number;
      }[];
      return rows.map((row) => ({
        id: row.id,
        relativePath: row.relative_path,
        language: row.language,
        text: row.text,
        startLine: row.start_line,
        endLine: row.end_line,
        symbol: row.symbol ?? undefined,
        chunkType: row.chunk_type,
        score: -row.rank,
      }));
    },

    getIndexStatus() {
      const row = indexStatusStmt.get() as {
        file_count: number;
        chunk_count: number;
        newest_indexed_at: string | null;
      };
      return {
        fileCount: row.file_count,
        chunkCount: row.chunk_count,
        newestIndexedAt: row.newest_indexed_at,
      };
    },

    getRecentChanges(limit) {
      const rows = recentChangesStmt.all(limit) as {
        relative_path: string;
        indexed_at: string;
        chunk_count: number;
      }[];
      return rows.map((row) => ({
        relativePath: row.relative_path,
        indexedAt: row.indexed_at,
        chunkCount: row.chunk_count,
      }));
    },

    close() {
      db.close();
    },
  };
}
