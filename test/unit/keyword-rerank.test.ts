import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTerms, keywordScore, keywordRerank } from "../../src/search/keyword-rerank.js";
import type { VectorSearchResult } from "../../src/storage/vector-store.js";

/**
 * Unit tests for the hybrid keyword+vector reranking step -- a TS port
 * of `.ai-context/mcp-server/src/context_assembler.ts`'s
 * `extractTerms`/`keywordScore`/`keywordRerank`. Only the local,
 * network-free half of the original's hybrid ranking is ported: the
 * OTHER half (`crossEncoderRerank`, a ColBERT/cross-encoder call to a
 * separate always-on inference microservice) is deliberately NOT
 * ported -- it requires a persistent model-serving process, which is
 * exactly the kind of Docker-based infrastructure this plugin exists to
 * replace. `keywordRerank` alone gets most of the benefit (boosting
 * literal-term matches within an already-dense-ranked candidate set)
 * with zero extra infrastructure. See plan.md for the full rationale.
 */

function hit(text: string, score: number): VectorSearchResult {
  return {
    id: text,
    relativePath: "a.ts",
    language: "typescript",
    text,
    startLine: 1,
    endLine: 1,
    chunkType: "block",
    score,
  };
}

test("extractTerms lowercases, dedupes, and drops short tokens", () => {
  assert.deepEqual(extractTerms("Retry retry HTTP is ok"), ["retry", "http"]);
});

test("extractTerms splits camelCase identifiers into their component words", () => {
  const terms = extractTerms("retryHttpRequest");
  assert.ok(terms.includes("retryhttprequest"));
  assert.ok(terms.includes("retry"));
  assert.ok(terms.includes("http"));
  assert.ok(terms.includes("request"));
});

test("keywordScore counts term occurrences, capped at 1.0", () => {
  assert.equal(keywordScore(["retry"], "no match here"), 0);
  assert.equal(keywordScore(["retry"], "retry retry retry"), 0.3);
  assert.equal(keywordScore(["retry"], "retry ".repeat(20)), 1.0);
});

test("keywordScore returns 0 when there are no query terms", () => {
  assert.equal(keywordScore([], "retry retry"), 0);
});

test("keywordRerank boosts a lower-scored hit containing literal query terms above a higher-scored hit without them", () => {
  // score_after = 0.75*original + 0.25*keywordScore. With a near-tied
  // original score (0.55 vs 0.5) but a much higher keyword-match density
  // for the second hit, the boost is enough to flip the ranking.
  const hits = [hit("totally unrelated content here", 0.55), hit("retryHttpRequest ".repeat(4), 0.5)];
  const reranked = keywordRerank("retry http request", hits);
  assert.equal(reranked[0]!.text, "retryHttpRequest ".repeat(4));
});

test("keywordRerank returns hits unchanged (score-wise) when the query has no usable terms", () => {
  const hits = [hit("a", 0.9), hit("b", 0.5)];
  const reranked = keywordRerank("is a an", hits); // all below the 3-char minimum
  assert.deepEqual(
    reranked.map((h) => h.score),
    [0.9, 0.5],
  );
});

test("keywordRerank keeps the original relative ordering stable when scores tie", () => {
  const hits = [hit("no terms here", 0.5), hit("also no terms here", 0.5)];
  const reranked = keywordRerank("zzzznotfound", hits);
  assert.deepEqual(
    reranked.map((h) => h.text),
    ["no terms here", "also no terms here"],
  );
});
