import net from "node:net";
import {
  createLineDecoder,
  encodeMessage,
  type EmbedPrefix,
} from "./protocol.js";
import type { WorkerEmbedder } from "./worker-server.js";

export interface WorkerEmbedderOptions {
  socketPath: string;
  /** Starts a detached worker process. Called at most once per (re)connect attempt. */
  spawn(): void;
  connectTimeoutMs?: number;
  pollMs?: number;
  /** In-process embedder used when the worker cannot be reached; created lazily. */
  fallback?: () => WorkerEmbedder;
  onFallback?: (reason: unknown) => void;
  onModelLoading?: (loading: boolean) => void;
  /** Called with errors reported by the worker (e.g. model load failures). */
  onWorkerError?: (message: string) => void;
  /** Reranking waits at most this long (an older worker never answers `rerank`). Default 30 s. */
  rerankTimeoutMs?: number;
}

export interface WorkerEmbeddingClient extends WorkerEmbedder {
  rerank(query: string, texts: string[]): Promise<number[]>;
  close(): void;
}

class WorkerUnavailableError extends Error {}
class ConnectionLostError extends Error {}

function tryConnect(socketPath: string): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", () => resolve(null));
  });
}

/** LazyEmbedder-compatible client of the shared worker (ADR-0021). */
export function createWorkerEmbedder(
  options: WorkerEmbedderOptions,
): WorkerEmbeddingClient {
  const connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
  const pollMs = options.pollMs ?? 100;
  let socket: net.Socket | null = null;
  let connecting: Promise<net.Socket> | null = null;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  let fallbackEmbedder: WorkerEmbedder | null = null;
  let useFallback = false;

  function attach(s: net.Socket) {
    const decoder = createLineDecoder((message) => {
      if (message?.event === "model-loading") {
        options.onModelLoading?.(Boolean(message.loading));
        return;
      }
      const waiter = pending.get(message?.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error !== undefined) {
        options.onWorkerError?.(message.error);
        waiter.reject(new Error(message.error));
      } else waiter.resolve(message.scores ?? message.vector);
    });
    s.on("data", (chunk) => decoder.push(chunk));
    s.on("error", () => {});
    s.on("close", () => {
      if (socket === s) socket = null;
      for (const [id, waiter] of pending) {
        pending.delete(id);
        waiter.reject(
          new ConnectionLostError("embedding worker connection lost"),
        );
      }
    });
  }

  async function connect(): Promise<net.Socket> {
    if (socket && !socket.destroyed) return socket;
    connecting ??= (async () => {
      let s = await tryConnect(options.socketPath);
      if (!s) {
        options.spawn();
        const deadline = Date.now() + connectTimeoutMs;
        while (!s && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, pollMs));
          s = await tryConnect(options.socketPath);
        }
      }
      if (!s)
        throw new WorkerUnavailableError(
          "embedding worker did not start in time",
        );
      attach(s);
      socket = s;
      return s;
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  }

  async function requestOnce(
    prefix: EmbedPrefix,
    text: string,
  ): Promise<number[]> {
    const s = await connect();
    const id = nextId++;
    return new Promise<number[]>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      s.write(encodeMessage({ id, op: "embed", prefix, text }));
    });
  }

  async function rerankOnce(query: string, texts: string[]): Promise<number[]> {
    const s = await connect();
    const id = nextId++;
    return new Promise<number[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("rerank timed out"));
      }, options.rerankTimeoutMs ?? 30_000);
      pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      s.write(encodeMessage({ id, op: "rerank", query, texts }));
    });
  }

  async function rerank(query: string, texts: string[]): Promise<number[]> {
    if (useFallback) return fallbackRerank(query, texts);
    try {
      try {
        return await rerankOnce(query, texts);
      } catch (error) {
        if (!(error instanceof ConnectionLostError)) throw error;
        return await rerankOnce(query, texts);
      }
    } catch (error) {
      if (
        (error instanceof WorkerUnavailableError ||
          error instanceof ConnectionLostError) &&
        options.fallback
      ) {
        useFallback = true;
        options.onFallback?.(error);
        return fallbackRerank(query, texts);
      }
      throw error;
    }
  }

  function fallbackRerank(query: string, texts: string[]): Promise<number[]> {
    fallbackEmbedder ??= options.fallback!();
    if (!fallbackEmbedder.rerank) throw new Error("rerank is not available");
    return fallbackEmbedder.rerank(query, texts);
  }

  async function embed(prefix: EmbedPrefix, text: string): Promise<number[]> {
    if (useFallback) return fromFallback(prefix, text);
    try {
      try {
        return await requestOnce(prefix, text);
      } catch (error) {
        if (!(error instanceof ConnectionLostError)) throw error;
        // the worker was recycled (idle/memory limit): reconnect or respawn once
        return await requestOnce(prefix, text);
      }
    } catch (error) {
      if (
        (error instanceof WorkerUnavailableError ||
          error instanceof ConnectionLostError) &&
        options.fallback
      ) {
        useFallback = true;
        options.onFallback?.(error);
        return fromFallback(prefix, text);
      }
      throw error;
    }
  }

  function fromFallback(prefix: EmbedPrefix, text: string): Promise<number[]> {
    fallbackEmbedder ??= options.fallback!();
    return prefix === "query"
      ? fallbackEmbedder.embedQuery(text)
      : fallbackEmbedder.embedDocument(text);
  }

  return {
    embedQuery: (text) => embed("query", text),
    embedDocument: (text) => embed("document", text),
    rerank,
    close() {
      socket?.destroy();
      socket = null;
    },
  };
}
