import type { Node } from "web-tree-sitter";
import { withParsedTree } from "./parse.js";
import type { GraphSymbol } from "../../storage/graph-store.js";
import { EXTENSION_TO_SPEC, LANGUAGE_SPECS, type LanguageSpec, type SymbolContext } from "./language-specs.js";

export interface ExtractedSymbols {
  /** Graph language id (`typescript` for both .ts and .tsx). */
  language: string;
  symbols: GraphSymbol[];
}

/** Graph language id for an extension, or undefined when no extractor exists. */
export function symbolLanguageForExtension(extension: string): string | undefined {
  const key = EXTENSION_TO_SPEC[extension.toLowerCase()];
  return key ? LANGUAGE_SPECS[key]!.language : undefined;
}

export function symbolsFromTree(root: Node, spec: LanguageSpec): GraphSymbol[] {
  const symbols: GraphSymbol[] = [];

  // Returns the container to use for the *following siblings*, if the node changes it.
  function visit(node: Node, context: SymbolContext | undefined): SymbolContext | undefined {
    const described = spec.describe(node, context);
    if (!described) {
      if (!spec.opaque?.has(node.type)) visitChildren(node, context);
      return undefined;
    }
    if (described.emit) {
      symbols.push({
        name: described.emit.name,
        kind: described.emit.kind,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        container: described.emit.container ?? context?.name,
      });
    }
    if (described.enter) visitChildren(node, described.enter);
    return described.siblingContext;
  }

  function visitChildren(node: Node, context: SymbolContext | undefined): void {
    let current = context;
    for (const child of node.namedChildren) {
      current = visit(child, current) ?? current;
    }
  }

  visit(root, undefined);
  return symbols;
}

/**
 * Extracts declared symbols (classes, functions, methods, ...) from `content`
 * using the tree-sitter grammar for `extension`. Returns `null` for
 * unsupported extensions and for files that fail to parse, so callers skip
 * graph indexing for them instead of failing the whole file.
 */
export function extractSymbols(content: string, extension: string): Promise<ExtractedSymbols | null> {
  return withParsedTree(content, extension, (root, spec) => ({
    language: spec.language,
    symbols: symbolsFromTree(root, spec),
  }));
}
