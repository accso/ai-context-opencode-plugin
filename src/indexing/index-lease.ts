import fs from "node:fs";
import path from "node:path";

/**
 * Cross-process lease so only one opencode process indexes a project at a
 * time. Every ACP session is its own process; without it they all ran the
 * startup pass and wrote to the same SQLite files. The holder refreshes a
 * heartbeat; a lease of a dead process or without a recent heartbeat is stale
 * and gets taken over.
 */
export interface IndexLeaseOptions {
  filePath: string;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  /** No heartbeat for this long = stale. Default 45 s. */
  staleMs?: number;
  /** Heartbeat interval while held; 0 disables the timer. Default 10 s. */
  heartbeatMs?: number;
  /** How often `run` retries while another process holds the lease. Default 3 s. */
  pollMs?: number;
}

export interface IndexLease {
  tryAcquire(): boolean;
  release(): void;
  heartbeat(): void;
  /** Waits for the lease, runs `job` while holding it, always releases. */
  run<T>(job: () => Promise<T>): Promise<T>;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function createIndexLease(options: IndexLeaseOptions): IndexLease {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? defaultIsAlive;
  const now = options.now ?? Date.now;
  const staleMs = options.staleMs ?? 45_000;
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const pollMs = options.pollMs ?? 3_000;
  let held = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const payload = () => JSON.stringify({ pid, ts: now() });
  const read = (): { pid: number; ts: number } | null => {
    try {
      return JSON.parse(fs.readFileSync(options.filePath, "utf8"));
    } catch {
      return null;
    }
  };
  const isStale = (holder: { pid: number; ts: number } | null) =>
    !holder || !isAlive(holder.pid) || now() - holder.ts > staleMs;

  function create(): boolean {
    try {
      fs.mkdirSync(path.dirname(options.filePath), { recursive: true });
      fs.writeFileSync(options.filePath, payload(), { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }

  function startTimer() {
    if (heartbeatMs > 0) {
      timer = setInterval(() => lease.heartbeat(), heartbeatMs);
      timer.unref?.();
    }
  }

  const lease: IndexLease = {
    tryAcquire() {
      if (held) return true;
      let ok = create();
      if (!ok && isStale(read())) {
        try {
          fs.unlinkSync(options.filePath);
        } catch {
          // someone else removed it first
        }
        ok = create();
      }
      if (ok && read()?.pid === pid) {
        held = true;
        startTimer();
        return true;
      }
      return false;
    },
    heartbeat() {
      if (!held || read()?.pid !== pid) return;
      try {
        fs.writeFileSync(options.filePath, payload());
      } catch {
        // a missed heartbeat only matters if it repeats beyond staleMs
      }
    },
    release() {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (!held) return;
      held = false;
      if (read()?.pid !== pid) return;
      try {
        fs.unlinkSync(options.filePath);
      } catch {
        // already gone
      }
    },
    async run(job) {
      while (!lease.tryAcquire()) await new Promise((r) => setTimeout(r, pollMs));
      try {
        return await job();
      } finally {
        lease.release();
      }
    },
  };
  return lease;
}
