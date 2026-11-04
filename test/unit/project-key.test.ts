import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveProjectKey, resolveDataDir } from "../../src/storage/project-key.js";

/**
 * Unit tests for per-repo isolation (user-directed, 2026-09-14): "the
 * vector db [should] give only that parts back which belongs to the
 * right repo" when multiple repos' data exist on the same machine.
 *
 * Design mirrors `watcher/db.py`'s existing pattern of ONE QDRANT
 * COLLECTION PER PROJECT (physical separation), not just a row/payload
 * filter -- see `collection_name=project_key` throughout `db.py`. The
 * difference: today's `project_key` is an explicit, manually-configured
 * `name` from `config.yaml` (`config_loader.py`'s `_project_key()`);
 * this plugin has no config-file step (auto-discovery via OpenCode's
 * `directory`/`worktree`), so the key must be auto-derived from the
 * worktree path instead.
 *
 * `deriveProjectKey` returns both a human-readable, collision-resistant
 * key AND the on-disk path for that project's OWN vector-store file --
 * a separate SQLite file per project, so a query literally cannot return
 * another project's rows (stronger guarantee than remembering to add a
 * WHERE project_key = ? filter everywhere).
 */

test("deriveProjectKey is stable for the same worktree path", () => {
  const a = deriveProjectKey("/Users/dev/repos/my-app");
  const b = deriveProjectKey("/Users/dev/repos/my-app");
  assert.equal(a.key, b.key);
  assert.equal(a.dbPath, b.dbPath);
});

test("deriveProjectKey produces different keys/paths for different worktrees", () => {
  const a = deriveProjectKey("/Users/dev/repos/my-app");
  const b = deriveProjectKey("/Users/dev/repos/other-app");
  assert.notEqual(a.key, b.key);
  assert.notEqual(a.dbPath, b.dbPath);
});

test("deriveProjectKey disambiguates two different paths that share the same basename", () => {
  // e.g. a monorepo checked out twice, or unrelated repos both named "app" --
  // a naive basename-only key would collide and leak data across them.
  const a = deriveProjectKey("/Users/dev/work/app");
  const b = deriveProjectKey("/Users/dev/personal/app");
  assert.notEqual(a.key, b.key);
  assert.notEqual(a.dbPath, b.dbPath);
});

test("deriveProjectKey's key includes a human-readable slug of the worktree basename", () => {
  const { key } = deriveProjectKey("/Users/dev/repos/My Cool App");
  assert.match(key, /my-cool-app/i);
});

test("deriveProjectKey's dbPath lives outside the given worktree (never inside the watched repo tree)", () => {
  const worktree = "/Users/dev/repos/my-app";
  const { dbPath } = deriveProjectKey(worktree);
  assert.ok(
    !dbPath.startsWith(worktree),
    `dbPath (${dbPath}) must not be nested inside the project's own worktree, or the plugin's own ` +
      "writes to it would trigger file.watcher.updated and re-index its own database file",
  );
});

test("deriveProjectKey respects an AI_CONTEXT_PLUGIN_DATA_DIR override for the base data directory", () => {
  const { dbPath } = deriveProjectKey("/Users/dev/repos/my-app", {
    dataDir: "/tmp/custom-ai-context-data",
  });
  assert.ok(dbPath.startsWith("/tmp/custom-ai-context-data"));
});

/**
 * Config-file fallback (user-directed, 2026-09-16): the base data
 * directory is now also settable via `.opencode/ai-context.config.yaml`
 * (`data_dir`, config-file.ts). Precedence matches every other setting
 * in this plugin: explicit option > env var > config file > built-in
 * default.
 */
test("deriveProjectKey falls back to a config-file data dir when no explicit option or env var is set", () => {
  const { dbPath } = deriveProjectKey("/Users/dev/repos/my-app", {
    fileDataDir: "/tmp/from-config-file",
  });
  assert.ok(dbPath.startsWith("/tmp/from-config-file"));
});

test("deriveProjectKey prefers an explicit dataDir option over a config-file data dir", () => {
  const { dbPath } = deriveProjectKey("/Users/dev/repos/my-app", {
    dataDir: "/tmp/explicit",
    fileDataDir: "/tmp/from-config-file",
  });
  assert.ok(dbPath.startsWith("/tmp/explicit"));
});

test("deriveProjectKey's dbPath ends with a predictable index.sqlite filename", () => {
  const { dbPath } = deriveProjectKey("/Users/dev/repos/my-app");
  assert.ok(dbPath.endsWith("index.sqlite"));
});

test("resolveDataDir defaults to the renamed directory and keeps using a pre-rename one until it is moved", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-context-home-"));
  const saved = { HOME: process.env.HOME, XDG: process.env.XDG_DATA_HOME, DIR: process.env.AI_CONTEXT_PLUGIN_DATA_DIR };
  process.env.HOME = home;
  delete process.env.XDG_DATA_HOME;
  delete process.env.AI_CONTEXT_PLUGIN_DATA_DIR;
  try {
    const share = path.join(home, ".local", "share");
    assert.equal(resolveDataDir(), path.join(share, "ai-context-opencode-plugin"));
    fs.mkdirSync(path.join(share, "opencode-ai-context-plugin"), { recursive: true });
    assert.equal(resolveDataDir(), path.join(share, "opencode-ai-context-plugin"));
    fs.mkdirSync(path.join(share, "ai-context-opencode-plugin"), { recursive: true });
    assert.equal(resolveDataDir(), path.join(share, "ai-context-opencode-plugin"));
  } finally {
    for (const [k, v] of [["HOME", saved.HOME], ["XDG_DATA_HOME", saved.XDG], ["AI_CONTEXT_PLUGIN_DATA_DIR", saved.DIR]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
