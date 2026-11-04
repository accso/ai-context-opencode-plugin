import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSpawnSpec, resolveWorkerScript } from "../../src/worker/worker-spawn.js";

test("resolveWorkerScript prefers a sibling, then the parent directory, else null", () => {
  const exists = (p: string) => p === "/cfg/ai-context-worker.mjs";
  assert.equal(resolveWorkerScript("/cfg/plugins", exists), "/cfg/ai-context-worker.mjs");
  assert.equal(resolveWorkerScript("/cfg", exists), "/cfg/ai-context-worker.mjs");
  assert.equal(resolveWorkerScript("/other", exists), null);
});

test("buildSpawnSpec runs the host binary as bun (BUN_BE_BUN) with JSON options as argument", () => {
  const spec = buildSpawnSpec({
    execPath: "/opt/opencode",
    scriptPath: "/cfg/ai-context-worker.mjs",
    options: { socketPath: "/s.sock", idleMs: 1 },
    env: { PATH: "/bin" },
  });
  assert.equal(spec.command, "/opt/opencode");
  assert.equal(spec.args[0], "/cfg/ai-context-worker.mjs");
  assert.deepEqual(JSON.parse(spec.args[1]!), { socketPath: "/s.sock", idleMs: 1 });
  assert.equal(spec.env.BUN_BE_BUN, "1");
  assert.equal(spec.env.PATH, "/bin");
});
