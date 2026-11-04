import { z } from "zod";

/**
 * Host-neutral tool definition helper.
 *
 * The tools used to import `tool` from `@opencode-ai/plugin` (V1 SDK). That
 * package does not exist at runtime under OpenCode 2.x, and a runtime import
 * would break the bundle there. A V1 tool is just `{ description, args, execute }`
 * with zod args, so the plugin keeps that shape (same call sites, same tests)
 * and owns the tiny helper itself:
 *
 *  - OpenCode 1.x gets the object as-is (`hook/plugin.ts` returns it in `tool`).
 *  - OpenCode 2.x gets it converted to a JSON-Schema tool by `hook/v2-plugin.ts`.
 */

export interface ToolContext {
  sessionID?: string;
  messageID?: string;
  agent?: string;
  abort?: AbortSignal;
  [key: string]: unknown;
}

export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  description: string;
  args: Shape;
  execute(args: z.infer<z.ZodObject<Shape>>, context: ToolContext): Promise<string>;
}

export function tool<Shape extends z.ZodRawShape>(def: ToolDefinition<Shape>): ToolDefinition<Shape> {
  return def;
}
tool.schema = z;
