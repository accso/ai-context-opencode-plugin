import { createRequire } from "node:module";
import { Language, Parser } from "web-tree-sitter";

/**
 * Loads `web-tree-sitter` (WASM) grammars from the prebuilt `.wasm` files
 * that each upstream `tree-sitter-<lang>` npm package ships (ADR-0013:
 * web-tree-sitter chosen over native tree-sitter bindings for
 * cross-platform install reliability; ADR-0016: upstream packages instead
 * of the stale, aggregated `tree-sitter-wasms` bundle so every grammar
 * tracks its language's current version).
 *
 * Grammar names here are this module's own keys, mapped to the
 * `<package>/<file>.wasm` specifier of the upstream package (C# is
 * `c_sharp`, mapped from this plugin's `"csharp"` id in
 * `language-grammars.ts`).
 */

const GRAMMAR_WASM: Readonly<Record<string, string>> = {
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm",
  python: "tree-sitter-python/tree-sitter-python.wasm",
  java: "tree-sitter-java/tree-sitter-java.wasm",
  c_sharp: "tree-sitter-c-sharp/tree-sitter-c_sharp.wasm",
  kotlin: "@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm",
  go: "tree-sitter-go/tree-sitter-go.wasm",
  rust: "tree-sitter-rust/tree-sitter-rust.wasm",
  ruby: "tree-sitter-ruby/tree-sitter-ruby.wasm",
  c: "tree-sitter-c/tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp/tree-sitter-cpp.wasm",
};

export type TreeSitterGrammarName = keyof typeof GRAMMAR_WASM;

// Resolved via Node module resolution from this file's location, so it
// works from src/ (tests) and from the bundled dist/ file alike, as long
// as the grammar packages are installed next to it.
const requireFromHere = createRequire(import.meta.url);

let parserInitialized: Promise<void> | undefined;

function ensureParserInitialized(): Promise<void> {
  parserInitialized ??= Parser.init();
  return parserInitialized;
}

const languageCache = new Map<string, Promise<Language>>();

/**
 * Loads (and caches, per grammar name) a `Language` from its
 * `.wasm` file. Rejects if `grammarName` isn't one of `GRAMMAR_WASM`
 * or its `.wasm` file can't be loaded -- callers (language-grammars.ts's
 * dispatch) are expected to catch and fall back to
 * `chunkText`'s paragraph-based chunker, matching chunker.py's own
 * `_chunk_by_treesitter` returning `None` on any failure.
 */
export async function loadTreeSitterLanguage(grammarName: string): Promise<Language> {
  const wasmSpecifier = GRAMMAR_WASM[grammarName];
  if (!wasmSpecifier) {
    throw new Error(`no tree-sitter grammar for "${grammarName}"`);
  }

  let cached = languageCache.get(grammarName);
  if (!cached) {
    cached = (async () => {
      await ensureParserInitialized();
      return Language.load(requireFromHere.resolve(wasmSpecifier));
    })();
    languageCache.set(grammarName, cached);
  }
  return cached;
}

/** Convenience: a ready-to-use `Parser` with `grammarName`'s language already set. */
export async function createTreeSitterParser(grammarName: string): Promise<Parser> {
  const language = await loadTreeSitterLanguage(grammarName);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}
