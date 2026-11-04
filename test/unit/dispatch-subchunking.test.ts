import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDispatchSubchunking } from "../../src/indexing/tree-sitter/dispatch-subchunking.js";
import type { TreeSitterChunk } from "../../src/indexing/tree-sitter/treesitter-chunker.js";

/**
 * Unit tests for the dispatch-table/switch-case sub-chunking pass -- TS
 * port of `.ai-context/watcher/chunker.py`'s `_apply_dispatch_subchunking`/
 * `_chunk_dispatch_arms` (`port-tree-sitter-chunker-followups`, item 2).
 * Splits a function/method chunk containing a `switch`/`when`/`match`
 * with >= 3 arms into a "head" chunk (declaration + dispatch header)
 * plus one `chunkType: "case"` chunk per arm, so each arm becomes
 * independently searchable. Covers the full `_DISPATCH_TABLE` scope:
 * `.ts`/`.tsx`/`.java`/`.cs`/`.js`/`.jsx`/`.swift` (switch/case),
 * `.kt`/`.kts` (when/->), and `.py` (match/case, indentation-based, no
 * braces).
 */

function chunk(text: string, startLine: number, symbol = "fn"): TreeSitterChunk {
  return { text, startLine, endLine: startLine + text.split("\n").length - 1, symbol, chunkType: "function" };
}

test("applyDispatchSubchunking splits a >=3-arm switch into a head chunk plus one chunk per case", () => {
  const text = [
    "function fn(x) {",
    "  switch (x) {",
    '    case "a":',
    "      doA();",
    "      break;",
    '    case "b":',
    "      doB();",
    "      break;",
    '    case "c":',
    "      doC();",
    "      break;",
    "  }",
    "}",
  ].join("\n");
  const input = [chunk(text, 1)];
  const result = applyDispatchSubchunking(input, ".ts");

  assert.equal(result.length, 4);
  assert.equal(result[0]!.chunkType, "function");
  // KNOWN GAP (faithfully ported from chunker.py's own
  // _chunk_dispatch_arms, verified against a direct Python repro): the
  // "head" chunk excludes the `switch (x) {` header line itself -- the
  // first arm's regex match (`^\s*case...`) has its `\s*` eat the
  // switch block's OWN leading newline (since the arm-search text
  // starts right after the switch's opening `{`), which shifts the
  // computed line offset for the FIRST arm only back by one line, so
  // the switch header ends up merged into the first "case" chunk
  // instead of the head chunk. Subsequent arms are unaffected because
  // their preceding newline belongs to the previous arm's own body, not
  // the switch header.
  assert.equal(result[0]!.text, "function fn(x) {");
  assert.ok(result[1]!.text.includes("switch (x) {"));
  assert.deepEqual(
    result.slice(1).map((c) => [c.chunkType, c.symbol]),
    [
      ["case", "a"],
      ["case", "b"],
      ["case", "c"],
    ],
  );
});

test("applyDispatchSubchunking leaves a chunk unchanged when it has fewer than 3 arms", () => {
  const text = ["function fn(x) {", "  switch (x) {", '    case "a":', "      doA();", "  }", "}"].join("\n");
  const input = [chunk(text, 1)];
  const result = applyDispatchSubchunking(input, ".ts");
  assert.deepEqual(result, input);
});

test("applyDispatchSubchunking leaves a chunk unchanged when it has no switch at all", () => {
  const input = [chunk("function fn() { return 1; }", 1)];
  const result = applyDispatchSubchunking(input, ".ts");
  assert.deepEqual(result, input);
});

test("applyDispatchSubchunking is a no-op for extensions without a dispatch-table entry", () => {
  const text = [
    "func fn(x) {",
    "  switch x {",
    '  case "a": doA()',
    '  case "b": doB()',
    '  case "c": doC()',
    "  }",
    "}",
  ].join("\n");
  const input = [chunk(text, 1)];
  const result = applyDispatchSubchunking(input, ".go");
  assert.deepEqual(result, input);
});

test("applyDispatchSubchunking splits a Kotlin >=3-arm `when` into a head chunk plus one chunk per arm", () => {
  const text = [
    "fun fn(x: String) {",
    "  when (x) {",
    '    "a" -> doA()',
    '    "b" -> doB()',
    '    "c" -> doC()',
    "  }",
    "}",
  ].join("\n");
  const input = [chunk(text, 1)];
  const result = applyDispatchSubchunking(input, ".kt");

  assert.equal(result.length, 4);
  assert.equal(result[0]!.text, "fun fn(x: String) {");
  // Same off-by-one quirk as switch/case: the when header merges into
  // the first arm chunk (see the KNOWN GAP note above the switch test).
  assert.ok(result[1]!.text.includes("when (x) {"));
  assert.deepEqual(
    result.slice(1).map((c) => [c.chunkType, c.symbol]),
    [
      ["case", "a"],
      ["case", "b"],
      ["case", "c"],
    ],
  );
});

test("applyDispatchSubchunking splits a Python >=3-arm `match` into a head chunk plus one chunk per arm", () => {
  // Python's `match` has no braces -- arm-matching falls back to the
  // whole chunk body (dispatchBlockSpan returns undefined), unlike the
  // brace-scoped languages above.
  const text = [
    "def fn(x):",
    "    match x:",
    '        case "a":',
    "            do_a()",
    '        case "b":',
    "            do_b()",
    '        case "c":',
    "            do_c()",
  ].join("\n");
  const input = [chunk(text, 1)];
  const result = applyDispatchSubchunking(input, ".py");

  assert.equal(result.length, 4);
  assert.equal(result[0]!.text, ["def fn(x):", "    match x:"].join("\n"));
  assert.deepEqual(
    result.slice(1).map((c) => [c.chunkType, c.symbol]),
    [
      ["case", "a"],
      ["case", "b"],
      ["case", "c"],
    ],
  );
});

test("applyDispatchSubchunking scopes arm-matching to the switch's own brace body, not the whole chunk", () => {
  // A `case`-like label appearing OUTSIDE the switch's braces must not be
  // picked up as a 4th arm.
  const text = [
    "function fn(x) {",
    "  switch (x) {",
    '    case "a":',
    "      doA();",
    "      break;",
    '    case "b":',
    "      doB();",
    "      break;",
    '    case "c":',
    "      doC();",
    "      break;",
    "  }",
    '  doSomethingElse("case: not an arm");',
    "}",
  ].join("\n");
  const input = [chunk(text, 1)];
  const result = applyDispatchSubchunking(input, ".ts");
  assert.equal(result.length, 4);
  assert.equal(result[3]!.symbol, "c");
  assert.ok(result[3]!.text.includes("doSomethingElse"));
});
