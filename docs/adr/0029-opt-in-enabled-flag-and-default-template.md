# ADR-0029: Opt-in per repository (`enabled`) and a config file generated with defaults

## Status

Accepted (2026-10-12). Amends [ADR-0014](0014-project-config-file-precedence.md).

## Context

The plugin started indexing every repository opencode was opened in, including
ones where nobody wanted it (cost: CPU, RAM, a model download, files written into
`.opencode/`). The generated config file listed every key only as a comment, so
users still had to read the documentation to learn the effective settings.

## Decision

- New top-level key `enabled` in `.opencode/ai-context.config.yaml`. It is
  **opt-in**: absent, `false` or unparsable (malformed file, wrong type) means
  off. `AI_CONTEXT_PLUGIN_ENABLED` (`1`/`true`, `0`/`false`) overrides the file in
  both directions (precedence as in ADR-0014).
- Off means: the plugin returns no hooks. The config file is still created when
  missing, but nothing else happens: no index or doc-tree store, no startup or
  watcher indexing, no worker, no tools, no agent hint, no bundled skills, no
  `.opencode/.gitignore`, no popups. The gate sits right after the config is
  loaded in `createAiContextHooks`.
- The generated file starts with `enabled: false` and then lists every setting
  with its **actual built-in default** as an active value. Machine-specific
  (`data_dir`, `model_cache_dir`, `embed_dims`) and optional (`exclude`,
  `heavy_mode`) keys stay commented. `config-template.test.ts` asserts that the
  template parses to exactly the code's default constants, so the two cannot
  drift apart.
- Existing config files are never rewritten. A file without `enabled` therefore
  switches the plugin off after the upgrade (strict opt-in, chosen on purpose);
  this repository's own file got `enabled: true`.

- Secrets stay out of the committed file (amendment, 2026-10-12): `summary_llm`
  takes no literal `api_key` (ignored with a warning); the key is read from the
  environment variable named by `api_key_env` (default
  `AI_CONTEXT_SUMMARY_LLM_API_KEY`), and the built-in default key `omlx` is gone.
  On HTTP 401 the summarizer raises `SummaryLlmAuthError` ("API key not set" or
  "rejected", with the `export ...` command); the plugin shows it as an OS popup
  and as a `notices` entry in `index-status.json` / `index_status`, cleared when
  the next run starts. Summaries fall back to the deterministic text as before.

## Consequences

- Setups that relied on the default key `omlx` must export
  `AI_CONTEXT_SUMMARY_LLM_API_KEY=omlx` once.
- Breaking for existing users: add `enabled: true` once per repository (or set
  the environment variable).
- Defaults copied into a user's file no longer follow later changes of the
  built-in defaults; users who never edit a line keep the old value.
- `summary_llm` is active in the template, so after enabling, file content goes
  to the local default server (`127.0.0.1:8000`), exactly as before; `summary_llm:
  false` turns it off.
- Tests that exercise the plugin set `AI_CONTEXT_PLUGIN_ENABLED=1` at the top of
  the test file; disabled-behaviour tests unset it explicitly.

## Amendment: index tree and error log files

Two generated files join `index-status.json` in `.opencode/ai-context/`:
`index-tree.md` (tool `ai_context_export_index_tree`, refreshed after each
completed indexing run) lists the indexed files with export date, repository,
branch and commit; `error.log.md` collects every reported problem, failed file
and failed run, size-capped. Both are git-ignored and written only when the
plugin is enabled (entries recorded before the enabled gate are buffered and
dropped if the plugin stays off), so a disabled plugin still only creates the
config file.

## Alternatives considered

- Default-on with an `enabled: false` kill switch: keeps upgrades non-breaking
  but leaves the plugin running in repositories that never asked for it.
- Rewriting existing config files to add missing keys: would edit user files and
  discard their formatting.
