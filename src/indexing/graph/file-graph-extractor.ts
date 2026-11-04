import { withParsedTree } from "./parse.js";
import { symbolsFromTree } from "./symbol-extractor.js";
import { importsFromTree, type RawImport } from "./import-extractor.js";
import { frameworkFromTree } from "./framework-extractor.js";
import { callsFromTree, type RawCall } from "./call-extractor.js";
import type { GraphSymbol } from "../../storage/graph-store.js";

export interface ExtractedFileGraph {
  language: string;
  symbols: GraphSymbol[];
  imports: RawImport[];
  calls: RawCall[];
}

/** Symbols, imports and calls of one file from a single parse; `null` when unsupported or unparseable. */
export function extractFileGraph(content: string, extension: string): Promise<ExtractedFileGraph | null> {
  return withParsedTree(content, extension, (root, spec) => {
    const symbols = symbolsFromTree(root, spec);
    const framework = frameworkFromTree(root, spec, symbols);
    return {
      language: spec.language,
      symbols: [...symbols, ...framework.symbols],
      imports: importsFromTree(root, spec),
      calls: [...callsFromTree(root, spec, symbols), ...framework.calls],
    };
  });
}
