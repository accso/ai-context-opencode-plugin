/**
 * In-process embedding via manual onnxruntime-node inference -- the
 * corrected embedding-backend decision recorded in plan.md
 * (2026-09-15). Replaces the earlier flawed plan of using the npm
 * `fastembed` package with `nomic-embed-text-v1.5`: that package's
 * `EmbeddingModel` catalog doesn't include nomic at all, and its
 * `getEmbeddings()` extraction is hardcoded to the first token
 * position (CLS pooling) rather than the attention-mask-weighted mean
 * pooling nomic-embed-text-v1.5 was actually trained with -- it would
 * silently produce degraded embeddings with no error. See plan.md's
 * fastembed/nomic audit for the full comparison against
 * `@huggingface/transformers` and forking `fastembed-js`.
 *
 * This module owns exactly the pieces that decision requires us to
 * hand-roll: mean pooling, L2 normalization, and Matryoshka dimension
 * truncation (a nomic-specific lever -- the model was trained so that
 * truncating its 768-dim output to a shorter prefix and re-normalizing
 * still yields a usable embedding, directly cutting the storage
 * spike's brute-force cosine search cost). Tokenization and ONNX
 * session management are injected as `tokenize`/`runInference`
 * dependencies so this module's own logic stays free of any real
 * network/native-binding I/O in unit tests -- a real default
 * implementation (reusing `@huggingface/hub`'s `downloadFileToCacheDir`
 * for model/tokenizer fetch + caching, a tokenizer package, and
 * `onnxruntime-node` for inference) is wired in only where the plugin
 * actually needs to run for real, matching this repo's existing
 * injected-deps-for-testability pattern (see `project-registry.ts`,
 * `index-scheduler.ts`).
 */

export type EmbeddingPrefix = "search_document" | "search_query";

export interface TokenizeResult {
  inputIds: number[];
  attentionMask: number[];
}

export interface InferenceResult {
  /** `last_hidden_state`, shape [sequenceLength][hiddenSize]. */
  lastHiddenState: number[][];
}

export interface EmbedOptions {
  /**
   * nomic-embed-text-v1.5 requires a task-instruction prefix prepended
   * to the raw text -- "search_document: " for indexed chunks,
   * "search_query: " for the user's search query -- per its model
   * card. Embedding without one is a valid ONNX call but produces
   * embeddings that don't match the model's trained distribution.
   */
  prefix: EmbeddingPrefix;
}

export interface EmbedderOptions {
  tokenize(text: string): Promise<TokenizeResult>;
  runInference(inputIds: number[], attentionMask: number[]): Promise<InferenceResult>;
  /** Matryoshka truncation target; omitted/undefined keeps the model's full output dims. */
  outputDims?: number;
  /**
   * Hard cap on the sequence length passed to inference. Attention memory
   * is quadratic in it (~4.5 GB at 4096 tokens), so this is what bounds
   * memory per embedding. Defaults to DEFAULT_MAX_EMBED_TOKENS.
   */
  maxTokens?: number;
}

export const DEFAULT_MAX_EMBED_TOKENS = 512;

/** Truncates to `maxTokens`, keeping the trailing [SEP] token the tokenizer appended. */
function capSequence(ids: number[], mask: number[], maxTokens: number): TokenizeResult {
  if (ids.length <= maxTokens) return { inputIds: ids, attentionMask: mask };
  return {
    inputIds: [...ids.slice(0, maxTokens - 1), ids[ids.length - 1]!],
    attentionMask: [...mask.slice(0, maxTokens - 1), mask[mask.length - 1]!],
  };
}

export interface Embedder {
  embed(text: string, options: EmbedOptions): Promise<number[]>;
}

/** Attention-mask-weighted mean pooling over `last_hidden_state`. */
export function meanPool(lastHiddenState: number[][], attentionMask: number[]): number[] {
  const hiddenSize = lastHiddenState[0]?.length ?? 0;
  const sum = new Array<number>(hiddenSize).fill(0);
  let attendedCount = 0;
  for (let t = 0; t < lastHiddenState.length; t++) {
    if (attentionMask[t] !== 1) continue;
    attendedCount++;
    const tokenVector = lastHiddenState[t]!;
    for (let d = 0; d < hiddenSize; d++) {
      sum[d]! += tokenVector[d]!;
    }
  }
  if (attendedCount === 0) return sum;
  return sum.map((value) => value / attendedCount);
}

export function l2Normalize(vector: number[]): number[] {
  let normSquared = 0;
  for (const value of vector) normSquared += value * value;
  if (normSquared === 0) return vector.slice();
  const norm = Math.sqrt(normSquared);
  return vector.map((value) => value / norm);
}

/**
 * Matryoshka dimension truncation: keep only the first `dims` values
 * (nomic's Matryoshka training orders dimensions by importance, so a
 * prefix slice -- not an arbitrary subset -- is the valid truncation)
 * and re-normalize, since the shorter slice of a unit vector is no
 * longer unit length itself.
 */
export function truncateMatryoshka(vector: number[], dims: number): number[] {
  if (dims >= vector.length) return vector;
  return l2Normalize(vector.slice(0, dims));
}

export function createEmbedder(options: EmbedderOptions): Embedder {
  return {
    async embed(text, { prefix }) {
      const prefixedText = `${prefix}: ${text}`;
      const tokenized = await options.tokenize(prefixedText);
      const { inputIds, attentionMask } = capSequence(
        tokenized.inputIds,
        tokenized.attentionMask,
        options.maxTokens ?? DEFAULT_MAX_EMBED_TOKENS,
      );
      const { lastHiddenState } = await options.runInference(inputIds, attentionMask);
      const pooled = meanPool(lastHiddenState, attentionMask);
      const normalized = l2Normalize(pooled);
      return options.outputDims !== undefined
        ? truncateMatryoshka(normalized, options.outputDims)
        : normalized;
    },
  };
}
