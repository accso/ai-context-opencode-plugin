#!/usr/bin/env bash
# Installs the bundled ai-context-opencode-plugin into OpenCode's GLOBAL
# plugin directory (~/.config/opencode/plugins/), as
# `accso-ai-context.js`, and ensures its native runtime dependencies
# (onnxruntime-node, tokenizers, @huggingface/hub,
# ignore, @opentelemetry/api, web-tree-sitter + grammar packages) are resolvable from there.
#
# Why global, not project-level (`.opencode/plugins/`): this plugin is
# meant to be usable across every repo a contributor works in, not
# re-installed per project (see docs/adr/0015-single-bundled-plugin-file.md).
#
# Why a package.json in the config directory: OpenCode's local-plugin
# loader does not `npm install` a plugin's own dependencies -- for a
# single bundled JS file to `import` native packages like
# `better-sqlite3` at runtime, those packages must already be resolvable
# from OpenCode's own config directory. OpenCode runs `bun install`
# against `~/.config/opencode/package.json` at startup (see
# https://opencode.ai/v2/docs/build/plugins (1.x: https://opencode.ai/docs/plugins/#dependencies)), so this script
# merges this plugin's runtime dependency versions into that file
# instead of overwriting whatever else may already be listed there
# (e.g. another plugin's own dependencies).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"
BUNDLE_NAME="accso-ai-context.js"
BUNDLE_SRC="$PLUGIN_ROOT/dist/$BUNDLE_NAME"

OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
PLUGIN_DIR="$OPENCODE_CONFIG_DIR/plugins"
DEPS_PACKAGE_JSON="$OPENCODE_CONFIG_DIR/package.json"

if [ ! -f "$BUNDLE_SRC" ]; then
  echo "error: $BUNDLE_SRC not found -- run 'npm run build' (or 'mise run build') first." >&2
  exit 1
fi

mkdir -p "$PLUGIN_DIR"
cp "$BUNDLE_SRC" "$PLUGIN_DIR/$BUNDLE_NAME"
if [ -f "$BUNDLE_SRC.map" ]; then
  cp "$BUNDLE_SRC.map" "$PLUGIN_DIR/$BUNDLE_NAME.map"
fi
echo "Installed $BUNDLE_NAME -> $PLUGIN_DIR/$BUNDLE_NAME"

# Shared embedding worker: lives next to (NOT inside) plugins/, because
# opencode loads every file in plugins/ as a plugin. Resolves its native
# deps from $OPENCODE_CONFIG_DIR/node_modules like the plugin does.
WORKER_NAME="ai-context-worker.mjs"
if [ -f "$PLUGIN_ROOT/dist/$WORKER_NAME" ]; then
  cp "$PLUGIN_ROOT/dist/$WORKER_NAME" "$OPENCODE_CONFIG_DIR/$WORKER_NAME"
  echo "Installed $WORKER_NAME -> $OPENCODE_CONFIG_DIR/$WORKER_NAME"
fi

# Merge (not overwrite) this plugin's runtime deps into the config
# directory's package.json, so a second plugin's own setup script run
# later doesn't clobber this one's entries (or vice versa).
node --input-type=module -e '
import fs from "node:fs";
import path from "node:path";

const pluginRoot = process.argv[1];
const depsPackageJsonPath = process.argv[2];

const pluginPkg = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8"));
// Keep in sync with scripts/build.mjs'"'"'s EXTERNAL_RUNTIME_DEPS list --
// every dependency actually imported at runtime by the bundled file
// (i.e. NOT inlined into it) needs to be resolvable here. "yaml" is
// intentionally excluded: it is bundled INTO accso-ai-context.js (pure
// JS, no native addon), so it does not need to be listed here.
// better-sqlite3 is deliberately absent: inside OpenCode (Bun) the stores use the
// built-in bun:sqlite (src/storage/sqlite.ts), and Bun crashes on a native
// addon whose install script never ran.
const EXTERNAL_RUNTIME_DEPS = [
  "onnxruntime-node",
  "tokenizers",
  "@huggingface/hub",
  "ignore",
  "@opentelemetry/api",
  "@opentelemetry/sdk-metrics",
  "@opentelemetry/exporter-metrics-otlp-http",
  "@opentelemetry/resources",
  "@opentelemetry/semantic-conventions",
  "web-tree-sitter",
  // Loaded at runtime via require.resolve("<pkg>/<file>.wasm"), not imported.
  "tree-sitter-c-sharp",
  "tree-sitter-java",
  "tree-sitter-python",
  "tree-sitter-typescript",
  "tree-sitter-javascript",
  "@tree-sitter-grammars/tree-sitter-kotlin",
  "tree-sitter-go",
  "tree-sitter-rust",
  "tree-sitter-ruby",
  "tree-sitter-c",
  "tree-sitter-cpp",
];

let depsPkg = { name: "opencode-config-dependencies", private: true, dependencies: {} };
if (fs.existsSync(depsPackageJsonPath)) {
  depsPkg = JSON.parse(fs.readFileSync(depsPackageJsonPath, "utf8"));
  depsPkg.dependencies ??= {};
}

let changed = false;
for (const dep of EXTERNAL_RUNTIME_DEPS) {
  const version = pluginPkg.dependencies[dep];
  if (!version) {
    throw new Error(`expected ${dep} in ai-context-opencode-plugin/package.json dependencies`);
  }
  if (depsPkg.dependencies[dep] !== version) {
    depsPkg.dependencies[dep] = version;
    changed = true;
  }
}

if (changed) {
  fs.writeFileSync(depsPackageJsonPath, JSON.stringify(depsPkg, null, 2) + "\n");
  console.log(`Merged runtime dependencies into ${depsPackageJsonPath}`);
} else {
  console.log(`${depsPackageJsonPath} already up to date`);
}
' "$PLUGIN_ROOT" "$DEPS_PACKAGE_JSON"

# Install the dependencies right away instead of waiting for OpenCode's
# next startup, so a freshly added grammar/native package can't be missing
# when the plugin first loads. Same package manager OpenCode itself uses
# (bun), with npm as fallback. Skip with SKIP_DEPS_INSTALL=1.
if [ "${SKIP_DEPS_INSTALL:-0}" != "1" ]; then
  echo
  if command -v bun >/dev/null 2>&1; then
    echo "Installing dependencies with bun in $OPENCODE_CONFIG_DIR ..."
    (cd "$OPENCODE_CONFIG_DIR" && bun install)
  elif command -v npm >/dev/null 2>&1; then
    echo "bun not found; installing dependencies with npm in $OPENCODE_CONFIG_DIR ..."
    (cd "$OPENCODE_CONFIG_DIR" && npm install --no-audit --no-fund)
  else
    echo "warning: neither bun nor npm found; OpenCode will install dependencies at its next startup." >&2
  fi

  # Verify every external dependency actually resolved, and that each
  # tree-sitter grammar ships the .wasm the loader needs.
  missing=$(node --input-type=module -e '
    import fs from "node:fs";
    import path from "node:path";
    const [pluginRoot, configDir] = process.argv.slice(1);
    const deps = Object.keys(JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8")).dependencies);
    const external = JSON.parse(fs.readFileSync(path.join(configDir, "package.json"), "utf8")).dependencies;
    const missing = [];
    for (const dep of Object.keys(external)) {
      if (!deps.includes(dep)) continue;
      const dir = path.join(configDir, "node_modules", dep);
      if (!fs.existsSync(dir)) { missing.push(dep); continue; }
      if (/tree-sitter-/.test(dep) && !fs.readdirSync(dir).some((f) => f.endsWith(".wasm"))) missing.push(`${dep} (no .wasm)`);
    }
    console.log(missing.join(", "));
  ' "$PLUGIN_ROOT" "$OPENCODE_CONFIG_DIR")
  if [ -n "$missing" ]; then
    echo "error: dependencies not resolvable after install: $missing" >&2
    exit 1
  fi
  echo "All plugin dependencies are installed."
fi

echo
echo "Done. OpenCode 2.x reloads the plugin on its own (or run /reload); on 1.x restart OpenCode."
