import fs from "node:fs";
import path from "node:path";

/** Volatile runtime files of the plugin; the backup under ai-context/backup stays committable. */
export const PLUGIN_GITIGNORE_ENTRIES = [
  "ai-context/index-status.json",
  "ai-context/index-status.json.*.tmp",
  "ai-context/index-tree.md",
  "ai-context/*.log.md", // error.log.md, tool.log.md and its rotated tool.<time>.log.md
];

/**
 * Makes sure `.opencode/.gitignore` ignores the status file. Creates the file
 * or appends missing entries; existing lines are kept. Never throws.
 * Returns true if the file was changed.
 */
export function ensurePluginGitignore(
  worktree: string,
  onError?: (error: unknown) => void,
): boolean {
  try {
    if (!fs.existsSync(worktree)) return false;
    const filePath = path.join(worktree, ".opencode", ".gitignore");
    const existing = fs.existsSync(filePath)
      ? fs.readFileSync(filePath, "utf8")
      : "";
    const present = new Set(existing.split("\n").map((l) => l.trim()));
    const missing = PLUGIN_GITIGNORE_ENTRIES.filter((e) => !present.has(e));
    if (missing.length === 0) return false;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const prefix =
      existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
    fs.writeFileSync(filePath, `${prefix}${missing.join("\n")}\n`);
    return true;
  } catch (error) {
    onError?.(error);
    return false;
  }
}
