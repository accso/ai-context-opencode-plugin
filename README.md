# ai-context-opencode-plugin

A native [OpenCode](https://opencode.ai) plugin that gives the agent a local,
Docker-free code index (indexing and search run locally; see the data boundary below): semantic search, repository structure, call/import
impact analysis and document search. It replaces the Docker-based MCP server,
LSP bridge and file watcher of this repo's `.ai-context/` stack.

Each multi-chunk file also gets an L1 summary chunk, written by a local
OpenAI-compatible LLM (LM Studio, Ollama, oMLX; configure `summary_llm`) and
falling back to a deterministic summary when none is reachable (rewritten
automatically once the LLM answers; `reindex_summaries` forces it). Search combines
vectors with FTS5 BM25 and a small cross-encoder re-ranker; other indexed repos
can be searched via an allowlist.

Works in the opencode TUI and under ACP (JetBrains AI Assistant). The embedding
model runs in one shared background process, so the opencode host stays small.

> **Data boundary:** indexing, embeddings and search run locally, but the
> plugin cannot control what the agent does with the results. Retrieved code
> and documents become part of the conversation and go to your configured model
> provider, which may not be local. See [docs/data-boundary.md](docs/data-boundary.md).

## Tools

| Tool | For |
| --- | --- |
| `repo_structure` | Directory layout, file counts, languages |
| `semantic_search` | Conceptual questions about source code |
| `find_symbol` | Where a class/function/method is defined, by name |
| `analyze_impact` | Callers/callees/importers before changing a symbol |
| `search_docs` | Markdown docs, ADRs, RFCs |
| `index_status` | Indexing progress and index health |
| `ai_context_*` | Admin: projects, backup, index tree, allowlist, rescan, telemetry |

On OpenCode 2.x the first six are direct tools and the `ai_context_*` tools are reached through Code Mode (`execute`). Details: [docs/tools.md](docs/tools.md).

## Quickstart

```bash
npm install
npm run build
./scripts/install-plugin.sh
```

Restart opencode. The plugin is opt-in per repository: the generated
`.opencode/ai-context.config.yaml` has `enabled: false`; set it to `true` and
restart. The first index takes minutes; follow it in
`.opencode/ai-context/index-status.json`. Next to it: `index-tree.md` (which files are indexed, with date/repo/branch) and `error.log.md` (what failed and why). More: [docs/installation.md](docs/installation.md).

**OpenCode versions.** The bundle serves OpenCode 2.x (`setup(ctx)`, `@opencode/plugin`) and
1.x (`server()`, >= 1.18.29) from one default export ([ADR-0031](docs/adr/0031-opencode-2x-entry-and-search-steering.md)).
**LSP:** on 1.x the plugin enables the built-in LSP servers (unless `lsp: false`) and points the
agent to the native `lsp` tool; opencode only registers that tool when
`OPENCODE_EXPERIMENTAL_LSP_TOOL=true` is set in the environment that starts opencode (setting it
from inside the plugin may come too late). OpenCode 2.x runs no language servers, so there the
plugin works from the index alone (`find_symbol`, `analyze_impact`) and never mentions `lsp`.
A plugin-owned LSP bridge for both is planned: [docs/lsp-roadmap.md](docs/lsp-roadmap.md).

Indexing follows file changes through opencode's file watcher on 1.x (opt-in via
`OPENCODE_EXPERIMENTAL_FILEWATCHER`, which the plugin sets itself, best effort). OpenCode 2.2
has no project-wide watcher event for plugins (`filesystem.changed` only fires for files
watched through its experimental `fs.watch` API), so on 2.x (and whenever the 1.x watcher is
silent) the index is kept fresh from tool calls: `edit`/`write`/`apply_patch` index just the touched files, `shell`/`bash` and IDE tools trigger a full rescan shortly after, and a finished session (`session.idle`, at most every 30 s) rescans for changes made outside the agent, and `ai_context_rescan` does it on demand.
Fingerprints skip unchanged files, so a rescan is cheap.

**Steering away from grep/glob.** Agents tend to start with `glob **/*.kt` or a descriptive
`grep`. The plugin counters this in three places: a rule block in the system prompt, a
suffix on the native `grep`/`glob` tool descriptions, and a one-line note appended to the
result of a grep/glob call that looks exploratory (extension-only glob, multi-word or
many-branch pattern, empty result). All three follow `agent_hint` in the config file.

## Metrics export (opt-in)

Set `AI_CONTEXT_OTEL_ENABLED=1` to push `opencode.tool.duration` (histogram, ms, labels `tool`, `project`) to an OTLP collector (`AI_CONTEXT_OTEL_ENDPOINT`, default `http://127.0.0.1:4318`; `AI_CONTEXT_OTEL_FLUSH_MS`, `AI_CONTEXT_PROJECT`). Details: [docs/observability.md](docs/observability.md).

## Documentation

See the [documentation index](docs/README.md): [status](docs/status.md),
[configuration](docs/configuration.md), [architecture](docs/architecture.md),
[concepts and prior art](docs/concepts-and-prior-art.md),
[data boundary](docs/data-boundary.md), [troubleshooting](docs/troubleshooting.md), [development](docs/development.md),
[ADRs](docs/adr/README.md).

## Author

Created and maintained by **Florestan Sulimma** at **Accso GmbH**.

## License

Apache License 2.0, Copyright 2026 Accso GmbH — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Bundled third-party code: [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) (regenerate with `npm run licenses`).
