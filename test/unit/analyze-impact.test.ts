import { test } from "node:test";
import assert from "node:assert/strict";
import { createGraphStore, type GraphStore } from "../../src/storage/graph-store.js";
import { createAnalyzeImpactTool } from "../../src/tools/analyze-impact.js";

function seeded(): GraphStore {
  const store = createGraphStore({ path: ":memory:" });
  store.replaceFile("src/a.ts", {
    language: "typescript",
    symbols: [{ name: "a", kind: "function", startLine: 2, endLine: 4 }],
    imports: [{ specifier: "./b", resolvedPath: "src/b.ts", line: 1 }],
    calls: [{ callerSymbol: "a", calleeName: "b", calleePath: "src/b.ts", line: 3, ambiguous: false }],
  });
  store.replaceFile("src/b.ts", {
    language: "typescript",
    symbols: [{ name: "b", kind: "function", startLine: 1, endLine: 5 }],
    imports: [],
    calls: [
      { callerSymbol: "b", calleeName: "dup", line: 2, ambiguous: true, candidateCount: 2 },
    ],
  });
  store.replaceFile("src/c.ts", {
    language: "typescript",
    symbols: [{ name: "dup", kind: "function", startLine: 1, endLine: 1 }],
    imports: [],
    calls: [],
  });
  store.replaceFile("src/d.ts", {
    language: "typescript",
    symbols: [{ name: "dup", kind: "function", startLine: 1, endLine: 1 }],
    imports: [],
    calls: [],
  });
  return store;
}

async function run(store: GraphStore, args: Record<string, unknown>) {
  const t = createAnalyzeImpactTool({ graphStore: store });
  return JSON.parse((await t.execute({ direction: "both", depth: 1, ...args } as never, {} as never)) as string);
}

test("reports definitions, callers, callees and importing files", async () => {
  const out = await run(seeded(), { symbolName: "b" });
  assert.deepEqual(out.definitions.map((d: { path: string; startLine: number }) => [d.path, d.startLine]), [["src/b.ts", 1]]);
  assert.deepEqual(out.callers.map((c: { path: string; caller: string; line: number }) => [c.path, c.caller, c.line]), [["src/a.ts", "a", 3]]);
  assert.deepEqual(out.callees.map((c: { callee: string }) => c.callee), ["dup"]);
  assert.deepEqual(out.importers, [{ path: "src/a.ts", depth: 1 }]);
  assert.match(out.hint, /grep/);
  assert.doesNotMatch(out.hint, /lsp/);
});

test("direction limits which edge lists are returned", async () => {
  const out = await run(seeded(), { symbolName: "b", direction: "callers" });
  assert.equal(out.callers.length, 1);
  assert.equal(out.callees, undefined);
});

test("ambiguous edges ask the agent to confirm them by reading the call site", async () => {
  const out = await run(seeded(), { symbolName: "b", direction: "callees" });
  assert.equal(out.ambiguousEdgeCount, 1);
  assert.match(out.hint, /read/);
  assert.match(out.hint, /src\/b\.ts:2/);
});

test("lists every definition when a name is defined in several files, and path narrows it", async () => {
  const all = await run(seeded(), { symbolName: "dup", direction: "callers" });
  assert.equal(all.definitions.length, 2);
  assert.match(all.hint, /exact `grep`/);
  const narrowed = await run(seeded(), { symbolName: "dup", path: "src/c.ts", direction: "callers" });
  assert.deepEqual(narrowed.definitions.map((d: { path: string }) => d.path), ["src/c.ts"]);
});

test("an unknown symbol yields a not-found hint instead of an error", async () => {
  const out = await run(seeded(), { symbolName: "nope" });
  assert.deepEqual(out.definitions, []);
  assert.match(out.hint, /semantic_search/);
});

test("a clean call chain reports no ambiguous edges", async () => {
  const out = await run(seeded(), { symbolName: "a", direction: "callees" });
  assert.equal(out.ambiguousEdgeCount, 0);
});

test("depth is passed through to the traversal", async () => {
  const out = await run(seeded(), { symbolName: "a", direction: "callees", depth: 2 });
  assert.deepEqual(out.callees.map((c: { depth: number }) => c.depth), [1, 2]);
});

test("edges carry their kind (jsx, inject, template ...)", async () => {
  const store = createGraphStore({ path: ":memory:" });
  store.replaceFile("src/Item.tsx", { language: "typescript", symbols: [{ name: "Item", kind: "function", startLine: 1, endLine: 1 }], imports: [], calls: [] });
  store.replaceFile("src/App.tsx", {
    language: "typescript",
    symbols: [{ name: "App", kind: "function", startLine: 1, endLine: 3 }],
    imports: [],
    calls: [{ callerSymbol: "App", calleeName: "Item", calleePath: "src/Item.tsx", kind: "jsx", line: 2, ambiguous: false }],
  });
  const out = await run(store, { symbolName: "Item", direction: "callers" });
  assert.equal(out.callers[0].kind, "jsx");
});

test("analyze_impact adds an indexingNotice to its answer while indexing is running", async () => {
  const t = createAnalyzeImpactTool({ graphStore: seeded(), getIndexingNotice: () => "graph incomplete" });
  const out = JSON.parse((await t.execute({ direction: "both", depth: 1, symbolName: "a" } as never, {} as never)) as string);
  assert.equal(out.indexingNotice, "graph incomplete");
  assert.equal(out.symbol, "a");
});

test("analyze_impact also adds the notice when the symbol is not (yet) in the graph", async () => {
  const t = createAnalyzeImpactTool({ graphStore: seeded(), getIndexingNotice: () => "graph incomplete" });
  const out = JSON.parse((await t.execute({ direction: "both", depth: 1, symbolName: "nope" } as never, {} as never)) as string);
  assert.equal(out.indexingNotice, "graph incomplete");
});

test("analyze_impact output has no indexingNotice when none is active", async () => {
  const out = await run(seeded(), { symbolName: "a" });
  assert.equal("indexingNotice" in out, false);
});

test("analyze_impact lists test files that import or call the symbol", async () => {
  const store = seeded();
  store.replaceFile("test/b.test.ts", {
    language: "typescript",
    symbols: [],
    imports: [{ specifier: "../src/b", resolvedPath: "src/b.ts", line: 1 }],
    calls: [{ calleeName: "b", line: 4 }],
  });
  const r = await run(store, { symbolName: "b" });
  assert.deepEqual(r.tests, ["test/b.test.ts"]);
});

test("analyze_impact can analyze another allowed project via `project`", async () => {
  const other = createGraphStore({ path: ":memory:" });
  other.replaceFile("lib/x.ts", {
    language: "typescript",
    symbols: [{ name: "LibThing", kind: "class", startLine: 1, endLine: 9 }],
    imports: [],
    calls: [],
  });
  const t = createAnalyzeImpactTool({ graphStore: seeded(), crossRepoGraphs: [{ key: "lib-1", store: other }] });
  const exec = async (args: Record<string, unknown>) =>
    JSON.parse((await t.execute({ direction: "both", depth: 1, ...args } as never, {} as never)) as string);
  const found = await exec({ symbolName: "LibThing", project: "lib-1" });
  assert.equal(found.definitions[0].path, "lib/x.ts");
  assert.equal(found.project, "lib-1");
  assert.equal((await exec({ symbolName: "LibThing" })).definitions.length, 0);
  assert.match((await exec({ symbolName: "x", project: "nope" })).error, /Unknown or not allowed project "nope"\. Allowed: lib-1/);
});

test("host v1 (lsp: true) points the hints and description to the native lsp tool", async () => {
  const tool = createAnalyzeImpactTool({ graphStore: seeded(), lsp: true });
  assert.match(tool.description, /native `lsp` tool/);
  const out = JSON.parse((await tool.execute({ direction: "callees", depth: 1, symbolName: "b" } as never, {} as never)) as string);
  assert.match(out.hint, /goToDefinition/);
  assert.match(out.hint, /findReferences/);
});
