import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  createLineDecoder,
  encodeMessage,
  type EmbedRequest,
  type RerankRequest,
  type WorkerEvent,
} from "./protocol.js";

export interface WorkerEmbedder {
  embedQuery(text: string): Promise<number[]>;
  embedDocument(text: string): Promise<number[]>;
  /** Cross-encoder scores per text; optional so embedder-only fakes stay valid. */
  rerank?(query: string, texts: string[]): Promise<number[]>;
}

export interface WorkerServerOptions {
  socketPath: string;
  embedder: WorkerEmbedder;
  /** Exit after this long without any connected client. */
  idleMs: number;
  /** Exit (after answering) once RSS exceeds this; clients respawn a fresh worker. */
  maxRssBytes?: number;
  getRss?: () => number;
  onExit?: (reason: "idle" | "memory") => void;
  /** Inferences allowed in parallel across all clients (default 1; each costs transient memory). */
  concurrency?: number;
}

export interface WorkerServer {
  broadcast(event: WorkerEvent): void;
  close(): Promise<void>;
}

function isAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

/**
 * Starts the worker's socket server. Returns null if another worker is
 * already serving this socket, so concurrent spawns converge on one.
 */
export async function startWorkerServer(
  options: WorkerServerOptions,
): Promise<WorkerServer | null> {
  const { socketPath, embedder } = options;
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  if (fs.existsSync(socketPath)) {
    if (await isAlive(socketPath)) return null;
    fs.rmSync(socketPath, { force: true });
  }

  const sockets = new Set<net.Socket>();
  const limit = Math.max(1, Math.floor(options.concurrency ?? 1));
  let active = 0;
  const waiting: Array<() => void> = [];
  const acquire = (): Promise<void> => {
    if (active < limit) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next(); // hand the slot over
    else active--;
  };
  let idleTimer: NodeJS.Timeout | undefined;
  let closed = false;
  const getRss = options.getRss ?? (() => process.memoryUsage().rss);

  const server = net.createServer();

  const shutdown = async (reason?: "idle" | "memory") => {
    if (closed) return;
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(socketPath, { force: true });
    if (reason) options.onExit?.(reason);
  };

  const armIdle = () => {
    if (closed) return;
    if (idleTimer) clearTimeout(idleTimer);
    if (sockets.size === 0)
      idleTimer = setTimeout(() => void shutdown("idle"), options.idleMs);
  };

  server.on("connection", (socket) => {
    sockets.add(socket);
    if (idleTimer) clearTimeout(idleTimer);
    const decoder = createLineDecoder((message: EmbedRequest | RerankRequest) => {
      if (message?.op !== "embed" && message?.op !== "rerank") return;
      // At most `limit` inferences at a time across all clients bounds peak memory.
      void (async () => {
        await acquire();
        try {
        let reply: unknown;
        try {
          if (message.op === "rerank") {
            if (!embedder.rerank) throw new Error("rerank is not supported by this worker");
            reply = { id: message.id, scores: await embedder.rerank(message.query, message.texts) };
          } else {
            const vector =
              message.prefix === "query"
                ? await embedder.embedQuery(message.text)
                : await embedder.embedDocument(message.text);
            reply = { id: message.id, vector };
          }
        } catch (error) {
          reply = {
            id: message.id,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        if (!socket.destroyed) socket.write(encodeMessage(reply));
        if (
          options.maxRssBytes !== undefined &&
          getRss() > options.maxRssBytes
        ) {
          setTimeout(() => void shutdown("memory"), 10);
        }
        } finally {
          release();
        }
      })();
    });
    socket.on("data", (chunk) => decoder.push(chunk));
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      armIdle();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  fs.chmodSync(socketPath, 0o600);
  armIdle();

  return {
    broadcast(event) {
      const wire = encodeMessage(event);
      for (const s of sockets) s.write(wire);
    },
    close: () => shutdown(),
  };
}
