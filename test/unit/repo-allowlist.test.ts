import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAllowlist, addAllowedRepo } from "../../src/storage/repo-allowlist.js";

/**
 * Unit tests for the cross-repo search allow-list (plan.md,
 * "cross-repo-allowlist", user-directed 2026-09-15): "soften the walls
 * between repos ... a allow list for the repo, which other repo it
 * could see by calling the search". Config lives at
 * the `allowed_repos` key of `.opencode/ai-context.config.yaml` inside the
 * worktree -- deliberately explicit opt-in per repo, not a default,
 * since `multi-repo-isolation` made "one repo's search can never see
 * another repo's data" the default behavior on purpose.
 */

function tmpWorktree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-context-allowlist-test-"));
}

test("readAllowlist returns an empty array when no config file exists yet", () => {
  const worktree = tmpWorktree();
  assert.deepEqual(readAllowlist(worktree), []);
  fs.rmSync(worktree, { recursive: true, force: true });
});

test("addAllowedRepo appends a key and readAllowlist reflects it afterwards", () => {
  const worktree = tmpWorktree();
  const result = addAllowedRepo(worktree, "libfoo");
  assert.deepEqual(result, { added: true, keys: ["libfoo"] });
  assert.deepEqual(readAllowlist(worktree), ["libfoo"]);
  fs.rmSync(worktree, { recursive: true, force: true });
});

test("addAllowedRepo is idempotent -- adding the same key twice doesn't duplicate it", () => {
  const worktree = tmpWorktree();
  addAllowedRepo(worktree, "libfoo");
  const result = addAllowedRepo(worktree, "libfoo");
  assert.deepEqual(result, { added: false, keys: ["libfoo"] });
  assert.deepEqual(readAllowlist(worktree), ["libfoo"]);
  fs.rmSync(worktree, { recursive: true, force: true });
});

test("addAllowedRepo keeps the keys list sorted for stable, git-diff-friendly output", () => {
  const worktree = tmpWorktree();
  addAllowedRepo(worktree, "zeta");
  addAllowedRepo(worktree, "alpha");
  assert.deepEqual(readAllowlist(worktree), ["alpha", "zeta"]);
  fs.rmSync(worktree, { recursive: true, force: true });
});

test("readAllowlist normalizes entries that still carry the hash suffix to the stable name", () => {
  const worktree = tmpWorktree();
  const file = path.join(worktree, ".opencode", "ai-context.config.yaml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "allowed_repos:\n  - libfoo-abc12345\n  - libfoo\n  - zeta\n");
  assert.deepEqual(readAllowlist(worktree), ["libfoo", "zeta"]);
  fs.rmSync(worktree, { recursive: true, force: true });
});

test("addAllowedRepo keeps comments and other keys of the config file", () => {
  const worktree = tmpWorktree();
  const file = path.join(worktree, ".opencode", "ai-context.config.yaml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "# my comment\nenabled: true\nembed_threads: 2 # keep\n");
  addAllowedRepo(worktree, "libfoo");
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /# my comment/);
  assert.match(text, /embed_threads: 2 # keep/);
  assert.match(text, /allowed_repos:\n\s*- libfoo/);
  assert.deepEqual(readAllowlist(worktree), ["libfoo"]);
  fs.rmSync(worktree, { recursive: true, force: true });
});

test("readAllowlist imports the legacy JSON file into the YAML and removes it", () => {
  const worktree = tmpWorktree();
  const legacy = path.join(worktree, ".opencode", "ai-context", "config", "allowed-repos.json");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify(["libfoo-abc12345", "zeta"]));
  assert.deepEqual(readAllowlist(worktree), ["libfoo", "zeta"]);
  assert.equal(fs.existsSync(legacy), false);
  assert.deepEqual(readAllowlist(worktree), ["libfoo", "zeta"]);
  fs.rmSync(worktree, { recursive: true, force: true });
});
