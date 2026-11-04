// INDEX SHAPE: changing the chunks this produces requires bumping CODE_INDEX_VERSION in ../indexing.ts (ADR-0027).
import type { Node, Parser, Tree } from "web-tree-sitter";
import { createTreeSitterParser } from "./parser-loader.js";
import { treeSitterConfigForExtension, KIND_MAP, type TreeSitterLanguageConfig } from "./language-grammars.js";

/**
 * Tree-sitter-driven chunk boundaries -- TS port of
 * `.ai-context/watcher/chunker.py`'s `_chunk_by_treesitter` (its
 * "Tier-1" tree-sitter chunker for TypeScript/TSX/Java/C#; see
 * "Structure-aware chunking" in `.ai-context/docs/architecture-deep-
 * dive.md`). Returns `null` -- the same fallback signal
 * `_chunk_by_treesitter` uses -- whenever this extension has no Tier-1
 * grammar, the file fails to parse, or zero top-level declaration nodes
 * are found; callers (indexing.ts) fall back to `chunkText`'s
 * paragraph-based chunker in all of those cases, exactly like
 * `chunker.py`'s own `chunk_file()` dispatch (`_chunk_by_treesitter(...)
 * or _chunk_by_pattern(...)`).
 */

export interface TreeSitterChunk {
  text: string;
  startLine: number;
  endLine: number;
  symbol: string | undefined;
  chunkType: string;
}

interface DeclarationSite {
  /** 1-based line number. */
  startLine: number;
  name: string | undefined;
  nodeType: string;
}

/**
 * Collects (startLine, name, nodeType) for every top-level declaration
 * node, using the parse tree instead of indentation/regexes.
 * Deliberately does NOT descend into a matched node's own children -- a
 * class's methods stay inside its single chunk, exactly like the
 * original regex chunker's `^`-anchored patterns never matching
 * indented methods either (see chunker.py's `_collect_top_level`
 * docstring: "this is a chunk-*boundary* swap-in, not a request to
 * chunk at every nested node"). `containerOnlyNodeTypes` (e.g. a C#
 * `namespace_declaration`) are the one exception: always recursed
 * through, never emitted as a boundary themselves.
 */
function collectTopLevel(node: Node, config: TreeSitterLanguageConfig): DeclarationSite[] {
  const results: DeclarationSite[] = [];

  function visit(n: Node): void {
    if (config.nodeTypes.has(n.type) && !config.containerOnlyNodeTypes.has(n.type)) {
      const nameNode = n.childForFieldName("name");
      results.push({
        startLine: n.startPosition.row + 1,
        name: nameNode?.text,
        nodeType: n.type,
      });
      return; // do not descend further -- see docstring above
    }
    for (const child of n.children) {
      visit(child);
    }
  }

  visit(node);
  results.sort((a, b) => a.startLine - b.startLine);
  return results;
}

/**
 * Parses `content` with the Tier-1 tree-sitter grammar for `extension`
 * (if any) and slices it into chunks at each top-level declaration's
 * boundary, with a leading "preamble" chunk (imports/package
 * declarations/annotations before the first declaration) matching
 * `_chunk_by_treesitter`'s own preamble convention. Returns `null` --
 * never throws -- for any condition that should fall back to
 * `chunkText` instead (see this module's own doc comment).
 */
export async function chunkWithTreeSitter(content: string, extension: string): Promise<TreeSitterChunk[] | null> {
  const config = treeSitterConfigForExtension(extension);
  if (!config) return null;

  let parser: Parser;
  try {
    parser = await createTreeSitterParser(config.grammarName);
  } catch {
    return null;
  }

  let tree: Tree | null;
  try {
    tree = parser.parse(content);
  } catch {
    return null;
  }
  if (!tree) return null;

  const lines = content.split("\n");
  const declarations = collectTopLevel(tree.rootNode, config);
  if (declarations.length === 0) return null;

  const chunks: TreeSitterChunk[] = [];

  const firstStart = declarations[0]!.startLine;
  if (firstStart > 1) {
    const preambleText = lines
      .slice(0, firstStart - 1)
      .join("\n")
      .trim();
    if (preambleText) {
      chunks.push({
        text: preambleText,
        startLine: 1,
        endLine: firstStart - 1,
        symbol: undefined,
        chunkType: "block",
      });
    }
  }

  for (let i = 0; i < declarations.length; i++) {
    const { startLine, name, nodeType } = declarations[i]!;
    const endLine = i + 1 < declarations.length ? declarations[i + 1]!.startLine - 1 : lines.length;
    const text = lines
      .slice(startLine - 1, endLine)
      .join("\n")
      .trim();
    if (text) {
      chunks.push({
        text,
        startLine,
        endLine,
        symbol: name,
        chunkType: KIND_MAP[nodeType] ?? "block",
      });
    }
  }

  return chunks;
}
