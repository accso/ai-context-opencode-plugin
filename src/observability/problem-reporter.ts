/**
 * One place for everything that goes wrong but must not stop the plugin.
 * console.error is invisible under ACP, so each problem also becomes a native
 * OS popup (docs/observability.md). The same problem is popped up once per
 * window; opencode bootstraps plugins twice, so the dedup state is shared
 * process-wide by default.
 */
export interface ProblemReporter {
  report(context: string, error?: unknown): void;
}

export interface ProblemReporterOptions {
  notify: (message: string) => void;
  log?: (message: string) => void;
  now?: () => number;
  windowMs?: number;
  seen?: Map<string, number>;
  /** Called for every report, before deduplication (persistent error log). */
  record?: (context: string, error?: unknown) => void;
}

const MAX_MESSAGE_CHARS = 200;
const sharedSeen = new Map<string, number>();

export function createProblemReporter(
  options: ProblemReporterOptions,
): ProblemReporter {
  const log =
    options.log ??
    ((message: string) =>
      console.error(`[ai-context-opencode-plugin] ${message}`));
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? 60_000;
  const seen = options.seen ?? sharedSeen;

  return {
    report(context, error) {
      const reason =
        error === undefined
          ? ""
          : error instanceof Error
            ? error.message
            : String(error);
      try {
        options.record?.(context, error);
      } catch {
        // reporting must never throw
      }
      const full = reason ? `${context}: ${reason}` : context;
      try {
        log(full);
      } catch {
        // reporting must never throw
      }
      const t = now();
      const last = seen.get(full);
      if (last !== undefined && t - last < windowMs) return;
      seen.set(full, t);
      const message =
        full.length > MAX_MESSAGE_CHARS
          ? `${full.slice(0, MAX_MESSAGE_CHARS - 1)}…`
          : full;
      try {
        options.notify(message);
      } catch {
        // reporting must never throw
      }
    },
  };
}
