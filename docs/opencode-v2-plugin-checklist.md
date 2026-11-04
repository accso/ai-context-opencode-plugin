# Writing and verifying an OpenCode 2.x plugin

Findings from porting this plugin to OpenCode 2.x (see also
[ADR-0031](adr/0031-opencode-2x-entry-and-search-steering.md)). Use the checklist
at the end to verify any other plugin.

Docs: <https://opencode.ai/v2/docs/build/plugins/server> and
<https://opencode.ai/v2/docs/tools>.

## 1. Tools are hidden behind Code Mode by default

**Symptom.** The plugin registers fine and every tool works, but the agent cannot
call them directly. They only exist inside the `execute` tool
(`await tools.<name>({...})`), and the Code Mode catalog is *partial*: some tools
are not listed and need `search({ query: "<name>" })` to find their signature.
Agents then fall back to grep/glob or conclude the tools are missing.

**Cause.** In 2.x a tool added with `ctx.tool.transform(editor => editor.add(...))`
has `options: { namespace?, codemode? }`. MCP tools are documented to be reached
through `execute` unless `codemode: false`. The docs do not state the default for
plugin tools, but a plugin tool without `options` showed exactly this behaviour.
1.x plugin tools were always direct, so a straight port regresses silently.

**Fix.** Set `options: { codemode: false }` on the tools the agent should see
every turn. Direct tools cost prompt tokens on each request (their schemas are
sent every time), so keep rarely used or admin tools in Code Mode
(`codemode: true`). Here: `semantic_search`, `find_symbol`, `repo_structure`, `analyze_impact`,
`search_docs` and `index_status` are direct (`index_status` is what the agent
checks when results look empty, so it must be reachable without detours); the
seven `ai_context_*` admin tools stay in Code Mode (`DIRECT_TOOLS` in
`src/hook/v2-plugin.ts`).

**Steer the agent.** If any tools stay in Code Mode, say so in the system prompt
hint: which tools are direct, that the rest need `execute`, and that
`search(...)` returns a signature for an unlisted tool. Never tell the agent to
"call X" without saying how it is reachable.

## 2. Other 1.x to 2.x differences that matter

| Area | 1.x | 2.x |
|---|---|---|
| Entry | `Plugin` function returning hooks | `Plugin.define({ id, setup(ctx) })`; `setup` may return a cleanup function |
| Tool schema | zod `args` | JSON Schema `input` (`z.toJSONSchema(..., { io: "input" })`) |
| Tool result | string | `{ content: string \| parts[] }`; validate input yourself |
| Registration | `tool` map | `ctx.tool.transform(editor => editor.add(...))`; transforms are synchronous and replayed, so resolve async data first |
| Tool hooks | `tool.execute.before/after` | `ctx.tool.hook("execute.before" / "execute.after")`; the `after` event carries `status`, `result` or `error` |
| System prompt | `experimental.chat.system.transform` | `ctx.session.hook("context")`, push to `event.system` |
| Compaction | `experimental.session.compacting` | `ctx.session.hook("compaction")` |
| Events | `event` hook | `ctx.event.subscribe({ types, signal })`; `filesystem.changed` only fires for files watched via the experimental fs.watch API |
| Dispose | `server.instance.disposed` event | cleanup function returned by `setup` |
| Config | global config object, `lsp` flag | none; no language servers, so no native `lsp` tool to point agents at |
| Project root | `worktree` argument | `ctx.location.project` (`id === "global"` means no project) |

## 3. How to verify a plugin on 2.x (from inside a 2.x session)

Reload the plugin (`/reload`, or restart) and then check:

1. **Registered.** `await search({ query: "<plugin tool name>" })` inside
   `execute` finds every tool and returns its signature.
2. **Visible as intended.** Direct tools appear as normal tool calls. Everything
   else appears in the Code Mode catalog. Confirm with the tool list the session
   shows; the Code Mode catalog changes after a reload.
3. **Works.** Call each tool with a cheap, safe input and check the result is
   correct, not just non-empty. Skip destructive tools; they share the same
   registration path.
4. **Invalid input.** Call one tool with a wrong argument and confirm it returns
   a clear error instead of throwing.
5. **Hooks fire.** Do an edit/grep/read, then check whatever the hooks record
   (here: `ai_context_telemetry_report` lists those calls).
6. **Prompt steering.** Check the injected system text names the right tools and
   says how to reach them.
7. **Cleanup.** Reloading must not leave duplicate subscriptions or workers.

## 4. Checklist

- [ ] Entry uses `Plugin.define({ id, setup })` with a stable `id`.
- [ ] Tool `input` is valid JSON Schema without `$schema`.
- [ ] Each tool has an explicit `options.codemode` (do not rely on the default).
- [ ] Always-needed tools are `codemode: false`; admin/rare tools are in Code Mode.
- [ ] System prompt hint matches how each tool is reachable.
- [ ] Transform callbacks are synchronous and cheap; async work happens before.
- [ ] Hooks tolerate both `completed` and failed tool results.
- [ ] Nothing depends on 1.x-only features (global config, `lsp`, `file.edited`).
- [ ] Cleanup function aborts subscriptions and stops background work.
- [ ] Steps 1 to 7 above pass in a real 2.x session after `/reload`.

## Open points

- The default of `codemode` for plugin tools is inferred from observed behaviour,
  not stated in the docs. Setting it explicitly avoids depending on it.
- Whether 2.x prefixes direct plugin tool names was not verified; check the
  names the agent actually sees after a reload.
