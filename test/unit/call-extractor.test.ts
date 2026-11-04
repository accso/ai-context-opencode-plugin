import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCalls } from "../../src/indexing/graph/call-extractor.js";

/** `caller->callee|qualifier|kind` per call, in document order; empty caller = top-level. */
async function callsOf(extension: string, source: string): Promise<string[]> {
  const result = await extractCalls(source, extension);
  assert.ok(result, `no extractor for ${extension}`);
  return result!.map((c) => `${c.callerSymbol ?? ""}->${c.calleeName}|${c.qualifier ?? ""}|${c.kind ?? ""}`);
}

test("extractCalls returns null for unsupported extensions", async () => {
  assert.equal(await extractCalls("x", ".md"), null);
});

test("extractCalls records 1-based lines", async () => {
  const r = await extractCalls("\nfunction f() {\n\n  g();\n}\n", ".ts");
  assert.equal(r![0]!.line, 4);
});

test("typescript/javascript: free, member, this, new, chained and top-level calls; require/super are not calls", async () => {
  const src = [
    "function f() { g(); a.b(); this.c(); new Foo(); a.b.c(); a().d(); require('x'); }",
    "const arrow = () => helper();",
    "class K extends B { m() { super(); super.go(); } }",
    "top();",
  ].join("\n");
  assert.deepEqual(await callsOf(".ts", src), [
    "f->g||", "f->b|a|", "f->c|this|", "f->Foo||new", "f->c|a.b|", "f->d||", "f->a||",
    "arrow->helper||",
    "m->go|super|",
    "->top||",
  ]);
});

test("calls inside local functions are attributed to the enclosing declared symbol", async () => {
  assert.deepEqual(await callsOf(".js", "function outer() { function inner() { deep(); } inner(); }"), [
    "outer->deep||", "outer->inner||",
  ]);
});

test("python: free and attribute calls, methods", async () => {
  const src = "def f():\n    g()\n    a.b()\n    a.b.c()\nclass A:\n    def m(self):\n        self.x()\n        Foo()\n";
  assert.deepEqual(await callsOf(".py", src), ["f->g||", "f->b|a|", "f->c|a.b|", "m->x|self|", "m->Foo||"]);
});

test("java: invocations, this calls and object creation", async () => {
  const src = "class A { void f() { g(); a.b(); this.c(); new Foo(); } }";
  assert.deepEqual(await callsOf(".java", src), ["f->g||", "f->b|a|", "f->c|this|", "f->Foo||new"]);
});

test("kotlin: free, navigation, constructor-style and safe calls", async () => {
  const src = "fun f() {\n  g()\n  a.b.c()\n  Foo(1)\n  x?.y()\n}\n";
  assert.deepEqual(await callsOf(".kt", src), ["f->g||", "f->c|a.b|", "f->Foo||", "f->y|x|"]);
});

test("csharp: invocations, member access, generics and object creation", async () => {
  const src = "class A { void F() { G(); a.B(); new Foo(); C<int>(); } }";
  assert.deepEqual(await callsOf(".cs", src), ["F->G||", "F->B|a|", "F->Foo||new", "F->C||"]);
});

test("go: free and selector calls", async () => {
  assert.deepEqual(await callsOf(".go", "package m\nfunc f() { g(); a.B(); x.y.Z() }\n"), [
    "f->g||", "f->B|a|", "f->Z|x.y|",
  ]);
});

test("rust: free, scoped, method and generic calls; macros are not calls", async () => {
  const src = 'fn f() { g(); a::b(); x.y(); Foo::new(); h::<T>(); println!("x"); }';
  assert.deepEqual(await callsOf(".rs", src), ["f->g||", "f->b|a|", "f->y|x|", "f->new|Foo|", "f->h||"]);
});

test("ruby: parenthesized, receiver and command calls; require family is not a call", async () => {
  const src = 'def f\n  g(1)\n  obj.h\n  Foo.bar(2)\n  require "a"\n  puts "x"\nend\n';
  assert.deepEqual(await callsOf(".rb", src), ["f->g||", "f->h|obj|", "f->bar|Foo|", "f->puts||"]);
});

test("c: free, member and arrow calls", async () => {
  assert.deepEqual(await callsOf(".c", "void f() { g(); s.m(); p->c(); }"), ["f->g||", "f->m|s|", "f->c|p|"]);
});

test("cpp: qualified, template and new expressions", async () => {
  assert.deepEqual(await callsOf(".cpp", "void f() { n::d(); new Foo(); h<int>(); a.b(); }"), [
    "f->d|n|", "f->Foo||new", "f->h||", "f->b|a|",
  ]);
});
