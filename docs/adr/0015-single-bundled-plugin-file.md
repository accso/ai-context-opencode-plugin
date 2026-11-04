# ADR-0015: Single bundled plugin file, installed to OpenCode's global plugin directory

## Status

Accepted (packaging/setup, user-directed, 2026-09-16).

## Context

OpenCode loads **local plugins** directly from a plugin directory --
either `.opencode/plugins/` (project-level) or
`~/.config/opencode/plugins/` (global) -- with no build/install step of
its own: whatever JS/TS file is in that directory is loaded as-is at
startup. This package, however, is developed as a normal multi-module
TypeScript project (`src/hook/`, `src/storage/`, `src/embedding/`, etc.)
with `node_modules` dependencies, some of which ship native addons
(`better-sqlite3`, `onnxruntime-node`, `tokenizers`).

Two related questions needed answers: (1) how does a multi-file TS
source tree become the single file layout OpenCode's local-plugin
loader expects, and (2) where do a local plugin's native npm
dependencies get resolved from, since OpenCode does not run `npm
install`/`bun install` against the plugin directory itself.

Per OpenCode's own docs (https://opencode.ai/docs/plugins/#dependencies):
local plugins needing external packages must have a `package.json`
placed in OpenCode's own **config directory** (`~/.config/opencode/`),
against which OpenCode runs `bun install` at startup, caching the result
in `~/.cache/opencode/node_modules/`.

## Decision

- **Bundle, don't ship source.** `scripts/build.mjs` (esbuild) bundles
  `src/index.ts` into one file, `dist/accso-ai-context.js` (ESM,
  `node18` target, with a sourcemap). This plugin's OWN `src/` modules
  are inlined; native/non-inlinable runtime dependencies
  (`better-sqlite3`, `onnxruntime-node`, `tokenizers`,
  `@huggingface/hub`, `ignore`, `@opentelemetry/api`) are marked
  `external` and stay as plain `import` statements resolved from
  `node_modules` at runtime, same as any normal npm consumer would
  resolve them. `yaml` is deliberately NOT external -- it's pure JS with
  no native addon, so esbuild inlines it like this plugin's own code.
- **Install to the GLOBAL plugin directory** (`~/.config/opencode/
  plugins/accso-ai-context.js`), not the project-level one. This plugin
  is meant to be usable across every repo a contributor works in (see
  ADR-0002's per-project SQLite isolation, which already makes one
  globally-installed plugin instance safe to reuse across many
  worktrees/sessions) -- a project-level install would mean
  re-installing into every single repo instead of once per machine.
- **`scripts/install-plugin.sh`** copies the bundle to the global plugin
  directory, then merges (not overwrites) this plugin's runtime
  dependency versions into `~/.config/opencode/package.json`, so a
  second, unrelated plugin's own dependencies already listed there (or
  added later by that plugin's own setup script) are preserved rather
  than clobbered. OpenCode's own `bun install` at its next startup then
  resolves them -- this script does not run `bun`/`npm install` itself.
- **`accso-ai-context` as the file/tool-family name** (user-directed) --
  distinct from the working directory's own name
  (`ai-context-opencode-plugin`), matching what will be a different,
  more product-facing name once extracted to its own repository.
- **`mise.toml` + `mise run setup`** wraps `install-plugin.sh` (via a
  `depends: [build]` task chain) as the one-command entry point, and
  separately pins the dev/build/test Node toolchain version -- see the
  file's own header comment for why it's fully self-contained and
  doesn't merge with (or depend on) the parent `ai-context` monorepo's
  own `mise.toml`.

## Consequences

- A contributor (or, eventually, an end user once this is a published
  package) runs one command (`mise run setup`, or `npm run build &&
  ./scripts/install-plugin.sh` without mise) and gets a working global
  install, without needing to understand OpenCode's local-plugin
  dependency-resolution mechanism themselves.
- Re-running the install script after a rebuild is safe and idempotent:
  it always overwrites `accso-ai-context.js` itself (that's the point of
  reinstalling a new build) but only adds/updates this plugin's OWN
  dependency entries in the shared config-directory `package.json`,
  never removing or overwriting unrelated entries another plugin may
  have added.
- `scripts/build.mjs`'s `EXTERNAL_RUNTIME_DEPS` list and
  `install-plugin.sh`'s own copy of that list must be kept in sync
  manually (both files carry a comment saying so) -- a genuine, accepted
  maintenance cost of not sharing a single source of truth between an
  esbuild config and a bash script; revisit if this drifts in practice.
- Sourcemap (`accso-ai-context.js.map`) is copied alongside the bundle
  for stack traces during local debugging; `dist/` itself is
  gitignored -- it's a build artifact, not source.

## Alternatives considered

- **Publish to npm, use OpenCode's `plugin: [...]` config-file
  mechanism instead of a local file.** Rejected for now: this package
  isn't published yet (still living inside the parent monorepo, per
  this repo's own README) -- worth revisiting once it's extracted and
  versioned independently; nothing about the bundling step itself needs
  to change if that happens later.
- **Project-level install (`.opencode/plugins/`).** Rejected: would
  require every repo a contributor works in to separately receive the
  bundle/config, instead of once per machine -- see the isolation
  argument above for why one global install is already safe.
- **Ship `src/` unbundled and rely on OpenCode/Bun resolving relative
  imports directly.** Rejected: OpenCode's local-plugin loader expects
  a single loadable file per plugin, not a package directory with its
  own `node_modules`/multi-file module graph.
