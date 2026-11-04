import {
  HEALING_REASONS,
  type IndexProgressSnapshot,
} from "../indexing/index-progress.js";

export const DEFAULT_MIN_FILES_FOR_NOTICE = 20;

export interface ProgressNotifierOptions {
  notify: (message: string) => void;
  /** Runs smaller than this (single watcher edits) stay silent; failures always notify. */
  minFilesForNotice?: number;
}

const REASON_LABELS: Record<string, string> = {
  upgrade: "new index format",
  repair: "repaired",
  summaries: "adding summaries",
  new: "new",
  changed: "changed",
  removed: "removed",
};

function describeReasons(reasons: IndexProgressSnapshot["reasons"]): string {
  return Object.entries(reasons)
    .filter(([, count]) => (count ?? 0) > 0)
    .map(([reason, count]) => `${count} ${REASON_LABELS[reason] ?? reason}`)
    .join(", ");
}

/** Turns tracker snapshots into at most three popups per run: started, finished, failed. */
export function createProgressNotifier(
  options: ProgressNotifierOptions,
): (snapshot: IndexProgressSnapshot) => void {
  const min = options.minFilesForNotice ?? DEFAULT_MIN_FILES_FOR_NOTICE;
  let startAnnounced = false;
  let failureAnnounced = false;
  let healingRun = false;

  return (s) => {
    if (s.phase === "failed") {
      if (!failureAnnounced) {
        failureAnnounced = true;
        options.notify(`Indexing failed: ${s.lastError ?? "unknown error"}`);
      }
      startAnnounced = false;
      return;
    }
    failureAnnounced = false;

    const healing = HEALING_REASONS.some((r) => (s.reasons[r] ?? 0) > 0);
    if (s.running && s.total > 0 && (s.total >= min || healing) && !startAnnounced) {
      startAnnounced = true;
      healingRun = healing;
      const progressFile = "Progress: .opencode/ai-context/index-status.json";
      options.notify(
        healing
          ? `Updating index: ${s.total} files (${describeReasons(s.reasons)}). ${progressFile}`
          : `Indexing started: ${s.total} files. ${progressFile}`,
      );
    } else if (s.phase === "done" && startAnnounced) {
      startAnnounced = false;
      const skipped = s.failed > 0 ? `, ${s.failed} skipped` : "";
      options.notify(
        `${healingRun ? "Index update finished" : "Indexing finished"}: ${s.total} files${skipped}.`,
      );
    } else if (s.phase === "done" || s.phase === "idle") {
      startAnnounced = false;
    }
  };
}
