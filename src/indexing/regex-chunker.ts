// INDEX SHAPE: changing the chunks this produces requires bumping CODE_INDEX_VERSION in indexing.ts (ADR-0027).
import type { Chunk } from "./chunker.js";

/**
 * Regex-based top-level chunker -- TS port of `.ai-context/watcher/
 * chunker.py`'s `_chunk_by_pattern`/`_detect_chunk_type`, covering the
 * ~9 languages the original only ever regex-chunks (never tree-sitter-
 * chunks): Kotlin, JavaScript/JSX, Python, Swift, Go, Rust, Ruby, PHP,
 * C/C++ (`port-tree-sitter-chunker-followups`, item 3a). TypeScript/
 * TSX/Java/C# are intentionally out of scope here -- `indexing.ts`
 * tries `treesitter-chunker.ts` first for those, falling back straight
 * to `chunkText` (not this module) on failure, matching this plugin's
 * existing (simplified) dispatch.
 *
 * Returns `null` -- the same fallback signal `treesitter-chunker.ts`
 * uses -- whenever this extension has no regex-chunking table entry or
 * zero top-level declarations are found; callers fall back to
 * `chunkText`'s paragraph-based chunker in both cases, mirroring
 * `chunker.py`'s own `_chunk_by_pattern` (which calls
 * `_chunk_by_paragraphs` itself when no matches are found -- functionally
 * identical to returning `null` and letting the caller do it).
 */

const NG_DECORATOR_RE = /^\s*@(?:Component|Injectable|Directive|Pipe|NgModule)/;

// ── Per-language top-level declaration patterns, ported verbatim from
// chunker.py's module-level regex constants (same keyword lists, same
// capture-group shape: exactly one group, the bare declared name). ──────────

const KT_TOP =
  /^(?:(?:public|private|protected|internal|abstract|open|data|sealed|inline|suspend|override|companion)\s+)*(?:class|object|interface|fun|typealias)\s+(\w+)/gm;

// Shared by both TypeScript's own regex-fallback tier (not wired up yet,
// see indexing.ts's simplified dispatch) and JavaScript/JSX, which has no
// tree-sitter tier at all in this plugin and so always lands here.
const JS_TOP =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:class|function|const|interface|type|enum)\s+(\w+)/gm;
const JS_ARROW = /^(?:export\s+)?const\s+(\w+)\s*[:=].*(?:=>|\bfunction\b)/gm;

const PY_TOP = /^(?:async\s+)?(?:class|def)\s+(\w+)/gm;

const SWIFT_TOP =
  /^(?:(?:public|private|internal|fileprivate|open|final|override|static|@objc|@objcMembers|@main)\s+)*(?:class|struct|enum|protocol|func|extension|typealias|actor)\s+(\w+)/gm;

// Receiver clause (if any) is consumed non-capturing so the single group
// always lands on the actual function/type name.
const GO_TOP = /^(?:func\s+(?:\([^)]*\)\s*)?|type\s+)(\w+)/gm;

const RUST_TOP =
  /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|impl)\s+(?:<[^>]*>\s*)?(\w+)/gm;

const RUBY_TOP = /^(?:class|module|def)\s+(\w+(?:::\w+)*)/gm;

const PHP_TOP =
  /^(?:abstract\s+|final\s+)*(?:class|interface|trait|function)\s+&?(\w+)/gm;

const C_AGGREGATE =
  /^(?:typedef[ \t]+)?(?:struct|class|enum(?:[ \t]+class)?|union)\s+(\w+)/gm;
const C_CONTROL_KEYWORDS =
  "if|for|while|switch|catch|else|return|do|sizeof|defined";
const C_FUNCTION = new RegExp(
  `^(?:static[ \\t]+|inline[ \\t]+|extern[ \\t]+|virtual[ \\t]+|constexpr[ \\t]+|explicit[ \\t]+)*` +
    `[\\w:<>,*&\\t ]+?\\b(?!(?:${C_CONTROL_KEYWORDS})\\b)(\\w+)[ \\t]*` +
    `\\([^;{)]*\\)[ \\t]*(?:const[ \\t]*)?\\{`,
  "gm",
);

/** Extension -> one regex, or a list of regexes merged + sorted by position (C/C++'s two shapes). */
const REGEX_TABLE: Record<string, RegExp | RegExp[]> = {
  ".kt": KT_TOP,
  ".kts": KT_TOP,
  ".js": JS_TOP,
  ".jsx": JS_TOP,
  ".py": PY_TOP,
  ".swift": SWIFT_TOP,
  ".go": GO_TOP,
  ".rs": RUST_TOP,
  ".rb": RUBY_TOP,
  ".php": PHP_TOP,
  ".c": [C_AGGREGATE, C_FUNCTION],
  ".cc": [C_AGGREGATE, C_FUNCTION],
  ".cpp": [C_AGGREGATE, C_FUNCTION],
  ".cxx": [C_AGGREGATE, C_FUNCTION],
  ".h": [C_AGGREGATE, C_FUNCTION],
  ".hpp": [C_AGGREGATE, C_FUNCTION],
};

/**
 * Classifies a top-level declaration line into a `chunkType` --
 * language-agnostic (shared structural keywords across every language
 * this module covers), TS port of `_detect_chunk_type`.
 */
function detectChunkType(line: string): string {
  const stripped = line.replace(/^\s+/, "");

  if (NG_DECORATOR_RE.test(stripped)) return "component";

  if (/\b(?:function|fun|def|func|fn)\b\s/.test(stripped)) return "function";

  if (/^(?:export\s+)?const\s+\w+\s*[:=].*(?:=>|\bfunction\b)/.test(stripped))
    return "function";

  if (
    /\b(?:class|interface|struct|enum|record|protocol|actor|typealias|object|extension|namespace|delegate|trait|impl|module|union)\b|@interface\b/.test(
      stripped,
    )
  ) {
    return "class";
  }

  const controlRe = new RegExp(`^(?:${C_CONTROL_KEYWORDS})\\b`);
  if (/\)\s*(?:const\s*)?\{\s*$/.test(stripped) && !controlRe.test(stripped)) {
    return "function";
  }

  return "block";
}

interface MatchSite {
  lineIndex: number; // 0-based
  symbol: string | undefined;
}

/** `_chunk_by_pattern`'s port: merges every pattern's matches, sorts by position, and slices `lines` at each boundary. */
function chunkByPattern(lines: string[], patterns: RegExp[]): Chunk[] | null {
  const source = lines.join("\n");
  const matchStarts: number[] = [];
  const matchSymbols: (string | undefined)[] = [];

  for (const pattern of patterns) {
    const re = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g",
    );
    for (const m of source.matchAll(re)) {
      matchStarts.push(m.index!);
      matchSymbols.push(m[1]);
    }
  }
  if (matchStarts.length === 0) return null;

  const order = matchStarts
    .map((_, i) => i)
    .sort((a, b) => matchStarts[a]! - matchStarts[b]!);
  const starts: MatchSite[] = order.map((i) => ({
    lineIndex: source.slice(0, matchStarts[i]).split("\n").length - 1,
    symbol: matchSymbols[i],
  }));

  const chunks: Chunk[] = [];

  if (starts[0]!.lineIndex > 0) {
    const preambleText = lines.slice(0, starts[0]!.lineIndex).join("\n").trim();
    if (preambleText) {
      chunks.push({
        text: preambleText,
        startLine: 1,
        endLine: starts[0]!.lineIndex,
        symbol: undefined,
        chunkType: "block",
      });
    }
  }

  for (let i = 0; i < starts.length; i++) {
    const { lineIndex, symbol } = starts[i]!;
    const endLineIndex =
      i + 1 < starts.length ? starts[i + 1]!.lineIndex : lines.length;
    const text = lines.slice(lineIndex, endLineIndex).join("\n").trim();
    if (text) {
      chunks.push({
        text,
        startLine: lineIndex + 1,
        endLine: endLineIndex,
        symbol,
        chunkType: detectChunkType(lines[lineIndex]!),
      });
    }
  }

  return chunks;
}

/**
 * Chunks `content` at the regex-derived top-level declaration
 * boundaries for `extension` (if any). Returns `null` -- never throws
 * -- whenever `extension` has no table entry or zero matches are found,
 * signalling the caller (`indexing.ts`) to fall back to `chunkText`.
 */
export function chunkWithRegexPatterns(
  content: string,
  extension: string,
): Chunk[] | null {
  let patterns = REGEX_TABLE[extension];
  if (!patterns) return null;
  patterns = Array.isArray(patterns) ? patterns : [patterns];

  // TypeScript's own fallback tier additionally retries with _TS_ARROW
  // when _TS_TOP finds nothing (chunker.py's ".ts"/".tsx" case) -- JS/JSX
  // doesn't get that retry in the original (its case block only ever
  // calls _chunk_by_pattern(lines, _TS_TOP) once), so this module
  // deliberately folds the arrow pattern into JS_TOP's own pattern list
  // instead of a conditional retry, which is behaviorally equivalent
  // (merged-and-sorted matches either way) but simpler to express here.
  if (extension === ".js" || extension === ".jsx") {
    patterns = [JS_TOP, JS_ARROW];
  }

  const lines = content.split("\n");
  return chunkByPattern(lines, patterns);
}
