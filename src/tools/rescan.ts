import { tool } from "./tool-def.js";
import type { RescanTrigger } from "../indexing/rescan-trigger.js";

export interface RescanDeps {
  trigger: Pick<RescanTrigger, "runNow" | "stats">;
}

/** Manual rescan: picks up files changed outside opencode's file watcher (e.g. via `bash`, `git pull`). */
export function createRescanTool(deps: RescanDeps) {
  return tool({
    description: [
      "Re-scan this repository now and index every new, changed or deleted",
      "file (unchanged files are skipped, so it is cheap). Use it when",
      "index_status or a search shows files missing or stale, e.g. after",
      "changes made through shell commands or git operations. Waits until",
      "the scan finished and returns what the scan saw.",
    ].join(" "),
    args: {},
    async execute() {
      await deps.trigger.runNow("manual");
      return JSON.stringify({ rescanned: true, ...deps.trigger.stats() });
    },
  });
}
