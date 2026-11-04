/**
 * Soft memory ceiling for the indexer. A Bun/Node process cannot be hard-capped
 * from inside, so the indexer asks the guard before every file: over the limit
 * it collects garbage and waits for the RSS to fall; if it does not, indexing
 * stops with a readable error instead of pushing the machine into swap.
 */
export class MemoryLimitError extends Error {
  constructor(
    readonly rssMb: number,
    readonly limitMb: number,
  ) {
    super(
      `indexing stopped: process memory is ${rssMb} MB, above max_memory_mb=${limitMb}. ` +
        `Raise max_memory_mb in .opencode/ai-context.config.yaml or lower embed_max_tokens / max_file_bytes.`,
    );
    this.name = "MemoryLimitError";
  }
}

export interface MemoryGuard {
  ensure(): Promise<void>;
}

export interface MemoryGuardOptions {
  /** <= 0 disables the guard. */
  limitMb: number;
  getRss?: () => number;
  collect?: () => void;
  sleep?: (ms: number) => Promise<void>;
  retries?: number;
  pauseMs?: number;
}

export function createMemoryGuard(options: MemoryGuardOptions): MemoryGuard {
  const getRss = options.getRss ?? (() => process.memoryUsage().rss);
  const collect = options.collect ?? defaultCollect;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 5;
  const pauseMs = options.pauseMs ?? 500;
  const limitBytes = options.limitMb * 1024 * 1024;

  return {
    async ensure() {
      if (options.limitMb <= 0 || getRss() <= limitBytes) return;
      for (let attempt = 0; attempt < retries; attempt++) {
        collect();
        await sleep(pauseMs);
        if (getRss() <= limitBytes) return;
      }
      throw new MemoryLimitError(
        Math.round(getRss() / (1024 * 1024)),
        options.limitMb,
      );
    },
  };
}

function defaultCollect(): void {
  const bun = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun;
  if (bun?.gc) bun.gc(true);
  else (globalThis as { gc?: () => void }).gc?.();
}
