---
name: cross-repo
description: >
  Use when the user wants code, structure or symbols from ANOTHER repository
  (a library, a sibling service, a dependency) that is indexed by the
  ai-context plugin on this machine, or when search results should include
  more than the current repo. Explains how to allow and query other projects.
---
<!-- managed-by: ai-context-opencode-plugin -->

# Cross-repo lookup

Every repo is isolated by default: `semantic_search` only sees its own index.
The other repo must already be indexed (opened once with this plugin).

## 1. Find the exact project name

Call `ai_context_list_projects` BEFORE assuming a library or repo is not
indexed. Each entry has a `name` (e.g. `tlt-platform`) and a `key`
(`<name>-<hash8>`). Use only the `name`: the hash differs per machine.
Never guess a name; pick the one matching what the user named.

## 2. Allow it (once, persistent)

Call `ai_context_allow_repo` with that name. It is validated against the
registry and stored (as name, shareable with the team) in `allowed_repos` in `.opencode/ai-context.config.yaml`. It
takes effect immediately, no restart. Only do this when the user asked for
the other repo's results.

## 3. Query it

- `semantic_search`: results of allowed repos are merged in, each tagged with
  its `project`.
- `repo_structure`, `find_symbol`, `analyze_impact` and `search_docs`: pass
  `project: "<name>"` to look into that repo instead of the current one.
- Paths in results are relative to THAT repo, not to the current worktree.
  To read the files, ask the user for the repo's location; `read` only
  works inside the current project.

## Troubleshooting

- `Unknown or not allowed project`: run step 1 and 2. A hashed key is not accepted.
- Name missing in the list: that repo was never indexed with this plugin.
- No symbols or docs from that repo: its symbol index or doc trees may not exist yet.
