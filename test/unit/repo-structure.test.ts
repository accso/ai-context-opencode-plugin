import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRepoStructure } from "../../src/search/repo-structure.js";
import { createRepoStructureTool } from "../../src/tools/repo-structure.js";

const f = (relativePath: string, language = "typescript", chunkCount = 1) => ({ relativePath, language, chunkCount });

const FILES = [
  f("README.md", "markdown"),
  f("src/index.ts"),
  f("src/util/a.ts"),
  f("src/util/b.ts"),
  f("src/util/deep/c.ts"),
  f("test/a.test.ts"),
];

test("buildRepoStructure lists directories first, then files, with file counts", () => {
  const r = buildRepoStructure(FILES, { depth: 1 });
  assert.deepEqual(
    r.entries.map((e) => [e.path, e.type, e.files]),
    [
      ["src", "dir", 4],
      ["test", "dir", 1],
      ["README.md", "file", undefined],
    ],
  );
});

test("buildRepoStructure expands to the requested depth", () => {
  const r = buildRepoStructure(FILES, { depth: 2 });
  assert.ok(r.entries.some((e) => e.path === "src/util" && e.type === "dir" && e.files === 3));
  assert.ok(r.entries.some((e) => e.path === "src/index.ts" && e.type === "file"));
  assert.ok(!r.entries.some((e) => e.path === "src/util/a.ts"));
});

test("buildRepoStructure scopes to dirPath and reports languages per directory", () => {
  const r = buildRepoStructure(FILES, { dirPath: "src/util", depth: 1 });
  assert.deepEqual(r.entries.map((e) => e.path), ["src/util/deep", "src/util/a.ts", "src/util/b.ts"]);
  const all = buildRepoStructure(FILES, { depth: 1 });
  assert.deepEqual(all.entries.find((e) => e.path === "src")!.languages, ["typescript"]);
});

test("buildRepoStructure normalises dirPath and reports an unknown directory", () => {
  assert.equal(buildRepoStructure(FILES, { dirPath: "./src/", depth: 1 }).entries.length, 2);
  const r = buildRepoStructure(FILES, { dirPath: "nope", depth: 1 });
  assert.deepEqual(r.entries, []);
  assert.equal(r.found, false);
});

test("buildRepoStructure truncates to maxEntries and says how many were omitted", () => {
  const r = buildRepoStructure(FILES, { depth: 2, maxEntries: 2 });
  assert.equal(r.entries.length, 2);
  assert.ok(r.omitted > 0);
});

test("repo_structure tool returns JSON, appends the indexing notice and can target another project", async () => {
  const other = { key: "other-1", store: { listFiles: () => [f("lib/x.ts")] } };
  const t = createRepoStructureTool({
    listFiles: () => FILES,
    crossRepoStores: [other as never],
    getIndexingNotice: () => "indexing 10%",
  });
  const own = JSON.parse((await t.execute({}, {} as never)) as string);
  assert.equal(own.entries[0].path, "src");
  assert.equal(own.indexingNotice, "indexing 10%");
  const cross = JSON.parse((await t.execute({ project: "other-1" }, {} as never)) as string);
  assert.equal(cross.entries[0].path, "lib");
  const unknown = JSON.parse((await t.execute({ project: "zzz" }, {} as never)) as string);
  assert.match(unknown.error, /zzz/);
});

import { withDocFiles } from "../../src/tools/repo-structure.js";

test("withDocFiles adds tree-indexed markdown that has no chunks and does not duplicate known files", () => {
  const files = withDocFiles([f("src/a.ts")], ["docs/business/cases/x.md", "src/a.ts"]);
  assert.deepEqual(files.map((x) => x.relativePath), ["src/a.ts", "docs/business/cases/x.md"]);
  assert.equal(files[1]!.language, "markdown");
});

test("repo_structure lists docs from the doc-tree store, also for a docs-only directory", async () => {
  const def = createRepoStructureTool({
    listFiles: () => [f("src/a.ts")],
    listDocPaths: () => ["docs/business/cases/a.md", "docs/business/cases/b.md"],
  });
  const out = JSON.parse((await def.execute({ dir_path: "docs/business/cases" }, {} as never)) as string);
  assert.equal(out.found, true);
  assert.deepEqual(out.entries.map((e: { path: string }) => e.path), ["docs/business/cases/a.md", "docs/business/cases/b.md"]);
});
