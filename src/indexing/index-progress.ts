/**
 * In-memory progress tracker for the indexing pipeline. It is the single
 * source of truth for "how far is indexing" and is read by the status
 * file (status-file.ts), `index_status` and the notice that
 * the search tools attach while an index is still being built.
 *
 * Why not a TUI toast / chat message: neither reaches JetBrains AI
 * Assistant over ACP (docs/observability.md), so progress is surfaced
 * through tool responses and a plain file instead (ADR-0018).
 */

export type IndexPhase =
  "idle" | "scanning" | "loading-model" | "indexing" | "done" | "failed";

/** Why a file is (re)indexed; the last three are self-healing (ADR-0027). */
export type IndexReason =
  | "new"
  | "changed"
  | "removed"
  | "upgrade"
  | "repair"
  | "summaries";

export const HEALING_REASONS: readonly IndexReason[] = ["upgrade", "repair", "summaries"];

export interface IndexFailure {
  file: string;
  error: string;
  /** How many times indexing this file has failed (a watcher-triggered retry increments it). */
  attempts: number;
  lastFailedAt: number;
}

export interface IndexProgressSnapshot {
  running: boolean;
  phase: IndexPhase;
  /** Files processed in the current run, successful or failed. */
  done: number;
  total: number;
  percent: number;
  /** Files whose last indexing attempt failed and that have not been re-indexed successfully since. */
  failed: number;
  failures: IndexFailure[];
  currentFile: string | null;
  filesPerSec: number | null;
  etaSeconds: number | null;
  startedAt: number | null;
  updatedAt: number;
  finishedAt: number | null;
  lastError: string | null;
  /** Files of the current run by reason. */
  reasons: Partial<Record<IndexReason, number>>;
  /** Actionable hints for the user of the current run (e.g. a missing API key); cleared when a new run starts. */
  notices: string[];
}

export interface ProgressTrackerOptions {
  now?: () => number;
  onChange?: (snapshot: IndexProgressSnapshot) => void;
  maxFailures?: number;
  /** Called for every failed file, including repeats (persistent error log). */
  onFileFailed?: (file: string, message: string) => void;
}

export interface ProgressTracker {
  snapshot(): IndexProgressSnapshot;
  setPhase(phase: "scanning"): void;
  /** Called before a batch of files is indexed. While a run is active the batch extends it. */
  beginBatch(fileCount: number, reasons?: Partial<Record<IndexReason, number>>): void;
  fileDone(file: string): void;
  fileFailed(file: string, error: unknown): void;
  /** Finishes the run once every announced file has been processed. */
  endBatch(): void;
  fail(error: unknown): void;
  /** Stops the current run with an error (alias of fail, named for the indexer's contract). */
  abort(error: unknown): void;
  /** Adds an actionable hint to the snapshot (status file, index_status); duplicates are ignored. */
  addNotice(message: string): void;
  /** Reflects lazy embedding-model download/load; ignored while no run is active. */
  setModelLoading(loading: boolean): void;
}

const DEFAULT_MAX_FAILURES = 200;

export function createProgressTracker(
  options: ProgressTrackerOptions = {},
): ProgressTracker {
  const now = options.now ?? Date.now;
  const maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;

  let phase: IndexPhase = "idle";
  let done = 0;
  let total = 0;
  let currentFile: string | null = null;
  let startedAt: number | null = null;
  let finishedAt: number | null = null;
  let updatedAt = now();
  let lastError: string | null = null;
  let rateStartAt: number | null = null;
  let rateStartDone = 0;
  const failures = new Map<string, IndexFailure>();
  let reasons: Partial<Record<IndexReason, number>> = {};
  let notices: string[] = [];

  const isRunning = () =>
    phase === "scanning" || phase === "loading-model" || phase === "indexing";

  function snapshot(): IndexProgressSnapshot {
    const elapsedSec = rateStartAt === null ? 0 : (now() - rateStartAt) / 1000;
    const processedSinceRateStart = done - rateStartDone;
    const filesPerSec =
      elapsedSec > 0 && processedSinceRateStart > 0
        ? processedSinceRateStart / elapsedSec
        : null;
    const percent =
      phase === "done" ? 100 : total > 0 ? Math.floor((done / total) * 100) : 0;
    return {
      running: isRunning(),
      phase,
      done,
      total,
      percent,
      failed: failures.size,
      failures: [...failures.values()].map((f) => ({ ...f })),
      currentFile,
      filesPerSec,
      etaSeconds:
        filesPerSec !== null && isRunning()
          ? Math.round((total - done) / filesPerSec)
          : null,
      startedAt,
      updatedAt,
      finishedAt,
      lastError,
      reasons: { ...reasons },
      notices: [...notices],
    };
  }

  function emit(): void {
    updatedAt = now();
    options.onChange?.(snapshot());
  }

  function startRun(): void {
    done = 0;
    total = 0;
    currentFile = null;
    startedAt = now();
    finishedAt = null;
    lastError = null;
    reasons = {};
    notices = [];
    rateStartAt = null;
    rateStartDone = 0;
  }

  function markProcessed(file: string): void {
    done += 1;
    if (rateStartAt === null) {
      rateStartAt = now();
      rateStartDone = done; // the first completed file anchors the rate window, so model load time never skews the ETA
    }
    currentFile = file;
  }

  return {
    snapshot,
    setPhase() {
      if (!isRunning()) startRun();
      phase = "scanning";
      emit();
    },
    beginBatch(fileCount, batchReasons = {}) {
      if (!isRunning()) startRun();
      total += fileCount;
      for (const [reason, count] of Object.entries(batchReasons)) {
        const key = reason as IndexReason;
        reasons[key] = (reasons[key] ?? 0) + (count ?? 0);
      }
      if (phase !== "loading-model") phase = "indexing";
      emit();
    },
    fileDone(file) {
      markProcessed(file);
      failures.delete(file);
      emit();
    },
    fileFailed(file, error) {
      markProcessed(file);
      const message = error instanceof Error ? error.message : String(error);
      options.onFileFailed?.(file, message);
      const previous = failures.get(file);
      failures.delete(file); // re-insert so Map order == recency, which the cap relies on
      failures.set(file, {
        file,
        error: message,
        attempts: (previous?.attempts ?? 0) + 1,
        lastFailedAt: now(),
      });
      while (failures.size > maxFailures)
        failures.delete(failures.keys().next().value as string);
      emit();
    },
    endBatch() {
      if (!isRunning() || done < total) return;
      phase = "done";
      currentFile = null;
      finishedAt = now();
      emit();
    },
    abort(error) {
      this.fail(error);
    },
    fail(error) {
      phase = "failed";
      lastError = error instanceof Error ? error.message : String(error);
      finishedAt = now();
      emit();
    },
    addNotice(message) {
      if (notices.includes(message)) return;
      notices.push(message);
      emit();
    },
    setModelLoading(loading) {
      if (loading) {
        if (!isRunning()) return;
        phase = "loading-model";
      } else if (phase === "loading-model") {
        phase = "indexing";
      } else {
        return;
      }
      emit();
    },
  };
}
