import { tool } from "./tool-def.js";
import type { VectorStore } from "../storage/vector-store.js";
import { hybridSearch } from "../search/hybrid.js";
import { buildEmbedInput } from "../indexing/embed-input.js";
import { attachIndexingNotice } from "../indexing/index-notice.js";

/**
 * Native OpenCode custom tool for hybrid semantic + keyword code search.
 *
 * This is the plugin's actual differentiator over OpenCode's built-in
 * `grep`/`glob` tools: those are lexical-only, so they miss conceptually
 * related code that doesn't share literal keywords or identifiers. This
 * tool's `description` is deliberately verbose -- it replaces the
 * separate SKILL.md that the old MCP-based design needed, since OpenCode
 * surfaces this text to the agent directly at tool-listing time (see
 * plan.md's "Repository layout & packaging decision").
 *
 * `createSemanticSearchTool` wires the tool to a real `VectorStore` and
 * a query-side `embedQuery` step (`nomic-embed-text-v1.5` via the
 * onnxruntime-node embedder, see `embedder.ts` and plan.md's corrected
 * embedding-backend decision) -- injected so this module stays free of
 * real ONNX/native-binding I/O in unit tests, matching this repo's
 * existing injected-deps pattern (`project-registry.ts`,
 * `index-scheduler.ts`).
 *
 * NOTE: this covers the query/search half only. Populating the vector
 * store itself (chunking + document-side embedding, wired into
 * `defaultIndexFiles`/`defaultReconcileOnStartup` in `plugin.ts`) is a
 * separate remaining step of the `port-semantic-search-tool` todo --
 * see plan.md for the open decision on reusing/porting the existing
 * Python chunker/symbol-extractor/import-extractor.
 */

const DESCRIPTION = [
  "Search this repository's SOURCE CODE by meaning. Use this FIRST for",
  'any code question where the exact wording is unknown -- e.g. "where do we retry failed',
  'HTTP requests?", "what validates the incoming webhook signature?",',
  '"how does login work?" -- before grepping or reading files one by one.',
  "Returns ranked chunks (path, line range, symbol, score; `project` when",
  "the hit comes from another allowed project). Open the best hit with",
  "`read` using its line range. One call replaces many grep/glob attempts;",
  "use grep/glob only for an exact identifier or literal string.",
  "Does NOT cover long Markdown documentation (ADRs, RFCs, wikis): use",
  "search_docs for those. If results are empty or partial, indexing may",
  "still be running -- see the indexingNotice or call index_status.",
  "Scores: with reranking, higher is better and negative scores mean the",
  "hit is probably not about the query; use min_score (e.g. 0) to drop",
  "weak hits and paths (folder prefixes or globs) to restrict the search.",
].join(" ");

/** `src/foo`, `src/foo/`, `docs/**\/*.yaml` or `*.ts` -> predicate on a repo-relative path. */
export function createPathFilter(patterns: string[] | undefined): ((relativePath: string) => boolean) | undefined {
  const active = (patterns ?? []).map((p) => p.trim().replace(/^\.?\//, "")).filter(Boolean);
  if (active.length === 0) return undefined;
  const tests = active.map((pattern) => {
    if (!/[*?]/.test(pattern)) {
      const dir = pattern.replace(/\/+$/, "");
      return (p: string) => p === dir || p.startsWith(`${dir}/`);
    }
    const source = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "\u0000")
      .replace(/\*\*/g, "\u0001")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/\u0000/g, "(?:.*/)?")
      .replace(/\u0001/g, ".*");
    const re = new RegExp(`^${source}$`);
    return (p: string) => re.test(p) || (!pattern.includes("/") && re.test(p.split("/").pop()!));
  });
  return (p) => tests.some((t) => t(p));
}

const ARGS = {
  query: tool.schema
    .string()
    .describe(
      "Natural-language description of the code or behavior you're looking for.",
    ),
  limit: tool.schema
    .number()
    .int()
    .positive()
    .max(50)
    .default(10)
    .describe("Maximum number of ranked results to return."),
  min_score: tool.schema
    .number()
    .optional()
    .describe("Drop hits scoring below this value (the final, reranked score)."),
  paths: tool.schema
    .array(tool.schema.string())
    .optional()
    .describe("Only hits below these repo-relative folders, or matching these globs (e.g. src/api, **/*.yaml)."),
};

export interface SemanticSearchDeps {
  vectorStore: VectorStore;
  embedQuery(text: string): Promise<number[]>;
  /** Other allowed repos' stores to also search (cross-repo-allowlist), tagged with their project key. */
  crossRepoStores?: { key: string; store: VectorStore }[];
  /** Non-null while indexing is still running; see index-notice.ts. */
  getIndexingNotice?: () => string | null;
  /** Cross-encoder scores (higher = more relevant) for `texts` against `query`; omit to skip reranking. */
  rerank?: (query: string, texts: string[]) => Promise<number[]>;
  /** How many fused candidates the reranker sees (default 30). */
  rerankCandidates?: number;
}

export function createSemanticSearchTool(deps: SemanticSearchDeps) {
  return tool({
    description: DESCRIPTION,
    args: ARGS,
    async execute(args) {
      const queryVector = await deps.embedQuery(args.query);
      // Dense + BM25 channels fused per store (RRF), then merged across
      // projects; RRF scores are comparable because the formula is the same.
      const pathFilter = createPathFilter(args.paths);
      const basePool = deps.rerank
        ? Math.max(args.limit, deps.rerankCandidates ?? 30)
        : args.limit;
      // A path filter discards hits after the search, so look at more of them.
      const pool = pathFilter ? basePool * 4 : basePool;
      const search = (store: VectorStore) =>
        hybridSearch(store, {
          query: args.query,
          vector: queryVector,
          limit: pool,
        });
      const candidates = [
        ...search(deps.vectorStore),
        ...(deps.crossRepoStores ?? []).flatMap(({ key, store }) =>
          search(store).map((result) => ({ ...result, project: key })),
        ),
      ]
        .filter((c) => !pathFilter || pathFilter(c.relativePath))
        .sort((a, b) => b.score - a.score)
        .slice(0, basePool);
      let merged = candidates.slice(0, args.limit);
      if (deps.rerank && candidates.length > 1) {
        try {
          const scores = await deps.rerank(
            args.query,
            candidates.map((c) =>
              buildEmbedInput({
                relativePath: c.relativePath,
                symbol: c.symbol,
                text: c.text,
              }),
            ),
          );
          merged = candidates
            .map((c, i) => ({ ...c, score: scores[i] ?? Number.NEGATIVE_INFINITY }))
            .sort((a, b) => b.score - a.score)
            .slice(0, args.limit);
        } catch {
          // reranking is an optimization; keep the fused order
        }
      }
      if (args.min_score !== undefined) merged = merged.filter((c) => c.score >= args.min_score!);
      return JSON.stringify(
        attachIndexingNotice(merged, deps.getIndexingNotice?.() ?? null),
      );
    },
  });
}
