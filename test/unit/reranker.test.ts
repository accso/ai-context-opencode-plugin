import { test } from "node:test";
import assert from "node:assert/strict";
import { createLazyReranker } from "../../src/embedding/model-runtime.js";

function fakeDeps() {
  const calls = { ensure: 0, tokenizer: 0, session: 0, scored: [] as string[] };
  const deps = {
    ensureModelFiles: async () => {
      calls.ensure++;
      return { tokenizerPath: "t", modelPath: "m" };
    },
    loadTokenizer: async () => {
      calls.tokenizer++;
      return {
        encodePair: async (query: string, text: string) => ({
          inputIds: [query.length, text.length],
          attentionMask: [1, 1],
          tokenTypeIds: [0, 1],
        }),
      };
    },
    createSession: async () => {
      calls.session++;
      return {
        score: async (enc: { inputIds: number[] }) => {
          calls.scored.push(String(enc.inputIds[1]));
          return enc.inputIds[1]!;
        },
      };
    },
  };
  return { deps, calls };
}

test("rerank scores every text in order and loads the model once", async () => {
  const { deps, calls } = fakeDeps();
  const reranker = createLazyReranker(deps);
  assert.deepEqual(await reranker.rerank("q", ["aa", "b", "cccc"]), [2, 1, 4]);
  assert.deepEqual(await reranker.rerank("q", ["x"]), [1]);
  assert.equal(calls.ensure, 1);
  assert.equal(calls.session, 1);
});

test("rerank of no texts does not load the model", async () => {
  const { deps, calls } = fakeDeps();
  assert.deepEqual(await createLazyReranker(deps).rerank("q", []), []);
  assert.equal(calls.ensure, 0);
});

test("a failed model load is reported and retried on the next call", async () => {
  const { deps, calls } = fakeDeps();
  let fail = true;
  const errors: unknown[] = [];
  const reranker = createLazyReranker({
    ...deps,
    ensureModelFiles: async () => {
      if (fail) throw new Error("offline");
      return deps.ensureModelFiles();
    },
    onModelError: (e) => errors.push(e),
  });
  await assert.rejects(reranker.rerank("q", ["a"]), /offline/);
  assert.equal(errors.length, 1);
  fail = false;
  assert.deepEqual(await reranker.rerank("q", ["abc"]), [3]);
  assert.equal(calls.ensure, 1);
});
