import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkVueSfc, chunkSql, chunkYaml } from "../../src/indexing/data-format-chunker.js";

/**
 * Unit tests for the bespoke Vue/SQL/YAML splitters -- TS port of
 * `.ai-context/watcher/chunker.py`'s `_chunk_vue`/`_chunk_sql`/
 * `_chunk_yaml` (`port-tree-sitter-chunker-followups`, item 4).
 * Markdown's `_chunk_markdown` is intentionally NOT ported here --
 * this plugin's PageIndex-style doc-tree feature already covers
 * eligible Markdown files instead (see doc-tree-builder.ts), and
 * non-tree-eligible Markdown already falls back to `chunkText`
 * unchanged, matching chunker.py's own fallback for that case.
 */

test("chunkVueSfc splits a Vue SFC into one chunk per top-level block, classified by tag", () => {
  const content = [
    "<template>",
    "  <div>{{ msg }}</div>",
    "</template>",
    "",
    '<script setup lang="ts">',
    "const msg = 'hi'",
    "</script>",
    "",
    "<style scoped>",
    "div { color: red; }",
    "</style>",
    "",
  ].join("\n");

  const chunks = chunkVueSfc(content);
  assert.ok(chunks);
  assert.deepEqual(
    chunks!.map((c) => c.chunkType),
    ["component", "function", "block"],
  );
  assert.equal(chunks![0]!.symbol, "<template>");
  assert.equal(chunks![1]!.symbol, '<script setup lang="ts">');
  assert.equal(chunks![2]!.symbol, "<style scoped>");
  assert.ok(chunks![0]!.text.includes("{{ msg }}"));
  assert.ok(chunks![1]!.text.includes("const msg"));
  assert.ok(chunks![2]!.text.includes("color: red"));
});

test("chunkVueSfc emits a preamble chunk for content before the first SFC block", () => {
  const content = ["<!-- top-of-file comment -->", "", "<template>", "  <div />", "</template>", ""].join("\n");
  const chunks = chunkVueSfc(content);
  assert.ok(chunks);
  assert.equal(chunks![0]!.chunkType, "block");
  assert.equal(chunks![0]!.symbol, undefined);
  assert.ok(chunks![0]!.text.includes("top-of-file comment"));
});

test("chunkVueSfc returns null when the file has no SFC blocks (triggering chunkText fallback)", () => {
  assert.equal(chunkVueSfc("just some plain text\nwith no SFC blocks\n"), null);
});

test("chunkSql groups all short statements within 80 lines into one chunk, deriving a symbol from the first CREATE statement found", () => {
  const content = [
    "CREATE TABLE users (",
    "  id INTEGER PRIMARY KEY",
    ");",
    "",
    "CREATE UNIQUE INDEX idx_users_id ON users(id);",
    "",
    "INSERT INTO users (id) VALUES (1);",
  ].join("\n");

  const chunks = chunkSql(content);
  assert.ok(chunks);
  assert.equal(chunks!.length, 1);
  assert.equal(chunks![0]!.chunkType, "statement");
  assert.equal(chunks![0]!.symbol, "CREATE TABLE users");
  assert.equal(chunks![0]!.text, content);
});

test("chunkSql strips -- line comments before deriving a symbol, so commented-out prose isn't mistaken for a CREATE statement", () => {
  const content = [
    "-- All tables use CREATE TABLE IF NOT EXISTS.",
    "CREATE TABLE IF NOT EXISTS accounts (id INTEGER);",
  ].join("\n");
  const chunks = chunkSql(content);
  assert.ok(chunks);
  assert.equal(chunks!.length, 1);
  assert.equal(chunks![0]!.symbol, "CREATE TABLE accounts");
});

test("chunkSql groups consecutive short statements into one chunk, up to 80 lines, then starts a new chunk", () => {
  const statements = Array.from({ length: 90 }, (_, i) => `INSERT INTO t VALUES (${i});`);
  const content = statements.join("\n");
  const chunks = chunkSql(content);
  assert.ok(chunks);
  assert.equal(chunks!.length, 2);
  assert.equal(chunks![0]!.startLine, 1);
  assert.equal(chunks![0]!.endLine, 80);
  assert.equal(chunks![1]!.startLine, 81);
  assert.equal(chunks![1]!.endLine, 90);
});

test("chunkSql returns null when the content has no statement-terminating semicolon (triggering chunkText fallback)", () => {
  assert.equal(chunkSql("SELECT * FROM users -- no trailing semicolon"), null);
});

test("chunkYaml splits content at non-indented top-level keys", () => {
  const content = ["name: demo", "version: 1.0.0", "dependencies:", "  foo: ^1.0.0", "  bar: ^2.0.0", ""].join("\n");
  const chunks = chunkYaml(content);
  assert.ok(chunks);
  assert.deepEqual(
    chunks!.map((c) => c.symbol),
    ["name", "version", "dependencies"],
  );
  assert.ok(chunks![2]!.text.includes("foo: ^1.0.0"));
});

test("chunkYaml ignores comment lines and supports TOML's '=' top-level keys", () => {
  const content = ["# a comment, not a key", 'name = "demo"', "version = 1", ""].join("\n");
  const chunks = chunkYaml(content);
  assert.ok(chunks);
  assert.equal(chunks!.length, 3);
  assert.equal(chunks![0]!.symbol, undefined);
  assert.ok(chunks![0]!.text.includes("a comment"));
  assert.deepEqual(
    chunks!.slice(1).map((c) => c.symbol),
    ["name", "version"],
  );
});

test("chunkYaml returns null when no top-level key is found (triggering chunkText fallback)", () => {
  assert.equal(chunkYaml("  - just an indented list item\n  - another one\n"), null);
});

test("chunkYaml splits a long list at item boundaries, groups small items and names them", () => {
  const items = Array.from({ length: 12 }, (_, i) => [`  - slug: epic-${i}`, `    title: ${"T".repeat(60)}`, `    status: Draft`]).flat();
  const content = ["version: 1", "epics:", ...items, "other: x", ""].join("\n");
  const chunks = chunkYaml(content, 300)!;
  const epics = chunks.filter((c) => c.symbol?.startsWith("epics"));
  assert.ok(epics.length > 2, "list is split into several chunks");
  for (const c of epics) {
    const body = c.text.split("\n").filter((l) => l.trim() !== "");
    const firstItemLine = c === epics[0] ? body[1] : body[1];
    assert.match(firstItemLine!, /^ {2}- slug: /, "every chunk starts at an item head");
    assert.ok(c.text.length <= 300 + 20);
  }
  assert.equal(epics[0]!.symbol, "epics[epic-0..epic-" + epics[0]!.text.match(/epic-(\d+)/g)!.slice(-1)[0]!.split("-")[1] + "]");
  assert.ok(epics[1]!.text.startsWith("epics:\n  - slug: "), "later chunks carry the parent key");
  // line ranges are contiguous and cover the key block
  for (let i = 1; i < epics.length; i++) assert.equal(epics[i]!.startLine, epics[i - 1]!.endLine + 1);
  assert.ok(chunks.some((c) => c.symbol === "other"));
});

test("chunkYaml leaves small keys and non-list values untouched", () => {
  const content = "a:\n  - x\n  - y\nb:\n" + "  k: v\n".repeat(200);
  const chunks = chunkYaml(content, 100)!;
  assert.deepEqual(chunks.filter((c) => c.symbol === "a").length, 1);
  assert.deepEqual(chunks.filter((c) => c.symbol === "b").length, 1);
});
