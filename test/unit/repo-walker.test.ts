import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { walkRepoFiles } from "../../src/indexing/repo-walker.js";

/**
 * Unit tests for the startup reconciliation file-walker: enumerates
 * every indexable file under a worktree, skipping common
 * non-source/vendor/VCS directories (and this plugin's own metadata
 * dirs) so a full re-scan doesn't try to index node_modules, .git
 * history, or its own local vector-store/backup files.
 */

async function makeTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-context-repo-walker-"));
  return dir;
}

test("walkRepoFiles returns relative paths for regular files, recursing into subdirectories", async () => {
  const dir = await makeTempRepo();
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "a.ts"), "a");
  await fs.writeFile(path.join(dir, "README.md"), "b");

  const files = (await walkRepoFiles(dir)).sort();
  assert.deepEqual(files, ["README.md", "src/a.ts"]);
});

test("walkRepoFiles skips node_modules, .git, and other common vendor/VCS directories", async () => {
  const dir = await makeTempRepo();
  await fs.mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(dir, "node_modules", "pkg", "index.js"), "x");
  await fs.mkdir(path.join(dir, ".git"), { recursive: true });
  await fs.writeFile(path.join(dir, ".git", "HEAD"), "x");
  await fs.writeFile(path.join(dir, "kept.ts"), "x");

  const files = await walkRepoFiles(dir);
  assert.deepEqual(files, ["kept.ts"]);
});

test("walkRepoFiles skips the plugin's own .opencode/ai-context metadata directory", async () => {
  const dir = await makeTempRepo();
  await fs.mkdir(path.join(dir, ".opencode", "ai-context", "backup"), { recursive: true });
  await fs.writeFile(path.join(dir, ".opencode", "ai-context", "backup", "index.jsonl"), "x");
  await fs.writeFile(path.join(dir, "kept.ts"), "x");

  const files = await walkRepoFiles(dir);
  assert.deepEqual(files, ["kept.ts"]);
});

test("walkRepoFiles skips files with non-safelisted extensions (binary-detection substitute, critical-review finding)", async () => {
  const dir = await makeTempRepo();
  await fs.writeFile(path.join(dir, "logo.png"), "binary-ish");
  await fs.writeFile(path.join(dir, "kept.ts"), "x");

  const files = await walkRepoFiles(dir);
  assert.deepEqual(files, ["kept.ts"]);
});

test("walkRepoFiles respects the worktree's .gitignore (critical-review finding)", async () => {
  const dir = await makeTempRepo();
  await fs.writeFile(path.join(dir, ".gitignore"), "generated/\nsecrets.env\n");
  await fs.mkdir(path.join(dir, "generated"), { recursive: true });
  await fs.writeFile(path.join(dir, "generated", "out.ts"), "x");
  await fs.writeFile(path.join(dir, "secrets.env"), "SECRET=1");
  await fs.writeFile(path.join(dir, "kept.ts"), "x");

  const files = await walkRepoFiles(dir);
  assert.deepEqual(files, ["kept.ts"]);
});


test("walkRepoFiles skips excluded directories without descending into them", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-context-walker-exclude-"));
  await fs.mkdir(path.join(dir, "legacy/deep"), { recursive: true });
  await fs.mkdir(path.join(dir, "src"));
  await fs.writeFile(path.join(dir, "legacy/deep/a.ts"), "x");
  await fs.writeFile(path.join(dir, "src/b.ts"), "x");
  await fs.writeFile(path.join(dir, "src/c.generated.ts"), "x");
  const files = (await walkRepoFiles(dir, { exclude: ["legacy/", "*.generated.ts"] })).sort();
  assert.deepEqual(files, ["src/b.ts"]);
});
