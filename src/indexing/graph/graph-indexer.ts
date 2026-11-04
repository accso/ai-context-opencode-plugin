import path from "node:path";
import type { FileGraph, GraphCall, GraphImport, GraphStore, StoredSymbol } from "../../storage/graph-store.js";
import { extractFileGraph } from "./file-graph-extractor.js";
import { createImportResolver, type ImportResolver } from "./import-resolver.js";
import type { RawImport } from "./import-extractor.js";
import { resolveCall } from "./call-resolver.js";

/**
 * Keeps the symbol / import / call graph in sync with indexed files.
 *
 * `update` stores a file's raw extraction immediately; edges are only
 * resolved in `finishBatch`, once per indexing batch. Resolution needs the
 * whole file set (an import can point at a file that is indexed later in
 * the same batch, or in a later one), so resolving per file would be both
 * order-dependent and quadratic during the initial walk.
 *
 * `finishBatch` re-resolves only what a batch could have changed:
 *  - imports of touched files, or of every file when files were added/removed;
 *  - calls of touched files, of files whose imports changed, and of files
 *    calling a name whose definitions appeared/disappeared.
 */
export interface GraphIndexer {
  /** Index `content` for `relativePath`; `null` (deleted, ignored) removes it. Unsupported files are skipped. */
  update(relativePath: string, content: string | null): Promise<void>;
  /** Resolve edges affected by the `update` calls since the last `finishBatch`. */
  finishBatch(): void;
}

export interface GraphIndexerDeps {
  store: GraphStore;
}

const symbolKey = (s: { name: string; kind: string; container?: string }) => `${s.name}\u0000${s.kind}\u0000${s.container ?? ""}`;

function rawImportsOf(graph: FileGraph): RawImport[] {
  const seen = new Map<string, RawImport>();
  for (const i of graph.imports) {
    const key = `${i.specifier}\u0000${i.kind ?? ""}\u0000${i.line}`;
    if (!seen.has(key)) seen.set(key, { specifier: i.specifier, kind: i.kind, importedNames: i.importedNames, line: i.line });
  }
  return [...seen.values()];
}

function resolveImportRows(graph: FileGraph, file: string, resolver: ImportResolver): GraphImport[] {
  return rawImportsOf(graph).flatMap((raw) => {
    const resolved = resolver.resolve(raw, file, graph.language);
    return resolved.length === 0
      ? [{ ...raw }]
      : resolved.map((resolvedPath) => ({ ...raw, resolvedPath }));
  });
}

/**
 * A template edge keeps its raw tag/attribute in `qualifier`; once exactly
 * one class claims that selector the edge points at the class, so
 * `analyze_impact` on the component finds the templates using it.
 */
function resolveTemplateEdge(call: GraphCall, candidatesFor: (name: string) => StoredSymbol[]): GraphCall {
  const selector = call.qualifier ?? call.calleeName;
  const owners = candidatesFor(selector).filter((s) => s.kind === "selector" && s.container);
  const classes = new Map(owners.map((s) => [`${s.relativePath}\u0000${s.container}`, s]));
  if (classes.size === 1) {
    const owner = [...classes.values()][0]!;
    return { ...call, calleeName: owner.container!, calleePath: owner.relativePath, ambiguous: false, candidateCount: undefined };
  }
  if (classes.size > 1) return { ...call, calleeName: selector, calleePath: undefined, ambiguous: true, candidateCount: classes.size };
  return { ...call, calleeName: selector, calleePath: undefined, ambiguous: false, candidateCount: undefined };
}

export function createGraphIndexer({ store }: GraphIndexerDeps): GraphIndexer {
  let touched = new Set<string>();
  let affectedNames = new Set<string>();
  let fileSetChanged = false;

  function noteSymbolChanges(before: readonly { name: string; kind: string; container?: string }[], after: readonly { name: string; kind: string; container?: string }[]): void {
    const beforeKeys = new Map(before.map((s) => [symbolKey(s), s.name]));
    const afterKeys = new Map(after.map((s) => [symbolKey(s), s.name]));
    for (const [key, name] of beforeKeys) if (!afterKeys.has(key)) affectedNames.add(name);
    for (const [key, name] of afterKeys) if (!beforeKeys.has(key)) affectedNames.add(name);
  }

  return {
    async update(relativePath, content) {
      const before = store.getFileGraph(relativePath);
      let extracted = null;
      if (content !== null) {
        try {
          extracted = await extractFileGraph(content, path.extname(relativePath));
        } catch {
          extracted = null; // a file the extractor chokes on must not break indexing; it just has no graph
        }
      }
      if (!extracted) {
        if (before) {
          noteSymbolChanges(before.symbols, []);
          store.deleteFile(relativePath);
          fileSetChanged = true;
        }
        return;
      }
      if (!before) fileSetChanged = true;
      noteSymbolChanges(before?.symbols ?? [], extracted.symbols);
      store.replaceFile(relativePath, {
        language: extracted.language,
        symbols: extracted.symbols,
        imports: extracted.imports.map((i) => ({ ...i })),
        calls: extracted.calls.map((c) => ({ ...c })),
      });
      touched.add(relativePath);
    },

    finishBatch() {
      if (touched.size === 0 && affectedNames.size === 0 && !fileSetChanged) return;
      const allFiles = store.listFiles();
      const resolver = createImportResolver(allFiles);

      const importFiles = fileSetChanged ? allFiles : [...touched];
      const importsByFile = new Map<string, GraphImport[]>();
      const changedImportFiles = new Set<string>();
      for (const file of importFiles) {
        const graph = store.getFileGraph(file);
        if (!graph) continue;
        const resolved = resolveImportRows(graph, file, resolver);
        importsByFile.set(file, resolved);
        if (JSON.stringify(resolved) !== JSON.stringify(graph.imports)) changedImportFiles.add(file);
      }

      const callFiles = new Set<string>([...touched, ...changedImportFiles, ...store.findCallerFiles([...affectedNames])]);
      const candidateCache = new Map<string, StoredSymbol[]>();
      const candidatesFor = (name: string) => {
        let list = candidateCache.get(name);
        if (!list) candidateCache.set(name, (list = store.findSymbols(name)));
        return list;
      };

      for (const file of new Set([...changedImportFiles, ...callFiles])) {
        const graph = store.getFileGraph(file);
        if (!graph) continue;
        const imports = importsByFile.get(file) ?? graph.imports;
        let calls: GraphCall[] = graph.calls;
        if (callFiles.has(file)) {
          const importedFiles = new Set(imports.flatMap((i) => (i.resolvedPath ? [i.resolvedPath] : [])));
          calls = graph.calls.map((call) => {
            const callerContainer = call.callerSymbol
              ? graph.symbols.find((s) => s.name === call.callerSymbol)?.container
              : undefined;
            if (call.kind === "template") return resolveTemplateEdge(call, candidatesFor);
            const r = resolveCall(call, { fromPath: file, callerContainer, candidates: candidatesFor(call.calleeName), importedFiles });
            return { ...call, calleePath: r.calleePath, ambiguous: r.ambiguous, candidateCount: r.candidateCount };
          });
        }
        if (JSON.stringify(imports) !== JSON.stringify(graph.imports) || JSON.stringify(calls) !== JSON.stringify(graph.calls)) {
          store.replaceFile(file, { ...graph, imports, calls });
        }
      }

      touched = new Set();
      affectedNames = new Set();
      fileSetChanged = false;
    },
  };
}
