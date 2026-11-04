import type { ProgressTracker } from "../indexing/index-progress.js";

/**
 * State shared by every plugin instance of one worktree inside this
 * process. opencode bootstraps plugins twice per session; unshared, both
 * instances ran a full index at the same time -- two model sessions
 * (~0.5 GB each), a locked SQLite file, doubled CPU and memory.
 */
export interface WorktreeRuntime {
  progress: ProgressTracker;
  /** Runs jobs strictly one at a time (indexing batches must not overlap). */
  exclusive<T>(job: () => Promise<T>): Promise<T>;
  /** The startup full pass runs once per process and worktree; later callers get the same promise. */
  reconcileOnce(work: () => Promise<void>): Promise<void>;
  /** One lazily created embedder (i.e. one model session) for all instances. */
  sharedEmbedder<E>(create: () => E): E;
}

export interface RuntimeRegistry {
  get(
    worktree: string,
    init: () => { progress: ProgressTracker },
  ): WorktreeRuntime;
}

export function createRuntimeRegistry(): RuntimeRegistry {
  const runtimes = new Map<string, WorktreeRuntime>();
  return {
    get(worktree, init) {
      const existing = runtimes.get(worktree);
      if (existing) return existing;

      let queue: Promise<unknown> = Promise.resolve();
      let reconcile: Promise<void> | undefined;
      let embedder: unknown;
      const runtime: WorktreeRuntime = {
        progress: init().progress,
        exclusive(job) {
          const result = queue.then(job, job);
          queue = result.catch(() => {});
          return result;
        },
        reconcileOnce(work) {
          reconcile ??= work();
          return reconcile;
        },
        sharedEmbedder<E>(create: () => E): E {
          embedder ??= create();
          return embedder as E;
        },
      };
      runtimes.set(worktree, runtime);
      return runtime;
    },
  };
}

export const defaultRuntimeRegistry = createRuntimeRegistry();
