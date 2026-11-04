import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isIndexableExtension, createIgnoreMatcher, loadGitignoreSync, createFileFilter } from "../../src/indexing/file-filter.js";

/**
 * Unit tests for the file-filter module (critical-review finding
 * "repo-walker-ignore-filtering", plan.md): ports config.yaml's
 * include_extensions safelist (the original's binary-detection
 * mechanism) and watcher/indexer.py's .gitignore-based exclusion,
 * neither of which repo-walker.ts had before this todo.
 */

test("isIndexableExtension accepts safelisted code/config/doc extensions", () => {
  for (const p of ["src/a.ts", "src/a.tsx", "main.py", "lib.rs", "README.md", "config.yaml", "schema.sql", "styles.css"]) {
    assert.ok(isIndexableExtension(p), `expected ${p} to be indexable`);
  }
});

test("isIndexableExtension accepts extensionless safelisted filenames like Dockerfile", () => {
  assert.ok(isIndexableExtension("Dockerfile"));
  assert.ok(isIndexableExtension("services/api/Dockerfile"));
});

test("isIndexableExtension rejects binaries and other non-safelisted extensions", () => {
  for (const p of ["logo.png", "archive.zip", "app.exe", "data.bin", "notes.docx", "photo.jpg"]) {
    assert.equal(isIndexableExtension(p), false, `expected ${p} to be rejected`);
  }
});

test("isIndexableExtension rejects files with no extension and an unrecognized name", () => {
  assert.equal(isIndexableExtension("LICENSE"), false);
  assert.equal(isIndexableExtension("Makefile"), false);
});

test("createIgnoreMatcher matches standard gitignore patterns, including negation", () => {
  const matcher = createIgnoreMatcher(["dist/", "*.log", "!important.log"].join("\n"));
  assert.equal(matcher.isIgnored("dist/bundle.js"), true);
  assert.equal(matcher.isIgnored("debug.log"), true);
  assert.equal(matcher.isIgnored("important.log"), false);
  assert.equal(matcher.isIgnored("src/index.ts"), false);
});

test("createIgnoreMatcher with null content ignores nothing", () => {
  const matcher = createIgnoreMatcher(null);
  assert.equal(matcher.isIgnored("anything.ts"), false);
});

test("loadGitignoreSync reads a worktree's .gitignore file if present", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-context-file-filter-"));
  await fs.writeFile(path.join(dir, ".gitignore"), "dist/\n");
  assert.equal(loadGitignoreSync(dir), "dist/\n");
});

test("loadGitignoreSync returns null when no .gitignore exists", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-context-file-filter-"));
  assert.equal(loadGitignoreSync(dir), null);
});

test("createFileFilter never indexes this plugin's own metadata under .opencode/ai-context/", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-context-file-filter-"));
  const shouldIndex = createFileFilter(dir);
  // index-status.json is rewritten constantly while indexing; indexing it would feed back into file.watcher.updated
  assert.equal(shouldIndex(".opencode/ai-context/index-status.json"), false);
  assert.equal(shouldIndex(".opencode/ai-context/config/allowed-repos.json"), false);
  assert.equal(shouldIndex(".opencode/ai-context/backup/index.jsonl"), false);
  assert.equal(shouldIndex(".opencode/skills/index-status/SKILL.md"), false); // plugin-provided skill
  assert.equal(shouldIndex("src/a.ts"), true);
  assert.equal(shouldIndex(".opencode/ai-context.config.yaml"), true);
});

test("createFileFilter applies extra exclude patterns (gitignore syntax) on top of .gitignore", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-context-file-filter-"));
  await fs.writeFile(path.join(dir, ".gitignore"), "dist/\n");
  const shouldIndex = createFileFilter(dir, { exclude: ["legacy/", "**/*.generated.ts", "!keep.generated.ts"] });
  assert.equal(shouldIndex("legacy/a.ts"), false);
  assert.equal(shouldIndex("src/api.generated.ts"), false);
  assert.equal(shouldIndex("dist/a.ts"), false); // still honours .gitignore
  assert.equal(shouldIndex("src/a.ts"), true);
});
