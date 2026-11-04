import type { GraphStore } from "../storage/graph-store.js";

const TEST_PATH =
  /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]*$|_test\.[a-z]+$|[a-z0-9](Test|Tests|Spec)\.[a-z]+$/;

export function isTestPath(relativePath: string): boolean {
  return TEST_PATH.test(relativePath);
}

/** Test files that import one of `paths` or call one of `names`, sorted, capped at `limit`. */
export function findTestFiles(
  graphStore: GraphStore,
  paths: string[],
  names: string[],
  limit = 10,
): string[] {
  const found = new Set<string>();
  for (const name of new Set(names)) {
    for (const file of graphStore.findCallerFiles([name])) if (isTestPath(file)) found.add(file);
  }
  for (const p of new Set(paths)) {
    for (const dep of graphStore.importDependents(p, 1)) if (isTestPath(dep.relativePath)) found.add(dep.relativePath);
  }
  return [...found].sort().slice(0, limit);
}
