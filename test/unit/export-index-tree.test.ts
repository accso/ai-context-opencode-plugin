import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createExportIndexTreeTool, readGitInfo, renderIndexTree, writeIndexTree } from "../../src/tools/export-index-tree.js";

const files = [
  { relativePath: "README.md", language: "markdown", chunkCount: 2 },
  { relativePath: "src/a.ts", language: "typescript", chunkCount: 3 },
  { relativePath: "src/util/b.ts", language: "typescript", chunkCount: 1 },
];
const meta = {
  repoName: "demo",
  repoPath: "/w/demo",
  branch: "main",
  commit: "abc1234",
  exportedAt: "2026-10-12T10:00:00.000Z",
  newestIndexedAt: "2026-10-12T09:00:00.000Z",
  chunkCount: 6,
  skipped: ["big.js: skipped: file is 5000000 bytes"],
};

test("renderIndexTree has metadata header, nested tree and skipped list", () => {
  const md = renderIndexTree(files, meta);
  assert.match(md, /^# Indexed files/m);
  assert.match(md, /Repository: demo/);
  assert.match(md, /Branch: main \(abc1234\)/);
  assert.match(md, /Exported: 2026-10-12T10:00:00.000Z/);
  assert.match(md, /Index last updated: 2026-10-12T09:00:00.000Z/);
  assert.match(md, /Files: 3 · Chunks: 6/);
  assert.match(md, /^- src\/$/m);
  assert.match(md, /^  - util\/$/m);
  assert.match(md, /^    - b\.ts \(typescript, 1 chunk\)$/m);
  assert.match(md, /^  - a\.ts \(typescript, 3 chunks\)$/m);
  assert.match(md, /## Not indexed[\s\S]*big\.js/);
});

test("readGitInfo reads branch and commit, falls back to unknown outside git", () => {
  const dir = mkdtempSync(join(tmpdir(), "tree-git-"));
  assert.deepEqual(readGitInfo(dir), { branch: "unknown", commit: "unknown" });
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir });
  git("init", "-b", "feat");
  git("commit", "--allow-empty", "-m", "x");
  const info = readGitInfo(dir);
  assert.equal(info.branch, "feat");
  assert.match(info.commit, /^[0-9a-f]{7,}$/);
});

test("writeIndexTree writes the file and the tool returns path and count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tree-out-"));
  const filePath = join(dir, "ai-context", "index-tree.md");
  const deps = {
    filePath,
    worktree: "/w/demo",
    listFiles: () => files,
    getIndexStatus: () => ({ fileCount: 3, chunkCount: 6, newestIndexedAt: meta.newestIndexedAt }),
    getSkipped: () => [],
    gitInfo: () => ({ branch: "main", commit: "abc1234" }),
    now: () => new Date(meta.exportedAt),
  };
  writeIndexTree(deps);
  assert.match(readFileSync(filePath, "utf8"), /Repository: demo/);
  const out = await createExportIndexTreeTool(deps).execute({}, {} as never);
  assert.match(String(out), /index-tree\.md/);
  assert.match(String(out), /3 files/);
});
