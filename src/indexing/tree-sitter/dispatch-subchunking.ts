import type { TreeSitterChunk } from "./treesitter-chunker.js";

/**
 * Dispatch-table/switch-case sub-chunking -- TS port of
 * `.ai-context/watcher/chunker.py`'s `_apply_dispatch_subchunking`/
 * `_chunk_dispatch_arms` (`port-tree-sitter-chunker-followups`, item
 * 2). A switch block is itself a string/pattern-keyed dispatch table:
 * neither symbol lookup nor semantic search can anchor on a value
 * computed inside one arm, because an arm has no declaration-like
 * boundary line of its own -- it's just a label inside a function's
 * existing single chunk. This splits a qualifying chunk (>= 3 arms)
 * into a "head" chunk (declaration + switch header, kept together)
 * plus one `chunkType: "case"` chunk per arm.
 *
 * Covers the full `_DISPATCH_TABLE` scope from chunker.py:
 * `.ts`/`.tsx`/`.java`/`.cs`/`.js`/`.jsx`/`.swift` use the same
 * `switch`/`case` shape; `.kt`/`.kts` use `when`/`-> ` arms; `.py` uses
 * `match`/`case` arms (indentation-based, no braces -- arm-matching
 * falls back to the whole chunk body there, same as the original).
 * This runs over chunks regardless of which earlier tier produced them
 * (tree-sitter for TS/TSX/Java/C#, regex-chunker.ts for the rest) --
 * chunker.py's own `_apply_dispatch_subchunking` isn't gated on that
 * either.
 *
 * KNOWN GAP (faithfully ported from chunker.py's `_chunk_dispatch_arms`,
 * verified against a direct Python repro of the same regex/algorithm):
 * the "head" chunk for the FIRST arm only excludes the dispatch
 * header line itself (e.g. `switch (x) {`) -- the arm-start regex's
 * leading `\s*` eats the newline right after the block's opening `{`,
 * shifting the computed line offset for that one arm back by one line,
 * so the header ends up merged into the first "case" chunk instead of
 * the head chunk. Subsequent arms are unaffected. See
 * dispatch-subchunking.test.ts's first test for the exact repro.
 */

const SWITCH_START = /\bswitch\s*\(/;
const SWITCH_ARM = /^\s*case\s+(.+?):/gm;
const WHEN_START = /\bwhen\s*[({]/;
const WHEN_ARM = /^\s*(.+?)\s*->/gm;
const MATCH_START = /\bmatch\s+.+:/;
const MATCH_ARM = /^\s*case\s+(.+?):/gm;

const MIN_ARMS_FOR_SUBCHUNK = 3; // heuristic gate, matches chunker.py

// Extension -> (dispatch-start-re, arm-start-re) -- mirrors chunker.py's
// own `_DISPATCH_TABLE` exactly. Extensions not listed here get no
// dispatch sub-chunking (e.g. Go/Rust/Ruby/PHP/C -- out of scope for
// this pass; their own top-level chunking is unaffected).
const DISPATCH_TABLE: Record<string, [RegExp, RegExp]> = {
  ".ts": [SWITCH_START, SWITCH_ARM],
  ".tsx": [SWITCH_START, SWITCH_ARM],
  ".js": [SWITCH_START, SWITCH_ARM],
  ".jsx": [SWITCH_START, SWITCH_ARM],
  ".java": [SWITCH_START, SWITCH_ARM],
  ".cs": [SWITCH_START, SWITCH_ARM],
  ".swift": [SWITCH_START, SWITCH_ARM],
  ".kt": [WHEN_START, WHEN_ARM],
  ".kts": [WHEN_START, WHEN_ARM],
  ".py": [MATCH_START, MATCH_ARM],
};

/**
 * Finds the `{...}` extent of a brace-delimited dispatch block,
 * searching for the first `{` starting just after the dispatch
 * keyword's own match. Returns `[start, end)` as character offsets
 * bounding the block's *inner* content (start is just after the
 * opening `{`, end is at the matching `}`, via simple depth-counting --
 * no string/comment awareness, same heuristic bar as the rest of this
 * port). Returns `undefined` if no `{` follows at all.
 */
function dispatchBlockSpan(bodyText: string, dispatchMatchEnd: number): [number, number] | undefined {
  const openPos = bodyText.indexOf("{", dispatchMatchEnd);
  if (openPos === -1) return undefined;
  let depth = 0;
  for (let i = openPos; i < bodyText.length; i++) {
    const ch = bodyText[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return [openPos + 1, i];
    }
  }
  return [openPos + 1, bodyText.length]; // unbalanced braces -- scope to end
}

/**
 * Given one already-produced chunk, checks whether its body contains a
 * `switch` block with >= `MIN_ARMS_FOR_SUBCHUNK` `case` arms, scoped to
 * the switch's own `{...}` body (not the whole chunk, so a `case`-like
 * string literal elsewhere in the function is never mistaken for an
 * arm). If so, splits it into a head chunk plus one `case` chunk per
 * arm; returns `[chunk]` unchanged otherwise.
 */
function chunkDispatchArms(
  chunk: TreeSitterChunk,
  dispatchStartRe: RegExp,
  armStartRe: RegExp,
): TreeSitterChunk[] {
  const lines = chunk.text.split("\n");
  const dispatchMatch = dispatchStartRe.exec(chunk.text);
  if (!dispatchMatch) return [chunk];

  const span = dispatchBlockSpan(chunk.text, dispatchMatch.index + dispatchMatch[0].length);
  const [searchText, searchOffset] = span
    ? [chunk.text.slice(span[0], span[1]), span[0]]
    : [chunk.text, 0];

  const armMatches = [...searchText.matchAll(armStartRe)];
  if (armMatches.length < MIN_ARMS_FOR_SUBCHUNK) return [chunk]; // not "dispatch-table style" enough

  const armStarts = armMatches.map((m) => {
    const absCharPos = searchOffset + m.index!;
    const relLine = chunk.text.slice(0, absCharPos).split("\n").length - 1; // 0-based
    const label = m[1]?.trim().replace(/^["']|["']$/g, ""); // `case "foo":` -> foo
    return { line: relLine, label };
  });

  const result: TreeSitterChunk[] = [];

  const headEnd = armStarts[0]!.line; // exclusive, 0-based
  const headText = lines.slice(0, headEnd).join("\n").trim();
  if (headText) {
    result.push({
      text: headText,
      startLine: chunk.startLine,
      endLine: chunk.startLine + headEnd - 1,
      symbol: chunk.symbol,
      chunkType: chunk.chunkType,
    });
  }

  for (let i = 0; i < armStarts.length; i++) {
    const { line: armLine, label } = armStarts[i]!;
    const armEndLine = i + 1 < armStarts.length ? armStarts[i + 1]!.line : lines.length;
    const armText = lines.slice(armLine, armEndLine).join("\n").trim();
    if (armText) {
      result.push({
        text: armText,
        startLine: chunk.startLine + armLine,
        endLine: chunk.startLine + armEndLine - 1,
        symbol: label,
        chunkType: "case",
      });
    }
  }

  return result.length > 0 ? result : [chunk];
}

/**
 * Runs `chunkDispatchArms` over every chunk, for the extensions listed
 * in `DISPATCH_EXTENSIONS` -- a no-op (returns `chunks` unchanged) for
 * every other extension.
 */
/**
 * Runs `chunkDispatchArms` over every chunk, for extensions with a
 * `DISPATCH_TABLE` entry -- a no-op (returns `chunks` unchanged) for
 * every other extension.
 */
export function applyDispatchSubchunking(chunks: TreeSitterChunk[], extension: string): TreeSitterChunk[] {
  const pair = DISPATCH_TABLE[extension];
  if (!pair) return chunks;
  const [dispatchStartRe, armStartRe] = pair;
  return chunks.flatMap((c) => chunkDispatchArms(c, dispatchStartRe, armStartRe));
}
