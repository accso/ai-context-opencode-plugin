import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionMemory } from "../../src/hook/session-memory.js";

const search = JSON.stringify([
  { relativePath: "src/a.ts", startLine: 3, endLine: 9, symbol: "foo", text: "x", score: 1 },
  { relativePath: "src/b.ts", startLine: 1, endLine: 2, text: "y", score: 0.5 },
]);

test("records locations from semantic_search, find_symbol and analyze_impact", () => {
  const m = createSessionMemory();
  m.record("s1", "semantic_search", search);
  m.record("s1", "find_symbol", JSON.stringify({ matches: [{ name: "Bar", path: "src/c.ts", startLine: 5, endLine: 8 }] }));
  m.record("s1", "analyze_impact", JSON.stringify({ symbol: "baz", definitions: [{ path: "src/d.ts", startLine: 7, endLine: 9 }] }));
  const block = m.compactionBlock("s1")!;
  assert.match(block, /src\/a\.ts:3-9 \(foo\)/);
  assert.match(block, /src\/b\.ts:1-2/);
  assert.match(block, /src\/c\.ts:5-8 \(Bar\)/);
  assert.match(block, /src\/d\.ts:7-9 \(baz\)/);
  assert.match(block, /semantic_search/);
});

test("ignores other tools, broken JSON and other sessions", () => {
  const m = createSessionMemory();
  m.record("s1", "grep", search);
  m.record("s1", "semantic_search", "not json");
  m.record("s2", "semantic_search", search);
  assert.equal(m.compactionBlock("s1"), null);
  assert.ok(m.compactionBlock("s2"));
});

test("deduplicates, keeps the most recent entries within the cap", () => {
  const m = createSessionMemory({ maxEntries: 3 });
  for (let i = 0; i < 5; i++) {
    m.record("s", "find_symbol", JSON.stringify({ matches: [{ name: `n${i}`, path: `f${i}.ts`, startLine: 1, endLine: 1 }] }));
  }
  m.record("s", "find_symbol", JSON.stringify({ matches: [{ name: "n3", path: "f3.ts", startLine: 1, endLine: 1 }] }));
  const block = m.compactionBlock("s")!;
  assert.doesNotMatch(block, /f0\.ts|f1\.ts/);
  assert.equal((block.match(/f3\.ts/g) ?? []).length, 1);
  assert.match(block, /f4\.ts/);
  assert.equal(block.split("\n").filter((l) => l.startsWith("- ")).length, 3);
});
