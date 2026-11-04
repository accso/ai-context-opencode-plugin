import { createRequire } from "node:module";

/**
 * Minimal SQLite surface the stores need, backed by whatever is available:
 * `bun:sqlite` inside OpenCode (which runs on Bun) and `better-sqlite3`
 * under Node (unit tests, tooling).
 *
 * Why not just `better-sqlite3`: it is a native addon that Bun only builds
 * when its install script is trusted, and Bun crashes the whole process
 * (a NAPI panic, not an exception) when asked to load an addon that was
 * never built. `bun:sqlite` ships inside Bun and needs nothing installed.
 */

export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  /** `db.pragma("journal_mode = WAL")`; returns the resulting rows. */
  pragma(statement: string): unknown[];
  transaction<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void;
  close(): void;
}

const nodeRequire = createRequire(import.meta.url);

interface RawStatement {
  run(...p: unknown[]): unknown;
  get(...p: unknown[]): unknown;
  all(...p: unknown[]): unknown[];
}
interface RawDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): RawStatement;
  transaction<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void;
  close(): void;
}

function openRaw(path: string): RawDatabase {
  if (process.versions.bun) {
    const { Database } = nodeRequire("bun:sqlite") as { Database: new (p: string, o: object) => RawDatabase };
    // strict: named parameters bind without their `@`/`$` prefix, like better-sqlite3.
    return new Database(path, { create: true, strict: true });
  }
  const BetterSqlite = nodeRequire("better-sqlite3") as new (p: string) => RawDatabase;
  return new BetterSqlite(path);
}

export function openDatabase(path: string): SqliteDatabase {
  const raw = openRaw(path);
  return {
    exec: (sql) => void raw.exec(sql),
    prepare: (sql) => {
      const stmt = raw.prepare(sql);
      return {
        run: (...p) => stmt.run(...p),
        get: (...p) => stmt.get(...p) ?? undefined, // bun returns null for "no row"
        all: (...p) => stmt.all(...p),
      };
    },
    pragma: (statement) => raw.prepare(`PRAGMA ${statement}`).all(),
    transaction: (fn) => raw.transaction(fn),
    close: () => raw.close(),
  };
}
