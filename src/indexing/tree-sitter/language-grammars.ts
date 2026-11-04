/**
 * Tier-1 tree-sitter chunk-boundary config, one entry per language that
 * gets REAL tree-sitter-driven chunking (not just the paragraph-based
 * fallback). Mirrors `.ai-context/watcher/symbol_extractor.py`'s
 * `_EXT_TO_LANG`/`_SYMBOL_NODE_TYPES`/`_KIND_MAP` tables exactly (node
 * type names and field names verified against the real
 * `tree-sitter-wasms` grammar files, not just copied blind from the
 * Python source) -- this is deliberately the SAME set of languages
 * `chunker.py`'s own `chunk_file()` dispatches to `_chunk_by_treesitter`
 * for (TypeScript/TSX, Java, C#): the original codebase itself only
 * used tree-sitter for chunk *boundaries* on these three, relying on
 * regex (`_chunk_by_pattern`) for every other language. Extending
 * tree-sitter boundaries to more languages is tracked as a separate
 * follow-up (`port-tree-sitter-chunker-remaining-languages`), not
 * silently done here as scope creep beyond the original's own behavior.
 */

export interface TreeSitterLanguageConfig {
  /** `tree-sitter-wasms`' own grammar filename stem (e.g. "c_sharp", not "csharp"). */
  grammarName: string;
  /** Top-level declaration node types this language's chunk boundaries are drawn at. */
  nodeTypes: ReadonlySet<string>;
  /**
   * Node types that are pure organizational containers (recursed
   * through, never themselves emitted as a chunk boundary) -- e.g. a
   * C# `namespace_declaration` wrapping many classes/interfaces should
   * not collapse all of them into one giant chunk.
   */
  containerOnlyNodeTypes: ReadonlySet<string>;
}

/** Node type -> human-readable chunk_type, shared across all Tier-1 languages (symbol_extractor.py's `_KIND_MAP`). */
export const KIND_MAP: Readonly<Record<string, string>> = {
  class_declaration: "class",
  class_definition: "class",
  function_declaration: "function",
  function_definition: "function",
  method_declaration: "method",
  method_definition: "method",
  constructor_declaration: "constructor",
  secondary_constructor: "constructor",
  initializer_declaration: "initializer",
  interface_declaration: "interface",
  enum_declaration: "enum",
  struct_declaration: "struct",
  record_declaration: "record",
  namespace_declaration: "namespace",
  object_declaration: "object",
  protocol_declaration: "protocol",
  extension_declaration: "extension",
  type_alias_declaration: "typealias",
};

/** This plugin's own language ids (indexing.ts's `guessLanguage`) -> tree-sitter chunk-boundary config. */
export const TREE_SITTER_LANGUAGES: Readonly<Record<string, TreeSitterLanguageConfig>> = {
  typescript: {
    grammarName: "typescript",
    nodeTypes: new Set([
      "class_declaration",
      "function_declaration",
      "method_definition",
      "interface_declaration",
      "enum_declaration",
      "type_alias_declaration",
    ]),
    containerOnlyNodeTypes: new Set(),
  },
  tsx: {
    grammarName: "tsx",
    nodeTypes: new Set([
      "class_declaration",
      "function_declaration",
      "method_definition",
      "interface_declaration",
      "enum_declaration",
    ]),
    containerOnlyNodeTypes: new Set(),
  },
  java: {
    grammarName: "java",
    nodeTypes: new Set([
      "class_declaration",
      "interface_declaration",
      "method_declaration",
      "enum_declaration",
      "record_declaration",
      "constructor_declaration",
    ]),
    containerOnlyNodeTypes: new Set(),
  },
  csharp: {
    grammarName: "c_sharp",
    nodeTypes: new Set([
      "class_declaration",
      "interface_declaration",
      "method_declaration",
      "struct_declaration",
      "enum_declaration",
      "namespace_declaration",
      "record_declaration",
      "constructor_declaration",
    ]),
    containerOnlyNodeTypes: new Set(["namespace_declaration"]),
  },
};

/**
 * `tsx`'s language id here is this plugin's OWN `guessLanguage` result
 * for `.tsx` (see indexing.ts's `EXTENSION_LANGUAGE_MAP`, which maps
 * both `.ts`/`.tsx` to `"typescript"`) -- so callers dispatch on file
 * EXTENSION, not on `guessLanguage`'s language id, to pick `tsx` vs
 * `typescript` grammars. This map is keyed separately from
 * `guessLanguage`'s output for exactly that reason.
 */
export function treeSitterConfigForExtension(extension: string): TreeSitterLanguageConfig | undefined {
  switch (extension.toLowerCase()) {
    case ".ts":
      return TREE_SITTER_LANGUAGES.typescript;
    case ".tsx":
      return TREE_SITTER_LANGUAGES.tsx;
    case ".java":
      return TREE_SITTER_LANGUAGES.java;
    case ".cs":
      return TREE_SITTER_LANGUAGES.csharp;
    default:
      return undefined;
  }
}
