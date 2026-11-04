import path from "node:path";
import type { RawImport } from "./import-extractor.js";

/**
 * Resolves raw imports to repo-relative files using only the set of known
 * repo files (no filesystem access, no build-tool config). That keeps it
 * deterministic and testable, but also bounds what it can see: tsconfig
 * `paths`, Gradle/Maven source roots, Cargo workspaces and Go module
 * names are not read. Unresolvable imports (third-party, stdlib, aliased)
 * return `[]` and are stored as external edges.
 */
export interface ImportResolver {
  /** Repo-relative files `imp` (written in `fromPath`) refers to; `[]` when external or unknown. */
  resolve(imp: RawImport, fromPath: string, language: string): string[];
}

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"];
const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};
const MAX_DIRECTORY_FANOUT = 100;

const posix = path.posix;

function commonDirDepth(a: string, b: string): number {
  const as = posix.dirname(a).split("/");
  const bs = posix.dirname(b).split("/");
  let i = 0;
  while (i < as.length && i < bs.length && as[i] === bs[i]) i++;
  return i;
}

export function createImportResolver(files: Iterable<string>): ImportResolver {
  const fileSet = new Set(files);
  const byBase = new Map<string, string[]>();
  const byDir = new Map<string, string[]>();
  for (const f of fileSet) {
    const base = posix.basename(f);
    (byBase.get(base) ?? byBase.set(base, []).get(base)!).push(f);
    const dir = posix.dirname(f);
    (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(f);
  }
  for (const list of byDir.values()) list.sort();

  const closest = (candidates: string[], from: string): string | undefined =>
    [...candidates].sort(
      (a, b) =>
        commonDirDepth(b, from) - commonDirDepth(a, from) || a.split("/").length - b.split("/").length || a.localeCompare(b),
    )[0];

  /** Files whose path is `suffix` or ends with `/suffix`. */
  const bySuffix = (suffix: string): string[] =>
    (byBase.get(posix.basename(suffix)) ?? []).filter((f) => f === suffix || f.endsWith("/" + suffix));

  const closestBySuffix = (suffix: string, from: string): string[] => {
    const hit = closest(bySuffix(suffix), from);
    return hit ? [hit] : [];
  };

  /** Direct children of every directory equal to / ending with `suffix` that match `extensions`. */
  const filesInDirsEndingWith = (suffix: string, extensions: string[], exclude?: (f: string) => boolean): string[] => {
    const out: string[] = [];
    for (const [dir, list] of byDir) {
      if (dir === suffix || dir.endsWith("/" + suffix)) {
        for (const f of list) if (extensions.some((e) => f.endsWith(e)) && !exclude?.(f)) out.push(f);
      }
    }
    return out.sort().slice(0, MAX_DIRECTORY_FANOUT);
  };

  /** Longest-first directory-suffix match: `A.B.C` tries `A/B/C`, then `B/C`, then `C`. */
  const directoryByLongestSuffix = (segments: string[], extensions: string[], exclude?: (f: string) => boolean): string[] => {
    for (let k = 0; k < segments.length; k++) {
      const hit = filesInDirsEndingWith(segments.slice(k).join("/"), extensions, exclude);
      if (hit.length > 0) return hit;
    }
    return [];
  };

  function resolveEcmaScript(imp: RawImport, from: string): string[] {
    if (!imp.specifier.startsWith(".")) return [];
    const base = posix.normalize(posix.join(posix.dirname(from), imp.specifier));
    if (base.startsWith("..")) return [];
    const ext = posix.extname(base);
    const candidates = [
      base,
      ...(JS_TO_TS[ext] ?? []).map((e) => base.slice(0, -ext.length) + e),
      ...TS_EXTENSIONS.map((e) => base + e),
      ...TS_EXTENSIONS.map((e) => `${base}/index${e}`),
    ];
    const hit = candidates.find((c) => fileSet.has(c));
    return hit ? [hit] : [];
  }

  function resolvePython(imp: RawImport, from: string): string[] {
    const dots = /^\.*/.exec(imp.specifier)![0].length;
    const segments = imp.specifier.slice(dots).split(".").filter(Boolean);
    const names = (imp.importedNames ?? []).filter((n) => n !== "*");
    const out: string[] = [];

    if (dots > 0) {
      let dir = posix.dirname(from);
      for (let i = 1; i < dots && dir !== "."; i++) dir = posix.dirname(dir);
      const base = [dir === "." ? "" : dir, ...segments].filter(Boolean).join("/");
      const pick = (b: string) => (b === "" ? undefined : [`${b}.py`, `${b}/__init__.py`].find((c) => fileSet.has(c)));
      const self = segments.length === 0 ? [`${base}/__init__.py`, "__init__.py"].find((c) => fileSet.has(c)) : pick(base);
      if (self) out.push(self);
      for (const n of names) {
        const sub = pick(base ? `${base}/${n}` : n);
        if (sub) out.push(sub);
      }
      return [...new Set(out)];
    }

    const resolveModule = (segs: string[]): string | undefined => {
      const joined = segs.join("/");
      return closest([...bySuffix(`${joined}.py`), ...bySuffix(`${joined}/__init__.py`)], from);
    };
    const moduleFile = resolveModule(segments);
    if (moduleFile) out.push(moduleFile);
    for (const n of names) {
      const sub = resolveModule([...segments, n]);
      if (sub) out.push(sub);
    }
    return [...new Set(out)];
  }

  function resolveJvm(imp: RawImport, from: string, language: string): string[] {
    const extensions = language === "java" ? [".java", ".kt"] : [".kt", ".java"];
    const segments = imp.specifier.split(".");
    if (imp.importedNames?.includes("*")) {
      return filesInDirsEndingWith(segments.join("/"), [extensions[0]!]);
    }
    for (let len = segments.length; len >= Math.max(1, segments.length - 3); len--) {
      const stem = segments.slice(0, len).join("/");
      for (const ext of extensions) {
        const hit = closestBySuffix(stem + ext, from);
        if (hit.length > 0) return hit;
      }
    }
    return [];
  }

  function rustModuleDir(from: string): string {
    const stem = posix.basename(from, ".rs");
    const dir = posix.dirname(from);
    const base = ["mod", "lib", "main"].includes(stem) ? dir : posix.join(dir, stem);
    return base === "." ? "" : base;
  }

  function rustCrateRoot(from: string): string {
    const segs = posix.dirname(from).split("/");
    const idx = segs.lastIndexOf("src");
    return idx >= 0 ? segs.slice(0, idx + 1).join("/") : "";
  }

  const rustModuleFile = (base: string): string | undefined =>
    [`${base}.rs`, `${base}/mod.rs`].find((c) => fileSet.has(c));

  function resolveRust(imp: RawImport, from: string): string[] {
    const moduleDir = rustModuleDir(from);
    if (imp.kind === "mod") {
      const hit = rustModuleFile(posix.join(moduleDir, imp.specifier));
      return hit ? [hit] : [];
    }
    const segs = imp.specifier.split("::");
    const crateRoot = rustCrateRoot(from);
    let root: string;
    let rest: string[];
    if (segs[0] === "crate") {
      root = crateRoot;
      rest = segs.slice(1);
    } else if (segs[0] === "self") {
      root = moduleDir;
      rest = segs.slice(1);
    } else if (segs[0] === "super") {
      root = moduleDir;
      let i = 0;
      while (segs[i] === "super") {
        root = posix.dirname(root) === "." ? "" : posix.dirname(root);
        i++;
      }
      rest = segs.slice(i);
    } else {
      root = moduleDir;
      rest = segs;
    }
    for (let len = rest.length; len >= 1; len--) {
      const hit = rustModuleFile(posix.join(root, ...rest.slice(0, len)));
      if (hit) return [hit];
    }
    if (segs[0] === "crate") {
      const entry = ["lib.rs", "main.rs"].map((f) => posix.join(crateRoot, f)).find((c) => fileSet.has(c));
      if (entry) return [entry];
    }
    return [];
  }

  function resolveC(imp: RawImport, from: string): string[] {
    if (imp.kind !== "system") {
      const relative = posix.normalize(posix.join(posix.dirname(from), imp.specifier));
      if (fileSet.has(relative)) return [relative];
    }
    return closestBySuffix(imp.specifier, from);
  }

  function resolveRuby(imp: RawImport, from: string): string[] {
    const withExt = imp.specifier.endsWith(".rb") ? imp.specifier : `${imp.specifier}.rb`;
    if (imp.kind === "relative") {
      const target = posix.normalize(posix.join(posix.dirname(from), withExt));
      return fileSet.has(target) ? [target] : [];
    }
    return closestBySuffix(withExt, from);
  }

  return {
    resolve(imp, from, language) {
      switch (language) {
        case "typescript":
        case "javascript":
          return resolveEcmaScript(imp, from);
        case "python":
          return resolvePython(imp, from);
        case "java":
        case "kotlin":
          return resolveJvm(imp, from, language);
        case "csharp":
          return directoryByLongestSuffix(imp.specifier.split("."), [".cs"]);
        case "go":
          return directoryByLongestSuffix(imp.specifier.split("/"), [".go"], (f) => f.endsWith("_test.go"));
        case "rust":
          return resolveRust(imp, from);
        case "c":
        case "cpp":
          return resolveC(imp, from);
        case "ruby":
          return resolveRuby(imp, from);
        default:
          return [];
      }
    },
  };
}
