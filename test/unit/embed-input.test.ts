import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEmbedInput } from "../../src/indexing/embed-input.js";
import { createIndexer } from "../../src/indexing/indexing.js";
import { createVectorStore } from "../../src/storage/vector-store.js";

test("buildEmbedInput prefixes path and symbol before the text", () => {
  const input = buildEmbedInput({
    relativePath: "src/auth/login.ts",
    symbol: "LoginService",
    text: "class LoginService {}",
  });
  assert.equal(
    input,
    "File: src/auth/login.ts\nSymbol: LoginService\n\nclass LoginService {}",
  );
});

test("buildEmbedInput omits the symbol line when there is no symbol", () => {
  assert.equal(
    buildEmbedInput({ relativePath: "a.md", text: "hello" }),
    "File: a.md\n\nhello",
  );
});

test("indexer embeds path-prefixed text but stores the raw chunk text", async () => {
  const store = createVectorStore({ path: ":memory:" });
  const embedded: string[] = [];
  const indexer = createIndexer({
    vectorStore: store,
    embedDocument: async (text) => {
      embedded.push(text);
      return [1, 2];
    },
    readFile: async () => "export function bar() {}\n",
  });
  await indexer.indexFiles([{ file: "src/b.ts", event: "add" }]);
  assert.ok(embedded[0]!.startsWith("File: src/b.ts\n"));
  assert.match(embedded[0]!, /Symbol: bar/);
  const stored = store.getAllChunks();
  assert.ok(!stored[0]!.text.startsWith("File:"));
});
