import { test } from "node:test";
import assert from "node:assert/strict";
import { createTreeSitterParser } from "../../src/indexing/tree-sitter/parser-loader.js";

/**
 * Modern-language-version coverage for the grammars the blast-radius
 * graph (symbol/import/call extraction) will depend on. Each snippet uses
 * syntax introduced in the current major version of its language; a
 * stale grammar yields ERROR nodes (`rootNode.hasError`).
 */
const CASES: Array<{ grammar: string; name: string; source: string }> = [
  { grammar: "c_sharp", name: "C# 12/13 (file-scoped namespace, primary ctor, collection expr)", source: "namespace A;\nrecord P(int X);\nclass C(int a)\n{\n    int[] v = [1, 2];\n}\n" },
  { grammar: "java", name: "Java 21 (sealed, record patterns, switch expr)", source: "sealed interface S permits A {}\nrecord A(int x) implements S {}\nclass K {\n  int f(Object o) {\n    return switch (o) { case A(int x) -> x; default -> 0; };\n  }\n}\n" },
  { grammar: "python", name: "Python 3.12 (type alias, PEP 695 generics, match)", source: "type X = int\n\ndef f[T](a: T) -> T:\n    match a:\n        case 1:\n            return a\n    return a\n" },
  { grammar: "typescript", name: "TypeScript 5.x (decorators, accessor, satisfies)", source: "@Component({ selector: 'a' })\nclass A {\n  accessor x = 1;\n  constructor(private s: S) {}\n}\nconst o = { a: 1 } satisfies object;\n" },
  { grammar: "tsx", name: "TSX (JSX element with props)", source: "const A = () => <Foo x={1} />;\n" },
  { grammar: "javascript", name: "JavaScript ES2022+ (private fields, static block, ?. ??)", source: "class A {\n  #p = 1;\n  static {}\n}\nconst x = a?.b ?? c;\n" },
  { grammar: "kotlin", name: "Kotlin 2.x (data/sealed/fun interface, extension fn, companion)", source: "data class P(val x: Int)\nfun interface F {\n    fun f()\n}\nsealed interface S\nfun Int.ext() = this\nclass A {\n    companion object {\n        const val X = 1\n    }\n}\n" },
  { grammar: "go", name: "Go 1.18+ (generics, type constraints, range-over-func)", source: "package main\n\ntype Number interface{ ~int | ~float64 }\n\nfunc Sum[T Number](xs []T) T {\n\tvar s T\n\tfor _, x := range xs {\n\t\ts += x\n\t}\n\treturn s\n}\n" },
  { grammar: "rust", name: "Rust 2021 (traits, impl Trait, let-else, async, const generics)", source: "trait T { fn f(&self) -> impl Iterator<Item = u8>; }\nstruct S<const N: usize>([u8; N]);\nimpl<const N: usize> S<N> {\n    async fn g(&self) -> Option<u8> {\n        let Some(x) = self.0.first() else { return None };\n        Some(*x)\n    }\n}\n" },
  { grammar: "ruby", name: "Ruby 3.x (endless method, pattern matching, Data.define)", source: "P = Data.define(:x, :y)\ndef sq(x) = x * x\ncase {a: 1}\nin {a: Integer => n}\n  puts n\nend\nmodule M\n  class C; end\nend\n" },
  { grammar: "c", name: "C11/C23 (_Generic, designated init, static_assert)", source: "#include <stdio.h>\nstatic_assert(sizeof(int) >= 4, \"int\");\nstruct P { int x; int y; };\n#define T(x) _Generic((x), int: 1, default: 0)\nint main(void) {\n    struct P p = { .x = 1, .y = 2 };\n    return T(p.x);\n}\n" },
  { grammar: "cpp", name: "C++20 (concepts, templates, namespaces, structured bindings)", source: "#include <vector>\ntemplate <typename T> concept Num = requires(T a) { a + a; };\nnamespace n {\ntemplate <Num T> T add(T a, T b) { return a + b; }\nclass C { public: auto f() const { auto [a, b] = std::pair{1, 2}; return a + b; } };\n}\n" },
];

for (const c of CASES) {
  test(`grammar parses modern syntax without errors: ${c.name}`, async () => {
    const parser = await createTreeSitterParser(c.grammar);
    const tree = parser.parse(c.source);
    assert.ok(tree);
    assert.equal(tree!.rootNode.hasError, false);
  });
}
