import type { VectorSearchResult, VectorStore } from "../storage/vector-store.js";

/** Standard reciprocal-rank-fusion constant (Cormack et al., 2009). */
export const RRF_K = 60;

/**
 * Reciprocal rank fusion: each list contributes 1/(k+rank) per item, so items
 * ranked well in several lists win without having to compare incompatible
 * scores (cosine similarity vs. BM25). Items are identified by `id`.
 */
export function fuseRankings<T extends VectorSearchResult>(
  lists: T[][],
  limit: number,
  k: number = RRF_K,
): T[] {
  const scores = new Map<string, { item: T; score: number }>();
  for (const list of lists) {
    list.forEach((item, index) => {
      const gain = 1 / (k + index + 1);
      const entry = scores.get(item.id);
      if (entry) entry.score += gain;
      else scores.set(item.id, { item, score: gain });
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ item, score }) => ({ ...item, score }));
}

export interface HybridSearchInput {
  query: string;
  vector: number[];
  limit: number;
  /** Candidates fetched per channel before fusion (default: 3x limit, at least 20). */
  candidates?: number;
}

/** Dense vector search and BM25 keyword search of one store, fused by RRF. */
export function hybridSearch(
  store: VectorStore,
  input: HybridSearchInput,
): VectorSearchResult[] {
  const candidates = input.candidates ?? Math.max(20, input.limit * 3);
  return fuseRankings(
    [
      store.search(input.vector, candidates),
      store.searchText(input.query, candidates),
    ],
    input.limit,
  );
}
