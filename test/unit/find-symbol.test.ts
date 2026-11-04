import { test } from "node:test";
import assert from "node:assert/strict";
import { createGraphStore } from "../../src/storage/graph-store.js";
import { createFindSymbolTool } from "../../src/tools/find-symbol.js";

function seeded() {
  const store = createGraphStore({ path: ":memory:" });
  store.replaceFile("test/a.test.ts", {
    language: "typescript",
    symbols: [],
    imports: [{ specifier: "../src/a", resolvedPath: "src/a.ts", line: 1 }],
    calls: [],
  });
  store.replaceFile("src/a.ts", {
    language: "typescript",
    symbols: [
      { name: "UserService", kind: "class", startLine: 3, endLine: 40 },
      { name: "getUser", kind: "method", startLine: 10, endLine: 15, container: "UserService" },
    ],
    imports: [],
    calls: [],
  });
  return store;
}

async function run(args: Record<string, unknown>, notice: string | null = null) {
  const t = createFindSymbolTool({ graphStore: seeded(), getIndexingNotice: () => notice });
  return JSON.parse((await t.execute({ limit: 20, ...args } as never, {} as never)) as string);
}

test("find_symbol returns file, line range, kind and container", async () => {
  const r = await run({ query: "getuser" });
  assert.equal(r.matches.length, 1);
  assert.deepEqual(r.matches[0], {
    name: "getUser",
    kind: "method",
    path: "src/a.ts",
    startLine: 10,
    endLine: 15,
    container: "UserService",
  });
  assert.deepEqual(r.tests, ["test/a.test.ts"]);
});

test("find_symbol filters by kind and hints when nothing matches", async () => {
  assert.equal((await run({ query: "user", kind: "class" })).matches.length, 1);
  const r = await run({ query: "zzz" });
  assert.deepEqual(r.matches, []);
  assert.match(r.hint, /semantic_search/);
});

test("find_symbol attaches the indexing notice", async () => {
  const r = await run({ query: "user" }, "indexing 3/10");
  assert.ok(JSON.stringify(r).includes("indexing 3/10"));
});

test("find_symbol can search another allowed project's symbol index via `project`", async () => {
  const other = createGraphStore({ path: ":memory:" });
  other.replaceFile("lib/x.ts", {
    language: "typescript",
    symbols: [{ name: "LibThing", kind: "class", startLine: 1, endLine: 9 }],
    imports: [],
    calls: [],
  });
  const t = createFindSymbolTool({
    graphStore: seeded(),
    crossRepoGraphs: [{ key: "lib-1", store: other }],
  });
  const exec = async (args: Record<string, unknown>) =>
    JSON.parse((await t.execute({ limit: 20, ...args } as never, {} as never)) as string);
  const found = await exec({ query: "LibThing", project: "lib-1" });
  assert.equal(found.matches[0].path, "lib/x.ts");
  assert.equal(found.project, "lib-1");
  assert.equal((await exec({ query: "LibThing" })).matches.length, 0);
  const unknown = await exec({ query: "x", project: "nope" });
  assert.match(unknown.error, /Unknown or not allowed project "nope"\. Allowed: lib-1/);
});
