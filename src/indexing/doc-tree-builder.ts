/**
 * INDEX SHAPE: changing what this produces for existing files requires bumping
 * CODE_INDEX_VERSION / DOC_INDEX_VERSION in indexing.ts (ADR-0027).
 *
 * PageIndex-style hierarchical tree builder for long-form Markdown
 * documentation files (plan.md, "port-doc-tree-markdown"). TS port of
 * `.ai-context/watcher/doc_tree_builder.py` (heading parse + tree
 * build) and `chunker.py`'s `should_use_tree_index` (the gate deciding
 * whether a file is tree-indexed instead of normally chunked).
 *
 * Deliberately NOT the actual PageIndex package/API -- this is a
 * one-time LLM summary per heading section computed at index time (via
 * an injectable `summarize` function, mirroring embedder.ts's
 * injectable-dependency pattern -- no hard-wired LLM call here), not
 * per-query agentic LLM reasoning traversal.
 */

const MD_HEADING = /^(#{1,6})\s+(.+)/gm;

export interface Heading {
  level: number;
  title: string;
  startLine: number;
  endLine: number;
}

/** Port of doc_tree_builder.py's `_parse_headings` (raw_text dropped -- callers slice by line range instead). */
export function parseMarkdownHeadings(text: string): Heading[] {
  const lines = text.split("\n");
  const matches = [...text.matchAll(MD_HEADING)];
  if (matches.length === 0) return [];

  return matches.map((match, i) => {
    const level = match[1]!.length;
    const title = match[2]!.trim();
    const startLine = text.slice(0, match.index).split("\n").length; // 1-based
    const endLine =
      i + 1 < matches.length
        ? text.slice(0, matches[i + 1]!.index).split("\n").length - 1
        : lines.length;
    return { level, title, startLine, endLine };
  });
}

export interface DocTreeNode {
  nodeId: string;
  title: string;
  startLine: number;
  endLine: number;
  summary: string | null;
  bodyText: string;
  children: DocTreeNode[];
}

export interface DocTree {
  description: string | null;
  nodeCount: number;
  nodes: DocTreeNode[];
}

export interface BuildDocTreeOptions {
  /** Title of a single root node wrapping the whole text when it has no headings. */
  fallbackTitle?: string;
  /**
   * Injected summarizer -- called once per node (kind: "node") and once
   * for the whole document (kind: "document"). Omit to build a tree
   * with no summaries (matches the original's "LLM unavailable"
   * behavior). A thrown/rejected call is caught per-node/per-document
   * and falls back to `null`, so one failure doesn't abort the build.
   */
  summarize?: (
    text: string,
    kind: "node" | "document",
  ) => Promise<string | null>;
}

function countNodes(nodes: DocTreeNode[]): number {
  let total = 0;
  for (const node of nodes) total += 1 + countNodes(node.children);
  return total;
}

async function summarizeNodes(
  nodes: DocTreeNode[],
  summarize: NonNullable<BuildDocTreeOptions["summarize"]>,
): Promise<void> {
  for (const node of nodes) {
    try {
      node.summary = await summarize(node.bodyText, "node");
    } catch {
      node.summary = null;
    }
    await summarizeNodes(node.children, summarize);
  }
}

/** Port of doc_tree_builder.py's `build_tree_for_file`. */
export async function buildDocTree(
  text: string,
  options: BuildDocTreeOptions = {},
): Promise<DocTree> {
  const headings = parseMarkdownHeadings(text);
  const lines = text.split("\n");
  if (headings.length === 0) {
    if (!options.fallbackTitle || !text.trim()) {
      return { description: null, nodeCount: 0, nodes: [] };
    }
    headings.push({
      level: 1,
      title: options.fallbackTitle,
      startLine: 1,
      endLine: lines.length,
    });
  }

  let counter = 0;
  const roots: DocTreeNode[] = [];
  const stack: DocTreeNode[] = [];

  for (const heading of headings) {
    counter += 1;
    const node: DocTreeNode = {
      nodeId: String(counter).padStart(4, "0"),
      title: heading.title,
      startLine: heading.startLine,
      endLine: heading.endLine,
      summary: null,
      bodyText: lines.slice(heading.startLine - 1, heading.endLine).join("\n"),
      children: [],
    };
    // Pop back to the nearest ancestor with a shallower level, mirroring
    // the Python stack-based tree assembly.
    while (
      stack.length &&
      (stack[stack.length - 1] as DocTreeNode & { _level: number })._level >=
        heading.level
    ) {
      stack.pop();
    }
    (node as DocTreeNode & { _level: number })._level = heading.level;
    if (stack.length) {
      stack[stack.length - 1]!.children.push(node);
    } else {
      roots.push(node);
    }
    stack.push(node);
  }

  const nodeCount = countNodes(roots);

  let description: string | null = null;
  if (options.summarize) {
    try {
      description = await options.summarize(text, "document");
    } catch {
      description = null;
    }
    await summarizeNodes(roots, options.summarize);
  }

  return { description, nodeCount, nodes: roots };
}

export interface TreeIndexConfig {
  enabled: boolean;
  /** Paths (relative to project root) always tree-indexed regardless of heading count. */
  alwaysTreePaths?: string[];
  /** Minimum number of `#`-prefixed lines before tree mode activates. Default 0: every document is tree-indexed. */
  minHeadingsForTree?: number;
}

/** Port of chunker.py's `should_use_tree_index`. */
export function shouldUseTreeIndex(
  relativePath: string,
  text: string,
  config: TreeIndexConfig,
): boolean {
  if (!config.enabled) return false;
  const normPath = relativePath.replace(/^[/\\]+/, "");
  if (
    (config.alwaysTreePaths ?? []).some((p) =>
      normPath.startsWith(p.replace(/^[/\\]+/, "")),
    )
  ) {
    return true;
  }
  const minHeadings = config.minHeadingsForTree ?? 0;
  const headingCount = text
    .split("\n")
    .filter((line) => line.startsWith("#")).length;
  return headingCount >= minHeadings;
}
