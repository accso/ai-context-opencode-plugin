/**
 * Text that is actually embedded for a chunk: the raw chunk text with its
 * file path and symbol in front, so the vector carries where the code lives
 * and what it is called. The stored (and displayed) chunk text stays raw.
 *
 * Bump `EMBED_FORMAT_VERSION` whenever this format changes: stores whose
 * vectors were built with another version are rebuilt on open.
 */
export const EMBED_FORMAT_VERSION = 2;

export interface EmbedInputParts {
  relativePath: string;
  symbol?: string;
  text: string;
}

export function buildEmbedInput(parts: EmbedInputParts): string {
  const header = [`File: ${parts.relativePath}`];
  if (parts.symbol) header.push(`Symbol: ${parts.symbol}`);
  return `${header.join("\n")}\n\n${parts.text}`;
}
