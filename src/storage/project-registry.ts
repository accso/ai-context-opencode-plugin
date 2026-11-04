import fs from "node:fs";
import path from "node:path";
import { projectName, resolveDataDir, type ProjectKeyOptions } from "./project-key.js";

/**
 * Companion to `project-key.ts`'s per-project physical isolation
 * (plan.md, "multi-repo-isolation"): now that every project gets its own
 * directory (`<dataDir>/projects/<key>/`), this module gives the user a
 * way to see what's on disk and remove a project's data once its repo is
 * no longer in use -- otherwise the data dir only ever grows, since
 * nothing else in this plugin ever deletes a project directory.
 */

export interface ProjectInfo {
  /** The project's derived key (see project-key.ts:deriveProjectKey). */
  key: string;
  /** Stable name (key without the per-machine hash); what the agent and the allow-list use. */
  name: string;
  /** Absolute path to the project's vector-store file. */
  dbPath: string;
  /** Total size, in bytes, of everything under the project's directory. */
  sizeBytes: number;
  /** Last-modified time of the project's directory contents. */
  mtimeMs: number;
}

function projectsRoot(options: ProjectKeyOptions): string {
  return path.join(resolveDataDir(options), "projects");
}

function isValidKey(key: string): boolean {
  // Keys only ever come from deriveProjectKey's slug+hash format in
  // practice, but this is also reachable from a native tool with a
  // freeform argument -- reject anything that isn't a single path
  // segment before it's ever joined into a filesystem path.
  return key.length > 0 && !key.includes("/") && !key.includes("\\") && key !== "." && key !== "..";
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    try {
      total += entry.isDirectory() ? dirSizeBytes(entryPath) : fs.statSync(entryPath).size;
    } catch {
      // vanished meanwhile (index.lock, WAL files): not part of the size
    }
  }
  return total;
}

/** Lists every project currently stored under the data dir. */
export function listProjects(options: ProjectKeyOptions = {}): ProjectInfo[] {
  const root = projectsRoot(options);
  if (!fs.existsSync(root)) return [];

  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(root, entry.name);
      return {
        key: entry.name,
        name: projectName(entry.name),
        dbPath: path.join(dir, "index.sqlite"),
        sizeBytes: dirSizeBytes(dir),
        mtimeMs: fs.statSync(dir).mtimeMs,
      };
    });
}

/**
 * Deletes a project's entire directory (its vector store and any other
 * per-project data). Returns `true` if a project with that key existed
 * and was removed, `false` if there was nothing to delete -- deliberately
 * not an error, so "delete a project that's already gone" is a no-op.
 */
export function deleteProject(key: string, options: ProjectKeyOptions = {}): boolean {
  if (!isValidKey(key)) {
    throw new Error(`Invalid project key: ${JSON.stringify(key)}`);
  }
  const dir = path.join(projectsRoot(options), key);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
