import { createEmbedder, type TokenizeResult, type InferenceResult } from "./embedder.js";

/**
 * Real onnxruntime-node/tokenizers/HF-Hub wiring for `embedder.ts`'s
 * injectable `tokenize`/`runInference` seams -- the last remaining gap
 * from the corrected fastembed/nomic decision (plan.md, 2026-09-15).
 *
 * Model: nomic-ai/nomic-embed-text-v1.5, `onnx/model_quantized.onnx`
 * (~137MB int8-quantized vs. ~547MB for the fp32 export) -- picked over
 * the full-precision export to match this plugin's "no bundled infra,
 * keep it light" philosophy; quality loss from int8 quantization is
 * negligible for retrieval-style cosine similarity. Downloaded via
 * `@huggingface/hub`'s `downloadFileToCacheDir` into its OWN standard
 * shared cache (`$HF_HOME/hub`, `~/.cache/huggingface/hub` by default)
 * -- deliberately NOT a plugin-private directory, so another OpenCode
 * plugin (or any other HF-ecosystem tool) using the same model reuses
 * the exact same downloaded blob instead of duplicating a ~137MB
 * download. See `resolveModelCacheDir`'s doc comment for the full
 * rationale and the `AI_CONTEXT_PLUGIN_MODEL_CACHE_DIR` opt-out.
 *
 * Verified manually end-to-end (real download + real ONNX inference,
 * not part of the fast unit suite -- see model-runtime.test.ts's header
 * comment): the model's ONNX graph takes `input_ids`/`token_type_ids`/
 * `attention_mask` (int64, shape [1, seqLen]) and returns a single
 * `last_hidden_state` output of shape [1, seqLen, 768]. `token_type_ids`
 * is always all-zeros for our single-sequence (no sentence-pair) use.
 */

const MODEL_REPO = "nomic-ai/nomic-embed-text-v1.5";
const MODEL_FILE = "onnx/model_quantized.onnx";
const TOKENIZER_FILE = "tokenizer.json";

export interface ModelFiles {
  tokenizerPath: string;
  modelPath: string;
}

export interface TokenizerHandle {
  tokenize(text: string): Promise<TokenizeResult>;
}

export interface SessionHandle {
  runInference(inputIds: number[], attentionMask: number[]): Promise<InferenceResult>;
}

export interface ModelRuntimeDeps {
  ensureModelFiles(): Promise<ModelFiles>;
  loadTokenizer(tokenizerPath: string): Promise<TokenizerHandle>;
  createSession(modelPath: string): Promise<SessionHandle>;
  /** Matryoshka truncation target; omitted/undefined keeps the model's full 768-dim output. See `resolveOutputDims`. */
  outputDims?: number;
  /** Called with true when the lazy model download/load starts and false when it ends (success or failure). */
  onModelLoading?: (loading: boolean) => void;
  /** Called when download/load of the model fails (the caller still gets the rejection). */
  onModelError?: (error: unknown) => void;
  /** Sequence-length cap per embedding, see embedder.ts (defaults there). */
  maxTokens?: number;
}

export interface ModelCacheDirOptions {
  /** Explicit override; also read from AI_CONTEXT_PLUGIN_MODEL_CACHE_DIR. Injectable for tests. */
  cacheDir?: string;
  env?: Record<string, string | undefined>;
  /** Config-file fallback (.opencode/ai-context.config.yaml's model_cache_dir), used only when neither cacheDir nor the env var is set. */
  fileCacheDir?: string;
}

/**
 * Resolves the model cache directory override, if any. Returns
 * `undefined` by default so `defaultEnsureModelFiles` leaves
 * `@huggingface/hub`'s `cacheDir` param unset, letting it fall back to
 * its own standard shared cache (`$HF_HOME/hub`, `~/.cache/
 * huggingface/hub` by default) -- the SAME cache Python
 * `huggingface_hub`/`transformers`/`sentence-transformers` and JS
 * `@huggingface/transformers` all use. That's a deliberate choice: if
 * another OpenCode plugin (or any other HF-ecosystem tool on the same
 * machine) also embeds with nomic-embed-text-v1.5, it downloads the
 * exact same content-addressed blob once and every consumer reuses it,
 * instead of each plugin keeping its own private ~137MB copy under
 * this plugin's own data dir. Unlike the per-project vector-store
 * files (project-key.ts), this is a shared, static model artifact, not
 * per-project data -- there's no isolation benefit to duplicating it.
 * `AI_CONTEXT_PLUGIN_MODEL_CACHE_DIR` remains as an explicit opt-out
 * for locked-down/air-gapped setups that want a private, fully
 * plugin-owned cache instead. Also settable via a repo's
 * `.opencode/ai-context.config.yaml` (`model_cache_dir`, config-file.ts,
 * user-directed 2026-09-16) -- the env var still wins when explicitly
 * set, matching heavy-mode.ts's "env overrides the file" precedence.
 */
export function resolveModelCacheDir(options: ModelCacheDirOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  return options.cacheDir ?? env.AI_CONTEXT_PLUGIN_MODEL_CACHE_DIR ?? options.fileCacheDir;
}

export interface OutputDimsOptions {
  /** Explicit override; also read from AI_CONTEXT_PLUGIN_EMBED_DIMS. Injectable for tests. */
  dims?: number;
  env?: Record<string, string | undefined>;
  /** Config-file fallback (.opencode/ai-context.config.yaml's embed_dims), used only when neither dims nor a valid env var is set. */
  fileDims?: number;
}

/**
 * Resolves the Matryoshka truncation target dims, if any. Returns
 * `undefined` by default (full nomic-embed-text-v1.5 768-dim output,
 * no truncation) -- opt-in via `AI_CONTEXT_PLUGIN_EMBED_DIMS` for repos
 * that want a smaller/faster brute-force cosine search at some recall
 * cost (see storage-spike's chunk-count-vs-latency numbers in plan.md).
 * A non-numeric env value is ignored (falls back to the config-file
 * value, if any, then no truncation) rather than throwing, matching
 * this module's other env-parsing (`heavy-mode.ts`'s case-insensitive
 * boolean parse) in preferring a safe default over a startup crash from
 * a malformed env var. Also settable via a repo's
 * `.opencode/ai-context.config.yaml` (`embed_dims`, config-file.ts,
 * user-directed 2026-09-16) -- an explicitly-set (and validly numeric)
 * env var still wins over the config file.
 */
export function resolveOutputDims(options: OutputDimsOptions = {}): number | undefined {
  if (options.dims !== undefined) return options.dims;
  const env = options.env ?? process.env;
  const raw = env.AI_CONTEXT_PLUGIN_EMBED_DIMS;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return options.fileDims;
}

/**
 * Splits a flat row-major `[1, seqLen, hidden]` ONNX output buffer into
 * `seqLen` rows of length `hidden` -- pure, so it's unit-testable
 * without a real ONNX session. Ignores the batch dimension (always 1:
 * this plugin embeds one text at a time, no batching yet).
 */
export function reshapeHiddenState(
  flatData: Float32Array | number[],
  dims: readonly number[],
): number[][] {
  const [, seqLen, hidden] = dims;
  const rows: number[][] = [];
  for (let t = 0; t < (seqLen ?? 0); t++) {
    const row: number[] = [];
    for (let d = 0; d < (hidden ?? 0); d++) {
      row.push(Number(flatData[t * (hidden ?? 0) + d]));
    }
    rows.push(row);
  }
  return rows;
}

/** Real `ensureModelFiles`: downloads (or reuses the cached copy of) the tokenizer + quantized ONNX model. */
export async function defaultEnsureModelFiles(options: ModelCacheDirOptions = {}): Promise<ModelFiles> {
  const { downloadFileToCacheDir } = await import("@huggingface/hub");
  const cacheDir = resolveModelCacheDir(options);
  const repo = { name: MODEL_REPO, type: "model" as const };
  const [tokenizerPath, modelPath] = await Promise.all([
    downloadFileToCacheDir({ repo, path: TOKENIZER_FILE, cacheDir }),
    downloadFileToCacheDir({ repo, path: MODEL_FILE, cacheDir }),
  ]);
  return { tokenizerPath, modelPath };
}

/** Real `loadTokenizer`: wraps `tokenizers`' `Tokenizer.fromFile` (adds CLS/SEP automatically, per the BERT-style tokenizer config nomic publishes). */
export async function defaultLoadTokenizer(tokenizerPath: string): Promise<TokenizerHandle> {
  const { Tokenizer } = await import("tokenizers");
  const tokenizer = Tokenizer.fromFile(tokenizerPath);
  return {
    async tokenize(text) {
      const encoding = await tokenizer.encode(text);
      return { inputIds: encoding.getIds(), attentionMask: encoding.getAttentionMask() };
    },
  };
}

export const DEFAULT_EMBED_THREADS = 6;

/**
 * Session options that favor a small, predictable footprint over raw
 * speed: no CPU memory arena (it retains the peak of the largest input
 * for the process lifetime), no memory-pattern pre-planning, and few
 * threads (indexing is background work and must not saturate the CPU).
 */
export function buildSessionOptions(options: { threads?: number }) {
  return {
    enableCpuMemArena: false,
    enableMemPattern: false,
    executionMode: "sequential" as const,
    intraOpNumThreads: options.threads ?? DEFAULT_EMBED_THREADS,
    interOpNumThreads: 1,
  };
}

/** Real `createSession`: wraps `onnxruntime-node`'s `InferenceSession`. */
export async function defaultCreateSession(modelPath: string, options: { threads?: number } = {}): Promise<SessionHandle> {
  const ort = await import("onnxruntime-node");
  const session = await ort.InferenceSession.create(modelPath, buildSessionOptions(options));
  return {
    async runInference(inputIds, attentionMask) {
      const n = inputIds.length;
      const toInt64Tensor = (values: number[]) =>
        new ort.Tensor("int64", BigInt64Array.from(values.map(BigInt)), [1, n]);
      const results = await session.run({
        input_ids: toInt64Tensor(inputIds),
        token_type_ids: toInt64Tensor(new Array(n).fill(0)),
        attention_mask: toInt64Tensor(attentionMask),
      });
      const output = results["last_hidden_state"]!;
      return { lastHiddenState: reshapeHiddenState(output.data as Float32Array, output.dims) };
    },
  };
}

/**
 * Lazily downloads/loads the model runtime on the FIRST embed call
 * (not at plugin startup -- avoids a network round trip/model load on
 * every OpenCode session start when semantic_search may never be
 * called), memoizing the init promise so concurrent/later calls reuse
 * the same tokenizer + ONNX session instead of reloading them. A failed
 * init is NOT cached, so a transient failure (e.g. no network on first
 * use) can be retried on the next call rather than permanently
 * breaking semantic_search for the rest of the session.
 *
 * Returns BOTH `embedQuery` (for search queries, "search_query: "
 * prefix) and `embedDocument` (for indexed chunks, "search_document: "
 * prefix) sharing the SAME underlying tokenizer + ONNX session --
 * calling this twice (once per direction) would otherwise download and
 * load the ~137MB model twice for no reason.
 */
export interface LazyEmbedder {
  embedQuery(text: string): Promise<number[]>;
  embedDocument(text: string): Promise<number[]>;
}

export function createLazyEmbedder(deps: ModelRuntimeDeps): LazyEmbedder {
  let initPromise: Promise<{ tokenize: TokenizerHandle["tokenize"]; runInference: SessionHandle["runInference"] }> | null = null;

  async function init() {
    const { tokenizerPath, modelPath } = await deps.ensureModelFiles();
    const [tokenizer, session] = await Promise.all([
      deps.loadTokenizer(tokenizerPath),
      deps.createSession(modelPath),
    ]);
    return { tokenize: tokenizer.tokenize, runInference: session.runInference };
  }

  async function embed(text: string, prefix: "search_query" | "search_document"): Promise<number[]> {
    if (!initPromise) {
      deps.onModelLoading?.(true);
      initPromise = init()
        .catch((error) => {
          initPromise = null; // don't cache a failed init -- allow retry on the next call
          deps.onModelError?.(error);
          throw error;
        })
        .finally(() => deps.onModelLoading?.(false));
    }
    const { tokenize, runInference } = await initPromise;
    const embedder = createEmbedder({ tokenize, runInference, outputDims: deps.outputDims, maxTokens: deps.maxTokens });
    return embedder.embed(text, { prefix });
  }

  return {
    embedQuery: (text) => embed(text, "search_query"),
    embedDocument: (text) => embed(text, "search_document"),
  };
}

/** Real default, wiring all pieces above together -- used by plugin.ts. */
export function createDefaultEmbedder(
  options: ModelCacheDirOptions &
    OutputDimsOptions &
    Pick<ModelRuntimeDeps, "onModelLoading" | "onModelError" | "maxTokens"> & { threads?: number } = {},
): LazyEmbedder {
  return createLazyEmbedder({
    ensureModelFiles: () => defaultEnsureModelFiles(options),
    loadTokenizer: defaultLoadTokenizer,
    createSession: (modelPath) => defaultCreateSession(modelPath, { threads: options.threads }),
    outputDims: resolveOutputDims(options),
    onModelLoading: options.onModelLoading,
    onModelError: options.onModelError,
    maxTokens: options.maxTokens,
  });
}

// --- Cross-encoder reranker -------------------------------------------------

const RERANKER_REPO = "Xenova/ms-marco-MiniLM-L-6-v2";
const RERANKER_MAX_TOKENS = 512;

export interface PairEncoding {
  inputIds: number[];
  attentionMask: number[];
  tokenTypeIds: number[];
}

export interface PairTokenizerHandle {
  encodePair(query: string, text: string): Promise<PairEncoding>;
}

export interface RerankSession {
  score(encoding: PairEncoding): Promise<number>;
}

export interface RerankerRuntimeDeps {
  ensureModelFiles(): Promise<ModelFiles>;
  loadTokenizer(tokenizerPath: string): Promise<PairTokenizerHandle>;
  createSession(modelPath: string): Promise<RerankSession>;
  onModelError?: (error: unknown) => void;
}

export interface LazyReranker {
  /** Relevance logit per text (higher = more relevant to `query`), same order as `texts`. */
  rerank(query: string, texts: string[]): Promise<number[]>;
}

/**
 * Cross-encoder (query, passage) scorer, loaded on first use like the
 * embedder. A failed load is not cached so it can be retried.
 */
export function createLazyReranker(deps: RerankerRuntimeDeps): LazyReranker {
  let initPromise: Promise<{ tokenizer: PairTokenizerHandle; session: RerankSession }> | null = null;

  async function init() {
    const { tokenizerPath, modelPath } = await deps.ensureModelFiles();
    const [tokenizer, session] = await Promise.all([
      deps.loadTokenizer(tokenizerPath),
      deps.createSession(modelPath),
    ]);
    return { tokenizer, session };
  }

  return {
    async rerank(query, texts) {
      if (texts.length === 0) return [];
      initPromise ??= init().catch((error) => {
        initPromise = null;
        deps.onModelError?.(error);
        throw error;
      });
      const { tokenizer, session } = await initPromise;
      const scores: number[] = [];
      for (const text of texts) {
        scores.push(await session.score(await tokenizer.encodePair(query, text)));
      }
      return scores;
    },
  };
}

export async function defaultEnsureRerankerFiles(options: ModelCacheDirOptions = {}): Promise<ModelFiles> {
  const { downloadFileToCacheDir } = await import("@huggingface/hub");
  const cacheDir = resolveModelCacheDir(options);
  const repo = { name: RERANKER_REPO, type: "model" as const };
  const [tokenizerPath, modelPath] = await Promise.all([
    downloadFileToCacheDir({ repo, path: TOKENIZER_FILE, cacheDir }),
    downloadFileToCacheDir({ repo, path: MODEL_FILE, cacheDir }),
  ]);
  return { tokenizerPath, modelPath };
}

export async function defaultLoadPairTokenizer(tokenizerPath: string): Promise<PairTokenizerHandle> {
  const { Tokenizer } = await import("tokenizers");
  const tokenizer = Tokenizer.fromFile(tokenizerPath);
  tokenizer.setTruncation(RERANKER_MAX_TOKENS);
  return {
    async encodePair(query, text) {
      const encoding = await tokenizer.encode(query, text);
      return {
        inputIds: encoding.getIds(),
        attentionMask: encoding.getAttentionMask(),
        tokenTypeIds: encoding.getTypeIds(),
      };
    },
  };
}

export async function defaultCreateRerankSession(modelPath: string, options: { threads?: number } = {}): Promise<RerankSession> {
  const ort = await import("onnxruntime-node");
  const session = await ort.InferenceSession.create(modelPath, buildSessionOptions(options));
  return {
    async score(encoding) {
      const n = encoding.inputIds.length;
      const tensor = (values: number[]) =>
        new ort.Tensor("int64", BigInt64Array.from(values.map(BigInt)), [1, n]);
      const results = await session.run({
        input_ids: tensor(encoding.inputIds),
        attention_mask: tensor(encoding.attentionMask),
        token_type_ids: tensor(encoding.tokenTypeIds),
      });
      return Number((results["logits"]!.data as Float32Array)[0]);
    },
  };
}

export function createDefaultReranker(
  options: ModelCacheDirOptions & Pick<ModelRuntimeDeps, "onModelError"> & { threads?: number } = {},
): LazyReranker {
  return createLazyReranker({
    ensureModelFiles: () => defaultEnsureRerankerFiles(options),
    loadTokenizer: defaultLoadPairTokenizer,
    createSession: (modelPath) => defaultCreateRerankSession(modelPath, { threads: options.threads }),
    onModelError: options.onModelError,
  });
}
