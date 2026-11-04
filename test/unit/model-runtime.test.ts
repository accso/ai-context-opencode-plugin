import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  reshapeHiddenState,
  resolveModelCacheDir,
  resolveOutputDims,
  createLazyEmbedder,
  buildSessionOptions,
  DEFAULT_EMBED_THREADS,
} from "../../src/embedding/model-runtime.js";

/**
 * Unit tests for the real onnxruntime-node/tokenizers/HF-Hub wiring
 * (port-semantic-search-tool's last remaining gap, per plan.md). Real
 * model download/inference is real I/O (network + native ONNX bindings)
 * and deliberately NOT exercised here -- these tests cover the pure
 * reshape logic and the lazy-init/memoization orchestration only, with
 * the download/tokenizer/session pieces injected as mocks (same pattern
 * as index-scheduler.ts/project-registry.ts). A real end-to-end smoke
 * test (real download + real inference) was run manually against
 * nomic-ai/nomic-embed-text-v1.5's quantized ONNX export to confirm the
 * wiring is correct -- see plan.md for the transcript/verification
 * notes; that's not repeatable as a fast unit test.
 */

test("reshapeHiddenState splits a flat [1, seqLen, hidden] buffer into seqLen rows of length hidden", () => {
  // seqLen=2, hidden=3
  const flat = new Float32Array([1, 2, 3, 4, 5, 6]);
  const rows = reshapeHiddenState(flat, [1, 2, 3]);
  assert.deepEqual(rows, [
    [1, 2, 3],
    [4, 5, 6],
  ]);
});

test("reshapeHiddenState works with a plain number[] input too", () => {
  const rows = reshapeHiddenState([1, 2, 3, 4], [1, 2, 2]);
  assert.deepEqual(rows, [
    [1, 2],
    [3, 4],
  ]);
});

test("resolveModelCacheDir returns undefined by default (defers to @huggingface/hub's standard shared cache)", () => {
  // Other OpenCode plugins/tools using the same HF model (e.g. another
  // plugin also embedding with nomic-embed-text-v1.5) should reuse the
  // exact same downloaded blob via HF's own content-addressed cache
  // (~/.cache/huggingface/hub by default, HF_HOME-overridable) instead
  // of each maintaining a private, duplicate copy.
  const dir = resolveModelCacheDir({ env: {} });
  assert.equal(dir, undefined);
});

test("resolveModelCacheDir honors an explicit AI_CONTEXT_PLUGIN_MODEL_CACHE_DIR opt-out for isolation", () => {
  const dir = resolveModelCacheDir({ env: { AI_CONTEXT_PLUGIN_MODEL_CACHE_DIR: "/tmp/isolated-models" } });
  assert.equal(dir, "/tmp/isolated-models");
});

/**
 * Config-file fallback (user-directed, 2026-09-16): both cache dir and
 * output dims are now also settable via `.opencode/ai-context.config.yaml`
 * (config-file.ts). Precedence is explicit option > env var > config
 * file > default -- the env var still wins when set, matching
 * heavy-mode.ts's same "env overrides the file" rule.
 */
test("resolveModelCacheDir falls back to the config-file value when no env var or explicit option is set", () => {
  const dir = resolveModelCacheDir({ env: {}, fileCacheDir: "/from/config-file" });
  assert.equal(dir, "/from/config-file");
});

test("resolveModelCacheDir prefers an explicitly-set env var over the config-file value", () => {
  const dir = resolveModelCacheDir({
    env: { AI_CONTEXT_PLUGIN_MODEL_CACHE_DIR: "/from/env" },
    fileCacheDir: "/from/config-file",
  });
  assert.equal(dir, "/from/env");
});

/**
 * Critical-review finding "wire-matryoshka-truncation" (plan.md):
 * embedder.ts's `truncateMatryoshka` was fully implemented and unit
 * tested but never actually reachable from the real embedding path --
 * `createDefaultEmbedder`/`createLazyEmbedder` never passed an
 * `outputDims` value through to `createEmbedder`, so it was dead code.
 * `resolveOutputDims` reads `AI_CONTEXT_PLUGIN_EMBED_DIMS` the same way
 * `resolveModelCacheDir` reads its own env var -- undefined by default
 * (full 768-dim nomic output, no truncation), opt-in via the env var
 * for repos that want to trade a little recall for a smaller/faster
 * brute-force cosine search (see storage-spike's latency numbers).
 */
test("resolveOutputDims returns undefined by default (no Matryoshka truncation)", () => {
  const dims = resolveOutputDims({ env: {} });
  assert.equal(dims, undefined);
});

test("resolveOutputDims honors an explicit AI_CONTEXT_PLUGIN_EMBED_DIMS override", () => {
  const dims = resolveOutputDims({ env: { AI_CONTEXT_PLUGIN_EMBED_DIMS: "256" } });
  assert.equal(dims, 256);
});

test("resolveOutputDims ignores a non-numeric AI_CONTEXT_PLUGIN_EMBED_DIMS value (falls back to no truncation)", () => {
  const dims = resolveOutputDims({ env: { AI_CONTEXT_PLUGIN_EMBED_DIMS: "not-a-number" } });
  assert.equal(dims, undefined);
});

test("resolveOutputDims prefers an explicit dims option over the env var", () => {
  const dims = resolveOutputDims({ dims: 128, env: { AI_CONTEXT_PLUGIN_EMBED_DIMS: "256" } });
  assert.equal(dims, 128);
});

test("resolveOutputDims falls back to the config-file value when no env var or explicit option is set", () => {
  const dims = resolveOutputDims({ env: {}, fileDims: 384 });
  assert.equal(dims, 384);
});

test("resolveOutputDims prefers an explicitly-set env var over the config-file value", () => {
  const dims = resolveOutputDims({ env: { AI_CONTEXT_PLUGIN_EMBED_DIMS: "256" }, fileDims: 384 });
  assert.equal(dims, 256);
});

test("resolveOutputDims falls back to the config-file value when the env var is set but non-numeric", () => {
  const dims = resolveOutputDims({ env: { AI_CONTEXT_PLUGIN_EMBED_DIMS: "not-a-number" }, fileDims: 384 });
  assert.equal(dims, 384);
});

test("createLazyEmbedder threads outputDims through to the underlying embedder, truncating the result", async () => {
  const ensureModelFiles = mock.fn(async () => ({
    tokenizerPath: "/fake/tokenizer.json",
    modelPath: "/fake/model.onnx",
  }));
  const loadTokenizer = mock.fn(async () => ({
    tokenize: async () => ({ inputIds: [101, 42, 102], attentionMask: [1, 1, 1] }),
  }));
  const createSession = mock.fn(async () => ({
    runInference: async () => ({
      lastHiddenState: [
        [0.1, 0.2, 0.3, 0.4],
        [0.5, 0.6, 0.7, 0.8],
      ],
    }),
  }));

  const { embedQuery } = createLazyEmbedder({ ensureModelFiles, loadTokenizer, createSession, outputDims: 2 });
  const result = await embedQuery("hello");
  assert.equal(result.length, 2, "should truncate the full 4-dim output down to the requested 2 dims");
});

test("createLazyEmbedder initializes the model runtime only once, sharing it between embedQuery and embedDocument", async () => {
  const ensureModelFiles = mock.fn(async () => ({
    tokenizerPath: "/fake/tokenizer.json",
    modelPath: "/fake/model.onnx",
  }));
  const loadTokenizer = mock.fn(async (_path: string) => ({
    tokenize: async (_text: string) => ({ inputIds: [101, 42, 102], attentionMask: [1, 1, 1] }),
  }));
  const createSession = mock.fn(async (_path: string) => ({
    runInference: async (_inputIds: number[], _attentionMask: number[]) => ({
      lastHiddenState: [
        [0.1, 0.2],
        [0.3, 0.4],
        [0.5, 0.6],
      ],
    }),
  }));

  const { embedQuery, embedDocument } = createLazyEmbedder({ ensureModelFiles, loadTokenizer, createSession });

  const first = await embedQuery("hello");
  const second = await embedDocument("some indexed chunk text");

  assert.equal(ensureModelFiles.mock.callCount(), 1, "should only download/resolve model files once");
  assert.equal(loadTokenizer.mock.callCount(), 1, "should only load the tokenizer once");
  assert.equal(createSession.mock.callCount(), 1, "should only create the ONNX session once");
  assert.equal(first.length, 2, "embedQuery should return an embedding vector");
  assert.equal(second.length, 2, "embedDocument should return an embedding vector, sharing the same session");
});

test("createLazyEmbedder propagates init failures without caching a broken state forever on the first failure", async () => {
  let attempt = 0;
  const ensureModelFiles = mock.fn(async () => {
    attempt++;
    if (attempt === 1) throw new Error("network down");
    return { tokenizerPath: "/fake/tokenizer.json", modelPath: "/fake/model.onnx" };
  });
  const loadTokenizer = mock.fn(async () => ({
    tokenize: async () => ({ inputIds: [1], attentionMask: [1] }),
  }));
  const createSession = mock.fn(async () => ({
    runInference: async () => ({ lastHiddenState: [[1, 2]] }),
  }));

  const { embedQuery } = createLazyEmbedder({ ensureModelFiles, loadTokenizer, createSession });

  await assert.rejects(() => embedQuery("hello"), /network down/);
  // Retried on the next call instead of permanently failing.
  const result = await embedQuery("hello again");
  assert.equal(result.length, 2);
  assert.equal(ensureModelFiles.mock.callCount(), 2);
});

function fakeRuntime(overrides: { ensureModelFiles?: () => Promise<{ tokenizerPath: string; modelPath: string }> } = {}) {
  return {
    ensureModelFiles: overrides.ensureModelFiles ?? (async () => ({ tokenizerPath: "/t", modelPath: "/m" })),
    loadTokenizer: async () => ({ tokenize: async () => ({ inputIds: [1, 2], attentionMask: [1, 1] }) }),
    createSession: async () => ({ runInference: async () => ({ lastHiddenState: [[0.1, 0.2], [0.3, 0.4]] }) }),
  };
}

test("createLazyEmbedder signals model loading start/end exactly once around the lazy init", async () => {
  const events: string[] = [];
  const { embedDocument } = createLazyEmbedder({
    ...fakeRuntime(),
    onModelLoading: (loading) => void events.push(loading ? "loading" : "ready"),
  });
  await embedDocument("a");
  await embedDocument("b");
  assert.deepEqual(events, ["loading", "ready"]);
});

test("createLazyEmbedder signals the end of loading even when init fails, and again on retry", async () => {
  const events: string[] = [];
  let fail = true;
  const { embedDocument } = createLazyEmbedder({
    ...fakeRuntime({
      ensureModelFiles: async () => {
        if (fail) throw new Error("offline");
        return { tokenizerPath: "/t", modelPath: "/m" };
      },
    }),
    onModelLoading: (loading) => void events.push(loading ? "loading" : "ready"),
  });
  await assert.rejects(() => embedDocument("a"), /offline/);
  fail = false;
  await embedDocument("a");
  assert.deepEqual(events, ["loading", "ready", "loading", "ready"]);
});

test("buildSessionOptions disables the memory arena/pattern and limits threads", () => {
  const options = buildSessionOptions({ threads: 3 });
  assert.equal(options.enableCpuMemArena, false);
  assert.equal(options.enableMemPattern, false);
  assert.equal(options.intraOpNumThreads, 3);
  assert.equal(options.interOpNumThreads, 1);
  assert.equal(options.executionMode, "sequential");
});

test("buildSessionOptions defaults to a small thread count so indexing does not saturate every core", () => {
  assert.equal(buildSessionOptions({}).intraOpNumThreads, DEFAULT_EMBED_THREADS);
  assert.ok(DEFAULT_EMBED_THREADS === 6);
});

test("createLazyEmbedder passes maxTokens on to the embedder's sequence cap", async () => {
  let length = 0;
  const { embedDocument } = createLazyEmbedder({
    ensureModelFiles: async () => ({ tokenizerPath: "/t", modelPath: "/m" }),
    loadTokenizer: async () => ({ tokenize: async () => ({ inputIds: new Array(50).fill(5), attentionMask: new Array(50).fill(1) }) }),
    createSession: async () => ({
      runInference: async (ids: number[]) => {
        length = ids.length;
        return { lastHiddenState: ids.map(() => [1, 0]) };
      },
    }),
    maxTokens: 8,
  });
  await embedDocument("x");
  assert.equal(length, 8);
});

test("a failing model init is reported through onModelError and still rejects the caller", async () => {
  const errors: unknown[] = [];
  const embedder = createLazyEmbedder({
    ensureModelFiles: async () => {
      throw new Error("download failed");
    },
    loadTokenizer: async () => ({ tokenize: () => ({ inputIds: [], attentionMask: [] }) }) as never,
    createSession: async () => ({ runInference: async () => [] }) as never,
    onModelError: (e: unknown) => void errors.push(e),
  } as never);
  await assert.rejects(() => embedder.embedDocument("x"), /download failed/);
  assert.equal(errors.length, 1);
});
