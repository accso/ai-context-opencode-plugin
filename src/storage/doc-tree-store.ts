import { openDatabase } from "./sqlite.js";
import fs from "node:fs";
import path from "node:path";
import type { DocTree } from "../indexing/doc-tree-builder.js";

/**
 * Doc-tree store (plan.md, "port-doc-tree-markdown") -- a sibling to
 * vector-store.ts: one row per Markdown file (not one row per chunk),
 * storing the whole nested tree as JSON. Mirrors mcp-server/src/
 * doc_tree.ts's `doc_trees` Postgres table (file_path, tree_json,
 * node_count), but file-backed SQLite like the rest of this plugin's
 * storage -- no Docker/Postgres dependency.
 */

export interface DocTreeRecord extends DocTree {
  relativePath: string;
}

export interface DocTreeStoreOptions {
  /** SQLite file path, or ":memory:" for an ephemeral in-process store (tests). */
  path: string;
}

export interface DocTreeStore {
  upsertTree(relativePath: string, tree: DocTree): void;
  getTree(relativePath: string): DocTree | null;
  deleteTree(relativePath: string): void;
  /** Paths of all stored trees, without loading them. */
  listPaths(): string[];
  getAllTrees(): DocTreeRecord[];
  /** Number of stored trees, without loading them. */
  countTrees(): number;
  close(): void;
}

export function createDocTreeStore(options: DocTreeStoreOptions): DocTreeStore {
  if (options.path !== ":memory:") {
    fs.mkdirSync(path.dirname(options.path), { recursive: true });
  }
  const db = openDatabase(options.path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS doc_trees (
      relative_path TEXT PRIMARY KEY,
      description TEXT,
      node_count INTEGER NOT NULL,
      nodes_json TEXT NOT NULL
    );
  `);

  const upsertStmt = db.prepare(`
    INSERT INTO doc_trees (relative_path, description, node_count, nodes_json)
    VALUES (@relativePath, @description, @nodeCount, @nodesJson)
    ON CONFLICT(relative_path) DO UPDATE SET
      description = excluded.description,
      node_count = excluded.node_count,
      nodes_json = excluded.nodes_json
  `);
  const getStmt = db.prepare(`SELECT * FROM doc_trees WHERE relative_path = ?`);
  const deleteStmt = db.prepare(
    `DELETE FROM doc_trees WHERE relative_path = ?`,
  );
  const allStmt = db.prepare(`SELECT * FROM doc_trees`);
  const pathsStmt = db.prepare(`SELECT relative_path FROM doc_trees ORDER BY relative_path`);
  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM doc_trees`);

  type Row = {
    relative_path: string;
    description: string | null;
    node_count: number;
    nodes_json: string;
  };
  const toDocTree = (row: Row): DocTree => ({
    description: row.description,
    nodeCount: row.node_count,
    nodes: JSON.parse(row.nodes_json),
  });

  return {
    upsertTree(relativePath, tree) {
      upsertStmt.run({
        relativePath,
        description: tree.description,
        nodeCount: tree.nodeCount,
        nodesJson: JSON.stringify(tree.nodes),
      });
    },

    getTree(relativePath) {
      const row = getStmt.get(relativePath) as Row | undefined;
      return row ? toDocTree(row) : null;
    },

    deleteTree(relativePath) {
      deleteStmt.run(relativePath);
    },

    countTrees() {
      return (countStmt.get() as { n: number }).n;
    },

    listPaths() {
      return (pathsStmt.all() as { relative_path: string }[]).map((r) => r.relative_path);
    },

    getAllTrees() {
      const rows = allStmt.all() as Row[];
      return rows.map((row) => ({
        relativePath: row.relative_path,
        ...toDocTree(row),
      }));
    },

    close() {
      db.close();
    },
  };
}
