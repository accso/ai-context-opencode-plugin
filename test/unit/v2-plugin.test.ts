import assert from "node:assert/strict";
import test from "node:test";
import { tool } from "../../src/tools/tool-def.js";
import {
  createV2Plugin,
  registerHooks,
  resolveWorktree,
  resultText,
  toV2Tool,
} from "../../src/hook/v2-plugin.js";
import type { AiContextHooks } from "../../src/hook/plugin.js";

function fakeCtx(events: unknown[] = []) {
  const registered: Record<string, any> = {};
  const tools: any[] = [];
  const controller: { signal?: AbortSignal } = {};
  const ctx = {
    location: { directory: "/w/repo", project: { id: "p1", directory: "/w/repo", canonical: "/w/repo" } },
    tool: {
      transform: async (cb: (e: any) => void) => cb({ add: (t: any) => tools.push(t) }),
      hook: async (name: string, cb: any) => void (registered[`tool.${name}`] = cb),
    },
    session: { hook: async (name: string, cb: any) => void (registered[`session.${name}`] = cb) },
    event: {
      subscribe: (o: { signal: AbortSignal }) => {
        controller.signal = o.signal;
        return (async function* () {
          for (const e of events) yield e;
        })();
      },
    },
  };
  return { ctx: ctx as never, registered, tools, controller };
}

const greet = tool({
  description: "greets",
  args: { name: tool.schema.string(), times: tool.schema.number().int().default(2) },
  async execute(args) {
    return `hi ${args.name} x${args.times}`;
  },
});

test("toV2Tool converts zod args to JSON Schema and applies defaults/validation", async () => {
  const t = toV2Tool("greet", greet);
  const schema = t.input as any;
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["name"]);
  assert.equal(schema.$schema, undefined);
  assert.deepEqual(await t.execute({ name: "a" }, {}), { content: "hi a x2" });
  const bad = await t.execute({ times: "x" }, {});
  assert.match(JSON.parse(bad.content).error, /Invalid arguments for greet/);
});

test("resultText flattens string and part-list content", () => {
  assert.equal(resultText({ content: "x" }), "x");
  assert.equal(
    resultText({ content: [{ type: "text", text: "a" }, { type: "file", uri: "u" }, { type: "text", text: "b" }] }),
    "a\nb",
  );
  assert.equal(resultText(undefined), "");
});

test("resolveWorktree stays inert (root) for the global project", () => {
  assert.equal(resolveWorktree({ project: { id: "global", directory: "/home/u" } }), "/");
  assert.equal(resolveWorktree({ project: { id: "abc", directory: "/w/repo" } }), "/w/repo");
});

test("registerHooks maps every hook onto the 2.x API", async () => {
  const seen: Record<string, unknown> = {};
  const hooks: AiContextHooks = {
    tool: { greet },
    "tool.execute.before": async (i, o) => void (seen.before = { i, o }),
    "tool.execute.after": async (i, o) => void (seen.after = { i, o }),
    "experimental.chat.system.transform": async (_i, o) => void o.system.push("HINT"),
    "experimental.session.compacting": async (i, o) => void o.context.push(`mem:${i.sessionID}`),
    event: async (e) => void (e.event.type !== "session.idle" && (seen.event = e)),
  };
  const { ctx, registered, tools, controller } = fakeCtx([
    { type: "filesystem.changed", data: { file: "/w/repo/a.kt", event: "change" } },
    { type: "session.idle", data: {} },
  ]);
  const idleSeen: unknown[] = [];
  const baseEvent = hooks.event!;
  hooks.event = async (e) => {
    if (e.event.type === "session.idle") idleSeen.push(e);
    await baseEvent(e);
  };
  const cleanup = await registerHooks(ctx, hooks);
  assert.deepEqual(tools.map((t) => t.name), ["greet"]);

  await registered["tool.execute.before"]({ tool: "grep", sessionID: "s", id: "c", input: { pattern: "x" } });
  assert.deepEqual(seen.before, { i: { tool: "grep", sessionID: "s", callID: "c" }, o: { args: { pattern: "x" } } });

  await registered["tool.execute.after"]({ tool: "grep", sessionID: "s", id: "c", input: {}, status: "completed", result: { content: "out" } });
  assert.equal((seen.after as any).o.output, "out");
  await registered["tool.execute.after"]({ tool: "grep", sessionID: "s", id: "c", input: {}, status: "error", error: { message: "boom" } });
  assert.equal((seen.after as any).o.output, "boom");

  const ctxEvent = { system: [{ type: "text", text: "base" }] as any[] };
  await registered["session.context"](ctxEvent);
  assert.deepEqual(ctxEvent.system.map((p) => p.text), ["base", "HINT"]);

  const compaction = { sessionID: "s", system: [] as any[] };
  await registered["session.compaction"](compaction);
  assert.deepEqual(compaction.system, [{ type: "text", text: "mem:s" }]);

  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen.event, {
    event: { type: "file.watcher.updated", properties: { file: "/w/repo/a.kt", event: "change" } },
  });

  assert.equal(idleSeen.length, 1);
  await cleanup();
  assert.equal(controller.signal?.aborted, true);
  assert.deepEqual(seen.event, { event: { type: "server.instance.disposed" } });
});

test("createV2Plugin passes worktree and directory to the core", async () => {
  let deps: any;
  const plugin = createV2Plugin({
    createHooks: async (d) => {
      deps = d;
      return {};
    },
  });
  const { ctx } = fakeCtx();
  await plugin.setup(ctx);
  assert.deepEqual(deps, { worktree: "/w/repo", directory: "/w/repo", host: "v2" });
});

test("toV2Tool lists only the everyday lookup tools directly (codemode: false)", () => {
  for (const name of ["semantic_search", "find_symbol", "repo_structure", "analyze_impact", "search_docs", "index_status"]) {
    assert.equal((toV2Tool(name, greet) as any).options.codemode, false, name);
  }
  for (const name of ["ai_context_rescan", "ai_context_export_backup"]) {
    assert.equal((toV2Tool(name, greet) as any).options.codemode, true, name);
  }
});
