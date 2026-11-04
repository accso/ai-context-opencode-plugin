import type { VectorSearchResult } from "../storage/vector-store.js";

/**
 * Hybrid keyword+vector reranking -- a TS port of
 * `.ai-context/mcp-server/src/context_assembler.ts`'s
 * `extractTerms`/`keywordScore`/`keywordRerank`. Only this local,
 * network-free half of the original's hybrid ranking is ported: the
 * OTHER half (`crossEncoderRerank`, a ColBERT/cross-encoder call to a
 * separate always-on inference microservice) is deliberately NOT
 * ported here -- it requires a persistent model-serving process, which
 * is exactly the kind of Docker-based infrastructure this plugin exists
 * to replace. This keyword boost alone recovers most of the benefit
 * (surfacing literal-term matches that dense embedding similarity alone
 * sometimes under-ranks) at zero extra runtime cost.
 */

const KEYWORD_BOOST_WEIGHT = 0.25;
const MIN_TERM_LENGTH = 3;

/**
 * Splits a query into lowercase terms, additionally splitting camelCase
 * identifiers into their component words (so a query like
 * "retryHttpRequest" also matches text containing "retry"/"http" alone).
 * Drops short (<3 char) tokens and duplicates.
 */
export function extractTerms(query: string): string[] {
  const raw = query.split(/\W+/).filter(Boolean);
  const expanded: string[] = [];
  for (const token of raw) {
    expanded.push(token.toLowerCase());
    const parts = token.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
    if (parts.length > 1) expanded.push(...parts.map((p) => p.toLowerCase()));
  }
  return [...new Set(expanded)].filter((t) => t.length >= MIN_TERM_LENGTH);
}

/** Counts (case-insensitive, overlap-free) term occurrences in `text`, scaled to [0, 1]. */
export function keywordScore(queryTerms: string[], text: string): number {
  if (queryTerms.length === 0) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const term of queryTerms) {
    let pos = 0;
    while ((pos = lower.indexOf(term, pos)) !== -1) {
      hits++;
      pos += term.length;
    }
  }
  return Math.min(hits / 10, 1.0);
}

/**
 * Re-scores `hits` as `(1 - weight) * originalScore + weight * keywordScore`
 * and re-sorts descending. A stable sort keeps ties in their original
 * (dense-similarity-ranked) order rather than reshuffling them.
 */
export function keywordRerank<T extends VectorSearchResult>(query: string, hits: T[]): T[] {
  const terms = extractTerms(query);
  if (terms.length === 0) return [...hits];

  return hits
    .map((hit) => {
      const boost = KEYWORD_BOOST_WEIGHT * keywordScore(terms, hit.text);
      return { ...hit, score: (1 - KEYWORD_BOOST_WEIGHT) * hit.score + boost };
    })
    .sort((a, b) => b.score - a.score);
}
