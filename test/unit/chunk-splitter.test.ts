import { test } from "node:test";
import assert from "node:assert/strict";
import { splitOversizedChunks, type SplitChunk } from "../../src/indexing/chunk-splitter.js";

/**
 * Embedding memory grows quadratically with token count (a 4k-token chunk
 * costs ~4.5 GB in onnxruntime), so chunks above a size budget are split
 * into line windows before embedding instead of being truncated away.
 */

const chunk = (text: string, startLine = 1, over: Partial<SplitChunk> = {}): SplitChunk => ({
  text,
  startLine,
  endLine: startLine + text.split("\n").length - 1,
  symbol: undefined,
  chunkType: "block",
  ...over,
});

test("chunks within the budget pass through untouched", () => {
  const c = chunk("a\nb\nc");
  assert.deepEqual(splitOversizedChunks([c], 100), [c]);
});

test("an oversized chunk is split on line boundaries into pieces within the budget", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line-${i}-xxxxxxxx`); // 15 chars each
  const pieces = splitOversizedChunks([chunk(lines.join("\n"), 10, { symbol: "foo", chunkType: "function" })], 50);
  assert.ok(pieces.length > 1);
  for (const p of pieces) assert.ok(p.text.length <= 50, `piece too long: ${p.text.length}`);
  assert.equal(pieces.map((p) => p.text).join("\n"), lines.join("\n"), "no content may be lost");
  assert.equal(pieces[0]!.startLine, 10);
  assert.equal(pieces.at(-1)!.endLine, 19);
  for (const p of pieces) {
    assert.equal(p.symbol, "foo");
    assert.equal(p.chunkType, "function");
  }
});

test("line ranges of consecutive pieces are contiguous and non-overlapping", () => {
  const lines = Array.from({ length: 9 }, () => "x".repeat(20));
  const pieces = splitOversizedChunks([chunk(lines.join("\n"))], 45);
  for (let i = 1; i < pieces.length; i++) assert.equal(pieces[i]!.startLine, pieces[i - 1]!.endLine + 1);
});

test("a single line longer than the budget is hard-split, with distinct part numbers", () => {
  const pieces = splitOversizedChunks([chunk("y".repeat(250))], 100);
  assert.equal(pieces.length, 3);
  assert.equal(pieces.map((p) => p.text).join(""), "y".repeat(250));
  assert.deepEqual(pieces.map((p) => p.part), [0, 1, 2]);
  assert.ok(pieces.every((p) => p.startLine === 1 && p.endLine === 1));
});

test("pieces split on line boundaries carry no part number", () => {
  const pieces = splitOversizedChunks([chunk(["a".repeat(30), "b".repeat(30)].join("\n"))], 40);
  assert.equal(pieces.length, 2);
  assert.ok(pieces.every((p) => p.part === undefined));
});
