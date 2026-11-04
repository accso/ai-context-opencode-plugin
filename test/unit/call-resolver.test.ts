import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCall, type CallCandidate } from "../../src/indexing/graph/call-resolver.js";

const cand = (relativePath: string, name: string, kind = "function", container?: string): CallCandidate => ({
  relativePath,
  name,
  kind,
  container,
});

const noImports = new Set<string>();

test("no candidate means an external/unknown callee: unresolved but not ambiguous", () => {
  const r = resolveCall({ calleeName: "log", qualifier: "console" }, { fromPath: "a.ts", candidates: [], importedFiles: noImports });
  assert.deepEqual(r, { ambiguous: false });
});

test("free call: a same-file definition wins over other files", () => {
  const r = resolveCall(
    { calleeName: "helper" },
    { fromPath: "src/a.ts", candidates: [cand("src/a.ts", "helper"), cand("src/b.ts", "helper")], importedFiles: noImports },
  );
  assert.deepEqual(r, { calleePath: "src/a.ts", ambiguous: false });
});

test("free call: otherwise an imported file wins", () => {
  const r = resolveCall(
    { calleeName: "helper" },
    { fromPath: "src/a.ts", candidates: [cand("lib/x.ts", "helper"), cand("src/b.ts", "helper")], importedFiles: new Set(["src/b.ts"]) },
  );
  assert.deepEqual(r, { calleePath: "src/b.ts", ambiguous: false });
});

test("free call: same-directory definitions count as same package (Go/Java/C#)", () => {
  const r = resolveCall(
    { calleeName: "helper" },
    { fromPath: "pkg/a.go", candidates: [cand("pkg/b.go", "helper"), cand("other/c.go", "helper")], importedFiles: noImports },
  );
  assert.deepEqual(r, { calleePath: "pkg/b.go", ambiguous: false });
});

test("free call: C header include matches the implementation file with the same stem", () => {
  const r = resolveCall(
    { calleeName: "add" },
    { fromPath: "src/main.c", candidates: [cand("lib/math.c", "add"), cand("lib/other.c", "add")], importedFiles: new Set(["lib/math.h"]) },
  );
  assert.deepEqual(r, { calleePath: "lib/math.c", ambiguous: false });
});

test("free call: a single candidate with no same-file/import/package evidence is returned but flagged ambiguous", () => {
  const r = resolveCall(
    { calleeName: "get" },
    { fromPath: "src/a.ts", candidates: [cand("far/away.ts", "get")], importedFiles: noImports },
  );
  assert.deepEqual(r, { calleePath: "far/away.ts", ambiguous: true, candidateCount: 1 });
});

test("free call: several equally plausible candidates are ambiguous with a count and no path", () => {
  const r = resolveCall(
    { calleeName: "run" },
    { fromPath: "src/a.ts", candidates: [cand("x/one.ts", "run"), cand("y/two.ts", "run"), cand("z/three.ts", "run")], importedFiles: noImports },
  );
  assert.deepEqual(r, { ambiguous: true, candidateCount: 3 });
});

test("overloads in one file count once", () => {
  const r = resolveCall(
    { calleeName: "run" },
    { fromPath: "a.java", candidates: [cand("A.java", "run", "method", "A"), cand("A.java", "run", "method", "A")], importedFiles: noImports },
  );
  assert.deepEqual(r, { calleePath: "A.java", ambiguous: false });
});

test("class-qualified call resolves by container name", () => {
  const r = resolveCall(
    { calleeName: "create", qualifier: "User" },
    {
      fromPath: "a.ts",
      candidates: [cand("user.ts", "create", "method", "User"), cand("order.ts", "create", "method", "Order")],
      importedFiles: noImports,
    },
  );
  assert.deepEqual(r, { calleePath: "user.ts", ambiguous: false });
});

test("module-qualified call resolves by file stem or directory name (Python modules, Go packages)", () => {
  const py = resolveCall(
    { calleeName: "parse", qualifier: "utils" },
    { fromPath: "app/main.py", candidates: [cand("app/utils.py", "parse"), cand("app/other.py", "parse")], importedFiles: noImports },
  );
  assert.deepEqual(py, { calleePath: "app/utils.py", ambiguous: false });
  const go = resolveCall(
    { calleeName: "Open", qualifier: "store" },
    { fromPath: "cmd/main.go", candidates: [cand("internal/store/db.go", "Open"), cand("internal/cache/c.go", "Open")], importedFiles: noImports },
  );
  assert.deepEqual(go, { calleePath: "internal/store/db.go", ambiguous: false });
});

test("receiver of unknown type: a lone candidate is a guess, so it is flagged ambiguous but still returned", () => {
  const r = resolveCall(
    { calleeName: "save", qualifier: "r" },
    { fromPath: "a.ts", candidates: [cand("repo.ts", "save", "method", "Repo")], importedFiles: new Set(["repo.ts"]) },
  );
  assert.deepEqual(r, { calleePath: "repo.ts", ambiguous: true, candidateCount: 1 });
});

test("receiver of unknown type with several candidates narrows by imports but stays ambiguous", () => {
  const r = resolveCall(
    { calleeName: "save", qualifier: "x" },
    {
      fromPath: "a.ts",
      candidates: [cand("one.ts", "save", "method", "One"), cand("two.ts", "save", "method", "Two")],
      importedFiles: new Set(["two.ts"]),
    },
  );
  assert.deepEqual(r, { calleePath: "two.ts", ambiguous: true, candidateCount: 1 });
});

test("this/self calls resolve inside the caller's own class", () => {
  const r = resolveCall(
    { calleeName: "step", qualifier: "this" },
    {
      fromPath: "a.ts",
      callerContainer: "A",
      candidates: [cand("a.ts", "step", "method", "A"), cand("a.ts", "step", "method", "B"), cand("b.ts", "step", "method", "A")],
      importedFiles: noImports,
    },
  );
  assert.deepEqual(r, { calleePath: "a.ts", ambiguous: false });
});

test("new prefers class-like targets and collapses class + constructor into one file", () => {
  const r = resolveCall(
    { calleeName: "Foo", kind: "new" },
    {
      fromPath: "a.java",
      candidates: [cand("Foo.java", "Foo", "class"), cand("Foo.java", "Foo", "constructor", "Foo"), cand("x/Foo.java", "Foo", "class")],
      importedFiles: new Set(["Foo.java"]),
    },
  );
  assert.deepEqual(r, { calleePath: "Foo.java", ambiguous: false });
});

test("a plain call can target a class (Python/Kotlin construction) when no callable matches", () => {
  const r = resolveCall(
    { calleeName: "Foo" },
    { fromPath: "a.py", candidates: [cand("a.py", "Foo", "class")], importedFiles: noImports },
  );
  assert.deepEqual(r, { calleePath: "a.py", ambiguous: false });
});

test("non-callable symbols (interfaces, types) are never call targets", () => {
  const r = resolveCall(
    { calleeName: "Shape" },
    { fromPath: "a.ts", candidates: [cand("a.ts", "Shape", "interface")], importedFiles: noImports },
  );
  assert.deepEqual(r, { ambiguous: false });
});

test("inject edges prefer class-like targets and fall back to any same-named symbol (tokens)", () => {
  const classFirst = resolveCall(
    { calleeName: "Svc", kind: "inject" },
    { fromPath: "a.ts", candidates: [cand("s.ts", "Svc", "function"), cand("svc.ts", "Svc", "class")], importedFiles: noImports },
  );
  assert.equal(classFirst.calleePath, "svc.ts");
  const token = resolveCall(
    { calleeName: "TOKEN", kind: "inject" },
    { fromPath: "a/x.ts", candidates: [cand("a/t.ts", "TOKEN", "variable")], importedFiles: noImports },
  );
  assert.deepEqual(token, { calleePath: "a/t.ts", ambiguous: false });
});

test("decorator edges resolve like inject edges, narrowed by imports", () => {
  const r = resolveCall(
    { calleeName: "Mod", kind: "decorator" },
    { fromPath: "src/a.ts", candidates: [cand("x/m.ts", "Mod", "class"), cand("y/m.ts", "Mod", "class")], importedFiles: new Set(["y/m.ts"]) },
  );
  assert.deepEqual(r, { calleePath: "y/m.ts", ambiguous: false });
});

test("jsx edges resolve a component function through imports", () => {
  const r = resolveCall(
    { calleeName: "Item", kind: "jsx" },
    { fromPath: "src/App.tsx", candidates: [cand("src/Item.tsx", "Item"), cand("lib/Item.tsx", "Item")], importedFiles: new Set(["src/Item.tsx"]) },
  );
  assert.deepEqual(r, { calleePath: "src/Item.tsx", ambiguous: false });
});
