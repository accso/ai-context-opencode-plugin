# ADR-0031: OpenCode 2.x entry point, host-specific LSP handling, stronger grep/glob steering

## Status

Accepted (2026-10-28). Amends [ADR-0015](0015-single-bundled-plugin-file.md) and
[ADR-0020](0020-steer-agent-to-context-tools.md).

## Context

- OpenCode 2.x replaces the plugin API: a plugin is `Plugin.define({ id, setup(ctx) })` from
  `@opencode/plugin`; tools are JSON-Schema definitions registered with `ctx.tool.transform`,
  hooks are registered per domain (`ctx.tool.hook`, `ctx.session.hook`, `ctx.event.subscribe`).
  V1 plugin implementations do not run there. The `@opencode-ai/plugin` package (zod `tool()`
  helper) is not available at runtime.
- 2.x accepts the `lsp` config key but runs no language servers and has no LSP tool or API.
  The plugin used to switch 1.x's LSP on and told the agent to "confirm with `lsp`".
- Agents still explore with `glob **/*.kt` or descriptive greps although the system-prompt hint
  says otherwise.

## Decision

- **One bundle, two entries.** The default export is `{ id, setup, server }`: 2.x reads
  `setup`, 1.x (>= 1.18.29) reads `server`. The core (`createAiContextHooks`) stays
  host-neutral with a 1.x-shaped hook set (`AiContextHooks`); `hook/v2-plugin.ts` maps it onto
  the 2.x API (tools, `execute.before/after`, `context`, `compaction`, `filesystem.changed`,
  cleanup). No runtime import of any OpenCode package.
- **Own tool helper.** `tools/tool-def.ts` keeps the `tool({ description, args, execute })`
  shape with zod args (zod is bundled). 1.x gets the object as is; 2.x gets
  `z.toJSONSchema(args)` and validation/defaults inside `execute`.
- **LSP is host specific** (`host: "v1" | "v2"` dep of `createAiContextHooks`; the 1.x
  `server()` passes "v1", the 2.x `setup()` "v2", default "v2"). On "v1" nothing changes: the
  `config` hook enables LSP (never over `lsp: false`), and the agent hint, `find_symbol` and
  `analyze_impact` point to the native `lsp` tool. On "v2" the `config` hook is not used, nothing
  is switched on and no text mentions `lsp`; ambiguous edges are confirmed by reading the call
  site, exact-identifier grep, compiler/tests. A plugin-owned LSP bridge for both is planned
  ([lsp-roadmap](../lsp-roadmap.md)).
- **Steering.** In addition to the system-prompt rule: (1) suffix on the native `grep`/`glob`
  descriptions (`tool.definition` on 1.x, `ctx.tool.transform` + `editor.update` on 2.x);
  (2) a note appended to the result of exploratory grep/glob calls (`search-nudge.ts`):
  extension-only glob, multi-word/many-branch grep, empty result of an exact grep. Exact-token greps are not
  nudged. All follow `agent_hint`.
- `shell` joins `bash` as a file-changing tool for the rescan fallback.

## Consequences

- 2.x users get the tools, indexing, telemetry and steering; 1.x keeps working until dropped.
- The nudge text is part of tool results: small token cost, only on exploratory calls.
- Verified on 2.2.0: `filesystem.changed` is published only for files watched through the
  experimental `fs.watch` API, and the plugin context has no fs domain, so there is no
  project-wide watcher event. On 2.x the rescan after `shell`/`edit`/`write` calls is the
  indexing trigger (a probe `.ts` file was searchable via `find_symbol` within seconds); changes
  made outside the agent (IDE, `git pull`) are picked up by a throttled rescan on `session.idle`, the
  startup pass or `ai_context_rescan`. File-editing tools (`edit`/`write`/`apply_patch`) are indexed
  per file from their arguments instead of walking the repo; `shell` and IDE tools still rescan fully.
- **Tool visibility on 2.x.** A plugin tool without `options.codemode: false` is only reachable
  through Code Mode `execute`, and the Code Mode catalog is partial, so agents did not find the
  lookup tools. `toV2Tool` now sets `codemode: false` for `DIRECT_TOOLS` (`semantic_search`,
  `find_symbol`, `repo_structure`, `analyze_impact`, `search_docs`, `index_status`) and `true`
  for the `ai_context_*` admin tools, which keeps their schemas out of every request. On 2.x the
  agent hint (`CODE_MODE_HINT`) states which tools are direct and how to reach the rest. Details and
  a verification checklist: [opencode-v2-plugin-checklist.md](../opencode-v2-plugin-checklist.md).
- Run a real 2.x session after each release (tools listed, hooks fire, nudges visible).

## Alternatives considered

- Separate 2.x package: doubles releases for no gain while 1.x is still in use.
- Blocking grep/glob in `execute.before`: hostile to legitimate greps; rejected for now.
