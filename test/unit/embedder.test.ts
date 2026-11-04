import { test } from "node:test";
import assert from "node:assert/strict";
import { meanPool, l2Normalize, truncateMatryoshka, createEmbedder } from "../../src/embedding/embedder.js";

/**
 * Unit tests for the hand-rolled embedding math used by the
 * onnxruntime-node-backed embedder (plan.md's corrected
 * "nomic-embed-text-v1.5 via manual onnxruntime-node" decision,
 * 2026-09-15). Covers only the pure, deterministic pieces:
 *
 *   - attention-mask-weighted mean pooling over `last_hidden_state`
 *     (nomic is mean-pooling-trained; this is the exact step the npm
 *     `fastembed` package gets wrong by only reading the first token
 *     position / CLS token -- see plan.md's fastembed/nomic audit).
 *   - L2 normalization.
 *   - Matryoshka dimension truncation (nomic-specific: truncating the
 *     768-dim output to a shorter prefix and re-normalizing still
 *     yields a usable embedding, at a modest quality cost).
 *
 * Session/tokenizer/model-download wiring is exercised separately via
 * `createEmbedder`'s injectable `tokenize`/`runInference` deps -- no
 * real network access or native ONNX session in these tests.
 */

test("meanPool averages only attended token positions, ignoring padding", () => {
  // 3 tokens x 2 dims, last token is padding (attentionMask = 0).
  const lastHiddenState = [
    [1, 1],
    [3, 3],
    [100, 100], // padding -- must be excluded
  ];
  const attentionMask = [1, 1, 0];
  const pooled = meanPool(lastHiddenState, attentionMask);
  assert.deepEqual(pooled, [2, 2]); // average of [1,1] and [3,3]
});

test("meanPool returns zeros if attention mask has no attended tokens", () => {
  const pooled = meanPool(
    [
      [5, 5],
      [7, 7],
    ],
    [0, 0],
  );
  assert.deepEqual(pooled, [0, 0]);
});

test("l2Normalize scales a vector to unit length", () => {
  const normalized = l2Normalize([3, 4]);
  assert.equal(normalized.length, 2);
  assert.ok(Math.abs(normalized[0]! - 0.6) < 1e-9);
  assert.ok(Math.abs(normalized[1]! - 0.8) < 1e-9);
  const magnitude = Math.sqrt(normalized[0]! ** 2 + normalized[1]! ** 2);
  assert.ok(Math.abs(magnitude - 1) < 1e-9);
});

test("l2Normalize returns the zero vector unchanged (no divide-by-zero)", () => {
  assert.deepEqual(l2Normalize([0, 0, 0]), [0, 0, 0]);
});

test("truncateMatryoshka slices the vector prefix and re-normalizes", () => {
  const full = l2Normalize([1, 2, 3, 4]);
  const truncated = truncateMatryoshka(full, 2);
  assert.equal(truncated.length, 2);
  const magnitude = Math.sqrt(truncated[0]! ** 2 + truncated[1]! ** 2);
  assert.ok(Math.abs(magnitude - 1) < 1e-9);
});

test("truncateMatryoshka is a no-op when dims >= vector length", () => {
  const full = l2Normalize([1, 2, 3]);
  assert.deepEqual(truncateMatryoshka(full, 10), full);
});

test("createEmbedder composes tokenize + runInference + meanPool + l2Normalize using injected deps", async () => {
  const tokenize = async (text: string) => {
    assert.equal(text, "search_document: hello world");
    return { inputIds: [101, 1, 2, 102], attentionMask: [1, 1, 1, 1] };
  };
  const runInference = async (_inputIds: number[], _attentionMask: number[]) => {
    return {
      lastHiddenState: [
        [2, 0],
        [2, 0],
        [2, 0],
        [2, 0],
      ],
    };
  };
  const embedder = createEmbedder({ tokenize, runInference });
  const vector = await embedder.embed("hello world", { prefix: "search_document" });
  assert.equal(vector.length, 2);
  assert.ok(Math.abs(vector[0]! - 1) < 1e-9);
  assert.ok(Math.abs(vector[1]!) < 1e-9);
});

test("createEmbedder applies the search_query prefix for query-side embeddings", async () => {
  let seenPrefixedText = "";
  const tokenize = async (text: string) => {
    seenPrefixedText = text;
    return { inputIds: [101, 1, 102], attentionMask: [1, 1, 1] };
  };
  const runInference = async () => ({
    lastHiddenState: [
      [1, 0],
      [1, 0],
      [1, 0],
    ],
  });
  const embedder = createEmbedder({ tokenize, runInference });
  await embedder.embed("what retries failed requests?", { prefix: "search_query" });
  assert.equal(seenPrefixedText, "search_query: what retries failed requests?");
});

test("createEmbedder truncates to requested Matryoshka dims when configured", async () => {
  const tokenize = async () => ({ inputIds: [1, 2], attentionMask: [1, 1] });
  const runInference = async () => ({
    lastHiddenState: [
      [1, 2, 3, 4],
      [1, 2, 3, 4],
    ],
  });
  const embedder = createEmbedder({ tokenize, runInference, outputDims: 2 });
  const vector = await embedder.embed("text", { prefix: "search_document" });
  assert.equal(vector.length, 2);
});

test("createEmbedder caps the sequence length handed to inference, keeping the final [SEP] token", async () => {
  let seen: { ids: number[]; mask: number[] } | undefined;
  const embedder = createEmbedder({
    maxTokens: 4,
    tokenize: async () => ({ inputIds: [101, 1, 2, 3, 4, 5, 102], attentionMask: [1, 1, 1, 1, 1, 1, 1] }),
    runInference: async (ids, mask) => {
      seen = { ids, mask };
      return { lastHiddenState: ids.map(() => [1, 0]) };
    },
  });
  await embedder.embed("long", { prefix: "search_document" });
  assert.deepEqual(seen!.ids, [101, 1, 2, 102]);
  assert.deepEqual(seen!.mask, [1, 1, 1, 1]);
});

test("createEmbedder leaves sequences within the cap untouched", async () => {
  let seen: number[] | undefined;
  const embedder = createEmbedder({
    maxTokens: 10,
    tokenize: async () => ({ inputIds: [101, 1, 102], attentionMask: [1, 1, 1] }),
    runInference: async (ids) => {
      seen = ids;
      return { lastHiddenState: ids.map(() => [1, 0]) };
    },
  });
  await embedder.embed("short", { prefix: "search_document" });
  assert.deepEqual(seen, [101, 1, 102]);
});

test("createEmbedder applies a safe default cap even when none is configured", async () => {
  let length = 0;
  const embedder = createEmbedder({
    tokenize: async () => ({ inputIds: new Array(5000).fill(7), attentionMask: new Array(5000).fill(1) }),
    runInference: async (ids) => {
      length = ids.length;
      return { lastHiddenState: ids.map(() => [1, 0]) };
    },
  });
  await embedder.embed("huge", { prefix: "search_document" });
  assert.equal(length, 512);
});
