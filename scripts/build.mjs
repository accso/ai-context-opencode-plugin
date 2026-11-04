#!/usr/bin/env node
/**
 * Bundles `src/index.ts` -> a single `dist/accso-ai-context.js` file that
 * OpenCode's local-plugin loader can load directly from its plugin
 * directory (see `docs/adr/0015-single-bundled-plugin-file.md`).
 *
 * Runtime npm dependencies that ship native addons (better-sqlite3,
 * onnxruntime-node, tokenizers) or otherwise shouldn't be inlined
 * (@huggingface/hub, ignore, @opentelemetry/api) are marked `external` --
 * esbuild only resolves and bundles THIS package's own `src/` modules
 * into the one output file; the externals stay as plain `import`
 * statements resolved from `node_modules` at runtime, same as any
 * normal npm consumer. `scripts/install-plugin.sh` is what makes those
 * externals resolvable in OpenCode's global config directory.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { EXTERNAL_RUNTIME_DEPS } from "./bundle-config.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outfile = path.join(rootDir, "dist", "accso-ai-context.js");


await build({
  entryPoints: [path.join(rootDir, "src", "index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  sourcemap: true,
  external: EXTERNAL_RUNTIME_DEPS,
  logLevel: "info",
});

// Shared embedding worker (ADR-0021): a separate entry, installed NEXT TO
// (not inside) the plugins dir, since opencode loads every file in there.
const workerOutfile = path.join(rootDir, "dist", "ai-context-worker.mjs");
await build({
  entryPoints: [path.join(rootDir, "src", "worker", "worker-main.ts")],
  outfile: workerOutfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  sourcemap: true,
  external: EXTERNAL_RUNTIME_DEPS,
  logLevel: "info",
});

console.log(`\nBundled plugin written to ${path.relative(rootDir, outfile)}`);
