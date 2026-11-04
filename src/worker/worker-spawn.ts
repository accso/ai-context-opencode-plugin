import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const WORKER_SCRIPT_NAME = "ai-context-worker.mjs";

export interface WorkerOptions {
  socketPath: string;
  idleMs: number;
  maxRssBytes?: number;
  concurrency?: number;
  embed?: {
    fileCacheDir?: string;
    fileDims?: number;
    threads?: number;
    maxTokens?: number;
  };
}

/** The worker script is installed next to the `plugins/` dir (not inside: opencode loads everything there as a plugin). */
export function resolveWorkerScript(
  pluginDir: string,
  exists: (p: string) => boolean = fs.existsSync,
): string | null {
  for (const dir of [pluginDir, path.dirname(pluginDir)]) {
    const candidate = path.join(dir, WORKER_SCRIPT_NAME);
    if (exists(candidate)) return candidate;
  }
  return null;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}

/** opencode is a compiled Bun binary; BUN_BE_BUN=1 makes it run a script like `bun`. Plain node/bun ignore it. */
export function buildSpawnSpec(input: {
  execPath: string;
  scriptPath: string;
  options: WorkerOptions;
  env?: Record<string, string | undefined>;
}): SpawnSpec {
  return {
    command: input.execPath,
    args: [input.scriptPath, JSON.stringify(input.options)],
    env: { ...(input.env ?? process.env), BUN_BE_BUN: "1" },
  };
}

/** Starts the worker detached, logging to `logPath`; never throws (client falls back in-process). */
export function spawnDetached(spec: SpawnSpec, logPath: string): void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const log = fs.openSync(logPath, "a");
    const child = spawn(spec.command, spec.args, {
      detached: true,
      stdio: ["ignore", log, log],
      env: spec.env as NodeJS.ProcessEnv,
    });
    child.on("error", () => {});
    child.unref();
    fs.closeSync(log);
  } catch {
    // reported by the client's connect timeout / fallback
  }
}
