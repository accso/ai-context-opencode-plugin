/** Shared by scripts/build.mjs and scripts/generate-third-party-licenses.mjs. */
// Keep in sync with package.json's runtime "dependencies" -- every
// package actually imported (not just `import type`-only) at runtime
// belongs here so it's neither bundled nor silently dropped.
export const EXTERNAL_RUNTIME_DEPS = [
  "better-sqlite3",
  "onnxruntime-node",
  "tokenizers",
  "@huggingface/hub",
  "web-tree-sitter",
  "ignore",
  "@opentelemetry/api",
  "@opentelemetry/sdk-metrics",
  "@opentelemetry/exporter-metrics-otlp-http",
  "@opentelemetry/resources",
  "@opentelemetry/semantic-conventions",
  // Type-only import in src/hook/plugin.ts (`import type { ... }`) --
  // erased by esbuild regardless, but marked external for clarity and
  // in case a future change adds a real runtime import from it.
  "@opencode-ai/plugin",
];
