// The plugin is off unless enabled (config `enabled` / this env var); the suite tests the enabled plugin.
process.env.AI_CONTEXT_PLUGIN_ENABLED ??= "1";

import { MemoryLimitError } from "../../src/indexing/memory-guard.js";
import { createRuntimeRegistry } from "../../src/hook/runtime-registry.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AiContextPlugin,
  createAiContextHooks,
  nonGitNoticeGateKey,
} from "../../src/hook/plugin.js";

/**
 * Unit tests for the plugin scaffold's contract only -- no real indexing
 * logic exists yet (that lands with the storage-spike and
 * replace-watcher-with-hooks todos, see plan.md). These tests pin down:
 *
 *  1. the plugin registers exactly the native tools we committed to
 *     (semantic_search, analyze_impact) instead of an MCP server/skill file,
 *  2. each tool's `description` carries real workflow guidance inline
 *     (no separate SKILL.md -- see plan.md's "Repository layout &
 *     packaging decision"),
 *  3. the plugin reacts to `file.watcher.updated`, not `file.edited`,
 *     since only the former fires for changes made by any process
 *     (e.g. `git pull`), not just the agent's own edits.
 *  4. on OpenCode 1.x (host "v1") the plugin enables the built-in LSP servers via
 *     the `config` hook unless the user opted out with `lsp: false`; on 2.x
 *     (host "v2") there is no LSP, so nothing is switched on or mentioned.
 */

function mockPluginInput() {
  return {
    directory: "/tmp/project",
    worktree: "/tmp/project",
  } as unknown as Parameters<typeof AiContextPlugin>[0];
}

test("AiContextPlugin registers semantic_search as a native tool", async () => {
  const hooks = await AiContextPlugin(mockPluginInput());
  assert.ok(hooks.tool, "expected hooks.tool to be defined");
  assert.ok(hooks.tool!["semantic_search"], "expected a semantic_search tool");
});

test("analyze_impact is always registered, regardless of heavy mode (ADR-0006)", async () => {
  for (const heavyMode of [false, true]) {
    const hooks = await createAiContextHooks({
      worktree: "/tmp/project",
      heavyMode,
      reconcileOnStartup: async () => {},
    });
    assert.ok(
      hooks.tool!["analyze_impact"],
      `analyze_impact should be registered (heavyMode=${heavyMode})`,
    );
  }
});

test("analyze_impact's description (default host) tells the agent how to confirm ambiguous edges without lsp", async () => {
  const hooks = await createAiContextHooks({
    worktree: "/tmp/project",
    reconcileOnStartup: async () => {},
  });
  assert.match(hooks.tool!["analyze_impact"].description, /ambiguous/);
  assert.doesNotMatch(hooks.tool!["analyze_impact"].description, /lsp/);
});

test("semantic_search description carries workflow guidance instead of relying on a skill file", async () => {
  const hooks = await AiContextPlugin(mockPluginInput());
  const toolDef = hooks.tool!["semantic_search"];
  assert.ok(
    toolDef.description.length > 80,
    "description should carry real workflow guidance, not a one-liner",
  );
  assert.match(
    toolDef.description,
    /grep|glob/i,
    "description should tell the agent when to prefer grep/glob instead",
  );
});

test("AiContextPlugin reacts to file.watcher.updated (not file.edited) via its event hook", async () => {
  const hooks = await AiContextPlugin(mockPluginInput());
  assert.equal(
    typeof hooks.event,
    "function",
    "expected an event hook to be registered",
  );
  // Should not throw for an unrelated event type -- indexing logic is a
  // stub today, this only pins down that the hook exists and is inert
  // for events it doesn't care about.
  await hooks.event!({ event: { type: "session.created" } as any });
  await hooks.event!({
    event: {
      type: "file.watcher.updated",
      properties: { file: "src/index.ts", event: "change" },
    } as any,
  });
});

test("1.x: the config hook enables LSP unless the user configured it", async () => {
  const hooks = await AiContextPlugin(mockPluginInput());
  assert.equal(typeof hooks.config, "function");
  const config: { lsp?: unknown } = {};
  await hooks.config!(config as any);
  assert.ok(config.lsp && typeof config.lsp === "object");
});

test("1.x: the config hook sets the experimental lsp tool flag unless already set", async () => {
  const prev = process.env.OPENCODE_EXPERIMENTAL_LSP_TOOL;
  delete process.env.OPENCODE_EXPERIMENTAL_LSP_TOOL;
  try {
    const hooks = await AiContextPlugin(mockPluginInput());
    await hooks.config!({} as any);
    assert.equal(process.env.OPENCODE_EXPERIMENTAL_LSP_TOOL, "true");
    process.env.OPENCODE_EXPERIMENTAL_LSP_TOOL = "false";
    await hooks.config!({} as any);
    assert.equal(process.env.OPENCODE_EXPERIMENTAL_LSP_TOOL, "false");
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_EXPERIMENTAL_LSP_TOOL;
    else process.env.OPENCODE_EXPERIMENTAL_LSP_TOOL = prev;
  }
});

test("1.x: the config hook respects lsp: false and keeps existing per-server overrides", async () => {
  const hooks = await AiContextPlugin(mockPluginInput());
  const off: { lsp?: unknown } = { lsp: false };
  await hooks.config!(off as any);
  assert.equal(off.lsp, false);
  const custom = { lsp: { rust: { command: ["rust-analyzer"] } } };
  await hooks.config!(custom as any);
  assert.deepEqual(custom.lsp, { rust: { command: ["rust-analyzer"] } });
});

test("2.x host: the config hook never touches lsp or sets the lsp env flag", async () => {
  const prev = process.env.OPENCODE_EXPERIMENTAL_LSP_TOOL;
  delete process.env.OPENCODE_EXPERIMENTAL_LSP_TOOL;
  try {
    const hooks = await createAiContextHooks({ worktree: "/tmp/project", host: "v2", reconcileOnStartup: async () => {} });
    const config: { lsp?: unknown } = {};
    await hooks.config!(config as any);
    assert.equal(config.lsp, undefined);
    assert.equal(process.env.OPENCODE_EXPERIMENTAL_LSP_TOOL, undefined);
  } finally {
    if (prev !== undefined) process.env.OPENCODE_EXPERIMENTAL_LSP_TOOL = prev;
  }
});

test("lsp wording is host specific: 1.x points to the native lsp tool, 2.x never mentions it", async () => {
  const v1 = await createAiContextHooks({ worktree: "/tmp/project", host: "v1", reconcileOnStartup: async () => {} });
  const v2 = await createAiContextHooks({ worktree: "/tmp/project", host: "v2", reconcileOnStartup: async () => {} });
  for (const name of ["analyze_impact", "find_symbol"]) {
    assert.match(v1.tool![name].description, /`lsp`/, name);
    assert.doesNotMatch(v2.tool![name].description, /lsp/i, name);
  }
  const sys1: string[] = [];
  const sys2: string[] = [];
  await v1["experimental.chat.system.transform"]!({}, { system: sys1 });
  await v2["experimental.chat.system.transform"]!({}, { system: sys2 });
  assert.match(sys1.join("\n"), /native `lsp` tool/);
  assert.doesNotMatch(sys2.join("\n"), /lsp/i);
});

test("createAiContextHooks runs startup reconciliation exactly once when hooks are created", async () => {
  const reconcileOnStartup = mock.fn(async () => {});
  await createAiContextHooks({
    reconcileOnStartup,
    scheduler: { notify: () => {}, flush: async () => {} },
  });
  assert.equal(reconcileOnStartup.mock.callCount(), 1);
});

test("createAiContextHooks does not wait for the startup reconciliation (a slow initial index must not block plugin init)", async () => {
  let release!: () => void;
  let finished = false;
  const reconcileOnStartup = async () => {
    await new Promise<void>((resolve) => (release = resolve));
    finished = true;
  };
  const hooks = await createAiContextHooks({
    reconcileOnStartup,
    scheduler: { notify: () => {}, flush: async () => {} },
  });
  assert.ok(
    hooks.tool!["analyze_impact"],
    "tools are available while indexing is still running",
  );
  assert.equal(finished, false);
  release();
});

test("a failing startup reconciliation is logged, not thrown", async () => {
  const errors = mock.method(console, "error", () => {});
  try {
    await createAiContextHooks({
      reconcileOnStartup: async () => {
        throw new Error("walk failed");
      },
      scheduler: { notify: () => {}, flush: async () => {} },
    });
    await new Promise((r) => setImmediate(r));
    // other tests' background reconciliations may log too, so match on this one's error
    assert.ok(
      errors.mock.calls.some(
        (c) =>
          String((c.arguments[1] as Error | undefined)?.message) ===
          "walk failed",
      ),
    );
  } finally {
    errors.mock.restore();
  }
});

test("createAiContextHooks' event hook forwards file.watcher.updated to the scheduler with file + event", async () => {
  const notify = mock.fn();
  const hooks = await createAiContextHooks({
    reconcileOnStartup: async () => {},
    scheduler: { notify, flush: async () => {} },
  });
  await hooks.event!({
    event: {
      type: "file.watcher.updated",
      properties: { file: "src/index.ts", event: "change" },
    } as any,
  });
  assert.equal(notify.mock.callCount(), 1);
  assert.deepEqual(notify.mock.calls[0]!.arguments, ["src/index.ts", "change"]);
});

test("createAiContextHooks' event hook ignores event types other than file.watcher.updated", async () => {
  const notify = mock.fn();
  const hooks = await createAiContextHooks({
    reconcileOnStartup: async () => {},
    scheduler: { notify, flush: async () => {} },
  });
  await hooks.event!({ event: { type: "session.created" } as any });
  assert.equal(notify.mock.callCount(), 0);
});

/**
 * Telemetry wiring tests (plan.md, "overlap-benchmark-spike" -- telemetry
 * endpoints). `tool.execute.before`/`tool.execute.after` fire for EVERY
 * tool call in a session, including native grep/glob/lsp, so wiring these
 * to the recorder gives automatic latency telemetry with no
 * self-instrumentation -- unlike bench.js's manual wrap/start/stop.
 */

test("createAiContextHooks registers a ai_context_telemetry_report tool", async () => {
  const hooks = await createAiContextHooks({
    reconcileOnStartup: async () => {},
  });
  assert.ok(
    hooks.tool!["ai_context_telemetry_report"],
    "expected a ai_context_telemetry_report tool",
  );
});

test("createAiContextHooks' tool.execute.before/after hooks feed the telemetry recorder", async () => {
  const recordStart = mock.fn();
  const recordEnd = mock.fn();
  const hooks = await createAiContextHooks({
    telemetry: {
      recordStart,
      recordEnd,
      getEntries: () => [],
      getSummary: () => [],
      reset: () => {},
    },
    reconcileOnStartup: async () => {},
  });

  await hooks["tool.execute.before"]!(
    { tool: "grep", sessionID: "s1", callID: "c1" },
    { args: { pattern: "foo" } },
  );
  assert.equal(recordStart.mock.callCount(), 1);
  assert.deepEqual(recordStart.mock.calls[0]!.arguments[0], {
    tool: "grep",
    sessionID: "s1",
    callID: "c1",
    args: { pattern: "foo" },
  });

  await hooks["tool.execute.after"]!(
    { tool: "grep", sessionID: "s1", callID: "c1", args: { pattern: "foo" } },
    { title: "grep", output: "3 matches", metadata: {} },
  );
  assert.equal(recordEnd.mock.callCount(), 1);
  assert.deepEqual(recordEnd.mock.calls[0]!.arguments[0], {
    tool: "grep",
    sessionID: "s1",
    callID: "c1",
    output: "3 matches",
  });
});

test("createAiContextHooks' ai_context_telemetry_report tool returns the recorder's current summary as JSON", async () => {
  const summary = [
    {
      tool: "grep",
      callCount: 2,
      totalDurationMs: 300,
      avgDurationMs: 150,
      totalInputTokens: 10,
      totalOutputTokens: 40,
      totalTokens: 50,
    },
  ];
  const hooks = await createAiContextHooks({
    telemetry: {
      recordStart: () => {},
      recordEnd: () => {},
      getEntries: () => [],
      getSummary: () => summary,
      reset: () => {},
    },
    reconcileOnStartup: async () => {},
  });
  const result = await hooks.tool!["ai_context_telemetry_report"]!.execute({}, {
    sessionID: "s1",
  } as any);
  const text =
    typeof result === "string"
      ? result
      : ((result as { output: string }).output ?? JSON.stringify(result));
  assert.deepEqual(JSON.parse(text), summary);
});

/**
 * Per-repo isolation wiring tests (user-directed, 2026-09-14). Each
 * plugin instance must create its OWN vector-store file scoped to the
 * current session's worktree (via deriveProjectKey), not a single shared
 * store, so data from other repos indexed on the same machine can never
 * be returned for this one.
 */

test("createAiContextHooks derives a project-scoped vector-store path from the given worktree", async () => {
  const createVectorStore = mock.fn((_options: { path: string }) => ({
    upsertChunks: () => {},
    deleteChunksForFile: () => {},
    getChunkIdsForFile: () => new Set<string>(),
    getChunk: () => null,
    getAllChunks: () => [],
    getChunksPage: () => [],
    search: () => [],
    searchText: () => [],
    getFileFingerprint: () => null,
    setFileFingerprint: () => {},
    getIndexStatus: () => ({
      fileCount: 0,
      chunkCount: 0,
      newestIndexedAt: null,
    }),
    getRecentChanges: () => [],
    listFiles: () => [],
    close: () => {},
  }));
  await createAiContextHooks({
    worktree: "/Users/dev/repos/my-app",
    createVectorStore,
  });

  assert.equal(createVectorStore.mock.callCount(), 1);
  const passedPath = createVectorStore.mock.calls[0]!.arguments[0]!.path;
  assert.equal(
    (createVectorStore.mock.calls[0]!.arguments[0] as { embedFormat?: number }).embedFormat,
    2,
  );
  assert.match(passedPath, /my-app/);
  assert.ok(
    !passedPath.startsWith("/Users/dev/repos/my-app"),
    "the vector-store path must live outside the project's own worktree",
  );
});

test("createAiContextHooks derives distinct vector-store paths for two different worktrees", async () => {
  const createVectorStore = mock.fn((_options: { path: string }) => ({
    upsertChunks: () => {},
    deleteChunksForFile: () => {},
    getChunkIdsForFile: () => new Set<string>(),
    getChunk: () => null,
    getAllChunks: () => [],
    getChunksPage: () => [],
    search: () => [],
    searchText: () => [],
    getFileFingerprint: () => null,
    setFileFingerprint: () => {},
    getIndexStatus: () => ({
      fileCount: 0,
      chunkCount: 0,
      newestIndexedAt: null,
    }),
    getRecentChanges: () => [],
    listFiles: () => [],
    close: () => {},
  }));
  await createAiContextHooks({
    worktree: "/Users/dev/repos/repo-a",
    createVectorStore,
  });
  await createAiContextHooks({
    worktree: "/Users/dev/repos/repo-b",
    createVectorStore,
  });

  const pathA = createVectorStore.mock.calls[0]!.arguments[0]!.path;
  const pathB = createVectorStore.mock.calls[1]!.arguments[0]!.path;
  assert.notEqual(pathA, pathB);
});

/**
 * `.opencode/ai-context.config.yaml` wiring (user-directed, 2026-09-16):
 * `createAiContextHooks` loads the project's config file (injectable via
 * `deps.configFile` for tests, so these don't touch real disk I/O) and
 * threads each setting through to its consuming module -- `data_dir` to
 * `deriveProjectKey`, `heavy_mode` to `isHeavyModeEnabled`. An explicit
 * `deps.heavyMode` (or a real env var, at the module level) still wins
 * over the config file, matching every other setting's precedence.
 */
test("createAiContextHooks derives the vector-store path under a config-file data_dir", async () => {
  const createVectorStore = mock.fn((_options: { path: string }) => ({
    upsertChunks: () => {},
    deleteChunksForFile: () => {},
    getChunkIdsForFile: () => new Set<string>(),
    getChunk: () => null,
    getAllChunks: () => [],
    getChunksPage: () => [],
    search: () => [],
    searchText: () => [],
    getFileFingerprint: () => null,
    setFileFingerprint: () => {},
    getIndexStatus: () => ({
      fileCount: 0,
      chunkCount: 0,
      newestIndexedAt: null,
    }),
    getRecentChanges: () => [],
    listFiles: () => [],
    close: () => {},
  }));
  await createAiContextHooks({
    worktree: "/Users/dev/repos/repo-a",
    createVectorStore,
    configFile: { dataDir: "/tmp/from-config-file" },
    reconcileOnStartup: async () => {},
  });

  const dbPath = createVectorStore.mock.calls[0]!.arguments[0]!.path;
  assert.ok(dbPath.startsWith("/tmp/from-config-file"));
});

/**
 * Project-management tools (user-directed, 2026-09-14): "give an option
 * to delete projects from the database if they are not needed anymore."
 * Exposed as native tools (list/delete) rather than a script, since the
 * agent/user interacts with this plugin through OpenCode's tool calls,
 * not a separate CLI.
 */

test("createAiContextHooks registers ai_context_list_projects and ai_context_delete_project tools", async () => {
  const hooks = await createAiContextHooks({
    reconcileOnStartup: async () => {},
  });
  assert.ok(
    hooks.tool!["ai_context_list_projects"],
    "expected an ai_context_list_projects tool",
  );
  assert.ok(
    hooks.tool!["ai_context_delete_project"],
    "expected an ai_context_delete_project tool",
  );
});

/**
 * Index-status observability (port-index-status-tools, plan.md): ports
 * db.ts's getIndexStatus/getRecentChanges as a single native tool, using
 * the CURRENT project's own vector store (not a cross-project listing).
 */

test("createAiContextHooks registers an index_status tool backed by the current project's vector store", async () => {
  // Use an isolated in-memory store (not the real on-disk path) so this
  // test doesn't depend on -- or get polluted by -- whatever this repo's
  // real persisted store currently contains.
  const { createVectorStore } =
    await import("../../src/storage/vector-store.js");
  const hooks = await createAiContextHooks({
    reconcileOnStartup: async () => {},
    createVectorStore: () => createVectorStore({ path: ":memory:" }),
    importBackup: () => ({ count: 0 }),
    importDocTreeBackup: () => ({ count: 0 }),
    importGraphBackup: () => ({ count: 0 }),
  });
  const toolDef = hooks.tool!["index_status"];
  assert.ok(toolDef, "expected an index_status tool");
  const raw = await toolDef.execute({}, {} as never);
  const result = JSON.parse(raw as string);
  assert.equal(result.fileCount, 0);
  assert.equal(result.chunkCount, 0);
  assert.deepEqual(result.recentChanges, []);
});

/**
 * Doc-tree wiring (port-doc-tree-markdown, plan.md): a native
 * search_docs tool backed by a per-project DocTreeStore
 * (mirrors the vector store's per-project isolation), and the indexer
 * is given that same store + a docTreeConfig so qualifying Markdown
 * files get tree-indexed instead of chunked.
 */

test("createAiContextHooks registers an search_docs tool backed by the current project's doc-tree store", async () => {
  const { createVectorStore } =
    await import("../../src/storage/vector-store.js");
  const { createDocTreeStore } =
    await import("../../src/storage/doc-tree-store.js");
  const hooks = await createAiContextHooks({
    reconcileOnStartup: async () => {},
    createVectorStore: () => createVectorStore({ path: ":memory:" }),
    createDocTreeStore: () => createDocTreeStore({ path: ":memory:" }),
    importBackup: () => ({ count: 0 }),
    importDocTreeBackup: () => ({ count: 0 }),
    importGraphBackup: () => ({ count: 0 }),
  });
  const toolDef = hooks.tool!["search_docs"];
  assert.ok(toolDef, "expected an search_docs tool");
  const raw = await toolDef.execute({ query: "anything" }, {} as never);
  assert.deepEqual(JSON.parse(raw as string), []);
});

test("createAiContextHooks derives a project-scoped doc-tree store path alongside the vector store", async () => {
  const createVectorStore = mock.fn((_options: { path: string }) => ({
    upsertChunks: () => {},
    deleteChunksForFile: () => {},
    getChunkIdsForFile: () => new Set<string>(),
    getChunk: () => null,
    getAllChunks: () => [],
    getChunksPage: () => [],
    search: () => [],
    searchText: () => [],
    getFileFingerprint: () => null,
    setFileFingerprint: () => {},
    getIndexStatus: () => ({
      fileCount: 0,
      chunkCount: 0,
      newestIndexedAt: null,
    }),
    getRecentChanges: () => [],
    listFiles: () => [],
    close: () => {},
  }));
  const createDocTreeStore = mock.fn((_options: { path: string }) => ({
    upsertTree: () => {},
    getTree: () => null,
    deleteTree: () => {},
    getAllTrees: () => [],
    listPaths: () => [],
    countTrees: () => 0,
    close: () => {},
  }));
  await createAiContextHooks({
    worktree: "/Users/dev/repos/my-app",
    createVectorStore,
    createDocTreeStore,
    reconcileOnStartup: async () => {},
  });
  assert.equal(createDocTreeStore.mock.callCount(), 1);
  const vectorStorePath = createVectorStore.mock.calls[0]!.arguments[0]!.path;
  const docTreeStorePath = createDocTreeStore.mock.calls[0]!.arguments[0]!.path;
  assert.notEqual(docTreeStorePath, vectorStorePath);
  assert.match(docTreeStorePath, /my-app/);
});

test("ai_context_list_projects delegates to the injected project registry", async () => {
  const projects = [
    {
      key: "app-abc12345",
      name: "app",
      dbPath: "/data/projects/app-abc12345/index.sqlite",
      sizeBytes: 1234,
      mtimeMs: 0,
    },
  ];
  const listProjects = mock.fn(() => projects);
  const hooks = await createAiContextHooks({
    projectRegistry: { listProjects, deleteProject: mock.fn() },
    reconcileOnStartup: async () => {},
  });

  const result = await hooks.tool!["ai_context_list_projects"]!.execute({}, {
    sessionID: "s1",
  } as any);
  const text =
    typeof result === "string"
      ? result
      : ((result as { output: string }).output ?? JSON.stringify(result));
  assert.deepEqual(JSON.parse(text), projects);
  // >=1, not ===1: createAiContextHooks itself also calls listProjects
  // once at startup to resolve the cross-repo allow-list (see
  // repo-allowlist.ts wiring) -- this test only pins down that the
  // tool's OWN call delegates correctly, not the total call count.
  assert.ok(listProjects.mock.callCount() >= 1);
});

test("ai_context_delete_project delegates to the injected project registry with the given key", async () => {
  const deleteProject = mock.fn((_key: string) => true);
  const hooks = await createAiContextHooks({
    projectRegistry: { listProjects: mock.fn(() => []), deleteProject },
    reconcileOnStartup: async () => {},
  });

  const result = await hooks.tool!["ai_context_delete_project"]!.execute(
    { key: "app-abc12345" },
    { sessionID: "s1" } as any,
  );
  const text =
    typeof result === "string"
      ? result
      : ((result as { output: string }).output ?? JSON.stringify(result));
  assert.deepEqual(JSON.parse(text), { deleted: true, key: "app-abc12345" });
  assert.equal(deleteProject.mock.calls[0]!.arguments[0], "app-abc12345");
});

/**
 * Repo-local backup wiring tests (plan.md, "repo-local-backup",
 * user-directed 2026-09-15): teammates should get the indexed data
 * from a fresh clone without re-indexing, by committing a backup file
 * that lives INSIDE the worktree (unlike the live store, which lives
 * outside it -- see project-key.ts).
 */

test("createAiContextHooks registers an ai_context_export_backup tool", async () => {
  const hooks = await createAiContextHooks({
    reconcileOnStartup: async () => {},
  });
  assert.ok(
    hooks.tool!["ai_context_export_backup"],
    "expected an ai_context_export_backup tool",
  );
});

test("createAiContextHooks auto-imports the repo-local backup on startup when the store is empty", async () => {
  const importBackup = mock.fn((_store: unknown, _filePath: string) => ({
    count: 3,
  }));
  const getAllChunks = mock.fn((): { id: string }[] => {
    throw new Error("startup must not load every chunk and vector into memory");
  });
  const createVectorStore = () =>
    ({
      upsertChunks: () => {},
      deleteChunksForFile: () => {},
      getChunkIdsForFile: () => new Set<string>(),
      getChunk: () => null,
      getAllChunks,
      getIndexStatus: () => ({ fileCount: 0, chunkCount: 0, newestIndexedAt: null }),
      listFiles: () => [],
      search: () => [],
      searchText: () => [],
    getFileFingerprint: () => null,
    setFileFingerprint: () => {},
      close: () => {},
    }) as any;
  await createAiContextHooks({
    worktree: "/Users/dev/repos/my-app",
    createVectorStore,
    importBackup: importBackup as any,
  });
  assert.equal(importBackup.mock.callCount(), 1);
  const [, filePath] = importBackup.mock.calls[0]!.arguments as [
    unknown,
    string,
  ];
  assert.match(
    filePath,
    /\.opencode[\\/]ai-context[\\/]backup[\\/]index\.jsonl$/,
  );
});

test("createAiContextHooks does NOT auto-import the backup when the store already has chunks", async () => {
  const importBackup = mock.fn(() => ({ count: 0 }));
  const createVectorStore = () =>
    ({
      upsertChunks: () => {},
      deleteChunksForFile: () => {},
      getChunkIdsForFile: () => new Set<string>(),
      getChunk: () => null,
      getAllChunks: () => {
        throw new Error("startup must not load every chunk and vector into memory");
      },
      getIndexStatus: () => ({ fileCount: 1, chunkCount: 1, newestIndexedAt: null }),
      listFiles: () => [],
      search: () => [],
      searchText: () => [],
    getFileFingerprint: () => null,
    setFileFingerprint: () => {},
      close: () => {},
    }) as any;
  await createAiContextHooks({
    createVectorStore,
    importBackup: importBackup as any,
    reconcileOnStartup: async () => {},
  });
  assert.equal(importBackup.mock.callCount(), 0);
});

test("ai_context_export_backup delegates to the injected exportBackup with the resolved backup path", async () => {
  const exportBackup = mock.fn(() => ({ count: 5 }));
  const exportDocTreeBackup = mock.fn(() => ({ count: 0 }));
  const exportGraphBackup = mock.fn(() => ({ count: 3 }));
  const hooks = await createAiContextHooks({
    worktree: "/Users/dev/repos/my-app",
    exportBackup: exportBackup as any,
    exportDocTreeBackup: exportDocTreeBackup as any,
    exportGraphBackup: exportGraphBackup as any,
  });
  const result = await hooks.tool!["ai_context_export_backup"]!.execute({}, {
    sessionID: "s1",
  } as any);
  const text =
    typeof result === "string"
      ? result
      : ((result as { output: string }).output ?? JSON.stringify(result));
  const parsed = JSON.parse(text);
  assert.equal(parsed.count, 5);
  assert.ok(Array.isArray(parsed.files));
  assert.equal(exportBackup.mock.callCount(), 1);
  assert.equal(parsed.graphCount, 3);
  assert.match(
    parsed.graphPath,
    /\.opencode[\\/]ai-context[\\/]backup[\\/]graph\.jsonl$/,
  );
  assert.equal(exportGraphBackup.mock.callCount(), 1);
});

test("an empty graph store is restored from the committed graph backup, a populated one is left alone", async () => {
  const { createGraphStore } = await import("../../src/storage/graph-store.js");
  for (const populated of [false, true]) {
    const store = createGraphStore({ path: ":memory:" });
    if (populated)
      store.replaceFile("x.ts", {
        language: "typescript",
        symbols: [],
        imports: [],
        calls: [],
      });
    const importGraphBackup = mock.fn(() => ({ count: 1 }));
    await createAiContextHooks({
      worktree: "/tmp/project",
      reconcileOnStartup: async () => {},
      createGraphStore: () => store,
      importGraphBackup: importGraphBackup as any,
    });
    assert.equal(importGraphBackup.mock.callCount(), populated ? 0 : 1);
  }
});

/**
 * Cross-repo allow-list wiring tests (plan.md, "cross-repo-allowlist",
 * user-directed 2026-09-15): "soften the walls" between repos for
 * library/dependency repos the user explicitly opts into, via a native
 * tool that validates the target repo against the real project
 * registry rather than accepting a freeform, possibly-wrong name.
 */

test("createAiContextHooks registers an ai_context_allow_repo tool", async () => {
  const hooks = await createAiContextHooks({
    reconcileOnStartup: async () => {},
  });
  assert.ok(
    hooks.tool!["ai_context_allow_repo"],
    "expected an ai_context_allow_repo tool",
  );
});

test("ai_context_allow_repo adds a repo key that exists in the project registry", async () => {
  const projects = [
    {
      key: "libfoo-abc12345",
      name: "libfoo",
      dbPath: "/data/projects/libfoo-abc12345/index.sqlite",
      sizeBytes: 10,
      mtimeMs: 0,
    },
  ];
  const addAllowedRepo = mock.fn((_w: string, _n: string) => ({
    added: true,
    keys: ["libfoo"],
  }));
  const hooks = await createAiContextHooks({
    projectRegistry: { listProjects: () => projects, deleteProject: mock.fn() },
    addAllowedRepo: addAllowedRepo as any,
    reconcileOnStartup: async () => {},
  });
  const result = await hooks.tool!["ai_context_allow_repo"]!.execute(
    { repoName: "libfoo" },
    { sessionID: "s1" } as any,
  );
  const text =
    typeof result === "string"
      ? result
      : ((result as { output: string }).output ?? JSON.stringify(result));
  assert.deepEqual(JSON.parse(text), {
    added: true,
    keys: ["libfoo"],
  });
  assert.deepEqual(addAllowedRepo.mock.calls[0]!.arguments.slice(1), ["libfoo"]);
  assert.equal(addAllowedRepo.mock.callCount(), 1);
});

test("ai_context_allow_repo opens the allowed repo's store right away (no restart needed)", async () => {
  const projects = [
    { key: "libfoo-abc12345", name: "libfoo", dbPath: "/data/projects/libfoo-abc12345/index.sqlite", sizeBytes: 1, mtimeMs: 0 },
  ];
  const opened: string[] = [];
  const hooks = await createAiContextHooks({
    projectRegistry: { listProjects: () => projects, deleteProject: mock.fn() },
    addAllowedRepo: (() => ({ added: true, keys: ["libfoo"] })) as any,
    createVectorStore: ((options: { path: string }) => {
      opened.push(options.path);
      return realCreateVectorStore({ path: ":memory:" });
    }) as any,
    reconcileOnStartup: async () => {},
  });
  const before = opened.filter((p) => p.includes("libfoo")).length;
  await hooks.tool!["ai_context_allow_repo"]!.execute({ repoName: "libfoo" }, { sessionID: "s1" } as any);
  assert.equal(opened.filter((p) => p.includes("libfoo")).length, before + 1);
  const structure = await hooks.tool!["repo_structure"]!.execute({ project: "libfoo" }, { sessionID: "s1" } as any);
  assert.doesNotMatch(String(structure), /Unknown or not allowed/);
});

test("a legacy allow-list entry with the hash is resolved by name at startup; the full key is not a valid project value", async () => {
  const projects = [
    { key: "libfoo-abc12345", name: "libfoo", dbPath: "/data/projects/libfoo-abc12345/index.sqlite", sizeBytes: 1, mtimeMs: 0 },
  ];
  const opened: string[] = [];
  const hooks = await createAiContextHooks({
    projectRegistry: { listProjects: () => projects, deleteProject: mock.fn() },
    readAllowlist: () => ["libfoo"],
    createVectorStore: ((options: { path: string }) => {
      opened.push(options.path);
      return realCreateVectorStore({ path: ":memory:" });
    }) as any,
    reconcileOnStartup: async () => {},
  });
  assert.ok(opened.some((p) => p.includes("libfoo")));
  const byName = await hooks.tool!["repo_structure"]!.execute({ project: "libfoo" }, { sessionID: "s1" } as any);
  assert.doesNotMatch(String(byName), /Unknown or not allowed/);
  const byKey = await hooks.tool!["repo_structure"]!.execute({ project: "libfoo-abc12345" }, { sessionID: "s1" } as any);
  assert.match(String(byKey), /Unknown or not allowed.*libfoo/s);
});

test("ai_context_allow_repo rejects a repo key that isn't in the project registry", async () => {
  const hooks = await createAiContextHooks({
    projectRegistry: { listProjects: () => [], deleteProject: mock.fn() },
    reconcileOnStartup: async () => {},
  });
  await assert.rejects(() =>
    hooks.tool!["ai_context_allow_repo"]!.execute({ repoName: "unknown-repo" }, {
      sessionID: "s1",
    } as any),
  );
});

/**
 * Indexing progress (ADR-0018): the startup reconciliation must feed the
 * progress tracker, and the tracker's state must reach the status file
 * writer, so users can follow a long first-time index.
 */

import { createVectorStore as realCreateVectorStore } from "../../src/storage/vector-store.js";
import { createDocTreeStore as realCreateDocTreeStore } from "../../src/storage/doc-tree-store.js";
import { createGraphStore as realCreateGraphStore } from "../../src/storage/graph-store.js";
import type { IndexProgressSnapshot } from "../../src/indexing/index-progress.js";

function progressDeps(overrides: Record<string, unknown> = {}) {
  const snapshots: IndexProgressSnapshot[] = [];
  return {
    snapshots,
    deps: {
      worktree: "/tmp/project-progress",
      createVectorStore: () => realCreateVectorStore({ path: ":memory:" }),
      createDocTreeStore: () => realCreateDocTreeStore({ path: ":memory:" }),
      createGraphStore: () => realCreateGraphStore({ path: ":memory:" }),
      importBackup: () => ({ count: 0 }),
      importDocTreeBackup: () => ({ count: 0 }),
      importGraphBackup: () => ({ count: 0 }),
      embedQuery: async () => [1, 2],
      embedDocument: async () => [1, 2],
      shouldIndexFile: () => true,
      readFile: async () => "content",
      statusWriter: {
        write: (s: IndexProgressSnapshot) => void snapshots.push(s),
      },
      runtimeRegistry: createRuntimeRegistry(),
      indexLease: { run: <T>(job: () => Promise<T>) => job() },
      ...overrides,
    },
  };
}

test("startup reconciliation reports scanning -> indexing -> done to the status writer", async () => {
  const { snapshots, deps } = progressDeps({
    walkRepoFiles: async () => ["a.ts", "b.ts"],
  });
  await createAiContextHooks(deps);
  // reconciliation is intentionally not awaited by the factory
  for (let i = 0; i < 100 && snapshots.at(-1)?.running !== false; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const phases = [...new Set(snapshots.map((s) => s.phase))];
  assert.deepEqual(phases, ["scanning", "indexing", "done"]);
  const last = snapshots.at(-1)!;
  assert.equal(last.done, 2);
  assert.equal(last.total, 2);
  assert.equal(last.running, false);
});

test("startup reconciliation records a failing walk as phase 'failed' without crashing the plugin", async () => {
  const { snapshots, deps } = progressDeps({
    walkRepoFiles: async () => {
      throw new Error("worktree unreadable");
    },
  });
  const errorSpy = mock.method(console, "error", () => {});
  try {
    await createAiContextHooks(deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    errorSpy.mock.restore();
  }
  const last = snapshots.at(-1)!;
  assert.equal(last.phase, "failed");
  assert.equal(last.lastError, "worktree unreadable");
});

test("a file that fails during startup indexing is listed in the final snapshot's failures", async () => {
  const { snapshots, deps } = progressDeps({
    walkRepoFiles: async () => ["ok.ts", "bad.ts"],
    readFile: async (p: string) => {
      if (p === "bad.ts") throw new Error("EACCES");
      return "content";
    },
  });
  await createAiContextHooks(deps);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const last = snapshots.at(-1)!;
  assert.equal(last.phase, "done");
  assert.deepEqual(
    last.failures.map((f) => [f.file, f.error]),
    [["bad.ts", "EACCES"]],
  );
});

test("search tools carry an indexingNotice while startup indexing is still running", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { deps } = progressDeps({
    walkRepoFiles: async () => ["a.ts", "b.ts"],
    readFile: async () => {
      await gate; // hold the first file so the run stays open
      return "content";
    },
  });
  const hooks = await createAiContextHooks(deps);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const raw = await hooks.tool!["semantic_search"]!.execute(
    { query: "x", limit: 3 } as never,
    {} as never,
  );
  assert.match(JSON.parse(raw as string).indexingNotice, /still being built/);
  release();
});

/**
 * opencode bootstraps the plugin twice per session (docs/observability.md).
 * Both instances must share one runtime: one full startup pass, one
 * progress tracker, strictly serial batches.
 */

test("two plugin instances of one worktree run the startup indexing only once", async () => {
  const registry = createRuntimeRegistry();
  let walks = 0;
  const walkRepoFiles = async () => (walks++, ["a.ts"]);
  const { deps: d1 } = progressDeps({
    walkRepoFiles,
    runtimeRegistry: registry,
  });
  const { deps: d2 } = progressDeps({
    walkRepoFiles,
    runtimeRegistry: registry,
  });
  await createAiContextHooks(d1);
  await createAiContextHooks(d2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(walks, 1);
});

test("the second instance reports the progress made by the first one", async () => {
  const registry = createRuntimeRegistry();
  const { deps: d1 } = progressDeps({
    walkRepoFiles: async () => ["a.ts", "b.ts"],
    runtimeRegistry: registry,
  });
  const { deps: d2 } = progressDeps({
    walkRepoFiles: async () => ["a.ts", "b.ts"],
    runtimeRegistry: registry,
  });
  await createAiContextHooks(d1);
  const second = await createAiContextHooks(d2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const status = JSON.parse(
    (await second.tool!["index_status"]!.execute(
      { limit: 1 } as never,
      {} as never,
    )) as string,
  );
  assert.equal(status.indexing.phase, "done");
  assert.equal(status.indexing.done, 2);
});

test("hitting the memory ceiling during startup indexing ends in phase 'failed' with a readable reason", async () => {
  const { snapshots, deps } = progressDeps({
    walkRepoFiles: async () => ["a.ts", "b.ts"],
    memoryGuard: {
      ensure: async () => {
        throw new MemoryLimitError(5000, 4096);
      },
    },
  });
  await createAiContextHooks(deps);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const last = snapshots.at(-1)!;
  assert.equal(last.phase, "failed");
  assert.match(last.lastError ?? "", /max_memory_mb=4096/);
});

test("indexing progress and plugin load are announced through the injected OS notifier", async () => {
  const messages: string[] = [];
  const files = Array.from({ length: 25 }, (_, i) => `f${i}.ts`);
  const { deps } = progressDeps({
    walkRepoFiles: async () => files,
    osNotify: (message: string) => void messages.push(message),
    osNotifyGate: { shouldNotify: () => true },
  });
  await createAiContextHooks(deps);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(messages.some((m) => /plugin/i.test(m)), "plugin-load message");
  assert.ok(messages.some((m) => /started.*25/.test(m)));
  assert.ok(messages.some((m) => /finished.*25/.test(m)));
});

test("the plugin-load popup goes through the gate (double bootstrap) and os_notifications:false silences everything", async () => {
  const gated: string[] = [];
  await createAiContextHooks(
    progressDeps({ osNotify: (m: string) => void gated.push(m), osNotifyGate: { shouldNotify: () => false } }).deps,
  );
  assert.deepEqual(gated, []);

  const silent: string[] = [];
  await createAiContextHooks(
    progressDeps({
      osNotify: (m: string) => void silent.push(m),
      osNotifyGate: { shouldNotify: () => true },
      configFile: { osNotifications: false },
      walkRepoFiles: async () => {
        throw new Error("x");
      },
    }).deps,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(silent, []);
});

test("a missing config file is created on first start, but not when a config is injected", async () => {
  const created: string[] = [];
  const base = progressDeps().deps;
  await createAiContextHooks({ ...base, ensureConfigFile: (w: string) => void created.push(w) });
  assert.deepEqual(created, ["/tmp/project-progress"]);

  await createAiContextHooks({ ...base, configFile: {}, ensureConfigFile: (w: string) => void created.push(w) });
  assert.equal(created.length, 1);
});

test("problems that used to be swallowed reach the OS notifier: config creation, backup restore", async () => {
  const messages: string[] = [];
  const { deps } = progressDeps({
    osNotify: (m: string) => void messages.push(m),
    osNotifyGate: { shouldNotify: () => false },
    ensureConfigFile: (_w: string, onError?: (e: unknown) => void) => onError?.(new Error("EACCES: cannot write")),
    importBackup: () => {
      throw new Error("corrupt backup");
    },
  });
  await createAiContextHooks(deps);
  assert.ok(messages.some((m) => /config.*EACCES/i.test(m)));
  assert.ok(messages.some((m) => /Backup restore failed \(chunks\).*corrupt backup/.test(m)));
});

test("bundled skills are installed on start unless install_skills is false; failures are reported", async () => {
  let installs = 0;
  const messages: string[] = [];
  const base = progressDeps({
    osNotify: (m: string) => void messages.push(m),
    osNotifyGate: { shouldNotify: () => false },
  }).deps;
  await createAiContextHooks({
    ...base,
    installSkills: () => (installs++, { installed: [], problems: [new Error("EROFS")] }),
  });
  assert.equal(installs, 1);
  assert.ok(messages.some((m) => /install bundled skill.*EROFS/.test(m)));

  await createAiContextHooks({
    ...base,
    configFile: { installSkills: false },
    installSkills: () => (installs++, { installed: [], problems: [] }),
  });
  assert.equal(installs, 1);
});

test("the status file is added to .opencode/.gitignore on start and failures are reported", async () => {
  const calls: string[] = [];
  const messages: string[] = [];
  const { deps } = progressDeps({
    osNotify: (m: string) => void messages.push(m),
    osNotifyGate: { shouldNotify: () => false },
    ensureGitignore: (w: string, onError?: (e: unknown) => void) => {
      calls.push(w);
      onError?.(new Error("EACCES"));
    },
  });
  await createAiContextHooks(deps);
  assert.deepEqual(calls, ["/tmp/project-progress"]);
  assert.ok(messages.some((m) => /\.gitignore.*EACCES/.test(m)));
});

test("the system-prompt hook appends the agent hint once; agent_hint:false turns it off", async () => {
  const { deps } = progressDeps();
  const hooks = await createAiContextHooks(deps);
  const out = { system: ["base"] };
  await hooks["experimental.chat.system.transform"]!({ model: {} } as never, out as never);
  assert.equal(out.system.length, 2);
  assert.match(out.system[1]!, /semantic_search/);

  const off = await createAiContextHooks({ ...deps, configFile: { agentHint: false } });
  const out2 = { system: ["base"] };
  await off["experimental.chat.system.transform"]!({ model: {} } as never, out2 as never);
  assert.deepEqual(out2.system, ["base"]);
});

test("the system-prompt hook lists linked repos by stable name, re-read on every call", async () => {
  let keys = ["tlt-platform"];
  const { deps } = progressDeps({ readAllowlist: () => keys });
  const hooks = await createAiContextHooks(deps);
  const out = { system: ["base"] };
  await hooks["experimental.chat.system.transform"]!({ model: {} } as never, out as never);
  assert.equal(out.system.length, 3);
  assert.match(out.system[2]!, /tlt-platform/);

  keys = ["tlt-platform", "libfoo"];
  const out2 = { system: ["base"] };
  await hooks["experimental.chat.system.transform"]!({ model: {} } as never, out2 as never);
  assert.match(out2.system[2]!, /libfoo/);

  const off = await createAiContextHooks({ ...deps, configFile: { agentHint: false } });
  const out3 = { system: ["base"] };
  await off["experimental.chat.system.transform"]!({ model: {} } as never, out3 as never);
  assert.deepEqual(out3.system, ["base"]);
});

test("the plugin registers a repo_structure tool and the agent hint mentions it", async () => {
  const { deps } = progressDeps();
  const hooks = await createAiContextHooks(deps);
  assert.ok(hooks.tool?.repo_structure, "repo_structure tool missing");
  const out = { system: [] as string[] };
  await hooks["experimental.chat.system.transform"]!({ model: {} } as never, out as never);
  assert.match(out.system[0]!, /repo_structure/);
});

test("AiContextPlugin keeps found code locations through compaction", async () => {
  const hooks = await AiContextPlugin(mockPluginInput());
  await hooks["tool.execute.after"]!(
    { tool: "find_symbol", sessionID: "s1", callID: "c1", args: {} } as any,
    {
      title: "",
      output: JSON.stringify({ matches: [{ name: "Foo", path: "src/foo.ts", startLine: 2, endLine: 4 }] }),
      metadata: {},
    } as any,
  );
  const out = { context: [] as string[] };
  await hooks["experimental.session.compacting"]!({ sessionID: "s1" } as any, out as any);
  assert.equal(out.context.length, 1);
  assert.match(out.context[0]!, /src\/foo\.ts:2-4 \(Foo\)/);
  const none = { context: [] as string[] };
  await hooks["experimental.session.compacting"]!({ sessionID: "other" } as any, none as any);
  assert.equal(none.context.length, 0);
});

test("startup reconciliation removes indexed files that no longer exist and holds the index lease", async () => {
  const store = realCreateVectorStore({ path: ":memory:" });
  store.upsertChunks([
    { id: "gone.ts:1-1", relativePath: "gone.ts", language: "typescript", text: "x", startLine: 1, endLine: 1, chunkType: "function", vector: [1, 2] },
  ]);
  let leased = 0;
  const { deps } = progressDeps({
    createVectorStore: () => store,
    walkRepoFiles: async () => ["a.ts"],
    indexLease: { run: async <T>(job: () => Promise<T>) => (leased++, job()) },
  });
  await createAiContextHooks(deps);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(store.listFiles().map((f) => f.relativePath), ["a.ts"]);
  assert.equal(leased, 1);
});

test("createAiContextHooks does nothing but notify when the worktree is the filesystem root (non-git folder)", async () => {
  const messages: string[] = [];
  const touched: string[] = [];
  const hooks = await createAiContextHooks({
    worktree: "/",
    osNotify: (m) => messages.push(m),
    osNotifyGate: { shouldNotify: () => true },
    ensureConfigFile: (w) => touched.push(`config:${w}`),
    ensureGitignore: (w) => touched.push(`gitignore:${w}`),
    installSkills: (w) => {
      touched.push(`skills:${w}`);
      return { installed: [], problems: [] };
    },
    reconcileOnStartup: async () => {
      touched.push("reconcile");
    },
  });
  assert.deepEqual(touched, []);
  assert.equal(hooks.tool, undefined);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /not a git repository/i);
  assert.match(messages[0], /no indexing/i);
});

test("non-git notice gate key is stable per directory and differs between directories", () => {
  assert.equal(nonGitNoticeGateKey("/a/b"), nonGitNoticeGateKey("/a/b"));
  assert.notEqual(nonGitNoticeGateKey("/a/b"), nonGitNoticeGateKey("/a/c"));
  assert.match(nonGitNoticeGateKey(undefined), /^non-git-/);
});

test("startup reconciliation also removes doc trees of files that no longer exist", async () => {
  const docTreeStore = realCreateDocTreeStore({ path: ":memory:" });
  docTreeStore.upsertTree("gone.md", { description: null, nodeCount: 0, nodes: [] });
  const { deps } = progressDeps({
    createDocTreeStore: () => docTreeStore,
    walkRepoFiles: async () => ["a.ts"],
  });
  await createAiContextHooks(deps);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(docTreeStore.getTree("gone.md"), null);
});

/** reindex_chunks / reindex_summaries: forced once, then switched off in the config file. */

async function runReindexStartup(overrides: Record<string, unknown>) {
  const resets: string[] = [];
  const { snapshots, deps } = progressDeps({
    walkRepoFiles: async () => ["a.ts"],
    resetReindexFlags: (worktree: string) => (resets.push(worktree), true),
    ...overrides,
  });
  await createAiContextHooks(deps);
  for (let i = 0; i < 100 && snapshots.at(-1)?.running !== false; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  return resets;
}

test("a finished forced re-index switches the config flags off again", async () => {
  const resets = await runReindexStartup({ configFile: { reindexChunks: true } });
  assert.deepEqual(resets, ["/tmp/project-progress"]);
});

test("without reindex flags the config file is not touched", async () => {
  assert.deepEqual(await runReindexStartup({ configFile: {} }), []);
});

test("a forced re-index that failed keeps the flags on so it runs again", async () => {
  const resets = await runReindexStartup({
    configFile: { reindexSummaries: true },
    readFile: async () => {
      throw new Error("unreadable");
    },
  });
  assert.deepEqual(resets, []);
});


/** `enabled` (default false): a disabled plugin only provides the config file and does nothing else. */

async function withEnabledEnv<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.AI_CONTEXT_PLUGIN_ENABLED;
  if (value === undefined) delete process.env.AI_CONTEXT_PLUGIN_ENABLED;
  else process.env.AI_CONTEXT_PLUGIN_ENABLED = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.AI_CONTEXT_PLUGIN_ENABLED;
    else process.env.AI_CONTEXT_PLUGIN_ENABLED = previous;
  }
}

function disabledProbe() {
  const touched: string[] = [];
  const { deps } = progressDeps({
    createVectorStore: () => (touched.push("vectorStore"), realCreateVectorStore({ path: ":memory:" })),
    walkRepoFiles: async () => (touched.push("walk"), []),
    installSkills: () => (touched.push("skills"), { installed: [], problems: [] }),
    ensureGitignore: () => void touched.push("gitignore"),
    osNotify: () => void touched.push("notify"),
  });
  return { touched, deps };
}

test("a config without `enabled` leaves the plugin off: no hooks, no stores, no indexing", async () => {
  await withEnabledEnv(undefined, async () => {
    const { touched, deps } = disabledProbe();
    assert.deepEqual(await createAiContextHooks({ ...deps, configFile: {} }), {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(touched, []);
  });
});

test("`enabled: false` in the config leaves the plugin off", async () => {
  await withEnabledEnv(undefined, async () => {
    const { touched, deps } = disabledProbe();
    assert.deepEqual(await createAiContextHooks({ ...deps, configFile: { enabled: false } }), {});
    assert.deepEqual(touched, []);
  });
});

test("`enabled: true` in the config switches the plugin on", async () => {
  await withEnabledEnv(undefined, async () => {
    const { deps } = disabledProbe();
    const hooks = await createAiContextHooks({ ...deps, configFile: { enabled: true } });
    assert.ok(hooks.tool);
  });
});

test("AI_CONTEXT_PLUGIN_ENABLED overrides the config in both directions", async () => {
  const { deps } = disabledProbe();
  await withEnabledEnv("0", async () => {
    assert.deepEqual(await createAiContextHooks({ ...deps, configFile: { enabled: true } }), {});
  });
  await withEnabledEnv("true", async () => {
    assert.ok((await createAiContextHooks({ ...deps, configFile: { enabled: false } })).tool);
  });
});

test("a disabled plugin still creates the missing config file, with `enabled: false`", async () => {
  await withEnabledEnv(undefined, async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-context-disabled-"));
    const { touched, deps } = disabledProbe();
    assert.deepEqual(await createAiContextHooks({ ...deps, worktree: dir }), {});
    const file = path.join(dir, ".opencode", "ai-context.config.yaml");
    assert.match(fs.readFileSync(file, "utf8"), /^enabled: false$/m);
    assert.deepEqual(touched, []);
  });
});

test("a 401 from the summary LLM becomes an OS popup and an index status notice with the fix", async () => {
  const popups: string[] = [];
  const fetchMock = mock.method(globalThis, "fetch", async () => new Response("denied", { status: 401 }));
  try {
    const { snapshots, deps } = progressDeps({
      walkRepoFiles: async () => ["a.ts"],
      readFile: async () => "one\n\ntwo",
      osNotify: (m: string) => void popups.push(m),
    });
    await createAiContextHooks({ ...deps, configFile: { enabled: true } } as never);
    for (let i = 0; i < 100 && snapshots.at(-1)?.running !== false; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(fetchMock.mock.callCount() > 0);
    assert.ok(popups.some((m) => /API key not set/.test(m) && /AI_CONTEXT_SUMMARY_LLM_API_KEY/.test(m)), popups.join("|"));
    assert.ok(snapshots.at(-1)!.notices.some((n) => /export AI_CONTEXT_SUMMARY_LLM_API_KEY=/.test(n)));
  } finally {
    fetchMock.mock.restore();
  }
});

test("tool_log writes requests and response summaries to tool.log.md; off by default", async () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "toollog-plugin-"));
  const call = { tool: "find_symbol", sessionID: "s1", callID: "c1" };
  const logFile = path.join(worktree, ".opencode", "ai-context", "tool.log.md");

  const off = await createAiContextHooks(progressDeps({ worktree }).deps);
  await off["tool.execute.before"]!(call as never, { args: { query: "X" } } as never);
  assert.equal(fs.existsSync(logFile), false);

  const on = await createAiContextHooks(progressDeps({ worktree, configFile: { toolLog: true } }).deps);
  await on["tool.execute.before"]!(call as never, { args: { query: "BlobStore" } } as never);
  await on["tool.execute.after"]!(call as never, { title: "", output: JSON.stringify({ matches: [] }), metadata: {} } as never);
  const md = fs.readFileSync(logFile, "utf8");
  assert.match(md, /find_symbol/);
  assert.match(md, /BlobStore/);
  assert.match(md, /empty result/);
  fs.rmSync(worktree, { recursive: true, force: true });
});

test("tool_log_full_responses alone logs nothing; it only takes effect together with tool_log", async () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "toollog-full-"));
  const call = { tool: "read", sessionID: "s1", callID: "c1" };
  const logFile = path.join(worktree, ".opencode", "ai-context", "tool.log.md");
  const out = { title: "", output: "FULL-TEXT-" + "a".repeat(300), metadata: {} };

  const fullOnly = await createAiContextHooks(progressDeps({ worktree, configFile: { toolLogFullResponses: true } }).deps);
  await fullOnly["tool.execute.before"]!(call as never, { args: { path: "x" } } as never);
  await fullOnly["tool.execute.after"]!(call as never, out as never);
  assert.equal(fs.existsSync(logFile), false);

  const both = await createAiContextHooks(progressDeps({ worktree, configFile: { toolLog: true, toolLogFullResponses: true } }).deps);
  await both["tool.execute.before"]!(call as never, { args: { path: "x" } } as never);
  await both["tool.execute.after"]!(call as never, out as never);
  assert.match(fs.readFileSync(logFile, "utf8"), /FULL-TEXT-a{300}/);
  fs.rmSync(worktree, { recursive: true, force: true });
});

test("createAiContextHooks' event hook relativizes absolute watcher paths to the worktree", async () => {
  const notify = mock.fn();
  const hooks = await createAiContextHooks({
    worktree: "/tmp/project",
    reconcileOnStartup: async () => {},
    scheduler: { notify, flush: async () => {} },
  });
  const fire = (file: string) =>
    hooks.event!({
      event: { type: "file.watcher.updated", properties: { file, event: "change" } } as any,
    });
  await fire("/tmp/project/src/a/B.kt");
  await fire("/elsewhere/x.kt");
  await fire("/tmp/project");
  assert.equal(notify.mock.callCount(), 1);
  assert.deepEqual(notify.mock.calls[0]!.arguments, ["src/a/B.kt", "change"]);
});

test("enableFileWatcher sets the opencode watcher flag unless the user disabled it", async () => {
  const { enableFileWatcher } = await import("../../src/hook/plugin.js");
  const a: NodeJS.ProcessEnv = {};
  enableFileWatcher(a);
  assert.equal(a.OPENCODE_EXPERIMENTAL_FILEWATCHER, "true");
  const b: NodeJS.ProcessEnv = { OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1" };
  enableFileWatcher(b);
  assert.equal(b.OPENCODE_EXPERIMENTAL_FILEWATCHER, undefined);
  const c: NodeJS.ProcessEnv = { OPENCODE_EXPERIMENTAL_FILEWATCHER: "false" };
  enableFileWatcher(c);
  assert.equal(c.OPENCODE_EXPERIMENTAL_FILEWATCHER, "false");
});

test("file-editing tool calls index just the touched file; shell falls back to a full rescan; idle rescans are throttled", async () => {
  const notify = mock.fn();
  const rescan = mock.fn(async () => 1);
  const hooks = await createAiContextHooks({
    worktree: "/tmp/project",
    reconcileOnStartup: async () => {},
    scheduler: { notify, flush: async () => {} },
    rescan,
  });
  const after = async (tool: string, args: unknown) =>
    hooks["tool.execute.after"]!({ tool, sessionID: "s", callID: "c", args }, { output: "" });

  await after("edit", { filePath: "/tmp/project/src/a.ts" });
  await after("apply_patch", { patchText: "*** Delete File: src/old.ts\n*** Add File: src/new.ts" });
  assert.deepEqual(
    notify.mock.calls.map((c) => c.arguments),
    [["src/a.ts", "change"], ["src/old.ts", "unlink"], ["src/new.ts", "change"]],
  );
  await after("edit", { filePath: "/elsewhere/x.ts" }); // outside the worktree: ignored
  assert.equal(notify.mock.callCount(), 3);
  assert.equal(rescan.mock.callCount(), 0);

  await after("shell", { command: "git pull" });
  await hooks.event!({ event: { type: "session.idle" } });
  await new Promise((r) => setTimeout(r, 3300));
  assert.equal(rescan.mock.callCount(), 1, "shell + idle within one debounce window coalesce into one rescan");

  await hooks.event!({ event: { type: "session.idle" } }); // within 30 s of the last run: skipped
  await new Promise((r) => setTimeout(r, 3300));
  assert.equal(rescan.mock.callCount(), 1);
});
