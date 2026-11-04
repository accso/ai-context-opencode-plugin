import { test } from "node:test";
import assert from "node:assert/strict";
import { createSharedEmbedder } from "../../src/worker/shared-embedder.js";

const base = {
  dataDir: "/data",
  pluginDir: "/cfg/plugins",
  fallback: () => ({ embedQuery: async () => [1], embedDocument: async () => [1] }),
  exists: () => true,
  env: {} as Record<string, string | undefined>,
};

test("returns a client when enabled and the worker script exists", () => {
  assert.ok(createSharedEmbedder({ ...base }));
});

test("returns null when disabled by config, by env, or when the script is missing", () => {
  assert.equal(createSharedEmbedder({ ...base, sharedWorker: false }), null);
  assert.equal(createSharedEmbedder({ ...base, env: { AI_CONTEXT_SHARED_WORKER: "0" } }), null);
  assert.equal(createSharedEmbedder({ ...base, exists: () => false }), null);
});
