import { tool } from "./tool-def.js";
import { attachIndexingNotice } from "../indexing/index-notice.js";
import { findTestFiles } from "./test-files.js";
import type { GraphStore } from "../storage/graph-store.js";

/**
 * `find_symbol`: cheap name lookup (class/function/method definitions) from
 * the symbol index. Answers "where is X defined" without a language
 * server being up.
 */

export interface FindSymbolDeps {
  graphStore: GraphStore;
  /** Symbol indexes of other allowed projects (cross-repo allowlist), selectable via `project`. */
  crossRepoGraphs?: { key: string; store: GraphStore }[];
  getIndexingNotice?: () => string | null;
  /** OpenCode 1.x only: the host has a native `lsp` tool the description may point to (2.x: false). */
  lsp?: boolean;
}

export function createFindSymbolTool(deps: FindSymbolDeps) {
  return tool({
    description: [
      "Find where a class, function or method is defined by (part of) its name,",
      "from the symbol index: file, line range, kind and enclosing container.",
      "Case-insensitive substring match, exact and prefix matches first.",
      "`tests` lists test files that import or call the matches.",
      "Fast and needs no language server; use `read` on the returned file and lines.",
      "Pass `project` to search another allowed repo. For callers/dependents/usages use `analyze_impact`;",
      deps.lsp ? "for exact references use the native `lsp` tool;" : "",
      "for conceptual questions without a known name use `semantic_search`.",
    ]
      .filter(Boolean)
      .join(" "),
    args: {
      query: tool.schema.string().describe("Symbol name or part of it, e.g. `UserService` or `parseConf`."),
      kind: tool.schema
        .string()
        .optional()
        .describe("Only this kind, e.g. `class`, `function`, `method`."),
      project: tool.schema
        .string()
        .optional()
        .describe("Name of another allowed project (see ai_context_list_projects, field `name`, no hash); default: this project."),
      limit: tool.schema.number().int().positive().max(100).default(20).describe("Maximum matches."),
    },
    async execute(args) {
      const limit = args.limit ?? 20;
      let graph = deps.graphStore;
      if (args.project) {
        const others = deps.crossRepoGraphs ?? [];
        const other = others.find((g) => g.key === args.project);
        if (!other) {
          const known = others.map((g) => g.key).join(", ") || "none";
          return JSON.stringify({
            error: `Unknown or not allowed project "${args.project}". Allowed: ${known}.`,
          });
        }
        graph = other.store;
      }
      const pool = graph.searchSymbols(args.query, args.kind ? limit * 5 : limit);
      const matches = pool
        .filter((s) => !args.kind || s.kind === args.kind)
        .slice(0, limit)
        .map((s) => ({
          name: s.name,
          kind: s.kind,
          path: s.relativePath,
          startLine: s.startLine,
          endLine: s.endLine,
          container: s.container,
        }));
      const result: Record<string, unknown> = { matches };
      if (args.project) result.project = args.project;
      if (matches.length > 0) {
        result.tests = findTestFiles(
          graph,
          matches.map((m) => m.path),
          matches.map((m) => m.name),
        );
      }
      if (matches.length === 0) {
        result.hint =
          "No symbol matched. Try a shorter name, or use semantic_search for a conceptual query; the index may still be building (see index_status).";
      }
      return JSON.stringify(attachIndexingNotice(result, deps.getIndexingNotice?.() ?? null));
    },
  });
}
