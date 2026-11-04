import { createDefaultEmbedder, createDefaultReranker } from "../embedding/model-runtime.js";
import { startWorkerServer, type WorkerServer } from "./worker-server.js";
import type { WorkerOptions } from "./worker-spawn.js";

/**
 * Entry point of the shared embedding worker (ADR-0021), bundled to
 * ai-context-worker.mjs. Holds the one ONNX model session so the opencode
 * host process stays small; exits when idle or over its memory limit.
 */
const options = JSON.parse(process.argv[2] ?? "{}") as WorkerOptions;

let server: WorkerServer | null = null;
const embedder = createDefaultEmbedder({
  ...options.embed,
  onModelLoading: (loading) =>
    server?.broadcast({ event: "model-loading", loading }),
  onModelError: (error) =>
    console.error(`[worker] model error: ${String(error)}`),
});

const reranker = createDefaultReranker({
  fileCacheDir: options.embed?.fileCacheDir,
  threads: options.embed?.threads,
  onModelError: (error) =>
    console.error(`[worker] reranker model error: ${String(error)}`),
});

server = await startWorkerServer({
  socketPath: options.socketPath,
  embedder: {
    embedQuery: embedder.embedQuery,
    embedDocument: embedder.embedDocument,
    rerank: reranker.rerank,
  },
  idleMs: options.idleMs,
  concurrency: options.concurrency,
  maxRssBytes: options.maxRssBytes,
  onExit: (reason) => {
    console.error(`[worker] exiting: ${reason}`);
    process.exit(0);
  },
});
if (!server) {
  console.error("[worker] another worker is already running");
  process.exit(0);
}
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void server?.close().then(() => process.exit(0)));
}
