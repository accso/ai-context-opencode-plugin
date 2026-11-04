import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGraphStore, type FileGraph } from "../../src/storage/graph-store.js";
import { exportGraphBackup, importGraphBackup, resolveGraphBackupFilePath } from "../../src/storage/backup.js";

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "graph-backup-")), "backup", "graph.jsonl");
}

const graphA: FileGraph = {
  language: "typescript",
  symbols: [{ name: "a", kind: "function", startLine: 1, endLine: 3 }],
  imports: [{ specifier: "./b", resolvedPath: "src/b.ts", importedNames: ["b"], kind: "relative", line: 1 }],
  calls: [{ callerSymbol: "a", calleeName: "b", calleePath: "src/b.ts", line: 2, ambiguous: false }],
};
const graphB: FileGraph = {
  language: "typescript",
  symbols: [{ name: "b", kind: "function", startLine: 1, endLine: 1 }],
  imports: [],
  calls: [],
};

test("resolveGraphBackupFilePath lives next to the other backups", () => {
  assert.equal(resolveGraphBackupFilePath("/w"), path.join("/w", ".opencode", "ai-context", "backup", "graph.jsonl"));
});

test("export then import round-trips every file graph", () => {
  const file = tmpFile();
  const source = createGraphStore({ path: ":memory:" });
  source.replaceFile("src/b.ts", graphB);
  source.replaceFile("src/a.ts", graphA);
  assert.deepEqual(exportGraphBackup(source, file), { count: 2 });

  const target = createGraphStore({ path: ":memory:" });
  assert.deepEqual(importGraphBackup(target, file), { count: 2 });
  assert.deepEqual(target.listFiles(), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(target.getFileGraph("src/a.ts"), source.getFileGraph("src/a.ts"));
});

test("export is deterministic and sorted by path", () => {
  const file = tmpFile();
  const store = createGraphStore({ path: ":memory:" });
  store.replaceFile("src/b.ts", graphB);
  store.replaceFile("src/a.ts", graphA);
  exportGraphBackup(store, file);
  const first = fs.readFileSync(file, "utf8");
  exportGraphBackup(store, file);
  assert.equal(fs.readFileSync(file, "utf8"), first);
  const paths = first.trim().split("\n").map((l) => JSON.parse(l).relativePath);
  assert.deepEqual(paths, ["src/a.ts", "src/b.ts"]);
});

test("import is a no-op for a missing or empty file", () => {
  const store = createGraphStore({ path: ":memory:" });
  assert.deepEqual(importGraphBackup(store, tmpFile()), { count: 0 });
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "\n");
  assert.deepEqual(importGraphBackup(store, file), { count: 0 });
});

test("import skips merge-conflict markers and malformed rows but keeps valid ones", () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const good = JSON.stringify({ relativePath: "src/b.ts", ...graphB });
  const rows = [
    "<<<<<<< HEAD",
    good,
    "=======",
    JSON.stringify({ relativePath: "x.ts", language: "typescript", symbols: "nope", imports: [], calls: [] }),
    JSON.stringify({ relativePath: "y.ts", language: "typescript", symbols: [{ name: 1 }], imports: [], calls: [] }),
    JSON.stringify({ language: "typescript", symbols: [], imports: [], calls: [] }),
    ">>>>>>> branch",
  ];
  fs.writeFileSync(file, rows.join("\n"));
  const store = createGraphStore({ path: ":memory:" });
  assert.deepEqual(importGraphBackup(store, file), { count: 1 });
  assert.deepEqual(store.listFiles(), ["src/b.ts"]);
});
