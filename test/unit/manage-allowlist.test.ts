import { test } from "node:test";
import assert from "node:assert/strict";
import { createAllowRepoTool } from "../../src/tools/manage-allowlist.js";

/**
 * Unit tests for the native `ai_context_allow_repo` tool. The allow-list
 * holds stable project NAMES (no per-machine hash); a name must exist in
 * the real project registry, so a typo or a never-indexed repo can't end
 * up in the allow-list, and the hashed key is not a valid value.
 */

const projects = [{ key: "libfoo-abc12345", name: "libfoo", dbPath: "/x", sizeBytes: 1, mtimeMs: 0 }];

test("ai_context_allow_repo adds a name that exists in the project registry", async () => {
  const added: string[] = [];
  const toolDef = createAllowRepoTool({
    worktree: "/repo",
    listProjects: () => projects,
    addAllowedRepo: (_worktree: string, name: string) => {
      added.push(name);
      return { added: true, keys: [name] };
    },
  });
  const raw = await toolDef.execute({ repoName: "libfoo" }, {} as never);
  assert.deepEqual(JSON.parse(raw as string), { added: true, keys: ["libfoo"] });
  assert.deepEqual(added, ["libfoo"]);
});

test("ai_context_allow_repo throws, listing valid names, for an unknown name or a hashed key", async () => {
  const toolDef = createAllowRepoTool({
    worktree: "/repo",
    listProjects: () => projects,
    addAllowedRepo: () => ({ added: true, keys: [] }),
  });
  for (const bad of ["typo-repo", "libfoo-abc12345"]) {
    await assert.rejects(
      () => toolDef.execute({ repoName: bad }, {} as never),
      (e: Error) => /valid names: libfoo$/.test(e.message),
    );
  }
});
