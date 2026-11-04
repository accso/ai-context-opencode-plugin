import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSymbols, symbolLanguageForExtension } from "../../src/indexing/graph/symbol-extractor.js";

/** Renders symbols as `kind name` or `kind Container.name` for compact assertions. */
async function symbolsOf(extension: string, source: string): Promise<string[]> {
  const result = await extractSymbols(source, extension);
  assert.ok(result, `no extractor for ${extension}`);
  return result!.symbols.map((s) => `${s.kind} ${s.container ? s.container + "." : ""}${s.name}`);
}

test("symbolLanguageForExtension maps all supported extensions and rejects others", () => {
  const expected: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript",
    ".py": "python", ".java": "java", ".kt": "kotlin", ".cs": "csharp", ".go": "go", ".rs": "rust",
    ".rb": "ruby", ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp",
  };
  for (const [ext, lang] of Object.entries(expected)) assert.equal(symbolLanguageForExtension(ext), lang, ext);
  assert.equal(symbolLanguageForExtension(".md"), undefined);
  assert.equal(symbolLanguageForExtension(".PY"), "python");
});

test("extractSymbols returns null for unsupported extensions", async () => {
  assert.equal(await extractSymbols("# hi", ".md"), null);
});

test("extractSymbols reports 1-based line ranges", async () => {
  const r = await extractSymbols("\n\nfunction foo() {\n  return 1;\n}\n", ".ts");
  assert.deepEqual(r!.symbols.map((s) => [s.name, s.startLine, s.endLine]), [["foo", 3, 5]]);
  assert.equal(r!.language, "typescript");
});

test("typescript: classes, methods, interfaces, enums, aliases, namespaces, arrow functions; skips local functions", async () => {
  const src = [
    "export class Svc { run() {} handler = () => 1; }",
    "abstract class Base {}",
    "interface Shape { area(): number }",
    "enum Color { Red }",
    "type Id = string;",
    "namespace N { export function inN() {} }",
    "export const arrow = () => 1;",
    "const notFn = 5;",
    "function outer() { function inner() {} }",
  ].join("\n");
  assert.deepEqual(await symbolsOf(".ts", src), [
    "class Svc", "method Svc.run", "method Svc.handler", "class Base", "interface Shape", "enum Color",
    "typealias Id", "namespace N", "function N.inN", "function arrow", "function outer",
  ]);
});

test("tsx and javascript: components and function expressions", async () => {
  assert.deepEqual(await symbolsOf(".tsx", "export const App = () => <div />;\nfunction B() { return <A />; }"), [
    "function App", "function B",
  ]);
  assert.deepEqual(await symbolsOf(".js", "class A { #p = 1; m() {} static s() {} }\nconst h = function () {};\nfunction* gen() {}"), [
    "class A", "method A.m", "method A.s", "function h", "function gen",
  ]);
});

test("python: classes, methods vs functions, decorated and async defs", async () => {
  const src = "class A:\n    def m(self): pass\n    class Inner:\n        def n(self): pass\n@dec\ndef f(): pass\nasync def g(): pass\n";
  assert.deepEqual(await symbolsOf(".py", src), [
    "class A", "method A.m", "class A.Inner", "method Inner.n", "function f", "function g",
  ]);
});

test("java: classes, interfaces, enums, records, constructors, methods", async () => {
  const src = [
    "package p;",
    "public class A {",
    "  A() {}",
    "  void m() { Runnable r = new Runnable() { public void run() {} }; }",
    "  interface In { void x(); }",
    "}",
    "enum E { X; void e() {} }",
    "record R(int v) { int twice() { return v * 2; } }",
    "@interface Ann {}",
  ].join("\n");
  assert.deepEqual(await symbolsOf(".java", src), [
    "class A", "constructor A.A", "method A.m", "interface A.In", "method In.x", "enum E", "method E.e", "record R", "method R.twice",
    "interface Ann",
  ]);
});

test("kotlin: classes, interfaces, enums, objects, companions, constructors, functions vs methods, typealias", async () => {
  const src = [
    "class A {",
    "    companion object {",
    "        fun c() {}",
    "    }",
    "    constructor(x: Int) : this()",
    "    fun m() {}",
    "}",
    "interface I",
    "enum class E { X }",
    "object O",
    "typealias T = Int",
    "fun Int.ext() = this",
    "fun top() {}",
  ].join("\n");
  assert.deepEqual(await symbolsOf(".kt", src), [
    "class A", "object A.Companion", "method Companion.c", "constructor A.A", "method A.m", "interface I", "enum E",
    "object O", "typealias T", "function ext", "function top",
  ]);
});

test("csharp: namespaces (block and file-scoped), classes, structs, records, interfaces, enums, members", async () => {
  const src = [
    "namespace A;",
    "class C { public int P { get; set; } C() {} void M() {} }",
    "record struct R(int X);",
    "interface I { void F(); }",
    "struct S {}",
    "enum E { X }",
  ].join("\n");
  assert.deepEqual(await symbolsOf(".cs", src), [
    "namespace A", "class A.C", "property C.P", "constructor C.C", "method C.M", "record A.R", "interface A.I", "method I.F",
    "struct A.S", "enum A.E",
  ]);
  assert.deepEqual(await symbolsOf(".cs", "namespace N { class K { void M() {} } }"), [
    "namespace N", "class N.K", "method K.M",
  ]);
});

test("go: functions, methods attached to receiver type, structs, interfaces and their methods", async () => {
  const src = [
    "package m",
    "type S struct{}",
    "type I interface{ M() }",
    "type A = int",
    "type Id string",
    "func (s *S) M() {}",
    "func helper() {}",
  ].join("\n");
  assert.deepEqual(await symbolsOf(".go", src), [
    "struct S", "interface I", "method I.M", "typealias A", "type Id", "method S.M", "function helper",
  ]);
});

test("rust: functions, structs, enums, traits, impl methods attached to the implementing type, modules", async () => {
  const src = [
    "mod m { fn inner() {} }",
    "struct S;",
    "enum E { A }",
    "trait T { fn t(&self); }",
    "impl T for S { fn t(&self) {} }",
    "impl<X> Wrapper<X> { fn new() -> Self { todo!() } }",
    "type Alias = u8;",
    "fn main() {}",
  ].join("\n");
  assert.deepEqual(await symbolsOf(".rs", src), [
    "module m", "function m.inner", "struct S", "enum E", "trait T", "method T.t", "method S.t", "method Wrapper.new",
    "typealias Alias", "function main",
  ]);
});

test("ruby: modules, classes, instance and singleton methods", async () => {
  const src = "module M\n  class C < B\n    def f(x); end\n    def self.s; end\n  end\nend\ndef top; end\n";
  assert.deepEqual(await symbolsOf(".rb", src), ["module M", "class M.C", "method C.f", "method C.s", "function top"]);
});

test("c: functions (incl. pointer-returning), structs, enums, typedefs, function-like macros", async () => {
  const src = [
    "#define SQ(x) ((x)*(x))",
    "#define LIMIT 3",
    "struct P { int x; };",
    "enum Mode { A };",
    "typedef struct { int y; } Q;",
    "int add(int a, int b) { return a + b; }",
    "static int *ptr(void) { return 0; }",
    "struct P; ",
  ].join("\n");
  assert.deepEqual(await symbolsOf(".c", src), [
    "macro SQ", "struct P", "enum Mode", "typedef Q", "function add", "function ptr",
  ]);
});

test("cpp: namespaces, classes, templates, out-of-class methods, constructors, aliases", async () => {
  const src = [
    "namespace n {",
    "class C { public: C() {} void f() {} };",
    "}",
    "void C::h() {}",
    "C::C(int x) {}",
    "template <typename T> T add(T a) { return a; }",
    "template <typename T> class Box { public: T get() { return v; } };",
    "using Id = int;",
    "struct S { int x; };",
  ].join("\n");
  assert.deepEqual(await symbolsOf(".cpp", src), [
    "namespace n", "class n.C", "constructor C.C", "method C.f", "method C.h", "constructor C.C", "function add",
    "class Box", "method Box.get", "typealias Id", "struct S",
  ]);
});
