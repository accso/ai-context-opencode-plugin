import type { DocTree, DocTreeNode } from "../indexing/doc-tree-builder.js";
import type { DocTreeStore } from "../storage/doc-tree-store.js";

/**
 * Doc-tree search (plan.md, "port-doc-tree-markdown"), ported from
 * mcp-server/src/doc_tree.ts's `searchDocTrees`/`buildToc`/
 * `selectNodesByKeyword`/`findNodeById` -- simple, local keyword-based
 * node scoring, matching the original's own "Simple keyword-based node
 * selection (no external LLM from TS side)" comment; not ColBERT/
 * cross-encoder reranking (same rationale as keyword-rerank.ts).
 *
 * Simplified vs. the original: a `limit` on the number of files returned
 * replaces the original's `tokenBudget` accounting, since that budget
 * existed for `assembleContext()` -- an orchestrator this plugin's
 * plan.md already decided not to port (it wasn't wired to any live
 * route in the original either).
 */

export type DocTreeSearchMode = "toc_only" | "summary_only" | "node_text";

export interface DocTreeSearchNode {
  nodeId: string;
  title: string;
  startLine: number;
  endLine: number;
  summary: string | null;
  /** Only populated in "node_text" mode. */
  text?: string;
}

export interface DocTreeSearchResult {
  relativePath: string;
  toc: string;
  relevantNodes: DocTreeSearchNode[];
}

/** Port of doc_tree.ts's `buildToc`. */
export function buildToc(relativePath: string, tree: DocTree): string {
  function flatten(nodes: DocTreeNode[], indent = 0): string[] {
    const prefix = "  ".repeat(indent);
    const lines: string[] = [];
    for (const node of nodes) {
      const summary = node.summary ? `: "${node.summary}"` : "";
      lines.push(`${prefix}[${node.nodeId}] ${node.title} (lines ${node.startLine}–${node.endLine})${summary}`);
      lines.push(...flatten(node.children, indent + 1));
    }
    return lines;
  }

  const header = `# ${relativePath}` + (tree.description ? `\n_${tree.description}_` : "");
  return header + "\n" + flatten(tree.nodes).join("\n");
}

function findNodeById(nodes: DocTreeNode[], nodeId: string): DocTreeNode | null {
  for (const node of nodes) {
    if (node.nodeId === nodeId) return node;
    const found = findNodeById(node.children, nodeId);
    if (found) return found;
  }
  return null;
}

export interface DocTreeSearchOptions {
  /** Only docs below this repo-relative directory. */
  dirPath?: string;
  /** Skip this many ranked files (paging). */
  offset?: number;
}

interface ScoredNode {
  nodeId: string;
  score: number;
}

function scoreNodes(nodes: DocTreeNode[], queryTerms: string[]): ScoredNode[] {
  const flat: ScoredNode[] = [];
  function traverse(ns: DocTreeNode[]): void {
    for (const node of ns) {
      const text = `${node.title} ${node.summary ?? ""}`.toLowerCase();
      let hits = 0;
      for (const term of queryTerms) if (text.includes(term)) hits++;
      flat.push({ nodeId: node.nodeId, score: hits });
      traverse(node.children);
    }
  }
  traverse(nodes);
  return flat;
}

/** Port of doc_tree.ts's `selectNodesByKeyword`. */
function selectNodesByKeyword(scored: ScoredNode[], topN: number): string[] {
  return [...scored]
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .filter((x) => x.score > 0)
    .map((x) => x.nodeId);
}

function normalizeDir(dirPath: string | undefined): string {
  return (dirPath ?? "")
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/^\.$/, "");
}

/**
 * Ranks ALL trees (not the first `limit` in storage order) and then pages.
 * `toc_only` lists every doc below `dirPath` (path matches of the query first,
 * then path order); the other modes keep only docs whose path or sections match.
 */
export function searchDocTrees(
  store: DocTreeStore,
  query: string,
  mode: DocTreeSearchMode,
  limit: number,
  options: DocTreeSearchOptions = {},
): DocTreeSearchResult[] {
  const dir = normalizeDir(options.dirPath);
  const prefix = dir === "" ? "" : `${dir}/`;
  const trees = store
    .getAllTrees()
    .filter((t) => t.relativePath.startsWith(prefix));
  if (!trees.length) return [];

  const queryTerms = query
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length >= 3);

  const ranked = trees
    .map((record) => {
      const pathLower = record.relativePath.toLowerCase();
      const pathHits = queryTerms.filter((t) => pathLower.includes(t)).length;
      const scored = mode === "toc_only" ? [] : scoreNodes(record.nodes, queryTerms);
      const selectedIds = selectNodesByKeyword(scored, 5);
      const nodeScore = scored.reduce((best, n) => Math.max(best, n.score), 0);
      return { record, pathHits, selectedIds, score: pathHits * 2 + nodeScore };
    })
    .filter((r) => mode === "toc_only" || r.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || a.record.relativePath.localeCompare(b.record.relativePath),
    );

  const start = Math.max(0, options.offset ?? 0);
  const results: DocTreeSearchResult[] = [];
  for (const { record, selectedIds } of ranked.slice(start, start + limit)) {
    const toc = buildToc(record.relativePath, record);
    if (mode === "toc_only") {
      results.push({ relativePath: record.relativePath, toc, relevantNodes: [] });
      continue;
    }
    const relevantNodes: DocTreeSearchNode[] = [];
    for (const nodeId of selectedIds) {
      const node = findNodeById(record.nodes, nodeId);
      if (!node) continue;
      const entry: DocTreeSearchNode = {
        nodeId: node.nodeId,
        title: node.title,
        startLine: node.startLine,
        endLine: node.endLine,
        summary: node.summary,
      };
      if (mode === "node_text") entry.text = node.bodyText;
      relevantNodes.push(entry);
    }
    results.push({ relativePath: record.relativePath, toc, relevantNodes });
  }
  return results;
}
