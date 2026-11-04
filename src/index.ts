/**
 * Package entry point. Kept deliberately thin: the plugin core lives in
 * `hook/plugin.ts` (`createAiContextHooks`, a testable, dependency-injectable
 * hook set); this file only exposes it to the two plugin loaders:
 *
 *  - OpenCode 2.x reads `id` + `setup(ctx)` (see `hook/v2-plugin.ts`).
 *  - OpenCode 1.x (>= 1.18.29) reads `id` + `server()` (the legacy hook function).
 *
 * The two APIs stay separate; the shared default export only lets one bundle
 * run on both. Do NOT add further function exports here: for the legacy format
 * opencode 1.x would call every exported function as a plugin (second instance).
 * Tests import `createAiContextHooks` directly from "./hook/plugin.js".
 */
import { AiContextPlugin } from "./hook/plugin.js";
import { createV2Plugin } from "./hook/v2-plugin.js";

const v2 = createV2Plugin();

const plugin = {
  id: v2.id,
  setup: v2.setup,
  server: AiContextPlugin,
};

export default plugin;
