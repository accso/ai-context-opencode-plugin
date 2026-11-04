import { z } from "zod";
import type { Plugin as V2 } from "@opencode/plugin";
import { createAiContextHooks, type AiContextHooks } from "./plugin.js";
import type { ToolDefinition } from "../tools/tool-def.js";
import { NATIVE_SEARCH_TOOL_IDS } from "./search-nudge.js";

/**
 * OpenCode 2.x entry (`Plugin.define({ id, setup })` shape).
 *
 * The plugin core (`createAiContextHooks`) keeps its host-neutral, 1.x-shaped hook
 * set; this module only maps each member onto the 2.x plugin API:
 *
 *   tool map                        -> ctx.tool.transform (JSON-Schema tools)
 *   tool.definition (grep/glob hint) -> ctx.tool.transform(editor.update)
 *   tool.execute.before / after     -> ctx.tool.hook("execute.before" / "execute.after");
 *                                      text the core appends to the output (search nudge) is written back to the result
 *   experimental.chat.system.transform -> ctx.session.hook("context")
 *   experimental.session.compacting -> ctx.session.hook("compaction")
 *   event (file.watcher.updated)    -> ctx.event.subscribe(["filesystem.changed"]); in 2.2.0 that event only
 *                                      fires for files watched via the experimental fs.watch API, so on 2.x
 *                                      indexing is kept fresh by the rescan after shell/edit/write calls
 *   dispose (server.instance.disposed) -> cleanup function returned by setup
 *   config (lsp / file watcher flags) -> dropped: 2.x has no global config object,
 *                                        runs no language servers and always watches files.
 *                                        (The `lsp` switch-on and hints stay for host "v1".)
 *
 * Nothing here imports `@opencode/plugin` at runtime (types only), so the bundle
 * does not depend on how the host resolves that package.
 */

export const PLUGIN_ID = "accso-ai-context";

/**
 * Tools listed directly to the model on 2.x. Every other plugin tool stays behind
 * Code Mode (`execute`), which keeps their schemas out of every request.
 */
export const DIRECT_TOOLS: ReadonlySet<string> = new Set([
  "semantic_search",
  "find_symbol",
  "repo_structure",
  "analyze_impact",
  "search_docs",
  "index_status",
]);

type TextPart = { type: "text"; text: string };

export interface V2Deps {
  /** Injectable for tests. */
  createHooks?: typeof createAiContextHooks;
}

/** Text of a 2.x tool result (`content` is a string or a list of text/file parts). */
export function resultText(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && (part as TextPart).type === "text" ? (part as TextPart).text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Returns a copy of a 2.x tool result with text appended (string or part-list content). */
export function appendToResult<R extends { content?: unknown }>(result: R, extra: string): R {
  if (typeof result.content === "string") return { ...result, content: result.content + extra };
  if (Array.isArray(result.content)) {
    return { ...result, content: [...result.content, { type: "text", text: extra.trim() }] };
  }
  return { ...result, content: extra.trim() };
}

/** The project root a 2.x location maps to; "/" (the plugin's inert marker) for folders outside any project. */
export function resolveWorktree(location: { project: { id: string; directory: string } }): string {
  return location.project.id === "global" ? "/" : location.project.directory;
}

/** Converts one 1.x-style (zod args) tool into a 2.x tool definition (JSON Schema input). */
export function toV2Tool(name: string, def: ToolDefinition<any>) {
  const schema = z.object(def.args);
  const { $schema: _ignored, ...input } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return {
    name,
    description: def.description,
    input: input as never,
    options: { codemode: !DIRECT_TOOLS.has(name) },
    async execute(raw: unknown, context: Record<string, unknown>) {
      const parsed = schema.safeParse(raw ?? {});
      if (!parsed.success) {
        return { content: JSON.stringify({ error: `Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}` }) };
      }
      return { content: await def.execute(parsed.data, context as never) };
    },
  };
}

export function createV2Plugin(deps: V2Deps = {}) {
  const createHooks = deps.createHooks ?? createAiContextHooks;
  return {
    id: PLUGIN_ID,
    async setup(ctx: V2.Context) {
      const hooks: AiContextHooks = await createHooks({
        worktree: resolveWorktree(ctx.location as never),
        directory: ctx.location.directory,
        host: "v2",
      });
      return registerHooks(ctx, hooks);
    },
  };
}

/** Wires a hook set onto a 2.x plugin context; returns the cleanup function. */
export async function registerHooks(ctx: V2.Context, hooks: AiContextHooks): Promise<() => Promise<void>> {
  const tools = Object.entries(hooks.tool ?? {});
  // Transforms are replayed and must be synchronous: resolve the native-tool description
  // suffixes up front and only capture the plain strings.
  const suffixes: Record<string, string> = {};
  if (hooks["tool.definition"]) {
    for (const id of NATIVE_SEARCH_TOOL_IDS) {
      const out = { description: "" };
      await hooks["tool.definition"]({ toolID: id }, out);
      if (out.description.trim()) suffixes[id] = out.description.trim();
    }
  }
  if (tools.length > 0 || Object.keys(suffixes).length > 0) {
    await ctx.tool.transform((editor) => {
      for (const [name, def] of tools) editor.add(toV2Tool(name, def) as never);
      for (const [id, suffix] of Object.entries(suffixes)) {
        editor.update(id, (t) => {
          if (!t.description.includes(suffix)) t.description = `${t.description}\n\n${suffix}`;
        });
      }
    });
  }

  const before = hooks["tool.execute.before"];
  if (before) {
    await ctx.tool.hook("execute.before", async (event) => {
      await before(
        { tool: event.tool, sessionID: event.sessionID, callID: event.id },
        { args: event.input },
      );
    });
  }

  const after = hooks["tool.execute.after"];
  if (after) {
    await ctx.tool.hook("execute.after", async (event) => {
      const original = event.status === "completed" ? resultText(event.result) : event.error.message;
      const out = { output: original };
      await after(
        { tool: event.tool, sessionID: event.sessionID, callID: event.id, args: event.input },
        out,
      );
      // The core may append guidance (search nudge) to a successful result.
      if (event.status === "completed" && out.output !== original && out.output.startsWith(original)) {
        event.result = appendToResult(event.result, out.output.slice(original.length));
      }
    });
  }

  const systemTransform = hooks["experimental.chat.system.transform"];
  if (systemTransform) {
    await ctx.session.hook("context", async (event) => {
      const system = event.system
        .filter((part): part is TextPart => (part as TextPart).type === "text")
        .map((part) => part.text);
      const known = new Set(system);
      await systemTransform({}, { system });
      for (const text of system) {
        if (!known.has(text)) event.system.push({ type: "text", text } as never);
      }
    });
  }

  const compacting = hooks["experimental.session.compacting"];
  if (compacting) {
    await ctx.session.hook("compaction", async (event) => {
      const context: string[] = [];
      await compacting({ sessionID: event.sessionID }, { context });
      for (const text of context) event.system.push({ type: "text", text } as never);
    });
  }

  const onEvent = hooks.event;
  const controller = new AbortController();
  if (onEvent) {
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ types: ["filesystem.changed", "session.idle"], signal: controller.signal })) {
          if (event.type === "session.idle") {
            await onEvent({ event: { type: "session.idle" } });
            continue;
          }
          const { file, event: kind } = (event as { data: { file: string; event: "add" | "change" | "unlink" } }).data;
          await onEvent({ event: { type: "file.watcher.updated", properties: { file, event: kind } } });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error("[ai-context-opencode-plugin] event subscription ended:", error);
        }
      }
    })();
  }

  return async () => {
    controller.abort();
    await onEvent?.({ event: { type: "server.instance.disposed" } });
  };
}
