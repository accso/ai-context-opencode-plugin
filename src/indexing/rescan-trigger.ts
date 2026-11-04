/**
 * Fallback for a silent file watcher. opencode only emits `file.watcher.updated` (1.x) /
 * `filesystem.changed` (2.x) when its file watcher runs, so edits made through `bash`/`shell`
 * (heredocs, `sed -i`, `cp`, formatters) could otherwise stay unindexed until the
 * next restart. After a tool call that may have changed files, a debounced
 * rescan walks the worktree again; unchanged files are skipped by fingerprint.
 */

/** Tools whose calls can change files on disk (`bash` is OpenCode 1.x, `shell` is 2.x). */
export const FILE_CHANGING_TOOLS = new Set([
  "bash",
  "shell",
  "write",
  "edit",
  "multiedit",
  "patch",
  "apply_patch",
]);

export function mayChangeFiles(tool: string): boolean {
  return FILE_CHANGING_TOOLS.has(tool) || /^idea_(apply_patch|create_new_file|rename_refactoring|reformat_file|execute_terminal_command)$/.test(tool);
}

export interface EditedFile {
  /** Path as the tool reported it (absolute or worktree-relative). */
  file: string;
  /** "unlink" when the tool deleted the file, otherwise "change" (add/update). */
  event: "change" | "unlink";
}

const PATH_ARG_TOOLS = new Set(["edit", "write", "multiedit"]);
const PATCH_TOOLS = new Set(["patch", "apply_patch"]);

/**
 * The files a file-editing tool call touched, when its arguments say so
 * (`edit`/`write`/`multiedit`: a path argument; `patch`/`apply_patch`: the
 * `*** Add/Update/Delete File:` and `*** Move to:` lines). `null` when the files are
 * unknown (`bash`/`shell`, IDE tools): the caller then falls back to a full rescan.
 */
export function editedFiles(tool: string, args: unknown): EditedFile[] | null {
  const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  if (PATH_ARG_TOOLS.has(tool)) {
    const file = [input.filePath, input.path, input.file_path].find((v) => typeof v === "string" && v.length > 0);
    return typeof file === "string" ? [{ file, event: "change" }] : null;
  }
  if (PATCH_TOOLS.has(tool)) {
    const text = [input.patchText, input.patch, input.input].find((v) => typeof v === "string");
    if (typeof text !== "string") return null;
    const files: EditedFile[] = [];
    for (const line of text.split("\n")) {
      const m = /^\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*$/.exec(line) ?? /^\*\*\* Move to:\s*()(.+?)\s*$/.exec(line);
      if (m) files.push({ file: m[2]!, event: m[1] === "Delete" ? "unlink" : "change" });
    }
    return files.length > 0 ? files : null;
  }
  return null;
}

export interface RescanStats {
  runs: number;
  lastRunAt: string | null;
  lastTrigger: string | null;
  lastFilesOnDisk: number | null;
}

export interface RescanTriggerOptions {
  debounceMs?: number;
  /** Does one rescan; resolves with the number of files found on disk. */
  run: () => Promise<number | undefined>;
  onError?: (error: unknown) => void;
}

export interface RescanTrigger {
  /** Request a rescan after `debounceMs` of quiet; bursts coalesce into one run. */
  notify(trigger: string): void;
  /** Run now (waits for a running rescan, then runs once more if more was requested). */
  runNow(trigger: string): Promise<void>;
  stats(): RescanStats;
}

export function createRescanTrigger(options: RescanTriggerOptions): RescanTrigger {
  const debounceMs = options.debounceMs ?? 3000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let again: string | undefined;
  const state: RescanStats = { runs: 0, lastRunAt: null, lastTrigger: null, lastFilesOnDisk: null };

  async function execute(trigger: string): Promise<void> {
    if (running) {
      again = trigger; // a running scan may have missed the change: run once more afterwards
      return running;
    }
    running = (async () => {
      let next: string | undefined = trigger;
      while (next !== undefined) {
        const current: string = next;
        again = undefined;
        try {
          const files = await options.run();
          state.runs++;
          state.lastRunAt = new Date().toISOString();
          state.lastTrigger = current;
          if (typeof files === "number") state.lastFilesOnDisk = files;
        } catch (error) {
          options.onError?.(error);
        }
        next = again;
      }
    })().finally(() => {
      running = undefined;
    });
    return running;
  }

  return {
    notify(trigger) {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void execute(trigger);
      }, debounceMs);
      timer.unref?.();
    },
    async runNow(trigger) {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      await execute(trigger);
    },
    stats: () => ({ ...state }),
  };
}
