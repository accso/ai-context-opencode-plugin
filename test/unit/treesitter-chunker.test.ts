import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkWithTreeSitter } from "../../src/indexing/tree-sitter/treesitter-chunker.js";

/**
 * Unit tests for the tree-sitter-driven boundary chunker -- the TS port
 * of `.ai-context/watcher/chunker.py`'s `_chunk_by_treesitter` (its
 * "Tier-1" tree-sitter chunking, used for TypeScript/TSX/Java/C# only;
 * see language-grammars.ts's own doc comment for why the original
 * codebase itself never extended this to every language). Uses the
 * REAL `tree-sitter-wasms` grammar files (see
 * tree-sitter-parser-loader.test.ts's own rationale for not mocking
 * the parser).
 */

test("chunkWithTreeSitter splits a TypeScript file at class/interface/enum/type-alias/function boundaries", async () => {
  const content = [
    "export class Bar {",
    "  method() {}",
    "}",
    "",
    "export interface Baz {}",
    "export enum Qux { A, B }",
    "export type Alias = string;",
    "function standalone() {}",
    "",
  ].join("\n");

  const chunks = await chunkWithTreeSitter(content, ".ts");
  assert.ok(chunks);
  const symbols = chunks!.map((c) => c.symbol);
  assert.deepEqual(symbols, ["Bar", "Baz", "Qux", "Alias", "standalone"]);
  assert.deepEqual(
    chunks!.map((c) => c.chunkType),
    ["class", "interface", "enum", "typealias", "function"],
  );
});

test("chunkWithTreeSitter emits a preamble chunk for content before the first declaration", async () => {
  const content = ['import { Foo } from "./foo";', "", "export class Bar {}", ""].join("\n");
  const chunks = await chunkWithTreeSitter(content, ".ts");
  assert.ok(chunks);
  assert.equal(chunks![0]!.chunkType, "block");
  assert.equal(chunks![0]!.symbol, undefined);
  assert.ok(chunks![0]!.text.includes('import { Foo } from "./foo";'));
  assert.equal(chunks![1]!.symbol, "Bar");
});

test("chunkWithTreeSitter omits an empty preamble when the first line is already a declaration", async () => {
  const content = "export class Bar {}\n";
  const chunks = await chunkWithTreeSitter(content, ".ts");
  assert.ok(chunks);
  assert.equal(chunks!.length, 1);
  assert.equal(chunks![0]!.symbol, "Bar");
});

test("chunkWithTreeSitter assigns 1-based, non-overlapping start/end line numbers", async () => {
  const content = ["export class A {}", "export class B {", "  method() {}", "}"].join("\n");
  const chunks = await chunkWithTreeSitter(content, ".ts");
  assert.ok(chunks);
  assert.deepEqual(
    chunks!.map((c) => [c.startLine, c.endLine]),
    [
      [1, 1],
      [2, 4],
    ],
  );
});

test("chunkWithTreeSitter returns null (fallback signal) for an extension with no Tier-1 grammar", async () => {
  const chunks = await chunkWithTreeSitter("def foo():\n    pass\n", ".py");
  assert.equal(chunks, null);
});

test("chunkWithTreeSitter returns null when the file has zero top-level declarations", async () => {
  const chunks = await chunkWithTreeSitter('const x = 1;\nconsole.log("no declarations here");\n', ".ts");
  assert.equal(chunks, null);
});

test("chunkWithTreeSitter recurses through (but never emits a chunk for) a C# namespace_declaration container", async () => {
  const content = ["namespace Foo {", "  public class Bar {}", "  public interface IBaz {}", "}", ""].join("\n");
  const chunks = await chunkWithTreeSitter(content, ".cs");
  assert.ok(chunks);
  // "namespace Foo {" itself is never emitted as its own chunk (it's a
  // containerOnlyNodeTypes entry) -- it becomes the preamble chunk
  // (undefined symbol) preceding the first real declaration, exactly
  // like an import statement would.
  assert.deepEqual(
    chunks!.map((c) => c.symbol),
    [undefined, "Bar", "IBaz"],
  );
  assert.ok(!chunks!.some((c) => c.chunkType === "namespace"));
});

test("chunkWithTreeSitter handles Java constructors/methods/records", async () => {
  const content = ["public class Bar {", "  public Bar() {}", "  void method() {}", "}", "record Rec(int x) {}", ""].join(
    "\n",
  );
  const chunks = await chunkWithTreeSitter(content, ".java");
  assert.ok(chunks);
  // Bar's constructor/method are nested inside class_declaration's own
  // body and must NOT be separately chunked -- matches chunker.py's
  // "does not descend into a matched node's own children" contract.
  assert.deepEqual(
    chunks!.map((c) => c.symbol),
    ["Bar", "Rec"],
  );
});

test("chunkWithTreeSitter works for TSX (JSX-flavored) syntax", async () => {
  const content = ["export function App() {", "  return <div>hi</div>;", "}", ""].join("\n");
  const chunks = await chunkWithTreeSitter(content, ".tsx");
  assert.ok(chunks);
  assert.deepEqual(
    chunks!.map((c) => c.symbol),
    ["App"],
  );
});
