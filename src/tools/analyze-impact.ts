import { tool } from "./tool-def.js";
import { attachIndexingNotice } from "../indexing/index-notice.js";
import { findTestFiles } from "./test-files.js";
import type { GraphStore, TraversedCall } from "../storage/graph-store.js";

/**
 * `analyze_impact`: who calls a symbol, what it calls, and which files
 * import its defining files, answered from the precomputed
 * symbol/import/call graph (see `indexing/graph/`).
 *
 * The graph is name-based and static, so some edges cannot be pinned to a
 * single target (several same-named definitions, dynamic receivers). Those
 * are reported as `ambiguous` and the `hint` tells the agent to confirm
 * them by reading the call site (an exact, on-demand LSP check is planned: docs/lsp-roadmap.md).
 */

export interface AnalyzeImpactDeps {
  graphStore: GraphStore;
  /** Symbol graphs of other allowed projects (cross-repo allowlist), selectable via `project`. */
  crossRepoGraphs?: { key: string; store: GraphStore }[];
  /** Non-null while indexing is still running; see index-notice.ts. */
  getIndexingNotice?: () => string | null;
  /** OpenCode 1.x only: the host has a native `lsp` tool the hints may point to (2.x: false). */
  lsp?: boolean;
}

const MAX_EDGES_PER_DIRECTION = 100;
const MAX_HINT_LOCATIONS = 10;

export function createAnalyzeImpactTool(deps: AnalyzeImpactDeps) {
  return tool({
    description: [
      "Find callers/callees and import dependents of a symbol repo-wide,",
      "from a precomputed symbol/import/call graph (always on; covers",
      "TypeScript/JavaScript, Python, Java, Kotlin, C#, Go, Rust, Ruby, C and C++).",
      "Use it before changing or renaming a function/class/method to see",
      "what is affected, one call instead of many grep/read round trips.",
      "Besides calls, edges cover React JSX component usage (kind `jsx`),",
      "Angular DI (`inject`), module/component metadata (`decorator`) and",
      "selector usage in inline templates (`template`).",
      "Edges are name-based: those flagged `ambiguous` could not be narrowed",
      deps.lsp
        ? "to one target, so confirm them with the native `lsp` tool (`findReferences` on the definition, `goToDefinition` on a call site)."
        : "to one target, so confirm them by opening the call site with `read` or with an exact-identifier `grep`.",
      "`tests` lists test files that import or call the symbol.",
      "Pass `project` to analyze another allowed repo.",
      deps.lsp
        ? "Not a replacement for `lsp` when exactness matters."
        : "The graph is static, not a type-checker: for a critical change verify with the project's compiler/tests.",
      "Open the listed callers/callees with `read` (file and line are included).",
    ].join(" "),
    args: {
      symbolName: tool.schema
        .string()
        .describe("Exact symbol name to analyze."),
      path: tool.schema
        .string()
        .optional()
        .describe(
          "Repo-relative file defining the symbol; use it to disambiguate a name defined in several files.",
        ),
      project: tool.schema
        .string()
        .optional()
        .describe("Name of another allowed project (see ai_context_list_projects, field `name`, no hash); default: this project."),
      direction: tool.schema
        .enum(["callers", "callees", "both"])
        .default("both")
        .describe("Which edges of the call graph to traverse."),
      depth: tool.schema
        .number()
        .int()
        .positive()
        .max(5)
        .default(1)
        .describe("How many hops to traverse in the requested direction."),
    },
    async execute(args) {
      let graphStore = deps.graphStore;
      if (args.project) {
        const others = deps.crossRepoGraphs ?? [];
        const other = others.find((g) => g.key === args.project);
        if (!other) {
          const known = others.map((g) => g.key).join(", ") || "none";
          return JSON.stringify({
            error: `Unknown or not allowed project "${args.project}". Allowed: ${known}.`,
          });
        }
        graphStore = other.store;
      }
      const result = analyze(graphStore, args) as Record<string, unknown>;
      if (args.project) result.project = args.project;
      return JSON.stringify(
        attachIndexingNotice(result, deps.getIndexingNotice?.() ?? null),
      );
    },
  });

  function analyze(graphStore: GraphStore, args: {
    symbolName: string;
    path?: string;
    direction?: "callers" | "callees" | "both";
    depth?: number;
  }): unknown {
    const direction = args.direction ?? "both";
    const depth = args.depth ?? 1;

    const definitions = graphStore
      .findSymbols(args.symbolName)
      .filter((s) => !args.path || s.relativePath === args.path)
      .map((s) => ({
        path: s.relativePath,
        kind: s.kind,
        container: s.container,
        startLine: s.startLine,
        endLine: s.endLine,
      }));

    if (definitions.length === 0) {
      return {
        symbol: args.symbolName,
        definitions,
        hint: `No definition of "${args.symbolName}" in the graph. Check the spelling, try find_symbol (partial name) or semantic_search${deps.lsp ? ", or use the native lsp tool (workspaceSymbol)" : ""}.`,
      };
    }

    const traversal = graphStore.traverseCalls({
      symbol: args.symbolName,
      path: args.path,
      direction,
      depth,
    });
    const callers = traversal.edges.filter((e) => e.direction === "callers");
    const callees = traversal.edges.filter((e) => e.direction === "callees");

    const importers = new Map<string, number>();
    for (const def of definitions) {
      for (const dep of graphStore.importDependents(def.path, depth)) {
        const known = importers.get(dep.relativePath);
        if (known === undefined || dep.depth < known)
          importers.set(dep.relativePath, dep.depth);
      }
    }

    const response: Record<string, unknown> = {
      symbol: args.symbolName,
      definitions,
      importers: [...importers]
        .map(([p, d]) => ({ path: p, depth: d }))
        .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path)),
      tests: findTestFiles(
        graphStore,
        definitions.map((d) => d.path),
        [args.symbolName],
      ),
      ambiguousEdgeCount: traversal.edges.filter((e) => e.ambiguous).length,
      hint: buildHint(args.symbolName, definitions, traversal.edges, deps.lsp === true),
    };
    if (direction !== "callees") addEdges(response, "callers", callers);
    if (direction !== "callers") addEdges(response, "callees", callees);
    return response;
  }
}

function addEdges(
  response: Record<string, unknown>,
  key: "callers" | "callees",
  edges: TraversedCall[],
): void {
  response[key] = edges.slice(0, MAX_EDGES_PER_DIRECTION).map((e) => ({
    depth: e.depth,
    path: e.relativePath,
    caller: e.callerSymbol,
    callee: e.calleeName,
    calleePath: e.calleePath,
    line: e.line,
    kind: e.kind,
    ambiguous: e.ambiguous,
    candidateCount: e.candidateCount,
  }));
  if (edges.length > MAX_EDGES_PER_DIRECTION)
    response[`${key}Truncated`] = edges.length;
}

function buildHint(
  symbol: string,
  definitions: { path: string; startLine: number }[],
  edges: TraversedCall[],
  lsp: boolean,
): string {
  const ambiguous = edges.filter((e) => e.ambiguous);
  const defLocations = definitions
    .slice(0, MAX_HINT_LOCATIONS)
    .map((d) => `${d.path}:${d.startLine}`);
  if (ambiguous.length === 0 && definitions.length === 1) {
    return lsp
      ? "The graph is static and name-based; for an exact check of a critical change, confirm with lsp findReferences on the definition."
      : "The graph is static and name-based; for an exact check of a critical change, `grep` the exact identifier and `read` the call sites, then run the project's compiler/tests.";
  }
  const parts: string[] = [];
  if (ambiguous.length > 0) {
    const sites = [
      ...new Set(ambiguous.map((e) => `${e.relativePath}:${e.line}`)),
    ].slice(0, MAX_HINT_LOCATIONS);
    parts.push(
      `${ambiguous.length} edge(s) are ambiguous (the call could not be tied to one definition). ` +
        (lsp
          ? `Confirm them with the native lsp tool: goToDefinition at the call site(s) ${sites.join(", ")}.`
          : `Confirm them with \`read\` at the call site(s) ${sites.join(", ")}.`),
    );
  }
  parts.push(
    lsp
      ? `Confirm the full reference set with lsp findReferences on ${symbol} at ${defLocations.join(", ")}.`
      : `Cross-check the full reference set with an exact \`grep\` for ${symbol}; definition(s) at ${defLocations.join(", ")}.`,
  );
  if (definitions.length > 1)
    parts.push(
      "Several definitions share this name; pass `path` to analyze one.",
    );
  return parts.join(" ");
}
