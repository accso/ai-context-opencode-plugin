import type { IndexProgressSnapshot } from "./index-progress.js";

/**
 * While the index is still being built, search results can be silently
 * incomplete. The tools attach this notice so the agent tells the user
 * instead of treating a missing hit as "does not exist" (ADR-0018).
 */

function formatEta(seconds: number): string {
  if (seconds < 90) return `~${Math.max(seconds, 1)} s`;
  return `~${Math.round(seconds / 60)} min`;
}

export function buildIndexingNotice(
  snapshot: IndexProgressSnapshot,
): string | null {
  if (!snapshot.running) return null;
  let status: string;
  if (snapshot.phase === "scanning") {
    status = "scanning the repository for files";
  } else if (snapshot.phase === "loading-model") {
    status = "loading/downloading the embedding model";
  } else {
    status = `${snapshot.done}/${snapshot.total} files, ${snapshot.percent}%`;
    if (snapshot.etaSeconds !== null)
      status += `, ${formatEta(snapshot.etaSeconds)} left`;
  }
  return `Index is still being built (${status}); results may be incomplete -- a missing hit does not prove the code does not exist.`;
}

/** Arrays are wrapped (their shape cannot carry a field); objects get an extra field. */
export function attachIndexingNotice(
  value: unknown,
  notice: string | null,
): unknown {
  if (notice === null) return value;
  if (Array.isArray(value)) return { indexingNotice: notice, results: value };
  return { ...(value as Record<string, unknown>), indexingNotice: notice };
}
