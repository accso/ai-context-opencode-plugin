import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Per-repo isolation (user-directed, 2026-09-14): "the vector db [should]
 * give only that parts back which belongs to the right repo" when
 * multiple repos' data exist on the same machine.
 *
 * Mirrors `watcher/db.py`'s existing pattern of ONE QDRANT COLLECTION PER
 * PROJECT (physical separation via `collection_name=project_key`), not
 * just a row/payload filter -- this plugin gives each project its OWN
 * SQLite file (`vector-store.ts` instance) instead, so a query literally
 * cannot return another project's rows: there is no shared table to
 * filter in the first place.
 *
 * Key difference from today's `.ai-context`: `config_loader.py`'s
 * `project_key()` is an explicit, manually-configured `name` from
 * `config.yaml` (a deliberate multi-project setup step). This plugin
 * has no equivalent per-project naming step -- OpenCode gives it
 * `directory`/`worktree` automatically per session -- so the key
 * itself must always be auto-derived from the worktree path, never
 * hand-assigned. The base data directory ITS `key` subdirectory lives
 * under, however, is now also settable via a repo's
 * `.opencode/ai-context.config.yaml` (`data_dir`, config-file.ts,
 * user-directed 2026-09-16), in addition to `AI_CONTEXT_PLUGIN_DATA_DIR`
 * -- see `resolveDataDir`'s precedence.
 */

export interface ProjectKeyOptions {
  /** Base data directory override (also read from AI_CONTEXT_PLUGIN_DATA_DIR). */
  dataDir?: string;
  /** Config-file fallback (.opencode/ai-context.config.yaml's data_dir), used only when neither dataDir nor the env var is set. */
  fileDataDir?: string;
}

export interface ProjectKeyResult {
  /** Human-readable, collision-resistant identifier: "<slugified-basename>-<hash8>". */
  key: string;
  /** Absolute path to this project's OWN SQLite vector-store file. */
  dbPath: string;
}

/** Stable, per-user-independent part of a project key: the key without its `-<hash8>` suffix. */
export function projectName(key: string): string {
  return key.replace(/-[0-9a-f]{8}$/, "");
}

function slugify(basename: string): string {
  return (
    basename
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "repo"
  );
}

function defaultDataDir(): string {
  // XDG_DATA_HOME convention on Linux; a plain dotdir fallback elsewhere
  // (macOS/Windows) -- deliberately simple rather than fully
  // platform-idiomatic (no Application Support/AppData special-casing),
  // consistent with this plugin's "no bundled infra" philosophy.
  if (process.env.XDG_DATA_HOME) return process.env.XDG_DATA_HOME;
  const base = path.join(homedir(), ".local", "share");
  const dir = path.join(base, "ai-context-opencode-plugin");
  // Indexes created before the rename live in the old directory: keep using it
  // until the user moves it, so existing indexes are not orphaned.
  const legacy = path.join(base, "opencode-ai-context-plugin");
  return !existsSync(dir) && existsSync(legacy) ? legacy : dir;
}

/** Resolves the base data directory (shared by project-key derivation and the project registry). */
export function resolveDataDir(options: ProjectKeyOptions = {}): string {
  return (
    options.dataDir ??
    process.env.AI_CONTEXT_PLUGIN_DATA_DIR ??
    options.fileDataDir ??
    defaultDataDir()
  );
}

export function deriveProjectKey(
  worktree: string,
  options: ProjectKeyOptions = {},
): ProjectKeyResult {
  const dataDir = resolveDataDir(options);

  const normalized = path.resolve(worktree);
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  const slug = slugify(path.basename(normalized));
  const key = `${slug}-${hash}`;

  return {
    key,
    // Deliberately OUTSIDE the worktree: if the db file lived inside the
    // watched project tree, the plugin's own writes to it would trigger
    // file.watcher.updated and re-index its own database file.
    dbPath: path.join(dataDir, "projects", key, "index.sqlite"),
  };
}
