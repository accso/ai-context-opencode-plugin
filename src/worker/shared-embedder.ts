import fs from "node:fs";
import path from "node:path";
import { createWorkerEmbedder, type WorkerEmbeddingClient } from "./worker-client.js";
import { resolveSocketPath } from "./worker-paths.js";
import {
  buildSpawnSpec,
  resolveWorkerScript,
  spawnDetached,
  type WorkerOptions,
} from "./worker-spawn.js";
import type { WorkerEmbedder } from "./worker-server.js";

const WORKER_IDLE_MS = 10 * 60 * 1000;

export interface SharedEmbedderInput {
  /** Plugin data dir (socket and log live here). */
  dataDir: string;
  /** Directory of the running plugin bundle. */
  pluginDir: string;
  sharedWorker?: boolean;
  maxMemoryMb?: number;
  concurrency?: number;
  embed?: WorkerOptions["embed"];
  /** In-process embedder used if the worker cannot be reached. */
  fallback: () => WorkerEmbedder;
  onFallback?: (reason: unknown) => void;
  onModelLoading?: (loading: boolean) => void;
  onWorkerError?: (message: string) => void;
  execPath?: string;
  exists?: (p: string) => boolean;
  env?: Record<string, string | undefined>;
}

/**
 * Client of the shared embedding worker, or null when it is disabled
 * (`shared_worker: false`, `AI_CONTEXT_SHARED_WORKER=0`) or the worker
 * script is not installed -- the caller then embeds in-process (ADR-0021).
 */
export function createSharedEmbedder(input: SharedEmbedderInput): WorkerEmbeddingClient | null {
  const env = input.env ?? process.env;
  if (input.sharedWorker === false || env.AI_CONTEXT_SHARED_WORKER === "0") return null;
  const scriptPath = resolveWorkerScript(input.pluginDir, input.exists ?? fs.existsSync);
  if (!scriptPath) return null;

  const socketPath = resolveSocketPath(input.dataDir);
  const options: WorkerOptions = {
    socketPath,
    idleMs: WORKER_IDLE_MS,
    maxRssBytes: input.maxMemoryMb ? input.maxMemoryMb * 1024 * 1024 : undefined,
    concurrency: input.concurrency,
    embed: input.embed,
  };
  return createWorkerEmbedder({
    socketPath,
    spawn: () =>
      spawnDetached(
        buildSpawnSpec({ execPath: input.execPath ?? process.execPath, scriptPath, options }),
        path.join(input.dataDir, "embed-worker.log"),
      ),
    fallback: input.fallback,
    onFallback: input.onFallback,
    onModelLoading: input.onModelLoading,
    onWorkerError: input.onWorkerError,
  });
}
