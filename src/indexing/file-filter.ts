import fs from "node:fs";
import path from "node:path";
import ignore from "ignore";

/**
 * File filtering for the indexing pipeline (critical-review finding
 * "repo-walker-ignore-filtering", plan.md): repo-walker.ts previously
 * had ONLY a hardcoded directory denylist, unlike the original
 * `.ai-context` stack, which combines two mechanisms neither of which
 * had been ported:
 *
 *   1. `watcher/indexer.py`'s `load_gitignore` -- a merged `pathspec`
 *      built from the worktree's own `.gitignore` (+ configured extra
 *      gitignore files, not ported here since this plugin has no
 *      multi-file config step yet).
 *   2. `config.yaml`'s `include_extensions` -- an explicit SAFELIST of
 *      extensions, which doubles as binary detection ("no separate
 *      binary-detection step needed" per its own comment) rather than
 *      trying to sniff file contents.
 *
 * Without both, every file not caught by repo-walker.ts's small
 * directory denylist -- images, archives, lockfiles, `.env`, vendored
 * binaries, anything a project-specific `.gitignore` excludes -- gets
 * read as UTF-8, chunked, and embedded.
 */

// Mirrors config.yaml's include_extensions safelist (flattened; the
// original's grouping is comment-only). ".md" is included here too --
// eligibility for TREE-indexing vs. chunking is `doc-tree-builder.ts`'s
// `shouldUseTreeIndex` concern, layered on top of this safelist, not a
// replacement for it.
const INDEXABLE_EXTENSIONS = new Set([
  ".kt",
  ".kts",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".vue",
  ".cs",
  ".java",
  ".cpp",
  ".cc",
  ".cxx",
  ".c",
  ".h",
  ".hpp",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".swift",
  ".py",
  ".sh",
  ".html",
  ".css",
  ".scss",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".sql",
  ".md",
]);

// Extensionless filenames explicitly safelisted (config.yaml lists
// "Dockerfile" as a bare entry in include_extensions).
const INDEXABLE_FILENAMES = new Set(["Dockerfile"]);

/** Safelist check -- mirrors config.yaml's include_extensions (also this plugin's binary-detection mechanism). */
export function isIndexableExtension(relativePath: string): boolean {
  const base = path.basename(relativePath);
  if (INDEXABLE_FILENAMES.has(base)) return true;
  const ext = path.extname(relativePath).toLowerCase();
  return ext !== "" && INDEXABLE_EXTENSIONS.has(ext);
}

const PLUGIN_METADATA_PREFIXES = [
  ".opencode/ai-context/",
  ".opencode/skills/index-status/",
];

/**
 * This plugin's own bookkeeping (backup export, allow-list, index-status.json).
 * Never indexable: index-status.json is rewritten while indexing, so indexing
 * it would feed back into `file.watcher.updated`.
 */
export function isPluginMetadata(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return PLUGIN_METADATA_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix),
  );
}

export interface IgnoreMatcher {
  isIgnored(relativePath: string): boolean;
}

/**
 * Builds a gitignore-pattern matcher from raw `.gitignore` file content
 * (or `null`, meaning nothing is ignored). Content is injected rather
 * than read here so this stays unit-testable without real fs I/O --
 * see `loadGitignoreSync` for the real loader.
 */
export function createIgnoreMatcher(
  gitignoreContent: string | null,
): IgnoreMatcher {
  if (gitignoreContent === null) {
    return { isIgnored: () => false };
  }
  const ig = ignore().add(gitignoreContent);
  return {
    isIgnored: (relativePath: string) => ig.ignores(relativePath),
  };
}

/** Reads `<worktree>/.gitignore`, or returns `null` if it doesn't exist. */
export function loadGitignoreSync(worktree: string): string | null {
  const filePath = path.join(worktree, ".gitignore");
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

/**
 * Combines both checks into the single predicate the indexing pipeline
 * actually needs: `true` means "index this file", mirroring the
 * original's "include_extensions AND NOT gitignored" combination.
 */
export function createFileFilter(
  worktree: string,
  options: { exclude?: string[] } = {},
): (relativePath: string) => boolean {
  const matcher = createIgnoreMatcher(loadGitignoreSync(worktree));
  const excluded = createExcludeMatcher(options.exclude);
  return (relativePath: string) =>
    !isPluginMetadata(relativePath) &&
    isIndexableExtension(relativePath) &&
    !matcher.isIgnored(relativePath) &&
    !excluded.isIgnored(relativePath);
}

/** Matcher for the config file's `exclude` list (gitignore syntax); empty list ignores nothing. */
export function createExcludeMatcher(
  patterns: string[] | undefined,
): IgnoreMatcher {
  if (!patterns || patterns.length === 0) return { isIgnored: () => false };
  return createIgnoreMatcher(patterns.join("\n"));
}
