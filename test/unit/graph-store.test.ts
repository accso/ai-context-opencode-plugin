import { test } from "node:test";
import assert from "node:assert/strict";
import { createGraphStore, type FileGraph } from "../../src/storage/graph-store.js";

/**
 * Unit tests for the symbol / import / call graph store: per-file replace
 * semantics (re-indexing a file swaps its rows atomically) plus the
 * bounded, cycle-safe traversal that backs `analyze_impact`.
 */

function file(overrides: Partial<FileGraph> = {}): FileGraph {
  return { language: "typescript", symbols: [], imports: [], calls: [], ...overrides };
}

const sym = (name: string, kind = "function", startLine = 1, endLine = 2, container?: string) => ({
  name,
  kind,
  startLine,
  endLine,
  container,
});

const call = (callerSymbol: string | undefined, calleeName: string, extra: Record<string, unknown> = {}) => ({
  callerSymbol,
  calleeName,
  line: 1,
  ...extra,
});

test("replaceFile stores symbols that findSymbols returns by exact name", () => {
  const store = createGraphStore({ path: ":memory:" });
  store.replaceFile("a.ts", file({ symbols: [sym("foo"), sym("bar", "method", 3, 5, "Foo")] }));
  const found = store.findSymbols("bar");
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], {
    relativePath: "a.ts",
    name: "bar",
    kind: "method",
    language: "typescript",
    startLine: 3,
    endLine: 5,
    container: "Foo",
  });
  assert.deepEqual(store.findSymbols("nope"), []);
  store.close();
});

test("replaceFile swaps every row of the file, leaving other files untouched", () => {
  const store = createGraphStore({ path: ":memory:" });
  store.replaceFile("a.ts", file({ symbols: [sym("old")], calls: [call("old", "x")] }));
  store.replaceFile("b.ts", file({ symbols: [sym("keep")] }));
  store.replaceFile("a.ts", file({ symbols: [sym("fresh")] }));
  assert.deepEqual(store.findSymbols("old"), []);
  assert.equal(store.findSymbols("fresh").length, 1);
  assert.equal(store.findSymbols("keep").length, 1);
  assert.deepEqual(store.traverseCalls({ symbol: "x", direction: "callers", depth: 1 }).edges, []);
  store.close();
});

test("deleteFile removes symbols, imports and calls of that file", () => {
  const store = createGraphStore({ path: ":memory:" });
  store.replaceFile(
    "a.ts",
    file({
      symbols: [sym("foo")],
      imports: [{ specifier: "./b", resolvedPath: "b.ts", line: 1 }],
      calls: [call("foo", "bar")],
    }),
  );
  store.deleteFile("a.ts");
  assert.deepEqual(store.findSymbols("foo"), []);
  assert.deepEqual(store.importDependents("b.ts", 1), []);
  assert.deepEqual(store.traverseCalls({ symbol: "bar", direction: "callers", depth: 1 }).edges, []);
  store.close();
});

test("traverseCalls callers: depth 1 returns direct callers only, depth 2 adds transitive", () => {
  const store = createGraphStore({ path: ":memory:" });
  store.replaceFile("a.ts", file({ symbols: [sym("a")], calls: [call("a", "b")] }));
  store.replaceFile("b.ts", file({ symbols: [sym("b")], calls: [call("b", "c")] }));
  store.replaceFile("c.ts", file({ symbols: [sym("c")] }));

  const d1 = store.traverseCalls({ symbol: "c", direction: "callers", depth: 1 });
  assert.deepEqual(d1.edges.map((e) => [e.callerSymbol, e.calleeName, e.depth]), [["b", "c", 1]]);

  const d2 = store.traverseCalls({ symbol: "c", direction: "callers", depth: 2 });
  assert.deepEqual(
    d2.edges.map((e) => [e.callerSymbol, e.calleeName, e.depth]),
    [
      ["b", "c", 1],
      ["a", "b", 2],
    ],
  );
  store.close();
});

test("traverseCalls callees follows outgoing edges", () => {
  const store = createGraphStore({ path: ":memory:" });
  store.replaceFile("a.ts", file({ symbols: [sym("a")], calls: [call("a", "b"), call("a", "z")] }));
  store.replaceFile("b.ts", file({ symbols: [sym("b")], calls: [call("b", "c")] }));
  const r = store.traverseCalls({ symbol: "a", direction: "callees", depth: 2 });
  assert.deepEqual(
    r.edges.map((e) => [e.callerSymbol, e.calleeName, e.depth]).sort(),
    [
      ["a", "b", 1],
      ["a", "z", 1],
      ["b", "c", 2],
    ],
  );
  store.close();
});

test("traverseCalls terminates on call cycles and reports each edge once", () => {
  const store = createGraphStore({ path: ":memory:" });
  store.replaceFile("a.ts", file({ symbols: [sym("a"), sym("b")], calls: [call("a", "b"), call("b", "a")] }));
  const r = store.traverseCalls({ symbol: "a", direction: "callees", depth: 5 });
  assert.equal(r.edges.length, 2);
  store.close();
});

test("traverseCalls direction both merges callers and callees", () => {
  const store = createGraphStore({ path: ":memory:" });
  store.replaceFile("a.ts", file({ symbols: [sym("a")], calls: [call("a", "m")] }));
  store.replaceFile("m.ts", file({ symbols: [sym("m")], calls: [call("m", "z")] }));
  const r = store.traverseCalls({ symbol: "m", direction: "both", depth: 1 });
  assert.deepEqual(r.edges.map((e) => `${e.callerSymbol}->${e.calleeName}`).sort(), ["a->m", "m->z"]);
  store.close();
});

test("traverseCalls surfaces ambiguity and candidate count on edges", () => {
  const store = createGraphStore({ path: ":memory:" });
  store.replaceFile(
    "a.ts",
    file({ symbols: [sym("a")], calls: [call("a", "run", { ambiguous: true, candidateCount: 3 })] }),
  );
  const r = store.traverseCalls({ symbol: "run", direction: "callers", depth: 1 });
  assert.equal(r.edges[0]!.ambiguous, true);
  assert.equal(r.edges[0]!.candidateCount, 3);
  assert.equal(r.hasAmbiguousEdges, true);
  store.close();
});

test("traverseCalls with a path filter drops edges resolved to a different file but keeps unresolved ones", () => {
  const store = createGraphStore({ path: ":memory:" });
  store.replaceFile(
    "a.ts",
    file({
      symbols: [sym("a")],
      calls: [call("a", "run", { calleePath: "x.ts" }), call("a", "run", { calleePath: "y.ts" })],
    }),
  );
  store.replaceFile("b.ts", file({ symbols: [sym("b")], calls: [call("b", "run")] }));
  const r = store.traverseCalls({ symbol: "run", path: "x.ts", direction: "callers", depth: 1 });
  assert.deepEqual(r.edges.map((e) => e.relativePath + ":" + (e.calleePath ?? "?")).sort(), ["a.ts:x.ts", "b.ts:?"]);
  store.close();
});

test("importDependents returns transitive importers up to depth, cycle-safe", () => {
  const store = createGraphStore({ path: ":memory:" });
  store.replaceFile("a.ts", file({ imports: [{ specifier: "./b", resolvedPath: "b.ts", line: 1 }] }));
  store.replaceFile("b.ts", file({ imports: [{ specifier: "./c", resolvedPath: "c.ts", line: 1 }] }));
  store.replaceFile("c.ts", file({ imports: [{ specifier: "./a", resolvedPath: "a.ts", line: 1 }] }));
  assert.deepEqual(store.importDependents("c.ts", 1).map((d) => [d.relativePath, d.depth]), [["b.ts", 1]]);
  assert.deepEqual(
    store.importDependents("c.ts", 5).map((d) => [d.relativePath, d.depth]).sort(),
    [
      ["a.ts", 2],
      ["b.ts", 1],
    ],
  );
  store.close();
});

test("unresolved (external) imports are stored but never appear as dependents", () => {
  const store = createGraphStore({ path: ":memory:" });
  store.replaceFile("a.ts", file({ imports: [{ specifier: "react", line: 1 }] }));
  assert.deepEqual(store.importDependents("react", 1), []);
  assert.equal(store.getFileGraph("a.ts")!.imports[0]!.resolvedPath, undefined);
  store.close();
});

test("getFileGraph round-trips a file's rows and returns null for unknown files", () => {
  const store = createGraphStore({ path: ":memory:" });
  const g = file({
    symbols: [sym("foo", "class", 1, 9)],
    imports: [{ specifier: "./b", resolvedPath: "b.ts", importedNames: ["B"], line: 1 }],
    calls: [call("foo", "bar", { calleePath: "b.ts", ambiguous: false })],
  });
  store.replaceFile("a.ts", g);
  const got = store.getFileGraph("a.ts")!;
  assert.equal(got.symbols[0]!.name, "foo");
  assert.deepEqual(got.imports[0]!.importedNames, ["B"]);
  assert.equal(got.calls[0]!.calleePath, "b.ts");
  assert.equal(store.getFileGraph("zzz.ts"), null);
  store.close();
});

test("graph rows persist across reopen of an on-disk store", async () => {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-store-"));
  const p = path.join(dir, "g.sqlite");
  try {
    const s1 = createGraphStore({ path: p });
    s1.replaceFile("a.ts", file({ symbols: [sym("foo")] }));
    s1.close();
    const s2 = createGraphStore({ path: p });
    assert.equal(s2.findSymbols("foo").length, 1);
    s2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("traverseCalls keeps same-named symbols in different files apart (callers)", () => {
  const store = createGraphStore({ path: ":memory:" });
  store.replaceFile("x.ts", file({ symbols: [sym("run")], calls: [call("run", "leaf", { calleePath: "leaf.ts" })] }));
  store.replaceFile("y.ts", file({ symbols: [sym("run")] }));
  store.replaceFile("callerOfX.ts", file({ symbols: [sym("a")], calls: [call("a", "run", { calleePath: "x.ts" })] }));
  store.replaceFile("callerOfY.ts", file({ symbols: [sym("b")], calls: [call("b", "run", { calleePath: "y.ts" })] }));
  store.replaceFile("up.ts", file({ symbols: [sym("up")], calls: [call("up", "a", { calleePath: "callerOfX.ts" })] }));
  store.replaceFile("up2.ts", file({ symbols: [sym("up2")], calls: [call("up2", "b", { calleePath: "callerOfY.ts" })] }));
  const r = store.traverseCalls({ symbol: "leaf", direction: "callers", depth: 3 });
  assert.deepEqual(r.edges.map((e) => e.callerSymbol), ["run", "a", "up"]);
  const viaX = store.traverseCalls({ symbol: "run", path: "x.ts", direction: "callers", depth: 2 });
  assert.deepEqual(viaX.edges.map((e) => e.callerSymbol), ["a", "up"]);
  store.close();
});

test("traverseCalls keeps same-named symbols in different files apart (callees)", () => {
  const store = createGraphStore({ path: ":memory:" });
  store.replaceFile("x.ts", file({ symbols: [sym("run")], calls: [call("run", "fromX", { calleePath: "fx.ts" })] }));
  store.replaceFile("y.ts", file({ symbols: [sym("run")], calls: [call("run", "fromY", { calleePath: "fy.ts" })] }));
  store.replaceFile("m.ts", file({ symbols: [sym("main")], calls: [call("main", "run", { calleePath: "x.ts" })] }));
  const r = store.traverseCalls({ symbol: "main", direction: "callees", depth: 2 });
  assert.deepEqual(r.edges.map((e) => e.calleeName), ["run", "fromX"]);
  store.close();
});

test("call qualifier/kind and import kind round-trip through getFileGraph", () => {
  const store = createGraphStore({ path: ":memory:" });
  store.replaceFile(
    "a.rs",
    file({
      language: "rust",
      imports: [{ specifier: "b", kind: "mod", line: 1 }],
      calls: [call("f", "new", { qualifier: "Foo", kind: "member" })],
    }),
  );
  const g = store.getFileGraph("a.rs")!;
  assert.equal(g.imports[0]!.kind, "mod");
  assert.equal(g.calls[0]!.qualifier, "Foo");
  assert.equal(g.calls[0]!.kind, "member");
  store.close();
});

test("listFiles returns indexed file paths sorted, findCallerFiles returns files calling any of the names", () => {
  const store = createGraphStore({ path: ":memory:" });
  store.replaceFile("b.ts", file({ calls: [call(undefined, "x")] }));
  store.replaceFile("a.ts", file({ calls: [call(undefined, "y")] }));
  store.replaceFile("c.ts", file({ calls: [call(undefined, "z")] }));
  assert.deepEqual(store.listFiles(), ["a.ts", "b.ts", "c.ts"]);
  assert.deepEqual(store.findCallerFiles(["x", "y"]), ["a.ts", "b.ts"]);
  assert.deepEqual(store.findCallerFiles([]), []);
  store.close();
});

test("findCallerFiles also matches calls by their qualifier (raw template selectors)", () => {
  const store = createGraphStore({ path: ":memory:" });
  store.replaceFile("a.ts", file({ calls: [{ calleeName: "BarComponent", qualifier: "app-bar", kind: "template", line: 1 }] }));
  assert.deepEqual(store.findCallerFiles(["app-bar"]), ["a.ts"]);
  store.close();
});

test("searchSymbols matches by case-insensitive substring, exact and prefix first", () => {
  const store = createGraphStore({ path: ":memory:" });
  store.replaceFile("a.ts", file({ symbols: [sym("parseConfig"), sym("config"), sym("configLoader"), sym("other")] }));
  const names = store.searchSymbols("config", 10).map((s) => s.name);
  assert.deepEqual(names, ["config", "configLoader", "parseConfig"]);
  assert.equal(store.searchSymbols("config", 2).length, 2);
  assert.deepEqual(store.searchSymbols("", 5), []);
  assert.deepEqual(store.searchSymbols("100%_", 5), []);
});
