import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensurePluginGitignore, PLUGIN_GITIGNORE_ENTRIES } from "../../src/config/gitignore-writer.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ai-context-gitignore-"));
const file = (dir: string) => path.join(dir, ".opencode", ".gitignore");

test("ignores the volatile status file and its temp files, not the committable backup", () => {
  assert.ok(PLUGIN_GITIGNORE_ENTRIES.includes("ai-context/index-status.json"));
  assert.ok(PLUGIN_GITIGNORE_ENTRIES.includes("ai-context/index-status.json.*.tmp"));
  // one generic entry covers error.log.md, tool.log.md and the rotated tool.<time>.log.md
  assert.ok(PLUGIN_GITIGNORE_ENTRIES.includes("ai-context/*.log.md"));
  assert.ok(PLUGIN_GITIGNORE_ENTRIES.includes("ai-context/index-tree.md"));
  assert.ok(!PLUGIN_GITIGNORE_ENTRIES.some((e) => e.includes("backup")));
});

test("creates .opencode/.gitignore (and the folder) when missing", () => {
  const dir = tmp();
  assert.equal(ensurePluginGitignore(dir), true);
  const lines = fs.readFileSync(file(dir), "utf8").split("\n");
  for (const entry of PLUGIN_GITIGNORE_ENTRIES) assert.ok(lines.includes(entry), entry);
});

test("appends only missing entries to an existing file and keeps the user's lines", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, ".opencode"));
  fs.writeFileSync(file(dir), "my-private/\nai-context/index-status.json");
  assert.equal(ensurePluginGitignore(dir), true);
  const content = fs.readFileSync(file(dir), "utf8");
  assert.match(content, /^my-private\/\n/);
  assert.equal(content.split("\n").filter((l) => l === "ai-context/index-status.json").length, 1);
  assert.ok(content.includes("ai-context/index-status.json.*.tmp"));
});

test("is idempotent", () => {
  const dir = tmp();
  ensurePluginGitignore(dir);
  const before = fs.readFileSync(file(dir), "utf8");
  assert.equal(ensurePluginGitignore(dir), false);
  assert.equal(fs.readFileSync(file(dir), "utf8"), before);
});

test("does nothing for a missing worktree and reports write errors via onError", () => {
  assert.equal(ensurePluginGitignore("/definitely/not/here"), false);
  const dir = tmp();
  fs.writeFileSync(path.join(dir, ".opencode"), "a file");
  const errors: unknown[] = [];
  assert.equal(ensurePluginGitignore(dir, (e) => void errors.push(e)), false);
  assert.equal(errors.length, 1);
});
