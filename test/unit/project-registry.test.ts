import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { deriveProjectKey } from "../../src/storage/project-key.js";
import { listProjects, deleteProject } from "../../src/storage/project-registry.js";

function tmpDataDir(): string {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/ai-context-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function seedProject(dataDir: string, worktree: string, bytes = 100): ReturnType<typeof deriveProjectKey> {
  const result = deriveProjectKey(worktree, { dataDir });
  fs.mkdirSync(path.dirname(result.dbPath), { recursive: true });
  fs.writeFileSync(result.dbPath, Buffer.alloc(bytes));
  return result;
}

test("listProjects returns an empty array when no projects have been indexed yet", () => {
  const dataDir = tmpDataDir();
  assert.deepEqual(listProjects({ dataDir }), []);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("listProjects lists every project directory under the data dir with its size", () => {
  const dataDir = tmpDataDir();
  const a = seedProject(dataDir, "/tmp/repo-a", 200);
  const b = seedProject(dataDir, "/tmp/repo-b", 500);

  const projects = listProjects({ dataDir });
  const keys = projects.map((p) => p.key).sort();
  assert.deepEqual(keys, [a.key, b.key].sort());

  const found = projects.find((p) => p.key === b.key)!;
  assert.equal(found.dbPath, b.dbPath);
  assert.ok(found.sizeBytes >= 500, "sizeBytes should reflect the on-disk db file size");

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("deleteProject removes a project's directory and returns true", () => {
  const dataDir = tmpDataDir();
  const a = seedProject(dataDir, "/tmp/repo-a");

  const deleted = deleteProject(a.key, { dataDir });
  assert.equal(deleted, true);
  assert.deepEqual(listProjects({ dataDir }), []);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("deleteProject returns false for an unknown key instead of throwing", () => {
  const dataDir = tmpDataDir();
  assert.equal(deleteProject("does-not-exist-12345678", { dataDir }), false);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("deleteProject rejects keys that could escape the projects directory (path traversal)", () => {
  const dataDir = tmpDataDir();
  assert.throws(() => deleteProject("../../etc", { dataDir }), /invalid project key/i);
  assert.throws(() => deleteProject("nested/path", { dataDir }), /invalid project key/i);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("listProjects ignores files that vanish while sizing (e.g. the index lock being released)", () => {
  const dataDir = tmpDataDir();
  const a = seedProject(dataDir, "/tmp/repo-vanish", 100);
  fs.symlinkSync("/nonexistent/target", path.join(path.dirname(a.dbPath), "index.lock"));
  const [project] = listProjects({ dataDir });
  assert.equal(project!.sizeBytes, 100);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("listProjects exposes the stable name (key without the hash suffix)", () => {
  const dataDir = tmpDataDir();
  fs.mkdirSync(path.join(dataDir, "projects", "tlt-platform-cb270a90"), { recursive: true });
  const [project] = listProjects({ dataDir });
  assert.equal(project!.name, "tlt-platform");
  assert.equal(project!.key, "tlt-platform-cb270a90");
  fs.rmSync(dataDir, { recursive: true, force: true });
});
