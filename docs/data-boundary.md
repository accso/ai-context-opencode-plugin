# Data boundary: what is local, what is not

The plugin itself works locally. It does **not** control what happens to the
data after it has been handed to the agent.

## Stays on your machine (the plugin)

- Indexing, chunking, embeddings (ONNX, shared worker), re-ranking, SQLite
  stores and the call/import graph. No code or query is sent anywhere by the
  plugin's index and search path.
- File and document summaries use the `summary_llm` endpoint. The default is
  a local server (`127.0.0.1`). The plugin sends file content there. Its API
  key comes from an environment variable only, never from the committed config.
- The repo-local backup (`.opencode/ai-context/backup/`) is plain text that
  contains chunk text, doc trees and the symbol graph. It lives in the
  repository, so committing and pushing it publishes that content to whatever
  hosts the repo.

## Outside the plugin's control

- **Tool results go to the agent's LLM.** Everything `semantic_search`,
  `search_docs`, `find_symbol`, `analyze_impact`, `repo_structure` and the
  admin tools return (code snippets, document text, summaries, paths, status)
  becomes part of the conversation. opencode (or the ACP client) then sends it
  to the configured model provider. If that provider is a cloud service, the
  retrieved code leaves the machine, under that provider's terms and retention.
  The plugin cannot detect or restrict this.
- **Cross-repo search** (allowlist) makes other indexed projects' content
  retrievable, and therefore sendable, in the same way.
- **`summary_llm`**: pointing `base_url` at a remote endpoint sends file
  content to that endpoint.
- Hints and skills the plugin installs only steer the agent; they are not an
  access control.

## Recommendations

- For confidential code, use a model provider you consider local or
  contractually acceptable, not just a local index.
- Keep `summary_llm` on a local server.
- Review `allowed_repos` in `.opencode/ai-context.config.yaml` before enabling cross-repo search.
- `tool_log_full_responses: true` writes tool responses (repo code) to the git-ignored `tool.log.md`; do not attach that file to bug reports unreviewed.
- Check the backup content before committing it to a shared or public repo.
- Exclude sensitive paths from indexing (`exclude`, see [configuration](configuration.md)).
