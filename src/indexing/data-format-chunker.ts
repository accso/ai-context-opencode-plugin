// INDEX SHAPE: changing the chunks this produces requires bumping CODE_INDEX_VERSION in indexing.ts (ADR-0027).
import type { Chunk } from "./chunker.js";
import { DEFAULT_MAX_CHUNK_CHARS } from "./chunk-splitter.js";

/**
 * Bespoke Vue/SQL/YAML splitters -- TS port of
 * `.ai-context/watcher/chunker.py`'s `_chunk_vue`/`_chunk_sql`/
 * `_chunk_yaml` (`port-tree-sitter-chunker-followups`, item 4).
 * `_chunk_markdown` is intentionally NOT ported here -- this plugin's
 * PageIndex-style doc-tree feature already covers eligible Markdown
 * files (see doc-tree-builder.ts), and non-tree-eligible Markdown
 * already falls back to `chunkText` unchanged, matching chunker.py's
 * own fallback for that case.
 *
 * Each function returns `null` (rather than embedding the paragraph
 * fallback itself, unlike the Python original) when its boundary
 * pattern finds zero matches, so callers compose it the same way as
 * `chunkWithTreeSitter`/`chunkWithRegexPatterns`:
 * `chunkVueSfc(...) ?? chunkText(...)`, etc.
 */

// ── Vue SFC top-level blocks ──────────────────────────────────────────────
// Matches opening tags of SFC top-level blocks: <template>, <script>,
// <style> (with any attributes, e.g. <script setup lang="ts">).
const VUE_BLOCK = /^(<(?:template|script|style)(?:\s[^>]*)?>)/gim;

// ── YAML / TOML top-level keys ─────────────────────────────────────────────
// Matches non-indented lines that look like "key:" (YAML) or "key =" (TOML),
// not blank and not comments.
const YAML_KEY = /^(?![ \t#])(\S[^:#\n]*)\s*[=:]/gm;

// ── SQL statement boundary ──────────────────────────────────────────────────
const SQL_STMT_END = /;\s*$/gm;

// Extracts a name from a CREATE statement (TABLE/VIEW/INDEX/FUNCTION/
// PROCEDURE/TRIGGER), tolerating "IF NOT EXISTS", schema-qualified names,
// and optional quoting (backticks, double quotes, or square brackets).
const SQL_CREATE_NAME =
  /\bcreate\s+(?:or\s+replace\s+)?(table|view|index|unique\s+index|function|procedure|trigger)\s+(?:if\s+not\s+exists\s+)?["'`[]?([\w.]+)["'`\]]?/i;
// Strips "-- ..." line comments before running SQL_CREATE_NAME against a
// chunk's text -- without this, prose in a comment that happens to mention
// "CREATE TABLE ..." (e.g. a header comment) can match before the real
// statement below it.
const SQL_LINE_COMMENT = /--.*$/gm;

const SQL_MAX_LINES_PER_CHUNK = 80;

/**
 * Splits `content` at the boundaries matched by `boundaryRe` (each match's
 * start marks a new chunk), emitting a leading preamble chunk for content
 * before the first match. `symbolFor` derives each chunk's `symbol` (and,
 * for Vue, `chunkType`) from its boundary match. Returns `null` if
 * `boundaryRe` finds zero matches in `content`.
 */
function chunkAtLineBoundaries(
  content: string,
  boundaryRe: RegExp,
  toChunkMeta: (match: RegExpExecArray) => {
    symbol: string | undefined;
    chunkType: string;
  },
): Chunk[] | null {
  const lines = content.split("\n");
  const re = new RegExp(
    boundaryRe.source,
    boundaryRe.flags.includes("g") ? boundaryRe.flags : `${boundaryRe.flags}g`,
  );
  const matches = [...content.matchAll(re)];
  if (matches.length === 0) return null;

  const chunks: Chunk[] = [];
  const emit = (
    startIdx: number,
    endIdx: number,
    symbol: string | undefined,
    chunkType: string,
  ) => {
    const text = lines.slice(startIdx, endIdx).join("\n").trim();
    if (text) {
      chunks.push({
        text,
        startLine: startIdx + 1,
        endLine: endIdx,
        symbol,
        chunkType,
      });
    }
  };

  const lineOf = (charPos: number) =>
    content.slice(0, charPos).split("\n").length - 1; // 0-based

  const firstLine = lineOf(matches[0]!.index!);
  emit(0, firstLine, undefined, "block");

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const startLine = lineOf(match.index!);
    const endLine =
      i + 1 < matches.length ? lineOf(matches[i + 1]!.index!) : lines.length;
    const { symbol, chunkType } = toChunkMeta(match);
    emit(startLine, endLine, symbol, chunkType);
  }

  return chunks.length > 0 ? chunks : null;
}

/**
 * Splits a Vue Single File Component at top-level block boundaries,
 * producing one chunk per SFC block (`<template>`, `<script>`,
 * `<style>`) plus a preamble chunk for any content before the first
 * block. `chunkType` is `"component"` for `<template>`, `"function"`
 * for `<script>`, and `"block"` for everything else (`<style>`).
 * Returns `null` if no SFC blocks are found.
 */
export function chunkVueSfc(content: string): Chunk[] | null {
  return chunkAtLineBoundaries(content, VUE_BLOCK, (match) => {
    const tag = match[1]!.trim();
    const tagName = tag.replace(/^</, "").split(/[\s>]/)[0]!.toLowerCase();
    const chunkType =
      tagName === "template"
        ? "component"
        : tagName === "script"
          ? "function"
          : "block";
    return { symbol: tag, chunkType };
  });
}

/**
 * Splits YAML/TOML content at top-level key lines (non-indented,
 * non-comment lines containing `:` or `=`), emitting a preamble chunk
 * for any content before the first key. Returns `null` if no top-level
 * key is found.
 */
export function chunkYaml(content: string, maxChars = DEFAULT_MAX_CHUNK_CHARS): Chunk[] | null {
  const top = chunkAtLineBoundaries(content, YAML_KEY, (match) => ({
    symbol: match[1]!.trim(),
    chunkType: "block",
  }));
  if (!top) return null;
  return top.flatMap((chunk) => splitListChunk(chunk, maxChars));
}

const ITEM_ID_KEYS = /^\s*(?:-\s+)?(?:slug|id|name|key|title):\s*(.+?)\s*$/;

function itemId(itemLines: string[]): string | undefined {
  for (const line of itemLines.slice(0, 8)) {
    const m = ITEM_ID_KEYS.exec(line);
    if (m) return m[1]!.replace(/^["']|["']$/g, "");
  }
  return undefined;
}

/**
 * A top-level key whose value is a long list of items (`epics:\n  - slug: a ...`) is
 * split at the list items instead of at arbitrary lines, so every chunk starts with
 * an item head. Neighbouring small items are grouped up to `maxChars`; chunks after
 * the first carry the parent key as a header line and the symbol names the items
 * (`epics[a..c]`). Anything else is returned unchanged.
 */
function splitListChunk(chunk: Chunk, maxChars: number): Chunk[] {
  const key = chunk.symbol;
  if (!key || chunk.text.length <= maxChars) return [chunk];
  const lines = chunk.text.split("\n");
  const first = lines.findIndex((l, i) => i > 0 && l.trim() !== "" && !l.trim().startsWith("#"));
  if (first < 0) return [chunk];
  const indent = /^(\s*)-(?:\s|$)/.exec(lines[first]!)?.[1];
  if (indent === undefined) return [chunk];
  const isItem = (l: string) => l.startsWith(`${indent}-`) && (l.length === indent.length + 1 || /\s/.test(l[indent.length + 1]!));
  const starts = lines.flatMap((l, i) => (i >= first && isItem(l) ? [i] : []));
  if (starts.length < 2) return [chunk];

  const groups: { from: number; to: number; ids: (string | undefined)[] }[] = [];
  let current: (typeof groups)[number] | undefined;
  starts.forEach((from, n) => {
    const to = n + 1 < starts.length ? starts[n + 1]! : lines.length;
    const currentSize = current ? lines.slice(current.from, to).join("\n").length : 0;
    if (current && currentSize <= maxChars) {
      current.to = to;
      current.ids.push(itemId(lines.slice(from, to)));
    } else {
      current = { from: groups.length === 0 ? 0 : from, to, ids: [itemId(lines.slice(from, to))] };
      groups.push(current);
    }
  });

  return groups.map((g, i) => {
    const body = lines.slice(g.from, g.to).join("\n").replace(/\s+$/, "");
    const ids = g.ids.filter((x): x is string => !!x);
    const label = ids.length === 0 ? "" : ids.length === 1 ? `[${ids[0]}]` : `[${ids[0]}..${ids[ids.length - 1]}]`;
    return {
      ...chunk,
      text: i === 0 ? body : `${key}:\n${body}`,
      startLine: chunk.startLine + g.from,
      endLine: chunk.startLine + g.to - 1,
      symbol: `${key}${label}`,
    };
  });
}

/**
 * Splits SQL content at statement boundaries (semicolons), grouping
 * consecutive short statements into one chunk (up to
 * `SQL_MAX_LINES_PER_CHUNK` lines) to avoid producing hundreds of tiny
 * single-line chunks for INSERT-heavy migration files. Each chunk's
 * `symbol` is the first `CREATE TABLE/VIEW/INDEX/FUNCTION/PROCEDURE/
 * TRIGGER <name>` found in its text (comment-stripped first), or
 * `undefined` if none (the common case for INSERT-heavy chunks).
 * Returns `null` if the content has no statement-terminating `;`.
 */
export function chunkSql(content: string): Chunk[] | null {
  const lines = content.split("\n");

  const symbolFor = (text: string): string | undefined => {
    const stripped = text.replace(SQL_LINE_COMMENT, "");
    const match = SQL_CREATE_NAME.exec(stripped);
    if (!match) return undefined;
    const kind = match[1]!.toUpperCase().includes("INDEX")
      ? "INDEX"
      : match[1]!.toUpperCase();
    return `CREATE ${kind} ${match[2]}`;
  };

  const stmtEnds: number[] = []; // 0-based line indexes of each ";"
  for (const match of content.matchAll(SQL_STMT_END)) {
    stmtEnds.push(
      content.slice(0, match.index! + match[0].length).split("\n").length - 1,
    );
  }
  if (stmtEnds.length === 0) return null;

  const chunks: Chunk[] = [];
  let prev = 0;
  let bufStart = 0;
  let bufLines = 0;

  const flush = (endExclusive: number) => {
    const text = lines.slice(bufStart, endExclusive).join("\n").trim();
    if (text) {
      chunks.push({
        text,
        startLine: bufStart + 1,
        endLine: endExclusive,
        symbol: symbolFor(text),
        chunkType: "statement",
      });
    }
  };

  for (const end of stmtEnds) {
    const segLen = end - prev + 1;
    if (bufLines + segLen > SQL_MAX_LINES_PER_CHUNK && bufLines > 0) {
      flush(prev);
      bufStart = prev;
      bufLines = 0;
    }
    bufLines += segLen;
    prev = end + 1;
  }
  flush(lines.length);

  return chunks.length > 0 ? chunks : null;
}

/**
 * Extension-dispatching entry point mirroring `chunkWithRegexPatterns`'s
 * API shape, so `indexing.ts` can chain all the chunking tiers the same
 * way: `chunkWithTreeSitter(...) ?? chunkWithRegexPatterns(...) ??
 * chunkWithDataFormatSplitter(...) ?? chunkText(...)`. Returns `null`
 * for any extension without a dedicated splitter here, or when the
 * matching splitter itself finds zero boundaries.
 */
export function chunkWithDataFormatSplitter(
  content: string,
  extension: string,
  maxChars: number = DEFAULT_MAX_CHUNK_CHARS,
): Chunk[] | null {
  switch (extension) {
    case ".vue":
      return chunkVueSfc(content);
    case ".sql":
      return chunkSql(content);
    case ".yaml":
    case ".yml":
    case ".toml":
      return chunkYaml(content, maxChars);
    default:
      return null;
  }
}
