import fs from "node:fs/promises";
import path from "node:path";
import { createExcludeMatcher, createFileFilter } from "./file-filter.js";

/**
 * Recursively enumerates indexable files under `worktree` for the
 * startup delta-reconciliation pass (see plugin.ts's
 * `defaultReconcileOnStartup` and indexing.ts). Skips common vendor/VCS/
 * build directories and this plugin's own `.opencode/ai-context/`
 * metadata (backup export, allow-list config) so a full re-scan never
 * tries to index its own bookkeeping files or third-party dependency
 * trees.
 *
 * Also applies `file-filter.ts`'s extension safelist + `.gitignore`
 * matching (critical-review finding "repo-walker-ignore-filtering",
 * plan.md) -- without these, every file not caught by the directory
 * denylist below (images, archives, `.env`, project-specific
 * `.gitignore` entries) used to get read as UTF-8, chunked, and
 * embedded.
 */

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  "target",
]);

export async function walkRepoFiles(
  worktree: string,
  options: { exclude?: string[] } = {},
): Promise<string[]> {
  const results: string[] = [];
  const shouldIndexFile = createFileFilter(worktree, options);
  const excluded = createExcludeMatcher(options.exclude);

  async function walk(dirAbsolute: string, dirRelative: string): Promise<void> {
    const entries = await fs.readdir(dirAbsolute, { withFileTypes: true });
    for (const entry of entries) {
      const relative = dirRelative
        ? `${dirRelative}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        if (dirRelative === "" && entry.name === ".opencode") continue; // this plugin's own metadata dir
        if (excluded.isIgnored(`${relative}/`)) continue; // user-excluded directory: never descend
        await walk(path.join(dirAbsolute, entry.name), relative);
      } else if (entry.isFile()) {
        if (shouldIndexFile(relative)) results.push(relative);
      }
    }
  }

  await walk(worktree, "");
  return results;
}
