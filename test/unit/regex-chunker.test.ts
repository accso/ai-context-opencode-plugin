import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkWithRegexPatterns } from "../../src/indexing/regex-chunker.js";

/**
 * Unit tests for the regex-based top-level chunker -- TS port of
 * `.ai-context/watcher/chunker.py`'s `_chunk_by_pattern`/
 * `_detect_chunk_type`, covering the ~9 languages the original only
 * ever regex-chunks (never tree-sitter-chunks):
 * Kotlin/JS/Python/Swift/Go/Rust/Ruby/PHP/C/C++
 * (`port-tree-sitter-chunker-followups`, item 3a). TypeScript/TSX/Java/
 * C# are intentionally NOT covered here -- they already go through
 * `treesitter-chunker.ts` first (see indexing.ts's dispatch); this
 * module is consulted only as the next fallback tier, before the final
 * `chunkText` paragraph fallback.
 */

test("chunkWithRegexPatterns splits a Kotlin file at class/object/interface/fun/typealias boundaries", () => {
  const content = [
    "class Foo {",
    "  fun method() {}",
    "}",
    "",
    "object Bar",
    "interface Baz",
    "fun standalone() {}",
    "typealias Alias = String",
    "",
  ].join("\n");
  const chunks = chunkWithRegexPatterns(content, ".kt");
  assert.ok(chunks);
  assert.deepEqual(
    chunks!.map((c) => c.symbol),
    ["Foo", "Bar", "Baz", "standalone", "Alias"],
  );
  assert.deepEqual(
    chunks!.map((c) => c.chunkType),
    ["class", "class", "class", "function", "class"],
  );
});

test("chunkWithRegexPatterns splits a JavaScript file the same way as the TypeScript top-level pattern", () => {
  const content = ["export class Foo {}", "", "export function bar() {}", "const baz = () => {}", ""].join("\n");
  const chunks = chunkWithRegexPatterns(content, ".js");
  assert.ok(chunks);
  assert.deepEqual(
    chunks!.map((c) => c.symbol),
    ["Foo", "bar", "baz"],
  );
});

test("chunkWithRegexPatterns splits a Python file at top-level class/def boundaries", () => {
  const content = ["class Foo:", "    def method(self):", "        pass", "", "def standalone():", "    pass", ""].join(
    "\n",
  );
  const chunks = chunkWithRegexPatterns(content, ".py");
  assert.ok(chunks);
  assert.deepEqual(
    chunks!.map((c) => c.symbol),
    ["Foo", "standalone"],
  );
  assert.deepEqual(
    chunks!.map((c) => c.chunkType),
    ["class", "function"],
  );
});

test("chunkWithRegexPatterns splits a Swift file at class/struct/enum/protocol/func/extension/actor boundaries", () => {
  const content = ["struct Foo {}", "", "func bar() {}", "public final class Baz {}", ""].join("\n");
  const chunks = chunkWithRegexPatterns(content, ".swift");
  assert.ok(chunks);
  assert.deepEqual(
    chunks!.map((c) => c.symbol),
    ["Foo", "bar", "Baz"],
  );
});

test("chunkWithRegexPatterns splits a Go file at func/type boundaries, including methods with a receiver", () => {
  const content = ["func Standalone() {}", "", "func (r *Repo) Save() {}", "type Foo struct{}", ""].join("\n");
  const chunks = chunkWithRegexPatterns(content, ".go");
  assert.ok(chunks);
  assert.deepEqual(
    chunks!.map((c) => c.symbol),
    ["Standalone", "Save", "Foo"],
  );
});

test("chunkWithRegexPatterns splits a Rust file at top-level fn/struct/enum/trait/impl boundaries", () => {
  const content = ["pub fn foo() {}", "", "struct Bar {}", "impl Bar {}", ""].join("\n");
  const chunks = chunkWithRegexPatterns(content, ".rs");
  assert.ok(chunks);
  assert.deepEqual(
    chunks!.map((c) => c.symbol),
    ["foo", "Bar", "Bar"],
  );
});

test("chunkWithRegexPatterns splits a Ruby file at top-level class/module/def boundaries, incl. namespaced constants", () => {
  const content = ["class Foo::Bar", "  def method", "  end", "end", "", "def standalone", "end", ""].join("\n");
  const chunks = chunkWithRegexPatterns(content, ".rb");
  assert.ok(chunks);
  assert.deepEqual(
    chunks!.map((c) => c.symbol),
    ["Foo::Bar", "standalone"],
  );
});

test("chunkWithRegexPatterns splits a PHP file at top-level class/interface/trait/function boundaries", () => {
  const content = ["abstract class Foo {}", "", "function bar() {}", ""].join("\n");
  const chunks = chunkWithRegexPatterns(content, ".php");
  assert.ok(chunks);
  assert.deepEqual(
    chunks!.map((c) => c.symbol),
    ["Foo", "bar"],
  );
});

test("chunkWithRegexPatterns splits a C file at struct/enum/union declarations and function definitions", () => {
  const content = ["struct Point { int x; int y; };", "", "int add(int a, int b) {", "  return a + b;", "}", ""].join(
    "\n",
  );
  const chunks = chunkWithRegexPatterns(content, ".c");
  assert.ok(chunks);
  assert.deepEqual(
    chunks!.map((c) => c.symbol),
    ["Point", "add"],
  );
});

test("chunkWithRegexPatterns does not mistake C control-flow keywords for a function name", () => {
  const content = ["int main() {", "  if (x > 0) {", "    return 1;", "  }", "  return 0;", "}", ""].join("\n");
  const chunks = chunkWithRegexPatterns(content, ".c");
  assert.ok(chunks);
  assert.deepEqual(
    chunks!.map((c) => c.symbol),
    ["main"],
  );
});

test("chunkWithRegexPatterns returns null for an extension with no regex-chunking table entry", () => {
  const chunks = chunkWithRegexPatterns("<html></html>", ".html");
  assert.equal(chunks, null);
});

test("chunkWithRegexPatterns returns null when the file has zero top-level declarations (triggering chunkText fallback)", () => {
  const chunks = chunkWithRegexPatterns("print('no declarations here')\n", ".py");
  assert.equal(chunks, null);
});

test("chunkWithRegexPatterns emits a preamble chunk for content before the first declaration", () => {
  const content = ["import os", "", "def foo():", "    pass", ""].join("\n");
  const chunks = chunkWithRegexPatterns(content, ".py");
  assert.ok(chunks);
  assert.equal(chunks![0]!.chunkType, "block");
  assert.equal(chunks![0]!.symbol, undefined);
  assert.ok(chunks![0]!.text.includes("import os"));
  assert.equal(chunks![1]!.symbol, "foo");
});

test("chunkWithRegexPatterns matches a const arrow-function assignment as a function chunk (shared by JS and TS top-level pattern)", () => {
  const content = ["const handler = (x) => x + 1;", ""].join("\n");
  const chunks = chunkWithRegexPatterns(content, ".js");
  assert.ok(chunks);
  assert.deepEqual(
    chunks!.map((c) => [c.symbol, c.chunkType]),
    [["handler", "function"]],
  );
});
