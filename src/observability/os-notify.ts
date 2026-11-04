import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Native OS notifications: the only status channel that reaches the user
 * under every frontend, including JetBrains AI Assistant via ACP
 * (docs/opencode-plugin-workarounds.md §1e). Best-effort by design.
 */
export interface OsNotifyRunner {
  run(command: string, args: string[]): void;
}

const defaultRunner: OsNotifyRunner = {
  run(command, args) {
    execFile(command, args, () => {
      // notifications must never crash the plugin
    });
  },
};

export function appleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function notifyOs(
  message: string,
  options: {
    title?: string;
    platform?: NodeJS.Platform;
    runner?: OsNotifyRunner;
  } = {},
): void {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? defaultRunner;
  const title = options.title ?? "AI Context";

  if (platform === "darwin") {
    runner.run("osascript", [
      "-e",
      `display notification "${appleScriptString(message)}" with title "${appleScriptString(title)}"`,
    ]);
  } else if (platform === "linux") {
    runner.run("notify-send", [title, message]);
  }
}

/** opencode bootstraps plugins twice per session; this suppresses the duplicate one-shot popup. */
export interface OsNotifyGate {
  shouldNotify(): boolean;
}

export function createOsNotifyGate(
  options: { windowMs?: number; now?: () => number } = {},
): OsNotifyGate {
  const windowMs = options.windowMs ?? 10_000;
  const now = options.now ?? Date.now;
  let lastFiredAt: number | undefined;
  return {
    shouldNotify() {
      const t = now();
      if (lastFiredAt !== undefined && t - lastFiredAt < windowMs) return false;
      lastFiredAt = t;
      return true;
    },
  };
}

export const defaultOsNotifyGate = createOsNotifyGate();

/**
 * Like {@link createOsNotifyGate} but shared across processes (several opencode/ACP
 * processes can start at once) via a marker file whose mtime is the last firing time.
 */
export function createFileOsNotifyGate(
  options: {
    key: string;
    dir?: string;
    windowMs?: number;
    now?: () => number;
  },
): OsNotifyGate {
  const windowMs = options.windowMs ?? 5 * 60_000;
  const now = options.now ?? Date.now;
  const file = path.join(
    options.dir ?? os.tmpdir(),
    `opencode-ai-context-${options.key}.notified`,
  );
  return {
    shouldNotify() {
      try {
        const t = now();
        try {
          const age = t - fs.statSync(file).mtimeMs;
          if (age >= 0 && age < windowMs) return false;
          fs.unlinkSync(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        fs.writeFileSync(file, "", { flag: "wx" });
        fs.utimesSync(file, t / 1000, t / 1000);
        return true;
      } catch {
        // lost the race to another process, or no writable tmp dir
        return false;
      }
    },
  };
}
