import type { Node, Parser } from "web-tree-sitter";
import { createTreeSitterParser } from "../tree-sitter/parser-loader.js";
import { EXTENSION_TO_SPEC, LANGUAGE_SPECS, type LanguageSpec } from "./language-specs.js";

const parserCache = new Map<string, Promise<Parser>>();

function parserFor(grammar: string): Promise<Parser> {
  let parser = parserCache.get(grammar);
  if (!parser) {
    parser = createTreeSitterParser(grammar);
    parserCache.set(grammar, parser);
  }
  return parser;
}

/**
 * Parses `content` with the grammar for `extension` and runs `fn` on the
 * root node, freeing the tree afterwards. Returns `null` for unsupported
 * extensions and parse failures so callers skip graph indexing for the file.
 */
export async function withParsedTree<T>(
  content: string,
  extension: string,
  fn: (root: Node, spec: LanguageSpec) => T,
): Promise<T | null> {
  const key = EXTENSION_TO_SPEC[extension.toLowerCase()];
  if (!key) return null;
  const spec = LANGUAGE_SPECS[key]!;

  let parser: Parser;
  try {
    parser = await parserFor(spec.grammar);
  } catch {
    return null;
  }
  const tree = parser.parse(content);
  if (!tree) return null;
  try {
    return fn(tree.rootNode, spec);
  } finally {
    tree.delete();
  }
}
