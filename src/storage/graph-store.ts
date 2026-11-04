import { openDatabase } from "./sqlite.js";
import fs from "node:fs";
import path from "node:path";

/**
 * Symbol / import / call graph store backing `analyze_impact`. Lives in the
 * same per-project SQLite file as the chunk store (own connection, like
 * doc-tree-store.ts). Every row is keyed by the file it was extracted from,
 * so re-indexing or deleting a file is a single atomic per-file replace.
 *
 * Edges are name-based, not fully resolved: a call edge keeps the callee's
 * name and, when the extractor could pin it down, its file. Unresolved or
 * multi-candidate calls are flagged `ambiguous` so callers of the tool can
 * confirm them (read the call site; later: the LSP bridge, docs/lsp-roadmap.md) instead of
 * trusting a guess.
 */

export interface GraphSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  container?: string;
}

export interface GraphImport {
  /** The import specifier as written (`./b`, `react`, `java.util.List`). */
  specifier: string;
  /** Repo-relative file the specifier resolves to; absent for external/unresolved imports. */
  resolvedPath?: string;
  importedNames?: string[];
  /** Resolver hint kept so imports can be re-resolved later (`mod`, `local`, `system`, `relative`). */
  kind?: string;
  line: number;
}

export interface GraphCall {
  /** Enclosing symbol; absent for top-level (module-scope) calls. */
  callerSymbol?: string;
  calleeName: string;
  calleePath?: string;
  /** Receiver / scope as written (`obj` in `obj.run()`, `Foo` in `Foo::new()`), kept for re-resolution. */
  qualifier?: string;
  /** `new` for constructor calls; absent otherwise. */
  kind?: string;
  line: number;
  ambiguous?: boolean;
  candidateCount?: number;
}

export interface FileGraph {
  language: string;
  symbols: GraphSymbol[];
  imports: GraphImport[];
  calls: GraphCall[];
}

export interface StoredSymbol extends GraphSymbol {
  relativePath: string;
  language: string;
}

export type CallDirection = "callers" | "callees" | "both";

export interface TraversedCall {
  relativePath: string;
  callerSymbol?: string;
  calleeName: string;
  calleePath?: string;
  line: number;
  /** Edge flavor: `new`, `jsx`, `inject`, `decorator`, `template`; absent for plain calls. */
  kind?: string;
  ambiguous: boolean;
  candidateCount?: number;
  /** Hops from the requested symbol (1 = direct). */
  depth: number;
  direction: "callers" | "callees";
}

export interface CallTraversal {
  edges: TraversedCall[];
  hasAmbiguousEdges: boolean;
}

export interface TraverseCallsOptions {
  symbol: string;
  /** Narrows the root symbol to one file; unresolved edges are kept (and stay ambiguous). */
  path?: string;
  direction: CallDirection;
  depth: number;
}

export interface ImportDependent {
  relativePath: string;
  depth: number;
}

export interface GraphStoreOptions {
  /** SQLite file path, or ":memory:" for an ephemeral store (tests). */
  path: string;
}

export interface GraphStore {
  replaceFile(relativePath: string, graph: FileGraph): void;
  deleteFile(relativePath: string): void;
  getFileGraph(relativePath: string): FileGraph | null;
  /** Every indexed file path, sorted. */
  listFiles(): string[];
  /** Files with a call to any of `names` (by callee name or raw qualifier), sorted. */
  findCallerFiles(names: string[]): string[];
  findSymbols(name: string): StoredSymbol[];
  /** Case-insensitive substring lookup, exact then prefix matches first. */
  searchSymbols(query: string, limit: number): StoredSymbol[];
  traverseCalls(options: TraverseCallsOptions): CallTraversal;
  /** Files that (transitively, up to `depth`) import `relativePath`, excluding itself. */
  importDependents(relativePath: string, depth: number): ImportDependent[];
  close(): void;
}

function toStoredSymbol(r: Record<string, unknown>): StoredSymbol {
  return {
    relativePath: r.relative_path as string,
    name: r.name as string,
    kind: r.kind as string,
    language: r.language as string,
    startLine: r.start_line as number,
    endLine: r.end_line as number,
    container: (r.container as string | null) ?? undefined,
  };
}

interface CallRow {
  id: number;
  relative_path: string;
  caller_symbol: string | null;
  callee_name: string;
  callee_path: string | null;
  qualifier: string | null;
  call_kind: string | null;
  line: number;
  ambiguous: number;
  candidate_count: number | null;
}

export function createGraphStore(options: GraphStoreOptions): GraphStore {
  if (options.path !== ":memory:") {
    fs.mkdirSync(path.dirname(options.path), { recursive: true });
  }
  const db = openDatabase(options.path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_files (
      relative_path TEXT PRIMARY KEY,
      language TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      relative_path TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      language TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      container TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbols_path ON symbols(relative_path);
    CREATE TABLE IF NOT EXISTS import_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      relative_path TEXT NOT NULL,
      specifier TEXT NOT NULL,
      resolved_path TEXT,
      imported_names TEXT,
      kind TEXT,
      line INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_import_edges_path ON import_edges(relative_path);
    CREATE INDEX IF NOT EXISTS idx_import_edges_resolved ON import_edges(resolved_path);
    CREATE TABLE IF NOT EXISTS call_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      relative_path TEXT NOT NULL,
      caller_symbol TEXT,
      callee_name TEXT NOT NULL,
      callee_path TEXT,
      qualifier TEXT,
      call_kind TEXT,
      line INTEGER NOT NULL,
      ambiguous INTEGER NOT NULL DEFAULT 0,
      candidate_count INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_call_edges_path ON call_edges(relative_path);
    CREATE INDEX IF NOT EXISTS idx_call_edges_callee ON call_edges(callee_name);
    CREATE INDEX IF NOT EXISTS idx_call_edges_caller ON call_edges(caller_symbol);
  `);

  const deleteStmts = ["graph_files", "symbols", "import_edges", "call_edges"].map((table) =>
    db.prepare(`DELETE FROM ${table} WHERE relative_path = ?`),
  );
  const insertFile = db.prepare(`INSERT INTO graph_files (relative_path, language) VALUES (?, ?)`);
  const insertSymbol = db.prepare(`
    INSERT INTO symbols (relative_path, name, kind, language, start_line, end_line, container)
    VALUES (@relativePath, @name, @kind, @language, @startLine, @endLine, @container)
  `);
  const insertImport = db.prepare(`
    INSERT INTO import_edges (relative_path, specifier, resolved_path, imported_names, kind, line)
    VALUES (@relativePath, @specifier, @resolvedPath, @importedNames, @kind, @line)
  `);
  const insertCall = db.prepare(`
    INSERT INTO call_edges (relative_path, caller_symbol, callee_name, callee_path, qualifier, call_kind, line, ambiguous, candidate_count)
    VALUES (@relativePath, @callerSymbol, @calleeName, @calleePath, @qualifier, @callKind, @line, @ambiguous, @candidateCount)
  `);

  const listFilesStmt = db.prepare(`SELECT relative_path FROM graph_files ORDER BY relative_path`);
  const fileLanguageStmt = db.prepare(`SELECT language FROM graph_files WHERE relative_path = ?`);
  const symbolsForFileStmt = db.prepare(`SELECT * FROM symbols WHERE relative_path = ? ORDER BY start_line, id`);
  const importsForFileStmt = db.prepare(`SELECT * FROM import_edges WHERE relative_path = ? ORDER BY id`);
  const callsForFileStmt = db.prepare(`SELECT * FROM call_edges WHERE relative_path = ? ORDER BY id`);
  const symbolsSearchStmt = db.prepare(`
    SELECT * FROM symbols
    WHERE lower(name) LIKE ? ESCAPE '\\'
    ORDER BY (lower(name) = ?) DESC, (lower(name) LIKE ? ESCAPE '\\') DESC, length(name), relative_path, start_line
    LIMIT ?`);
  const symbolsByNameStmt = db.prepare(`SELECT * FROM symbols WHERE name = ? ORDER BY relative_path, start_line`);
  const callersOfStmt = db.prepare(`SELECT * FROM call_edges WHERE callee_name = ? ORDER BY id`);
  const calleesOfStmt = db.prepare(`SELECT * FROM call_edges WHERE caller_symbol = ? ORDER BY id`);
  const importersOfStmt = db.prepare(
    `SELECT DISTINCT relative_path FROM import_edges WHERE resolved_path = ? ORDER BY relative_path`,
  );

  function toTraversed(row: CallRow, depth: number, direction: "callers" | "callees"): TraversedCall {
    return {
      relativePath: row.relative_path,
      callerSymbol: row.caller_symbol ?? undefined,
      calleeName: row.callee_name,
      calleePath: row.callee_path ?? undefined,
      line: row.line,
      kind: row.call_kind ?? undefined,
      ambiguous: row.ambiguous === 1,
      candidateCount: row.candidate_count ?? undefined,
      depth,
      direction,
    };
  }

  interface Frontier {
    name: string;
    /** File the symbol lives in, when known; keeps same-named symbols in other files out of the walk. */
    path?: string;
  }

  function walk(options: TraverseCallsOptions, direction: "callers" | "callees"): TraversedCall[] {
    const out: TraversedCall[] = [];
    const seenEdges = new Set<number>();
    const expanded = new Set<string>();
    let frontier: Frontier[] = [{ name: options.symbol, path: options.path }];
    for (let depth = 1; depth <= options.depth && frontier.length > 0; depth++) {
      const next: Frontier[] = [];
      for (const node of frontier) {
        const key = `${node.path ?? ""}\u0000${node.name}`;
        if (expanded.has(key)) continue;
        expanded.add(key);
        const rows = (direction === "callers" ? callersOfStmt : calleesOfStmt).all(node.name) as CallRow[];
        for (const row of rows) {
          if (node.path) {
            if (direction === "callers" && row.callee_path !== null && row.callee_path !== node.path) continue;
            if (direction === "callees" && row.relative_path !== node.path) continue;
          }
          if (seenEdges.has(row.id)) continue;
          seenEdges.add(row.id);
          out.push(toTraversed(row, depth, direction));
          if (direction === "callers") {
            if (row.caller_symbol) next.push({ name: row.caller_symbol, path: row.relative_path });
          } else {
            next.push({ name: row.callee_name, path: row.callee_path ?? undefined });
          }
        }
      }
      frontier = next;
    }
    return out;
  }

  return {
    replaceFile(relativePath, graph) {
      db.transaction(() => {
        for (const stmt of deleteStmts) stmt.run(relativePath);
        insertFile.run(relativePath, graph.language);
        for (const s of graph.symbols) {
          insertSymbol.run({
            relativePath,
            name: s.name,
            kind: s.kind,
            language: graph.language,
            startLine: s.startLine,
            endLine: s.endLine,
            container: s.container ?? null,
          });
        }
        for (const i of graph.imports) {
          insertImport.run({
            relativePath,
            specifier: i.specifier,
            resolvedPath: i.resolvedPath ?? null,
            importedNames: i.importedNames ? JSON.stringify(i.importedNames) : null,
            kind: i.kind ?? null,
            line: i.line,
          });
        }
        for (const c of graph.calls) {
          insertCall.run({
            relativePath,
            callerSymbol: c.callerSymbol ?? null,
            calleeName: c.calleeName,
            calleePath: c.calleePath ?? null,
            qualifier: c.qualifier ?? null,
            callKind: c.kind ?? null,
            line: c.line,
            ambiguous: c.ambiguous ? 1 : 0,
            candidateCount: c.candidateCount ?? null,
          });
        }
      })();
    },

    deleteFile(relativePath) {
      db.transaction(() => {
        for (const stmt of deleteStmts) stmt.run(relativePath);
      })();
    },

    getFileGraph(relativePath) {
      const file = fileLanguageStmt.get(relativePath) as { language: string } | undefined;
      if (!file) return null;
      const symbols = (symbolsForFileStmt.all(relativePath) as Record<string, unknown>[]).map((r) => ({
        name: r.name as string,
        kind: r.kind as string,
        startLine: r.start_line as number,
        endLine: r.end_line as number,
        container: (r.container as string | null) ?? undefined,
      }));
      const imports = (importsForFileStmt.all(relativePath) as Record<string, unknown>[]).map((r) => ({
        specifier: r.specifier as string,
        resolvedPath: (r.resolved_path as string | null) ?? undefined,
        importedNames: r.imported_names ? (JSON.parse(r.imported_names as string) as string[]) : undefined,
        kind: (r.kind as string | null) ?? undefined,
        line: r.line as number,
      }));
      const calls = (callsForFileStmt.all(relativePath) as CallRow[]).map((r) => ({
        callerSymbol: r.caller_symbol ?? undefined,
        calleeName: r.callee_name,
        calleePath: r.callee_path ?? undefined,
        qualifier: r.qualifier ?? undefined,
        kind: r.call_kind ?? undefined,
        line: r.line,
        ambiguous: r.ambiguous === 1,
        candidateCount: r.candidate_count ?? undefined,
      }));
      return { language: file.language, symbols, imports, calls };
    },

    listFiles() {
      return (listFilesStmt.all() as { relative_path: string }[]).map((r) => r.relative_path);
    },

    findCallerFiles(names) {
      const found = new Set<string>();
      const CHUNK = 500; // stays well under SQLite's bound-parameter limit
      for (let i = 0; i < names.length; i += CHUNK) {
        const slice = names.slice(i, i + CHUNK);
        const rows = db
          .prepare(
            `SELECT DISTINCT relative_path FROM call_edges WHERE callee_name IN (${slice.map(() => "?").join(",")}) OR qualifier IN (${slice.map(() => "?").join(",")})`,
          )
          .all(...slice, ...slice) as { relative_path: string }[];
        for (const r of rows) found.add(r.relative_path);
      }
      return [...found].sort();
    },

    findSymbols(name) {
      return (symbolsByNameStmt.all(name) as Record<string, unknown>[]).map(toStoredSymbol);
    },

    searchSymbols(query, limit) {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
      return (
        symbolsSearchStmt.all(`%${escaped}%`, q, `${escaped}%`, limit) as Record<string, unknown>[]
      ).map(toStoredSymbol);
    },

    traverseCalls(options) {
      const edges: TraversedCall[] = [];
      if (options.direction !== "callees") edges.push(...walk(options, "callers"));
      if (options.direction !== "callers") edges.push(...walk(options, "callees"));
      return { edges, hasAmbiguousEdges: edges.some((e) => e.ambiguous) };
    },

    importDependents(relativePath, depth) {
      const out: ImportDependent[] = [];
      const seen = new Set<string>([relativePath]);
      let frontier = [relativePath];
      for (let d = 1; d <= depth && frontier.length > 0; d++) {
        const next: string[] = [];
        for (const target of frontier) {
          for (const row of importersOfStmt.all(target) as { relative_path: string }[]) {
            if (seen.has(row.relative_path)) continue;
            seen.add(row.relative_path);
            out.push({ relativePath: row.relative_path, depth: d });
            next.push(row.relative_path);
          }
        }
        frontier = next;
      }
      return out;
    },

    close() {
      db.close();
    },
  };
}
