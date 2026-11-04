import { test } from "node:test";
import assert from "node:assert/strict";
import { createGraphStore } from "../../src/storage/graph-store.js";
import { findTestFiles, isTestPath } from "../../src/tools/test-files.js";

test("isTestPath recognises common test file and directory conventions", () => {
  for (const p of [
    "src/a.test.ts", "src/a.spec.js", "test/unit/a.ts", "tests/a.py", "pkg/a_test.go",
    "src/test_a.py", "src/__tests__/a.ts", "src/test/java/ATest.java", "src/FooTests.cs", "src/FooTest.kt",
  ]) assert.ok(isTestPath(p), p);
  for (const p of ["src/a.ts", "src/latest.ts", "docs/contest.md"]) assert.ok(!isTestPath(p), p);
});

test("findTestFiles returns test files that import the defining file or call the symbol", () => {
  const store = createGraphStore({ path: ":memory:" });
  const empty = { language: "typescript", symbols: [], imports: [], calls: [] };
  store.replaceFile("src/a.ts", { ...empty, symbols: [{ name: "foo", kind: "function", startLine: 1, endLine: 2 }] });
  store.replaceFile("test/importer.test.ts", { ...empty, imports: [{ specifier: "../src/a", resolvedPath: "src/a.ts", line: 1 }] });
  store.replaceFile("test/caller.test.ts", { ...empty, calls: [{ calleeName: "foo", line: 3 }] });
  store.replaceFile("src/b.ts", { ...empty, calls: [{ calleeName: "foo", line: 3 }] });
  assert.deepEqual(findTestFiles(store, ["src/a.ts"], ["foo"]), ["test/caller.test.ts", "test/importer.test.ts"]);
  assert.deepEqual(findTestFiles(store, ["src/a.ts"], ["foo"], 1), ["test/caller.test.ts"]);
});
