/**
 * In-process debounce scheduler for file-change notifications coming from
 * the plugin's `file.watcher.updated` event hook (see plugin.ts and
 * plan.md, phased todo 5 "Replace the watcher container with plugin
 * hooks"). Mirrors the ~2s debounce the old standalone watcher container
 * used, but coalesces in-process instead of via a service loop -- OpenCode
 * does not debounce these events for you.
 */

export type FileChangeEvent = "add" | "change" | "unlink";

export interface FileChangeBatchEntry {
  file: string;
  event: FileChangeEvent;
}

export interface IndexSchedulerOptions {
  /** Debounce window in milliseconds. Defaults to 2000 (matches the old watcher's debounce). */
  debounceMs?: number;
  /** Invoked with the deduped, coalesced batch once the debounce window elapses (or flush() is called). */
  indexFiles: (batch: FileChangeBatchEntry[]) => Promise<void>;
}

export interface IndexScheduler {
  /** Record a file-change notification; (re)starts the debounce timer. */
  notify(file: string, event: FileChangeEvent): void;
  /** Flush any pending batch immediately, bypassing the debounce timer. No-op if nothing is pending. */
  flush(): Promise<void>;
}

export function createIndexScheduler(
  options: IndexSchedulerOptions,
): IndexScheduler {
  const debounceMs = options.debounceMs ?? 2000;
  const pending = new Map<string, FileChangeEvent>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function flush(): Promise<void> {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pending.size === 0) return;
    const batch: FileChangeBatchEntry[] = Array.from(pending.entries()).map(
      ([file, event]) => ({ file, event }),
    );
    pending.clear();
    await options.indexFiles(batch);
  }

  return {
    notify(file, event) {
      pending.set(file, event);
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        void flush();
      }, debounceMs);
    },
    flush,
  };
}
