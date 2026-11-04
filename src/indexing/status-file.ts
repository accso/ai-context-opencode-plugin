import nodeFs from "node:fs";
import path from "node:path";
import type { IndexProgressSnapshot } from "./index-progress.js";

/**
 * Mirrors the progress tracker into `.opencode/ai-context/index-status.json`
 * so a user can follow indexing with e.g. `watch -n1 cat <file>`, no matter
 * which frontend (opencode TUI, JetBrains AI Assistant via ACP, ...) hosts
 * the plugin. The file lives in the worktree, so file-filter.ts must keep
 * excluding `.opencode/ai-context/` -- otherwise every write would come
 * back as a `file.watcher.updated` event and be indexed.
 */

export const STATUS_FILE_VERSION = 1;
const DEFAULT_THROTTLE_MS = 2000;

export function resolveStatusFilePath(worktree: string): string {
  return path.join(worktree, ".opencode", "ai-context", "index-status.json");
}

export interface StatusFileFs {
  mkdirSync(dir: string, options: { recursive: true }): unknown;
  writeFileSync(file: string, data: string): unknown;
  renameSync(from: string, to: string): unknown;
}

export interface StatusFileWriterOptions {
  filePath: string;
  fs?: StatusFileFs;
  now?: () => number;
  throttleMs?: number;
  /** Called when the status file cannot be written. */
  onError?: (error: unknown) => void;
}

export interface StatusFileWriter {
  write(snapshot: IndexProgressSnapshot): void;
}

const iso = (ms: number | null) =>
  ms === null ? null : new Date(ms).toISOString();

function serialize(s: IndexProgressSnapshot): string {
  return JSON.stringify(
    {
      version: STATUS_FILE_VERSION,
      ...s,
      startedAt: iso(s.startedAt),
      updatedAt: iso(s.updatedAt),
      finishedAt: iso(s.finishedAt),
      failures: s.failures.map((f) => ({
        ...f,
        lastFailedAt: iso(f.lastFailedAt),
      })),
    },
    null,
    2,
  );
}

export function createStatusFileWriter(
  options: StatusFileWriterOptions,
): StatusFileWriter {
  const fs = options.fs ?? nodeFs;
  const now = options.now ?? Date.now;
  const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
  let lastWriteAt: number | null = null;
  let lastPhase: string | null = null;
  let lastFailed = 0;
  let counter = 0;

  return {
    write(snapshot) {
      const significant =
        snapshot.phase !== lastPhase || snapshot.failed !== lastFailed;
      const t = now();
      if (!significant && lastWriteAt !== null && t - lastWriteAt < throttleMs)
        return;
      lastWriteAt = t;
      lastPhase = snapshot.phase;
      lastFailed = snapshot.failed;
      try {
        fs.mkdirSync(path.dirname(options.filePath), { recursive: true });
        const tmp = `${options.filePath}.${process.pid}.${counter++}.tmp`;
        fs.writeFileSync(tmp, serialize(snapshot));
        fs.renameSync(tmp, options.filePath);
      } catch (error) {
        // progress reporting is best-effort and must never interrupt indexing
        options.onError?.(error);
      }
    },
  };
}
