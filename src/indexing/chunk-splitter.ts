// INDEX SHAPE: changing the chunks this produces requires bumping CODE_INDEX_VERSION in indexing.ts (ADR-0027).
import type { Chunk } from "./chunker.js";

/**
 * Embedding memory grows quadratically with the token count (onnxruntime:
 * ~0.5 GB at 512 tokens, ~4.5 GB at 4096), and the chunkers only bound
 * the number of LINES, so one dense chunk or a minified one-liner could
 * take gigabytes. Oversized chunks are therefore split into pieces within
 * a character budget before embedding, so no content becomes unsearchable
 * (the embedder's own token cap is only the last line of defense).
 */

export interface SplitChunk extends Chunk {
  /** Set only when a single over-long line was hard-split; keeps ids of pieces sharing one line range unique. */
  part?: number;
}

export const DEFAULT_MAX_CHUNK_CHARS = 1500;

export function splitOversizedChunks(
  chunks: Chunk[],
  maxChars: number,
): SplitChunk[] {
  return chunks.flatMap((chunk) =>
    chunk.text.length <= maxChars ? [chunk] : splitChunk(chunk, maxChars),
  );
}

function splitChunk(chunk: Chunk, maxChars: number): SplitChunk[] {
  const lines = chunk.text.split("\n");
  const pieces: SplitChunk[] = [];
  let buffer: string[] = [];
  let bufferChars = 0;
  let bufferStart = chunk.startLine;

  const flush = (endLine: number) => {
    if (buffer.length === 0) return;
    pieces.push({
      ...chunk,
      text: buffer.join("\n"),
      startLine: bufferStart,
      endLine,
    });
    buffer = [];
    bufferChars = 0;
  };

  lines.forEach((line, index) => {
    const lineNumber = chunk.startLine + index;
    if (line.length > maxChars) {
      flush(lineNumber - 1);
      for (
        let offset = 0, part = 0;
        offset < line.length;
        offset += maxChars, part++
      ) {
        pieces.push({
          ...chunk,
          text: line.slice(offset, offset + maxChars),
          startLine: lineNumber,
          endLine: lineNumber,
          part,
        });
      }
      bufferStart = lineNumber + 1;
      return;
    }
    const added = line.length + (buffer.length > 0 ? 1 : 0);
    if (buffer.length > 0 && bufferChars + added > maxChars) {
      flush(lineNumber - 1);
      bufferStart = lineNumber;
    }
    buffer.push(line);
    bufferChars += line.length + (buffer.length > 1 ? 1 : 0);
  });
  flush(chunk.startLine + lines.length - 1);
  return pieces;
}
