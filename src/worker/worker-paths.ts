import os from "node:os";
import path from "node:path";

// sun_path is 104 bytes on macOS (108 on Linux); stay clear of both.
const MAX_SOCKET_PATH = 100;

export function resolveSocketPath(dataDir: string): string {
  const preferred = path.join(dataDir, "embed-worker.sock");
  if (preferred.length <= MAX_SOCKET_PATH) return preferred;
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(os.tmpdir(), `ai-context-worker-${uid}.sock`);
}
