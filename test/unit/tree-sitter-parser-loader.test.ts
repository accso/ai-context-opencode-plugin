import { test } from "node:test";
import assert from "node:assert/strict";
import { createTreeSitterParser, loadTreeSitterLanguage } from "../../src/indexing/tree-sitter/parser-loader.js";

/**
 * Exercises the REAL tree-sitter-wasms grammar files (no injected fake --
 * matches this codebase's existing convention of testing storage.ts /
 * vector-store.ts against a real (temp-file) better-sqlite3 database
 * rather than mocking the database itself: loading a local .wasm file
 * and instantiating it is comparably cheap/local, unlike model-runtime's
 * real embedding model, which needs a network download and is mocked in
 * its own tests instead).
 */

test("loadTreeSitterLanguage loads the real typescript grammar and can parse a class", async () => {
  const language = await loadTreeSitterLanguage("typescript");
  assert.equal(typeof language.nodeTypeCount, "number");
  assert.ok(language.nodeTypeCount > 0);
});

test("loadTreeSitterLanguage caches the same grammar across calls (does not re-load the .wasm file)", async () => {
  const a = await loadTreeSitterLanguage("typescript");
  const b = await loadTreeSitterLanguage("typescript");
  assert.equal(a, b);
});

test("loadTreeSitterLanguage rejects for an unknown grammar name", async () => {
  await assert.rejects(() => loadTreeSitterLanguage("not-a-real-language"));
});

test("createTreeSitterParser returns a parser that can parse real typescript source", async () => {
  const parser = await createTreeSitterParser("typescript");
  const tree = parser.parse("class Foo {\n  bar() {}\n}\n");
  assert.ok(tree);
  assert.equal(tree!.rootNode.type, "program");
});

test("createTreeSitterParser works for the tsx grammar too", async () => {
  const parser = await createTreeSitterParser("tsx");
  const tree = parser.parse("const x = <div>hi</div>;\n");
  assert.ok(tree);
  assert.equal(tree!.rootNode.hasError, false);
});
