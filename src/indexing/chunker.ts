/**
 * INDEX SHAPE: changing what this produces for existing files requires bumping
 * CODE_INDEX_VERSION / DOC_INDEX_VERSION in indexing.ts (ADR-0027).
 *
 * Paragraph-based fallback chunker -- a TS port of
 * `.ai-context/watcher/chunker.py`'s `_chunk_by_paragraphs`. This is the
 * universal, language-agnostic chunking strategy the original chunker
 * falls back to for any file type without a dedicated tree-sitter/regex
 * splitter (Markdown headings, SQL statements, etc.) -- see chunker.py
 * lines ~751-785.
 *
 * Deliberately the ONLY chunking strategy ported so far: it's enough to
 * unblock an end-to-end index -> embed -> store -> search pipeline for
 * every file type today. Per-language tree-sitter-aware chunking (the
 * other ~1100 lines of chunker.py, covering ~13 languages) is deferred
 * to its own follow-up increment/todo rather than ported in one pass.
 */

export interface Chunk {
  text: string;
  startLine: number;
  endLine: number;
  symbol: string | undefined;
  chunkType: string;
}

export interface ChunkOptions {
  /** Maximum number of lines per chunk before a paragraph is force-split. Default: 80 (matches chunker.py). */
  maxLines?: number;
}

const DEFAULT_MAX_LINES = 80;

/**
 * Splits `content` into blank-line-delimited paragraphs, each further
 * capped at `maxLines`. Line numbers are 1-based and inclusive, matching
 * `read`/most editors. Empty/whitespace-only input yields no chunks.
 */
export function chunkText(
  content: string,
  options: ChunkOptions = {},
): Chunk[] {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const lines = content.split("\n");
  const chunks: Chunk[] = [];

  let paragraphLines: string[] = [];
  let paragraphStart = 1;

  const flushParagraph = (endLineExclusive: number) => {
    if (paragraphLines.length === 0) {
      return;
    }
    for (let offset = 0; offset < paragraphLines.length; offset += maxLines) {
      const slice = paragraphLines.slice(offset, offset + maxLines);
      const startLine = paragraphStart + offset;
      chunks.push({
        text: slice.join("\n").trim(),
        startLine,
        endLine: startLine + slice.length - 1,
        symbol: undefined,
        chunkType: "block",
      });
    }
    paragraphLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const line = lines[i]!;
    if (line.trim().length === 0) {
      flushParagraph(lineNumber);
      paragraphStart = lineNumber + 1;
    } else {
      paragraphLines.push(line);
    }
  }
  flushParagraph(lines.length + 1);

  return chunks;
}
