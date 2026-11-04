# LSP roadmap

## Where we are (2026-10-28)

OpenCode 2.x keeps the `lsp` config schema (`command`, `extensions`, `disabled`, `env`,
`initialization`) but does not run language servers, expose an LSP tool, an LSP API or
diagnostics. On 2.x the plugin therefore does not enable LSP and never points the agent at an
`lsp` tool. On OpenCode 1.x nothing changed: it still enables the built-in LSP and uses the
native `lsp` tool ([ADR-0031](adr/0031-opencode-2x-entry-and-search-steering.md)).

What replaces it today: `find_symbol` (definitions by name) and `analyze_impact` (callers,
callees, importers, tests) from the tree-sitter graph. The graph is name-based; ambiguous
edges are flagged and confirmed by reading the call site.

## Goal

Exact answers where the graph guesses: go to definition, find references, incoming/outgoing
calls, hover/type info, workspace symbols, plus diagnostics after edits. Delivered by the
plugin itself, since the host will not.

## Plan

1. **Spike (1-2 days).** One language end to end (Kotlin, the most used in the target repos;
   `kotlin-language-server` or JetBrains' server). A small stdio JSON-RPC client
   (`initialize`, `textDocument/definition|references|prepareCallHierarchy`, `workspace/symbol`)
   without a library or with `vscode-jsonrpc`. Measure start-up time and memory on a real repo.
2. **Server manager.** `src/lsp/`: lazy start on first use, one process per (language, project),
   idle timeout, memory cap shared with the existing memory guard, crash restart with backoff,
   clean shutdown in the plugin cleanup. Reuse the user's `lsp` config block from
   `opencode.json` (same schema, so a 1.x/2.x config keeps working) with built-in defaults
   for the languages in the graph.
3. **Tool surface.** One tool `code_navigate` (actions: `definition`, `references`,
   `incoming_calls`, `outgoing_calls`, `workspace_symbol`, `hover`) taking `path`, `line`,
   `character` or a symbol name resolved through `find_symbol` first. Results in the same JSON
   style as the other tools, capped and with file/line for `read`.
4. **Graph integration.** `analyze_impact` upgrades ambiguous edges through LSP when a server
   is up (`confirmed: true/false`), and falls back to the graph otherwise. The hint then offers
   `code_navigate` instead of reading call sites.
5. **Diagnostics (optional).** After `edit`/`write`, notify the server and append new errors
   to the tool result (like the nudge mechanism), so the agent sees compile errors without
   running the build.
6. **Steering.** Add one line to the agent hint and a suffix for the native `read`/`grep`
   descriptions only after step 3 ships and measurably helps (telemetry `adoption` view).

## Decisions needed before step 2

- Which languages first (Kotlin, TypeScript, Java, Python?) and who provides the server
  binaries (user-installed vs. downloaded to the shared model cache dir).
- Whether to reuse an LSP the IDE already runs (JetBrains MCP/`idea` tools) instead of
  spawning our own for IntelliJ users.
- Resource budget: language servers are heavy (Kotlin: 1+ GB); must respect `max_memory_mb`.

## Risks

- Start-up and indexing time of servers (minutes on large Gradle projects): the tool must
  report "server still indexing" like `indexingNotice` instead of blocking.
- Per-language setup quirks (build tool, SDK paths); keep it opt-in per language.
- Possible future native 2.x LSP support: keep the tool name and schema separate from the
  transport so we can switch to it if OpenCode ships one.
