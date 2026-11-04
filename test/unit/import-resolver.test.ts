import { test } from "node:test";
import assert from "node:assert/strict";
import { createImportResolver } from "../../src/indexing/graph/import-resolver.js";
import type { RawImport } from "../../src/indexing/graph/import-extractor.js";

const imp = (specifier: string, extra: Partial<RawImport> = {}): RawImport => ({ specifier, line: 1, ...extra });

test("typescript: relative specifiers resolve with extension probing, index files and .js->.ts swaps", () => {
  const r = createImportResolver([
    "src/a.ts", "src/b.tsx", "src/util/index.ts", "src/c.ts", "src/d.js", "lib/e.mjs",
  ]);
  assert.deepEqual(r.resolve(imp("./b"), "src/a.ts", "typescript"), ["src/b.tsx"]);
  assert.deepEqual(r.resolve(imp("./util"), "src/a.ts", "typescript"), ["src/util/index.ts"]);
  assert.deepEqual(r.resolve(imp("./c.js"), "src/a.ts", "typescript"), ["src/c.ts"]);
  assert.deepEqual(r.resolve(imp("./d.js"), "src/a.ts", "typescript"), ["src/d.js"]);
  assert.deepEqual(r.resolve(imp("../lib/e.mjs"), "src/a.ts", "javascript"), ["lib/e.mjs"]);
  assert.deepEqual(r.resolve(imp("../lib/e"), "src/a.ts", "javascript"), ["lib/e.mjs"]);
  assert.deepEqual(r.resolve(imp("react"), "src/a.ts", "typescript"), []);
  assert.deepEqual(r.resolve(imp("./missing"), "src/a.ts", "typescript"), []);
  assert.deepEqual(r.resolve(imp("../../outside"), "src/a.ts", "typescript"), []);
});

test("python: absolute (suffix-matched), relative, package __init__ and submodule-from-import", () => {
  const r = createImportResolver([
    "app/main.py", "app/pkg/__init__.py", "app/pkg/mod.py", "app/pkg/sub/leaf.py", "app/helpers.py",
    "other/pkg/mod.py",
  ]);
  assert.deepEqual(r.resolve(imp("pkg.mod"), "app/main.py", "python"), ["app/pkg/mod.py"]);
  assert.deepEqual(r.resolve(imp("pkg"), "app/main.py", "python"), ["app/pkg/__init__.py"]);
  assert.deepEqual(r.resolve(imp(".helpers"), "app/main.py", "python"), ["app/helpers.py"]);
  assert.deepEqual(r.resolve(imp(".", { importedNames: ["helpers"] }), "app/main.py", "python"), ["app/helpers.py"]);
  assert.deepEqual(r.resolve(imp("..mod"), "app/pkg/sub/leaf.py", "python"), ["app/pkg/mod.py"]);
  assert.deepEqual(r.resolve(imp("pkg", { importedNames: ["mod", "Thing"] }), "app/main.py", "python"), [
    "app/pkg/__init__.py", "app/pkg/mod.py",
  ]);
  assert.deepEqual(r.resolve(imp("os.path"), "app/main.py", "python"), []);
});

test("python: when several suffix matches exist the one closest to the importing file wins", () => {
  const r = createImportResolver(["a/x/main.py", "a/x/pkg/m.py", "b/pkg/m.py"]);
  assert.deepEqual(r.resolve(imp("pkg.m"), "a/x/main.py", "python"), ["a/x/pkg/m.py"]);
  assert.deepEqual(r.resolve(imp("pkg.m"), "b/main.py", "python"), ["b/pkg/m.py"]);
});

test("java: class imports match package path, static imports fall back to the class, wildcards list the package", () => {
  const r = createImportResolver([
    "src/main/java/com/x/Foo.java", "src/main/java/com/x/Bar.java", "src/main/java/com/y/Baz.java",
    "src/main/kotlin/com/x/Kt.kt",
  ]);
  assert.deepEqual(r.resolve(imp("com.x.Foo"), "src/main/java/com/y/Baz.java", "java"), ["src/main/java/com/x/Foo.java"]);
  assert.deepEqual(r.resolve(imp("com.x.Foo.helper"), "src/main/java/com/y/Baz.java", "java"), [
    "src/main/java/com/x/Foo.java",
  ]);
  assert.deepEqual(r.resolve(imp("com.x", { importedNames: ["*"] }), "src/main/java/com/y/Baz.java", "java"), [
    "src/main/java/com/x/Bar.java", "src/main/java/com/x/Foo.java",
  ]);
  assert.deepEqual(r.resolve(imp("com.x.Kt"), "src/main/java/com/y/Baz.java", "java"), ["src/main/kotlin/com/x/Kt.kt"]);
  assert.deepEqual(r.resolve(imp("java.util.List"), "src/main/java/com/y/Baz.java", "java"), []);
});

test("kotlin: resolves classes by package path, also into Java sources", () => {
  const r = createImportResolver(["src/com/x/Foo.kt", "src/com/x/J.java", "src/com/z/Main.kt"]);
  assert.deepEqual(r.resolve(imp("com.x.Foo"), "src/com/z/Main.kt", "kotlin"), ["src/com/x/Foo.kt"]);
  assert.deepEqual(r.resolve(imp("com.x.J"), "src/com/z/Main.kt", "kotlin"), ["src/com/x/J.java"]);
  assert.deepEqual(r.resolve(imp("kotlin.collections.List"), "src/com/z/Main.kt", "kotlin"), []);
});

test("csharp: namespaces resolve to the .cs files of the directory whose path ends with the namespace", () => {
  const r = createImportResolver([
    "App/Services/A.cs", "App/Services/B.cs", "App/Models/M.cs", "App/Program.cs",
  ]);
  assert.deepEqual(r.resolve(imp("MyCo.App.Services"), "App/Program.cs", "csharp"), [
    "App/Services/A.cs", "App/Services/B.cs",
  ]);
  assert.deepEqual(r.resolve(imp("System.Linq"), "App/Program.cs", "csharp"), []);
});

test("go: import paths match package directories by longest suffix, skipping _test files", () => {
  const r = createImportResolver([
    "internal/store/db.go", "internal/store/db_test.go", "cmd/app/main.go", "pkg/util/u.go",
  ]);
  assert.deepEqual(r.resolve(imp("github.com/me/proj/internal/store"), "cmd/app/main.go", "go"), [
    "internal/store/db.go",
  ]);
  assert.deepEqual(r.resolve(imp("github.com/me/proj/pkg/util"), "cmd/app/main.go", "go"), ["pkg/util/u.go"]);
  assert.deepEqual(r.resolve(imp("github.com/other/lib"), "cmd/app/main.go", "go"), []);
});

test("rust: mod declarations and crate/self/super paths resolve to module files", () => {
  const r = createImportResolver([
    "crate/src/main.rs", "crate/src/a.rs", "crate/src/a/b.rs", "crate/src/c/mod.rs", "crate/src/c/d.rs", "crate/src/lib.rs",
  ]);
  assert.deepEqual(r.resolve(imp("a", { kind: "mod" }), "crate/src/main.rs", "rust"), ["crate/src/a.rs"]);
  assert.deepEqual(r.resolve(imp("b", { kind: "mod" }), "crate/src/a.rs", "rust"), ["crate/src/a/b.rs"]);
  assert.deepEqual(r.resolve(imp("c", { kind: "mod" }), "crate/src/main.rs", "rust"), ["crate/src/c/mod.rs"]);
  assert.deepEqual(r.resolve(imp("crate::c::d"), "crate/src/a.rs", "rust"), ["crate/src/c/d.rs"]);
  assert.deepEqual(r.resolve(imp("crate::a::b::Item"), "crate/src/main.rs", "rust"), ["crate/src/a/b.rs"]);
  assert.deepEqual(r.resolve(imp("super::a"), "crate/src/c/mod.rs", "rust"), ["crate/src/a.rs"]);
  assert.deepEqual(r.resolve(imp("self::d"), "crate/src/c/mod.rs", "rust"), ["crate/src/c/d.rs"]);
  assert.deepEqual(r.resolve(imp("crate::Thing"), "crate/src/a.rs", "rust"), ["crate/src/lib.rs"]);
  assert.deepEqual(r.resolve(imp("std::fmt"), "crate/src/a.rs", "rust"), []);
});

test("c/cpp: local includes resolve relative to the file first, then by suffix; system includes only by suffix", () => {
  const r = createImportResolver(["src/a.c", "src/a.h", "include/lib/api.h", "src/sub/x.h"]);
  assert.deepEqual(r.resolve(imp("a.h", { kind: "local" }), "src/a.c", "c"), ["src/a.h"]);
  assert.deepEqual(r.resolve(imp("lib/api.h", { kind: "local" }), "src/a.c", "c"), ["include/lib/api.h"]);
  assert.deepEqual(r.resolve(imp("lib/api.h", { kind: "system" }), "src/a.c", "cpp"), ["include/lib/api.h"]);
  assert.deepEqual(r.resolve(imp("stdio.h", { kind: "system" }), "src/a.c", "c"), []);
});

test("ruby: require_relative resolves from the file; require matches by suffix", () => {
  const r = createImportResolver(["lib/app.rb", "lib/app/util.rb", "lib/other.rb"]);
  assert.deepEqual(r.resolve(imp("app/util", { kind: "relative" }), "lib/app.rb", "ruby"), ["lib/app/util.rb"]);
  assert.deepEqual(r.resolve(imp("../lib/other", { kind: "relative" }), "lib/app.rb", "ruby"), ["lib/other.rb"]);
  assert.deepEqual(r.resolve(imp("app/util"), "lib/other.rb", "ruby"), ["lib/app/util.rb"]);
  assert.deepEqual(r.resolve(imp("json"), "lib/other.rb", "ruby"), []);
});
