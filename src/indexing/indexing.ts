import { type MemoryGuard } from "./memory-guard.js";
import fs from "node:fs/promises";
import path from "node:path";
import { chunkText } from "./chunker.js";
import {
  splitOversizedChunks,
  DEFAULT_MAX_CHUNK_CHARS,
} from "./chunk-splitter.js";
import { chunkWithTreeSitter } from "./tree-sitter/treesitter-chunker.js";
import { applyDecoratorFix } from "./tree-sitter/decorator-fix.js";
import { applyDispatchSubchunking } from "./tree-sitter/dispatch-subchunking.js";
import { chunkWithRegexPatterns } from "./regex-chunker.js";
import { chunkWithDataFormatSplitter } from "./data-format-chunker.js";
import {
  buildDocTree,
  shouldUseTreeIndex,
  type TreeIndexConfig,
} from "./doc-tree-builder.js";
import { buildEmbedInput } from "./embed-input.js";
import type { FallbackSummary, SummaryInput } from "./file-summary.js";
import type { VectorStore } from "../storage/vector-store.js";
import type { DocTreeStore } from "../storage/doc-tree-store.js";
import type { GraphIndexer } from "./graph/graph-indexer.js";
import type { FileChangeBatchEntry } from "./index-scheduler.js";
import type { IndexReason } from "./index-progress.js";

/**
 * Document-side indexing pipeline: file content -> chunker.ts ->
 * embedDocument -> VectorStore. Implements the `IndexScheduler`'s
 * `indexFiles(batch)` contract so it can replace `plugin.ts`'s no-op
 * `defaultIndexFiles`, and is also reused for the startup
 * delta-reconciliation pass (each file treated as an "add"/"change").
 *
 * Mirrors `watcher/indexer.py`'s per-file delta-upsert shape: an
 * add/change re-chunks and re-embeds the WHOLE file, then replaces all of
 * that file's previously-stored chunks in one step (delete-then-upsert)
 * rather than trying to diff individual chunks -- simpler, and correct
 * even when the number/boundaries of chunks shift between edits. An
 * unlink just deletes.
 */

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".kt": "kotlin",
  ".swift": "swift",
  ".md": "markdown",
  ".sql": "sql",
  ".yaml": "yaml",
  ".yml": "yaml",
};

/** Best-effort language guess from a file extension. Falls back to "text". */
export function guessLanguage(relativePath: string): string {
  return (
    EXTENSION_LANGUAGE_MAP[path.extname(relativePath).toLowerCase()] ?? "text"
  );
}

/** Stable chunk id: unique per file+line-range, stable across re-indexing the same unchanged chunk. */
function chunkId(
  relativePath: string,
  startLine: number,
  endLine: number,
  part?: number,
): string {
  return `${relativePath}:${startLine}-${endLine}${part === undefined ? "" : `#${part}`}`;
}

/**
 * Self-healing (ADR-0027). The stored fingerprint carries a suffix for the
 * representation a file was indexed with, so a mismatch re-indexes just that
 * file kind. Bump when a change to the chunker/doc-tree builder should reach
 * already indexed files; code version 1 has no suffix so older stores stay valid.
 */
export const CODE_INDEX_VERSION = 2;
export const DOC_INDEX_VERSION = 2;

export interface DocTreeIndexConfig extends TreeIndexConfig {
  /** File extensions (lowercased, with leading dot) eligible for tree-indexing at all. */
  extensions: string[];
}

export interface IndexerDeps {
  vectorStore: VectorStore;
  embedDocument: (text: string) => Promise<number[]>;
  /** Reads a file's content by relative path; returns null if the file no longer exists. Injectable for tests. */
  readFile: (relativePath: string) => Promise<string | null>;
  /**
   * PageIndex-style Markdown doc-tree storage (plan.md,
   * "port-doc-tree-markdown"). When omitted, tree-indexing is fully
   * disabled and every file is chunked normally (unchanged default
   * behavior) -- there'd be nowhere to store a tree anyway.
   */
  docTreeStore?: DocTreeStore;
  /** Gate config for which files use tree-indexing instead of chunking. Defaults to `{ enabled: true, extensions: [".md"] }`. */
  docTreeConfig?: DocTreeIndexConfig;
  /** Injected summarizer, forwarded to buildDocTree -- see doc-tree-builder.ts. */
  summarize?: (
    text: string,
    kind: "node" | "document",
  ) => Promise<string | null>;
  /**
   * Extension-safelist + .gitignore filter (critical-review finding
   * "repo-walker-ignore-filtering", plan.md) -- applied here too, not
   * just in repo-walker.ts's startup walk, since file.watcher.updated
   * events reach the indexer directly and would otherwise bypass it.
   * Omit to index every file unconditionally (backward-compatible
   * default, matches this module's original behavior).
   */
  shouldIndexFile?: (relativePath: string) => boolean;
  /** Symbol/import/call graph kept in sync with every batch. Omit to skip graph indexing. */
  graphIndexer?: GraphIndexer;
  /** Writes the L1 summary chunk for files with several chunks; omit to index none. Errors are ignored. */
  summarizeFile?: (input: SummaryInput) => Promise<string | FallbackSummary>;
  /**
   * An LLM writes the summaries. A fallback summary is then flagged in the stored fingerprint
   * (`detsum`) and redone, summary only, on a later pass once the LLM answers.
   */
  summaryLlmConfigured?: boolean;
  /**
   * Cheap change marker ("size:mtime"; null = unknown). A file whose marker equals the stored one
   * is skipped, so a restart or a second session continues where indexing stopped.
   */
  fingerprint?: (relativePath: string) => Promise<string | null>;
  /** Chunks above this size are split before embedding to bound memory (chunk-splitter.ts). */
  maxChunkChars?: number;
  /** Receives per-file outcomes; see index-progress.ts. */
  progress?: IndexProgressReporter;
  /** Files indexed in parallel (default 1); each file's LLM summary and embeddings overlap with the others. */
  fileConcurrency?: number;
  /** Checked before every file; throws MemoryLimitError to stop the batch. */
  memoryGuard?: MemoryGuard;
}

/** Subset of `ProgressTracker` the indexer needs; structural so tests can pass a recorder. */
export interface IndexProgressReporter {
  beginBatch(fileCount: number, reasons?: Partial<Record<IndexReason, number>>): void;
  fileDone(file: string): void;
  fileFailed(file: string, error: unknown): void;
  endBatch(): void;
  /** The whole run was stopped (e.g. memory ceiling), not just one file. */
  abort?(error: unknown): void;
}

/** One-off forced re-indexing (config `reindex_chunks` / `reindex_summaries`); both = everything. */
export interface IndexOptions {
  reindex?: { chunks: boolean; summaries: boolean };
}

export interface IndexResult {
  /** False when the run was aborted or a file failed; a forced re-index is then not finished. */
  complete: boolean;
}

export interface Indexer {
  indexFiles(batch: FileChangeBatchEntry[], options?: IndexOptions): Promise<IndexResult>;
}

/** What of a file is rebuilt: everything, the chunks (keeping the summary) or only the summary. */
type WorkMode = "full" | "chunks" | "summaries";

const FALLBACK_FLAG = "detsum";

function withFlag(fingerprint: string, flag: string): string {
  return `${fingerprint}${fingerprint.includes("#") ? "+" : "#"}${flag}`;
}

function splitFlag(stored: string): { base: string; flagged: boolean } {
  const base = stored.replace(new RegExp(`[#+]${FALLBACK_FLAG}$`), "");
  return { base, flagged: base !== stored };
}

export function createIndexer(deps: IndexerDeps): Indexer {
  const docTreeConfig: DocTreeIndexConfig = deps.docTreeConfig ?? {
    enabled: true,
    extensions: [".md"],
  };

  // Graph problems must never stop chunk indexing.
  async function updateGraph(
    relativePath: string,
    content: string | null,
  ): Promise<void> {
    if (!deps.graphIndexer) return;
    try {
      await deps.graphIndexer.update(relativePath, content);
    } catch {
      // swallowed on purpose: the graph is best-effort, chunks are the primary index
    }
  }

  async function chunkContent(
    relativePath: string,
    content: string,
  ): Promise<{ language: string; chunks: ReturnType<typeof splitOversizedChunks> }> {
    const language = guessLanguage(relativePath);
    // Tier-1 tree-sitter boundary detection (TS/TSX/Java/C#, per ADR-0013
    // and language-grammars.ts) first; `chunkWithTreeSitter` returns
    // `null` for every other extension, a parse failure, or zero
    // top-level declarations found, in which case we fall back to
    // regex-based top-level chunking (tier 2, the 9 languages chunker.py
    // only ever regex-chunks -- Kotlin/JS/JSX/Python/Swift/Go/Rust/Ruby/
    // PHP/C/C++), then the bespoke Vue/SQL/YAML/TOML splitters (tier 3),
    // and finally the paragraph-based chunker -- mirrors chunker.py's own
    // `_chunk_by_treesitter(...) or _chunk_by_pattern(...)` dispatch,
    // less its TS/TSX/Java/C# regex-fallback tier (an intentional,
    // previously-accepted simplification -- see regex-chunker.ts's own
    // doc comment).
    const extension = path.extname(relativePath).toLowerCase();
    const treeSitterChunks = await chunkWithTreeSitter(content, extension);
    // Angular decorator-attachment fix (.ts/.tsx only, chunker.py's
    // `_apply_decorator_fix`) -- a no-op when treeSitterChunks is null,
    // since it only applies to the tree-sitter path's output.
    const decoratorFixed = treeSitterChunks
      ? applyDecoratorFix(treeSitterChunks, content, extension)
      : null;
    const topLevelChunks =
      decoratorFixed ??
      chunkWithRegexPatterns(content, extension) ??
      chunkWithDataFormatSplitter(content, extension, deps.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS) ??
      chunkText(content);
    // Dispatch-table/switch-case sub-chunking (chunker.py's
    // `_apply_dispatch_subchunking`) -- runs over whatever tier produced
    // `topLevelChunks` (tree-sitter or regex), a no-op for extensions
    // without a dispatch-table entry (e.g. paragraph-fallback chunks).
    const chunks = splitOversizedChunks(
      applyDispatchSubchunking(topLevelChunks, extension),
      deps.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS,
    );
    return { language, chunks };
  }

  /** Resolves to true when the file's summary is a fallback although an LLM is configured. */
  async function indexOneFile(
    relativePath: string,
    keepSummary?: { fallback: boolean },
  ): Promise<boolean> {
    const keptSummary = keepSummary
      ? deps.vectorStore.getChunk(`${relativePath}:summary`)
      : null;
    deps.vectorStore.deleteChunksForFile(relativePath);
    deps.docTreeStore?.deleteTree(relativePath);
    if (deps.shouldIndexFile && !deps.shouldIndexFile(relativePath)) {
      await updateGraph(relativePath, null);
      return false; // gitignored/non-safelisted -- nothing more to do
    }

    const content = await deps.readFile(relativePath);
    await updateGraph(relativePath, content);
    if (content === null) return false; // file gone (unlink, or a race with the read) -- nothing more to do

    if (
      deps.docTreeStore &&
      docTreeConfig.extensions.includes(
        path.extname(relativePath).toLowerCase(),
      ) &&
      shouldUseTreeIndex(relativePath, content, docTreeConfig)
    ) {
      // Tree-indexed and normally-chunked are mutually exclusive per
      // file (chunker.py's chunk_file gate) -- store the doc tree and
      // skip vector-store chunking entirely for this file.
      const tree = await buildDocTree(content, {
        summarize: deps.summarize,
        fallbackTitle: relativePath,
      });
      deps.docTreeStore.upsertTree(relativePath, tree);
      return false;
    }

    const { language, chunks } = await chunkContent(relativePath, content);
    // The LLM call is the slow part; run it while the chunks are embedded.
    const summaryText = keptSummary
      ? Promise.resolve(null)
      : startFileSummary(relativePath, language, content, chunks);
    for (const chunk of chunks) {
      const vector = await deps.embedDocument(
        buildEmbedInput({
          relativePath,
          symbol: chunk.symbol,
          text: chunk.text,
        }),
      );
      deps.vectorStore.upsertChunks([
        {
          id: chunkId(relativePath, chunk.startLine, chunk.endLine, chunk.part),
          relativePath,
          language,
          text: chunk.text,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          symbol: chunk.symbol,
          chunkType: chunk.chunkType,
          vector,
        },
      ]);
    }
    if (keptSummary) {
      deps.vectorStore.upsertChunks([keptSummary]);
      return keepSummary!.fallback;
    }
    return indexFileSummary(relativePath, language, chunks, summaryText);
  }

  /** Redoes only the summary chunk of an already indexed code file. */
  async function resummarizeFile(relativePath: string): Promise<boolean> {
    if (deps.shouldIndexFile && !deps.shouldIndexFile(relativePath)) return false;
    const content = await deps.readFile(relativePath);
    if (content === null) return false;
    if (deps.docTreeStore?.getTree(relativePath)) return indexOneFile(relativePath);
    const { language, chunks } = await chunkContent(relativePath, content);
    const pending = startFileSummary(relativePath, language, content, chunks);
    return indexFileSummary(relativePath, language, chunks, pending);
  }

  function startFileSummary(
    relativePath: string,
    language: string,
    content: string,
    chunks: { symbol: string | undefined }[],
  ): Promise<{ text: string; fallback: boolean } | null> {
    if (!deps.summarizeFile || chunks.length < 2) return Promise.resolve(null);
    return deps
      .summarizeFile({
        relativePath,
        language,
        symbols: chunks.map((c) => c.symbol),
        content,
      })
      .then((result) =>
        typeof result === "string"
          ? { text: result, fallback: false }
          : { text: result.text, fallback: true },
      )
      .catch(() => null);
  }

  async function indexFileSummary(
    relativePath: string,
    language: string,
    chunks: { endLine: number }[],
    pending: Promise<{ text: string; fallback: boolean } | null>,
  ): Promise<boolean> {
    try {
      const summary = await pending;
      if (summary === null) return false;
      const { text } = summary;
      const vector = await deps.embedDocument(
        buildEmbedInput({ relativePath, symbol: "(file summary)", text }),
      );
      deps.vectorStore.upsertChunks([
        {
          id: `${relativePath}:summary`,
          relativePath,
          language,
          text,
          startLine: 1,
          endLine: Math.max(...chunks.map((c) => c.endLine)),
          symbol: undefined,
          chunkType: "file-summary",
          vector,
        },
      ]);
      return summary.fallback;
    } catch {
      // a summary is an optional extra; the file's own chunks are already stored
      return false;
    }
  }

  const isDocCandidate = (relativePath: string): boolean =>
    !!deps.docTreeStore &&
    docTreeConfig.enabled &&
    docTreeConfig.extensions.includes(path.extname(relativePath).toLowerCase());

  function stampFingerprint(relativePath: string, fp: string): string {
    if (isDocCandidate(relativePath)) return `${fp}#doc${DOC_INDEX_VERSION}`;
    const parts: string[] = [];
    if (CODE_INDEX_VERSION > 1) parts.push(`code${CODE_INDEX_VERSION}`);
    if (!deps.summarizeFile) parts.push("nosum");
    return parts.length > 0 ? `${fp}#${parts.join("+")}` : fp;
  }

  /** Why an unchanged file's stored index is incomplete or in the old shape; null when healthy. */
  function healingReason(relativePath: string): "repair" | "summaries" | null {
    const hasChunks = deps.vectorStore.getChunkIdsForFile(relativePath).size > 0;
    if (!isDocCandidate(relativePath)) return hasChunks ? null : "repair";
    const tree = deps.docTreeStore!.getTree(relativePath);
    if (!tree) {
      return hasChunks && (docTreeConfig.minHeadingsForTree ?? 0) > 0 ? null : "repair";
    }
    if (hasChunks) return "repair"; // documents are trees only
    const missingSummaries =
      !!deps.summarize && tree.nodeCount > 0 && tree.description === null;
    return missingSummaries ? "summaries" : null;
  }

  interface Work {
    entry: FileChangeBatchEntry;
    reason: IndexReason;
    fingerprint?: string | null;
    mode: WorkMode;
    /** The stored summary was flagged as a fallback (kept when only the chunks are redone). */
    flagged?: boolean;
  }

  /** Decides per file whether it needs work and why; up-to-date files are dropped here. */
  async function classify(
    entry: FileChangeBatchEntry,
    reindex?: IndexOptions["reindex"],
  ): Promise<Work | null> {
    if (entry.event === "unlink") return { entry, reason: "removed", mode: "full" };
    const rawFp = await deps.fingerprint?.(entry.file);
    const fp = rawFp ? stampFingerprint(entry.file, rawFp) : null;
    const stored = fp ? deps.vectorStore.getFileFingerprint(entry.file) : null;
    const { base, flagged } = splitFlag(stored ?? "");
    if (reindex && (reindex.chunks || reindex.summaries)) {
      // Doc trees hold their summaries inside the tree, so they are rebuilt as a whole.
      const mode: WorkMode =
        reindex.chunks && reindex.summaries
          ? "full"
          : reindex.chunks
            ? "chunks"
            : isDocCandidate(entry.file)
              ? "full"
              : "summaries";
      if (stored !== null || !fp) return { entry, reason: "upgrade", fingerprint: fp, mode, flagged };
    }
    if (!fp) return { entry, reason: "changed", mode: "full" };
    if (stored === null) return { entry, reason: "new", fingerprint: fp, mode: "full" };
    if (base === fp) {
      if (flagged && deps.summaryLlmConfigured && deps.summarizeFile)
        return { entry, reason: "summaries", fingerprint: fp, mode: "summaries" };
      const reason = healingReason(entry.file);
      return reason ? { entry, reason, fingerprint: fp, mode: "full", flagged } : null;
    }
    const sameContent = base.split("#")[0] === rawFp;
    return { entry, reason: sameContent ? "upgrade" : "changed", fingerprint: fp, mode: "full" };
  }

  return {
    async indexFiles(allEntries, options = {}) {
      // Only real work is announced (ADR-0027); up-to-date files stay invisible.
      const batch: Work[] = [];
      for (const entry of allEntries) {
        try {
          const work = await classify(entry, options.reindex);
          if (work) batch.push(work);
        } catch (error) {
          batch.push({ entry, reason: "changed", mode: "full" });
          void error;
        }
      }
      const reasons: Partial<Record<IndexReason, number>> = {};
      for (const { reason } of batch) reasons[reason] = (reasons[reason] ?? 0) + 1;
      deps.progress?.beginBatch(batch.length, reasons);
      let next = 0;
      let aborted = false;
      let failures = 0;
      const processEntry = async ({ entry, fingerprint: fp, mode, flagged }: Work) => {
        try {
          await deps.memoryGuard?.ensure();
        } catch (error) {
          if (!aborted) deps.progress?.abort?.(error);
          aborted = true;
          return;
        }
        // One broken file (unreadable, embedder error, ...) must not abort
        // the batch: it is skipped and reported, and the next change event
        // for it (file watcher) or the next startup pass retries it.
        try {
          if (entry.event === "unlink") {
            deps.vectorStore.deleteChunksForFile(entry.file);
            deps.docTreeStore?.deleteTree(entry.file);
            await updateGraph(entry.file, null);
          } else {
            const fallback =
              mode === "summaries"
                ? await resummarizeFile(entry.file)
                : await indexOneFile(
                    entry.file,
                    mode === "chunks" ? { fallback: !!flagged } : undefined,
                  );
            if (fp)
              deps.vectorStore.setFileFingerprint(
                entry.file,
                fallback && deps.summaryLlmConfigured ? withFlag(fp, FALLBACK_FLAG) : fp,
              );
          }
          deps.progress?.fileDone(entry.file);
        } catch (error) {
          failures++;
          deps.progress?.fileFailed(entry.file, error);
        }
      };
      const lane = async () => {
        while (!aborted && next < batch.length) await processEntry(batch[next++]!);
      };
      const lanes = Math.max(1, Math.floor(deps.fileConcurrency ?? 1));
      await Promise.all(Array.from({ length: Math.min(lanes, batch.length) }, lane));
      if (aborted) return { complete: false };
      try {
        deps.graphIndexer?.finishBatch();
      } catch {
        // see updateGraph
      }
      deps.progress?.endBatch();
      return { complete: failures === 0 };
    },
  };
}

/** "size:mtimeMs" of a file under `worktree`, or null if it cannot be read. */
export function createFsFingerprint(worktree: string): (relativePath: string) => Promise<string | null> {
  return async (relativePath) => {
    try {
      const stat = await fs.stat(path.join(worktree, relativePath));
      return `${stat.size}:${Math.floor(stat.mtimeMs)}`;
    } catch {
      return null;
    }
  };
}

export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

/**
 * Real `readFile` implementation: reads relative to `worktree`, returns null if the file is
 * missing/unreadable. Files over `maxBytes` (generated/minified/bundled code) are refused
 * before being read into memory; the indexer reports that as a skipped file.
 */
export function createFsReadFile(
  worktree: string,
  options: { maxBytes?: number } = {},
): (relativePath: string) => Promise<string | null> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  return async (relativePath: string) => {
    const absolute = path.join(worktree, relativePath);
    let size: number;
    try {
      size = (await fs.stat(absolute)).size;
    } catch {
      return null;
    }
    if (size > maxBytes) {
      throw new Error(
        `skipped: file is ${size} bytes, over the limit of max_file_bytes=${maxBytes}`,
      );
    }
    try {
      return await fs.readFile(absolute, "utf8");
    } catch {
      return null;
    }
  };
}
