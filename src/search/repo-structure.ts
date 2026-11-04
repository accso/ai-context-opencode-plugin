import type { IndexedFile } from "../storage/vector-store.js";

export interface StructureEntry {
  path: string;
  type: "dir" | "file";
  /** Directories: number of indexed files below. */
  files?: number;
  /** Directories: languages found below, most frequent first. */
  languages?: string[];
  /** Files: language of the file. */
  language?: string;
}

export interface RepoStructure {
  dirPath: string;
  found: boolean;
  entries: StructureEntry[];
  omitted: number;
}

export interface RepoStructureOptions {
  dirPath?: string;
  depth?: number;
  maxEntries?: number;
}

export const DEFAULT_DEPTH = 2;
export const DEFAULT_MAX_ENTRIES = 200;

function normalizeDir(dirPath: string | undefined): string {
  return (dirPath ?? "")
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/^\.$/, "");
}

function topLanguages(counts: Map<string, number>): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([l]) => l);
}

/**
 * Pure directory-tree view over the indexed files: directories first (with
 * file count and languages), then files, `depth` levels below `dirPath`.
 */
export function buildRepoStructure(
  files: IndexedFile[],
  options: RepoStructureOptions = {},
): RepoStructure {
  const dirPath = normalizeDir(options.dirPath);
  const depth = Math.max(1, options.depth ?? DEFAULT_DEPTH);
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const prefix = dirPath === "" ? "" : `${dirPath}/`;

  const dirs = new Map<string, { files: number; langs: Map<string, number> }>();
  const fileEntries: StructureEntry[] = [];
  let found = dirPath === "";

  for (const file of files) {
    if (!file.relativePath.startsWith(prefix)) continue;
    found = true;
    const segments = file.relativePath.slice(prefix.length).split("/");
    for (let level = 1; level < segments.length && level <= depth; level++) {
      const dir = prefix + segments.slice(0, level).join("/");
      const info = dirs.get(dir) ?? { files: 0, langs: new Map() };
      info.files += 1;
      info.langs.set(file.language, (info.langs.get(file.language) ?? 0) + 1);
      dirs.set(dir, info);
    }
    if (segments.length <= depth) {
      fileEntries.push({
        path: file.relativePath,
        type: "file",
        language: file.language,
      });
    }
  }

  const dirEntries: StructureEntry[] = [...dirs.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([path, info]) => ({
      path,
      type: "dir",
      files: info.files,
      languages: topLanguages(info.langs),
    }));

  const all = [
    ...dirEntries,
    ...fileEntries.sort((a, b) => a.path.localeCompare(b.path)),
  ];
  return {
    dirPath,
    found,
    entries: all.slice(0, maxEntries),
    omitted: Math.max(0, all.length - maxEntries),
  };
}
