import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { startWorkerServer } from "../../src/worker/worker-server.js";
import { createWorkerEmbedder } from "../../src/worker/worker-client.js";
import { createLineDecoder, encodeMessage } from "../../src/worker/protocol.js";
import { resolveSocketPath } from "../../src/worker/worker-paths.js";

function tmpSocket(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aicw-")), "w.sock");
}

const fakeEmbedder = (calls: string[] = []) => ({
  embedQuery: async (t: string) => (calls.push(`q:${t}`), [t.length, 1]),
  embedDocument: async (t: string) => (calls.push(`d:${t}`), [t.length, 2]),
});

test("line decoder reassembles messages split across chunks", () => {
  const got: unknown[] = [];
  const dec = createLineDecoder((m) => got.push(m));
  const wire = encodeMessage({ id: 1, a: "é" });
  dec.push(wire.subarray(0, 3));
  dec.push(wire.subarray(3));
  dec.push(encodeMessage({ id: 2 }));
  assert.deepEqual(got, [{ id: 1, a: "é" }, { id: 2 }]);
});

test("resolveSocketPath stays under the unix socket length limit", () => {
  const short = resolveSocketPath("/tmp/x");
  assert.equal(short, "/tmp/x/embed-worker.sock");
  const long = resolveSocketPath("/" + "a".repeat(200));
  assert.ok(long.length < 100);
});

test("server answers embed requests through a real unix socket", async () => {
  const socketPath = tmpSocket();
  const calls: string[] = [];
  const server = await startWorkerServer({ socketPath, embedder: fakeEmbedder(calls), idleMs: 60_000 });
  assert.ok(server);
  const client = createWorkerEmbedder({ socketPath, spawn: () => assert.fail("must not spawn") });
  assert.deepEqual(await client.embedQuery("abc"), [3, 1]);
  assert.deepEqual(await client.embedDocument("abcd"), [4, 2]);
  assert.deepEqual(calls, ["q:abc", "d:abcd"]);
  client.close();
  await server!.close();
});

test("a second server on a live socket refuses to start (single shared worker)", async () => {
  const socketPath = tmpSocket();
  const first = await startWorkerServer({ socketPath, embedder: fakeEmbedder(), idleMs: 60_000 });
  const second = await startWorkerServer({ socketPath, embedder: fakeEmbedder(), idleMs: 60_000 });
  assert.equal(second, null);
  await first!.close();
});

test("a stale socket file left by a dead worker is replaced", async () => {
  const socketPath = tmpSocket();
  fs.writeFileSync(socketPath, "");
  const server = await startWorkerServer({ socketPath, embedder: fakeEmbedder(), idleMs: 60_000 });
  assert.ok(server);
  await server!.close();
});

test("embedder errors are returned to the client, not fatal for the worker", async () => {
  const socketPath = tmpSocket();
  let fail = true;
  const embedder = {
    embedQuery: async () => {
      if (fail) throw new Error("boom");
      return [1];
    },
    embedDocument: async () => [1],
  };
  const server = await startWorkerServer({ socketPath, embedder, idleMs: 60_000 });
  const client = createWorkerEmbedder({ socketPath, spawn: () => {} });
  await assert.rejects(client.embedQuery("x"), /boom/);
  fail = false;
  assert.deepEqual(await client.embedQuery("x"), [1]);
  client.close();
  await server!.close();
});

test("the worker exits after idleMs without clients", async () => {
  const socketPath = tmpSocket();
  let exited = 0;
  const server = await startWorkerServer({ socketPath, embedder: fakeEmbedder(), idleMs: 50, onExit: () => exited++ });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(exited, 1);
  assert.equal(fs.existsSync(socketPath), false);
  await server!.close();
});

test("a connected client keeps the worker alive past idleMs", async () => {
  const socketPath = tmpSocket();
  let exited = 0;
  const server = await startWorkerServer({ socketPath, embedder: fakeEmbedder(), idleMs: 50, onExit: () => exited++ });
  const client = createWorkerEmbedder({ socketPath, spawn: () => {} });
  await client.embedQuery("a");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(exited, 0);
  client.close();
  await server!.close();
});

test("the worker exits after a request when its RSS exceeds the limit", async () => {
  const socketPath = tmpSocket();
  let exited = 0;
  const server = await startWorkerServer({
    socketPath,
    embedder: fakeEmbedder(),
    idleMs: 60_000,
    maxRssBytes: 100,
    getRss: () => 1000,
    onExit: () => exited++,
  });
  const client = createWorkerEmbedder({ socketPath, spawn: () => {} });
  assert.deepEqual(await client.embedQuery("ab"), [2, 1]);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(exited, 1);
  client.close();
});

test("client spawns the worker when none is running and then connects", async () => {
  const socketPath = tmpSocket();
  let server: Awaited<ReturnType<typeof startWorkerServer>> = null;
  let spawns = 0;
  const client = createWorkerEmbedder({
    socketPath,
    spawn: () => {
      spawns++;
      setTimeout(async () => {
        server = await startWorkerServer({ socketPath, embedder: fakeEmbedder(), idleMs: 60_000 });
      }, 50);
    },
    connectTimeoutMs: 3000,
    pollMs: 20,
  });
  const [a, b] = await Promise.all([client.embedQuery("x"), client.embedQuery("yy")]);
  assert.deepEqual([a, b], [[1, 1], [2, 1]]);
  assert.equal(spawns, 1);
  client.close();
  await server!.close();
});

test("client falls back to the in-process embedder when the worker cannot be reached", async () => {
  const fallbackCalls: string[] = [];
  let fallbackNotices = 0;
  const client = createWorkerEmbedder({
    socketPath: tmpSocket(),
    spawn: () => {},
    connectTimeoutMs: 100,
    pollMs: 20,
    fallback: () => fakeEmbedder(fallbackCalls),
    onFallback: () => fallbackNotices++,
  });
  assert.deepEqual(await client.embedQuery("abc"), [3, 1]);
  assert.deepEqual(await client.embedDocument("a"), [1, 2]);
  assert.equal(fallbackNotices, 1);
});

test("client retries once when the worker connection drops mid-request (worker recycled)", async () => {
  const socketPath = tmpSocket();
  let first = true;
  const killer = net.createServer((sock) => {
    sock.on("data", () => {
      if (first) {
        first = false;
        sock.destroy();
      } else {
        sock.write(encodeMessage({ id: 2, vector: [9] }));
      }
    });
  });
  await new Promise<void>((r) => killer.listen(socketPath, r));
  const client = createWorkerEmbedder({ socketPath, spawn: () => {}, connectTimeoutMs: 500, pollMs: 20 });
  assert.deepEqual(await client.embedQuery("x"), [9]);
  client.close();
  killer.close();
});

test("model-loading events are forwarded to the client callback", async () => {
  const socketPath = tmpSocket();
  const seen: boolean[] = [];
  const server = await startWorkerServer({ socketPath, embedder: fakeEmbedder(), idleMs: 60_000 });
  const client = createWorkerEmbedder({ socketPath, spawn: () => {}, onModelLoading: (l) => seen.push(l) });
  await client.embedQuery("x");
  server!.broadcast({ event: "model-loading", loading: true });
  server!.broadcast({ event: "model-loading", loading: false });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(seen, [true, false]);
  client.close();
  await server!.close();
});

test("rerank requests travel through the worker and keep order", async () => {
  const socketPath = tmpSocket();
  const embedder = {
    ...fakeEmbedder(),
    rerank: async (q: string, texts: string[]) => texts.map((t) => t.length + q.length),
  };
  const server = await startWorkerServer({ socketPath, embedder, idleMs: 60_000 });
  const client = createWorkerEmbedder({ socketPath, spawn: () => assert.fail("must not spawn") });
  assert.deepEqual(await client.rerank("ab", ["x", "yyy"]), [3, 5]);
  client.close();
  await server!.close();
});

test("a worker without reranking support answers with an error instead of hanging", async () => {
  const socketPath = tmpSocket();
  const server = await startWorkerServer({ socketPath, embedder: fakeEmbedder(), idleMs: 60_000 });
  const client = createWorkerEmbedder({ socketPath, spawn: () => {} });
  await assert.rejects(client.rerank("q", ["a"]), /rerank/);
  client.close();
  await server!.close();
});

test("client rerank times out when the worker never answers (old worker version)", async () => {
  const socketPath = tmpSocket();
  const sockets: net.Socket[] = [];
  const silent = net.createServer((sock) => void sockets.push(sock));
  await new Promise<void>((r) => silent.listen(socketPath, () => r()));
  const client = createWorkerEmbedder({ socketPath, spawn: () => {}, rerankTimeoutMs: 50 });
  await assert.rejects(client.rerank("q", ["a"]), /timed out/);
  client.close();
  sockets.forEach((sock) => sock.destroy());
  await new Promise<void>((r) => silent.close(() => r()));
});

test("client rerank falls back to the in-process reranker when the worker is unavailable", async () => {
  const socketPath = tmpSocket();
  const client = createWorkerEmbedder({
    socketPath,
    spawn: () => {},
    connectTimeoutMs: 100,
    pollMs: 20,
    fallback: () => ({
      ...fakeEmbedder(),
      rerank: async (_q: string, texts: string[]) => texts.map(() => 7),
    }),
  });
  assert.deepEqual(await client.rerank("q", ["a", "b"]), [7, 7]);
  client.close();
});

function inflightEmbedder() {
  const state = { now: 0, max: 0 };
  return {
    state,
    embedder: {
      embedQuery: async () => [1],
      embedDocument: async (t: string) => {
        state.now++;
        state.max = Math.max(state.max, state.now);
        await new Promise((r) => setTimeout(r, 20));
        state.now--;
        return [t.length];
      },
    },
  };
}

test("worker runs inferences strictly one at a time by default", async () => {
  const socketPath = tmpSocket();
  const { state, embedder } = inflightEmbedder();
  const server = await startWorkerServer({ socketPath, embedder, idleMs: 60_000 });
  const client = createWorkerEmbedder({ socketPath, spawn: () => assert.fail("no spawn") });
  await Promise.all(["a", "bb", "ccc", "dddd"].map((t) => client.embedDocument(t)));
  assert.equal(state.max, 1);
  client.close();
  await server!.close();
});

test("worker runs up to `concurrency` inferences in parallel and answers every request", async () => {
  const socketPath = tmpSocket();
  const { state, embedder } = inflightEmbedder();
  const server = await startWorkerServer({ socketPath, embedder, idleMs: 60_000, concurrency: 3 });
  const client = createWorkerEmbedder({ socketPath, spawn: () => assert.fail("no spawn") });
  const out = await Promise.all(["a", "bb", "ccc", "dddd", "eeeee", "ffffff"].map((t) => client.embedDocument(t)));
  assert.deepEqual(out, [[1], [2], [3], [4], [5], [6]]);
  assert.equal(state.max, 3);
  client.close();
  await server!.close();
});
