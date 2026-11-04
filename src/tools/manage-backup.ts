import path from "node:path";
import { tool } from "./tool-def.js";
import type { VectorStore } from "../storage/vector-store.js";
import type { DocTreeStore } from "../storage/doc-tree-store.js";
import type { GraphStore } from "../storage/graph-store.js";
import {
  exportBackup as exportBackupDefault,
  shardFiles,
  exportDocTreeBackup as exportDocTreeBackupDefault,
  exportGraphBackup as exportGraphBackupDefault,
} from "../storage/backup.js";

/**
 * Native tool that exports the current project's vector store (and,
 * when a docTreeStore is injected, its PageIndex-style Markdown doc
 * trees too -- critical-review finding "doc-tree-backup", plan.md) to
 * the repo-local, versionable backup files. Deliberately a manual/
 * on-demand tool rather than something run after every indexing event
 * -- writing these files (and, per the user's intent, committing them)
 * is a deliberate "share the index with the team" action, not a
 * background side effect.
 */

export interface ExportBackupDeps {
  vectorStore: VectorStore;
  backupFilePath: string;
  /** Injectable for tests; defaults to the real backup.ts implementation. */
  exportBackup?: (store: VectorStore, filePath: string) => { count: number };
  /** Omit to skip doc-tree backup export entirely (e.g. no docTreeStore wired). */
  docTreeStore?: DocTreeStore;
  docTreeBackupFilePath?: string;
  /** Injectable for tests; defaults to the real backup.ts implementation. */
  exportDocTreeBackup?: (
    store: DocTreeStore,
    filePath: string,
  ) => { count: number };
  /** Omit to skip graph backup export entirely. */
  graphStore?: GraphStore;
  graphBackupFilePath?: string;
  /** Injectable for tests; defaults to the real backup.ts implementation. */
  exportGraphBackup?: (
    store: GraphStore,
    filePath: string,
  ) => { count: number };
}

export function createExportBackupTool(deps: ExportBackupDeps) {
  const exportBackup = deps.exportBackup ?? exportBackupDefault;
  const exportDocTreeBackup =
    deps.exportDocTreeBackup ?? exportDocTreeBackupDefault;
  const exportGraphBackup = deps.exportGraphBackup ?? exportGraphBackupDefault;
  return tool({
    description: [
      "Create the ai context backup: use it whenever the user asks to create,",
      "make, save or export a backup of the index (or to share it with the team).",
      "Exports this repository's indexed code chunks (and tree-indexed",
      "Markdown docs and the symbol/call graph, if any) to versionable backup files under",
      ".opencode/ai-context/backup/ inside the repo. Commit those files",
      "so teammates get the index on clone/pull instead of re-indexing",
      "the whole repository themselves. Re-run this after indexing has",
      "meaningfully changed and before committing. The response lists the shard files written (index-NNNN.jsonl).",
    ].join(" "),
    args: {},
    async execute() {
      const result = exportBackup(deps.vectorStore, deps.backupFilePath);
      const response: Record<string, unknown> = {
        ...result,
        // Shard names, so the agent reports what is really on disk.
        files: shardFiles(deps.backupFilePath).map((f) => path.basename(f)),
      };
      if (deps.docTreeStore && deps.docTreeBackupFilePath) {
        const docTreeResult = exportDocTreeBackup(
          deps.docTreeStore,
          deps.docTreeBackupFilePath,
        );
        response.docTreeCount = docTreeResult.count;
        response.docTreePath = deps.docTreeBackupFilePath;
      }
      if (deps.graphStore && deps.graphBackupFilePath) {
        const graphResult = exportGraphBackup(
          deps.graphStore,
          deps.graphBackupFilePath,
        );
        response.graphCount = graphResult.count;
        response.graphPath = deps.graphBackupFilePath;
      }
      return JSON.stringify(response);
    },
  });
}
