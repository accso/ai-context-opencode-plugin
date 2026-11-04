import { tool } from "./tool-def.js";
import { attachIndexingNotice } from "../indexing/index-notice.js";
import type {
  DocTreeSearchMode,
  DocTreeSearchOptions,
  DocTreeSearchResult,
} from "../search/doc-tree-search.js";

/**
 * search_docs (plan.md, "port-doc-tree-markdown"): retrieval
 * over PageIndex-style Markdown doc trees. Kept as a SEPARATE tool from
 * semantic_search (rather than a mode within it) -- its args
 * (toc_only/summary_only/node_text) and result shape (table-of-contents
 * + selected nodes) are meaningfully different from code-chunk search
 * results, and mixing them would make semantic_search's single
 * `execute()` harder to reason about for both the agent and this
 * codebase.
 */

export interface SearchDocsDeps {
  searchDocTrees: (
    query: string,
    mode: DocTreeSearchMode,
    limit: number,
    options?: DocTreeSearchOptions,
  ) => DocTreeSearchResult[];
  /** Doc-tree searches of other allowed projects (cross-repo allowlist), selectable via `project`. */
  crossRepoDocs?: {
    key: string;
    searchDocTrees: SearchDocsDeps["searchDocTrees"];
  }[];
  /** Non-null while indexing is still running; see index-notice.ts. */
  getIndexingNotice?: () => string | null;
}

const DEFAULT_MODE: DocTreeSearchMode = "summary_only";
const DEFAULT_LIMIT = 5;

export function createSearchDocsTool(deps: SearchDocsDeps) {
  return tool({
    description: [
      "Search this project's long-form Markdown documentation (docs, ADRs,",
      "RFCs, wikis) -- the part semantic_search does NOT cover. These files",
      "are indexed as heading trees, so matching is by keyword against",
      "section titles and summaries, not by meaning: use concrete terms",
      '(e.g. "retry", "ADR migration"), not whole questions. For source code',
      "use semantic_search. mode=toc_only returns just the table of contents",
      "of the docs (all docs below dir_path, docs whose path matches the",
      "query first; page with offset); mode=summary_only (default)",
      "ranks sections and returns titles/summaries; mode=node_text also",
      "includes the verbatim section text. Open the file with `read` for",
      "more context. Pass `project` to search another allowed repo.",
    ].join(" "),
    args: {
      query: tool.schema
        .string()
        .describe("Keywords to match against section titles/summaries."),
      mode: tool.schema
        .enum(["toc_only", "summary_only", "node_text"])
        .optional()
        .describe(`Result detail level (default "${DEFAULT_MODE}").`),
      project: tool.schema
        .string()
        .optional()
        .describe("Name of another allowed project (see ai_context_list_projects, field `name`, no hash); default: this project."),
      dir_path: tool.schema
        .string()
        .optional()
        .describe("Only docs below this repo-relative directory, e.g. docs/business/cases."),
      offset: tool.schema
        .number()
        .optional()
        .describe("Skip this many ranked files (paging, default 0)."),
      limit: tool.schema
        .number()
        .optional()
        .describe(`Max number of files to return (default ${DEFAULT_LIMIT}).`),
    },
    async execute(args) {
      const mode = args.mode ?? DEFAULT_MODE;
      const limit = args.limit ?? DEFAULT_LIMIT;
      let search = deps.searchDocTrees;
      if (args.project) {
        const others = deps.crossRepoDocs ?? [];
        const other = others.find((d) => d.key === args.project);
        if (!other) {
          const known = others.map((d) => d.key).join(", ") || "none";
          return JSON.stringify({
            error: `Unknown or not allowed project "${args.project}". Allowed: ${known}.`,
          });
        }
        search = other.searchDocTrees;
      }
      return JSON.stringify(
        attachIndexingNotice(
          search(args.query, mode, limit, {
            dirPath: args.dir_path,
            offset: args.offset,
          }),
          deps.getIndexingNotice?.() ?? null,
        ),
      );
    },
  });
}
