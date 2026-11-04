import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../src/storage/sqlite.js";

test("exec, prepared statements with positional and named parameters", () => {
  const db = openDatabase(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, note TEXT)");
  db.prepare("INSERT INTO t (name, note) VALUES (?, ?)").run("a", null);
  db.prepare("INSERT INTO t (name, note) VALUES (@name, @note)").run({ name: "b", note: "x" });
  assert.deepEqual(db.prepare("SELECT name, note FROM t ORDER BY id").all(), [
    { name: "a", note: null },
    { name: "b", note: "x" },
  ]);
  assert.deepEqual(db.prepare("SELECT name FROM t WHERE id = ?").get(2), { name: "b" });
  db.close();
});

test("get returns undefined (not null) when there is no row", () => {
  const db = openDatabase(":memory:");
  db.exec("CREATE TABLE t (id INTEGER)");
  assert.equal(db.prepare("SELECT * FROM t WHERE id = ?").get(1), undefined);
});

test("transaction commits on success and rolls back when the function throws", () => {
  const db = openDatabase(":memory:");
  db.exec("CREATE TABLE t (id INTEGER)");
  const insert = db.prepare("INSERT INTO t VALUES (?)");
  db.transaction((ids: number[]) => ids.forEach((i) => insert.run(i)))([1, 2]);
  assert.throws(() =>
    db.transaction(() => {
      insert.run(3);
      throw new Error("boom");
    })(),
  );
  assert.deepEqual(db.prepare("SELECT id FROM t ORDER BY id").all(), [{ id: 1 }, { id: 2 }]);
});

test("pragma reads and sets", () => {
  const db = openDatabase(":memory:");
  db.exec("CREATE TABLE t (id INTEGER, name TEXT)");
  assert.deepEqual((db.pragma("table_info(t)") as { name: string }[]).map((c) => c.name), ["id", "name"]);
  db.pragma("journal_mode = WAL");
});
