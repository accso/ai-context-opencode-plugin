# ADR-0014: Team-shared `.opencode/ai-context.config.yaml` with env-var override

## Status

Accepted (config-file feature, user-directed, 2026-09-16). Amended by [ADR-0029](0029-opt-in-enabled-flag-and-default-template.md): the generated file now carries every default as an active value, an `enabled` master switch (off by default) and no secrets; the separate example file was removed. Amended by [ADR-0030](0030-allowlist-in-config-yaml.md): the cross-repo allowlist is the `allowed_repos` key of this file.

## Context

By the time this decision was made, four settings existed, each
configurable ONLY via an `AI_CONTEXT_PLUGIN_*` environment variable:
`AI_CONTEXT_PLUGIN_DATA_DIR` (project-key.ts), `AI_CONTEXT_PLUGIN_EMBED_DIMS`
and `AI_CONTEXT_PLUGIN_MODEL_CACHE_DIR` (model-runtime.ts), and
`AI_CONTEXT_PLUGIN_HEAVY_MODE` (heavy-mode.ts). Env vars are inherently
machine/session-local -- there was no way for a team to commit a shared
default (e.g. "this monorepo always wants `embed_dims: 256`") without
every contributor separately exporting the same env var themselves.

The user asked for a project-level config file, explicitly requesting:
"a full config file loader which read a ai-context.config.yaml... env
vars become overrides on top of the file" -- i.e. env var still wins if
set, but the file becomes the new middle tier between env var and
built-in default.

## Decision

- One YAML file per project: `.opencode/ai-context.config.yaml`, resolved
  via `resolveConfigFilePath(worktree)`. Placed inside `.opencode/`
  alongside this plugin's other worktree-local, team-shareable metadata
  (the repo-local backup, see ADR-0007; since ADR-0030 the cross-repo
  allow-list is a key of this file) -- NOT alongside the live SQLite store,
  which ADR-0003 deliberately keeps OUTSIDE the worktree.
- Precedence, applied per-setting rather than centrally: explicit
  function option (only relevant to this plugin's own tests) > env var
  (if explicitly set) > this config file > built-in default. Each
  consuming module (`resolveDataDir`, `resolveModelCacheDir`,
  `resolveOutputDims`, `isHeavyModeEnabled`) takes the config-file value
  as an additional, final-fallback parameter rather than the config file
  being centrally merged into `process.env` or similar -- keeps each
  setting's precedence contract visible and independently unit-testable
  at its own module, matching this codebase's existing per-module
  resolve-function style.
- YAML keys are snake_case (`data_dir`, `model_cache_dir`, `embed_dims`,
  `heavy_mode`) to match the file's own idiom, mapped to camelCase
  `AiContextConfigFile` fields for the TS side.
- Scope is exactly these 4 existing settings -- no new, previously
  un-configurable internals (e.g. the chunker's `maxLines`) were promoted
  to configurable as part of this change, to keep the increment bounded.
- Fault tolerance mirrors `backup.ts`'s per-row validation: a missing
  file, an empty file, malformed YAML, a non-mapping top level, or a
  wrong-typed known key are all `console.error`-logged and degrade to
  "no override from this key/file" -- never thrown. One bad line in a
  committed config file must not break the whole plugin for every
  contributor who pulls it.

## Consequences

- A team can now commit `embed_dims: 256` (say, for a very large
  monorepo) once, and every contributor gets it automatically, while
  still being able to locally override via an env var for one-off
  debugging without editing the committed file.
- `heavy-mode.ts`'s doc comment previously argued heavy mode is "not a
  repo config file setting... a machine/session performance trade-off,
  not a team convention to version-control" -- this is explicitly
  superseded: it's now also settable via the config file (a team CAN
  commit a shared default), with the env var still available as a
  per-machine override on top, matching the other 3 settings' identical
  treatment. Keeping heavy mode's precedence inconsistent with the other
  3 settings would have been a confusing, unjustified special case.
- `resolveOutputDims`'s existing "env var set but invalid falls straight
  to `undefined`" behavior was deliberately widened to "falls through to
  the config-file value instead" -- a backward-compatible expansion,
  since existing callers that never pass a config-file value see
  identical behavior to before.
- Adds `yaml` as a direct dependency (was already present transitively
  via `@opencode-ai/plugin` -> `effect`; pinned directly for stability/
  clarity rather than relying on the transitive resolution holding).

## Alternatives considered

- **JSON instead of YAML.** Rejected: no comments support, and this file
  is exactly the kind of "explain what each knob does, right next to
  it" document that benefits from inline comments (see the generated
  `.opencode/ai-context.config.yaml`).
- **A single central "load all config" function that mutates
  `process.env` or a shared config object.** Rejected: would hide each
  setting's precedence contract behind one large function instead of
  keeping it visible (and independently unit-testable) at each
  consuming module, breaking from this codebase's existing
  `resolveDataDir`/`resolveModelCacheDir`/`resolveOutputDims` per-module
  pattern.
- **Config file overrides win over env vars.** Rejected per the user's
  explicit direction ("env vars become overrides on top of the file") --
  env vars stay the higher-precedence, machine-local escape hatch.
