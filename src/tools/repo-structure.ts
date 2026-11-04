import { tool } from "./tool-def.js";
import { attachIndexingNotice } from "../indexing/index-notice.js";
import {
  buildRepoStructure,
  DEFAULT_DEPTH,
  DEFAULT_MAX_ENTRIES,
} from "../search/repo-structure.js";
import type { IndexedFile } from "../storage/vector-store.js";

export interface RepoStructureDeps {
  listFiles(): IndexedFile[];
  /** Paths of tree-indexed Markdown docs (they have no chunks, so `listFiles` never lists them). */
  listDocPaths?(): string[];
  /** Doc paths of other allowed projects, same keys as `crossRepoStores`. */
  crossRepoDocPaths?: { key: string; listPaths(): string[] }[];
  /** Other allowed projects (cross-repo allowlist); selectable via the `project` argument. */
  crossRepoStores?: { key: string; store: { listFiles(): IndexedFile[] } }[];
  maxEntries?: number;
  getIndexingNotice?: () => string | null;
}

/** Adds tree-indexed docs (language `markdown`, no chunks) that `files` does not already list. */
export function withDocFiles(files: IndexedFile[], docPaths: string[]): IndexedFile[] {
  if (docPaths.length === 0) return files;
  const known = new Set(files.map((f) => f.relativePath));
  const extra = docPaths
    .filter((p) => !known.has(p))
    .map((relativePath) => ({ relativePath, language: "markdown", chunkCount: 0 }));
  return [...files, ...extra];
}

export function createRepoStructureTool(deps: RepoStructureDeps) {
  return tool({
    description: [
      "Show the directory structure of this project from the index:",
      "directories first (with indexed file count and languages), then files.",
      "Call it FIRST in an unfamiliar project or area to learn where things",
      "live, then drill down with dir_path, instead of listing directories",
      "one by one with glob/ls. Structure only -- use semantic_search to",
      "find code by meaning. Markdown docs are listed too (language",
      "markdown); search them with search_docs.",
    ].join(" "),
    args: {
      dir_path: tool.schema
        .string()
        .optional()
        .describe("Repo-relative directory to show (default: project root)."),
      depth: tool.schema
        .number()
        .optional()
        .describe(
          `Levels to expand below dir_path (default ${DEFAULT_DEPTH}).`,
        ),
      project: tool.schema
        .string()
        .optional()
        .describe(
          "Name of another allowed project (see ai_context_list_projects, field `name`, no hash); default: this project.",
        ),
    },
    async execute(args) {
      let files: IndexedFile[];
      let docPaths: string[] = [];
      if (args.project) {
        const other = (deps.crossRepoStores ?? []).find(
          (s) => s.key === args.project,
        );
        if (!other) {
          const known =
            (deps.crossRepoStores ?? []).map((s) => s.key).join(", ") || "none";
          return JSON.stringify({
            error: `Unknown or not allowed project "${args.project}". Allowed: ${known}.`,
          });
        }
        files = other.store.listFiles();
        docPaths =
          (deps.crossRepoDocPaths ?? []).find((d) => d.key === args.project)?.listPaths() ?? [];
      } else {
        files = deps.listFiles();
        docPaths = deps.listDocPaths?.() ?? [];
      }
      files = withDocFiles(files, docPaths);
      const result = buildRepoStructure(files, {
        dirPath: args.dir_path,
        depth: args.depth,
        maxEntries: deps.maxEntries ?? DEFAULT_MAX_ENTRIES,
      });
      return JSON.stringify(
        attachIndexingNotice(result, deps.getIndexingNotice?.() ?? null),
      );
    },
  });
}
