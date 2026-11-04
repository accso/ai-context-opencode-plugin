import { tool } from "./tool-def.js";
import type { IndexStatus, RecentChange } from "../storage/vector-store.js";
import type { IndexProgressSnapshot } from "../indexing/index-progress.js";
import type { RescanStats } from "../indexing/rescan-trigger.js";

/**
 * index_status (plan.md, "port-index-status-tools"): ports
 * mcp-server/src/db.ts's getIndexStatus + getRecentChanges into a single
 * native tool -- index-health/observability for the CURRENT project's
 * store, distinct from ai_context_list_projects (which lists every
 * project on the machine, not one project's indexing detail) and
 * ai_context_telemetry_report (tool-call latency/counts, not indexing state).
 */

export interface IndexStatusDeps {
  getIndexStatus: () => IndexStatus;
  getRecentChanges: (limit: number) => RecentChange[];
  /** Live indexing progress (index-progress.ts); omit to leave the `indexing` block out. */
  getProgress?: () => IndexProgressSnapshot;
  /** Where the progress is mirrored on disk, so the agent can point the user at it. */
  statusFilePath?: string;
  /** How changes reach the index: watcher events seen so far and the rescan fallback. */
  getWatcher?: () => { eventsReceived: number; lastEventAt: string | null; rescan: RescanStats };
}

const DEFAULT_RECENT_CHANGES_LIMIT = 10;

export function createIndexStatusTool(deps: IndexStatusDeps) {
  return tool({
    description: [
      "Report whether this project's index is complete and current. Call it",
      "when semantic_search, search_docs or analyze_impact return empty or",
      "partial results, or when an indexingNotice appears, to see if indexing",
      "is still running, how far it is and which files failed or were",
      "skipped -- a missing hit does not prove the code does not exist.",
      "Returns indexed file/chunk counts, the newest indexed_at, the most",
      "recently indexed files (path, indexed_at, chunk count) and an",
      "`indexing` block (phase, done/total, percent, ETA, failures, notices).",
      "A notice is an actionable hint for the user, e.g. a missing API key: relay it.",
      "`watcher` shows how many file-watcher events arrived (always 0 on OpenCode 2.x,",
      "which sends none; 1.x: 0 means its watcher is silent) and the last rescan; if files are missing, call",
      "ai_context_rescan.",
    ].join(" "),
    args: {
      limit: tool.schema
        .number()
        .optional()
        .describe(
          `Max number of recentChanges rows to return (default ${DEFAULT_RECENT_CHANGES_LIMIT}).`,
        ),
    },
    async execute(args) {
      const limit = args.limit ?? DEFAULT_RECENT_CHANGES_LIMIT;
      const status = deps.getIndexStatus();
      const recentChanges = deps.getRecentChanges(limit);
      const progress = deps.getProgress?.();
      const indexing = progress && {
        running: progress.running,
        phase: progress.phase,
        done: progress.done,
        total: progress.total,
        percent: progress.percent,
        etaSeconds: progress.etaSeconds,
        currentFile: progress.currentFile,
        failed: progress.failed,
        failures: progress.failures,
        lastError: progress.lastError,
        notices: progress.notices,
        statusFile: deps.statusFilePath,
      };
      return JSON.stringify({
        ...status,
        recentChanges,
        ...(indexing ? { indexing } : {}),
        ...(deps.getWatcher ? { watcher: deps.getWatcher() } : {}),
      });
    },
  });
}
