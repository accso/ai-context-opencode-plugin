import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText } from "../../src/indexing/chunker.js";

/**
 * Unit tests for the paragraph-based fallback chunker -- a TS port of
 * `.ai-context/watcher/chunker.py`'s `_chunk_by_paragraphs` (the
 * language-agnostic fallback used there for any file type without a
 * dedicated tree-sitter/regex splitter). This is deliberately the FIRST
 * slice of `chunker.py`'s ~1150-line, 12+-language port -- see plan.md's
 * "document-side indexing" section for why: it's the one strategy that
 * works for every file type with no language-specific parsing, so it
 * unblocks the end-to-end index -> embed -> store -> search pipeline
 * today. Per-language tree-sitter-aware chunking (the rest of
 * chunker.py) is tracked as its own follow-up todo instead of being
 * ported in one giant increment.
 */

test("chunkText splits on blank lines into separate chunks", () => {
  const content = "line one\nline two\n\nline three\nline four";
  const chunks = chunkText(content);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]!.text, "line one\nline two");
  assert.equal(chunks[1]!.text, "line three\nline four");
});

test("chunkText assigns 1-based start/end line numbers per chunk", () => {
  const content = "a\nb\n\nc\nd\ne";
  const chunks = chunkText(content);
  assert.deepEqual(chunks[0], { text: "a\nb", startLine: 1, endLine: 2, symbol: undefined, chunkType: "block" });
  assert.deepEqual(chunks[1], { text: "c\nd\ne", startLine: 4, endLine: 6, symbol: undefined, chunkType: "block" });
});

test("chunkText collapses multiple consecutive blank lines without emitting empty chunks", () => {
  const content = "a\n\n\n\nb";
  const chunks = chunkText(content);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]!.text, "a");
  assert.equal(chunks[1]!.text, "b");
});

test("chunkText caps each chunk at maxLines, starting a new one once the limit is hit", () => {
  const lines = Array.from({ length: 5 }, (_, i) => `line${i}`);
  const chunks = chunkText(lines.join("\n"), { maxLines: 2 });
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]!.text, "line0\nline1");
  assert.equal(chunks[1]!.text, "line2\nline3");
  assert.equal(chunks[2]!.text, "line4");
});

test("chunkText returns an empty array for empty/whitespace-only content", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("\n\n\n"), []);
});

test("chunkText trims trailing/leading whitespace within a chunk's text", () => {
  const chunks = chunkText("  a  \n  b  ");
  assert.equal(chunks[0]!.text, "a  \n  b");
});
