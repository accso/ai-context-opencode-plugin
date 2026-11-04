# ADR-0023: Tool naming scheme and description rules

Status: accepted

## Context

Tool names mixed two styles by build order, not by role: `search_docs` and
`index_status` carried the `ai_context_` prefix although agents use them for
research, while `telemetry_report` (admin) had none. `semantic_search` also
claimed to cover "code and docs", but Markdown docs are tree-indexed and not
searchable through it, so agents searched docs with the wrong tool.

## Decision

- **Research tools** (used by the agent while working), no prefix:
  `semantic_search`, `repo_structure`, `analyze_impact`, `search_docs`,
  `index_status`.
- **Admin tools**, prefix `ai_context_`: `ai_context_list_projects`,
  `ai_context_delete_project`, `ai_context_export_backup`,
  `ai_context_allow_repo`, `ai_context_telemetry_report`.
- A test enforces the scheme.
- Descriptions state: what it covers and what it does NOT (code vs docs),
  when to use it, what it returns, and the next step (`read` with the line
  range). `index_status` states its trigger: empty or partial results, or an
  `indexingNotice`.

## Consequences

- Renamed: `ai_context_search_docs` -> `search_docs`,
  `ai_context_index_status` -> `index_status`,
  `telemetry_report` -> `ai_context_telemetry_report`. No aliases are kept.
  Prompts or skills that use the old names must be updated.
- Unprefixed names could collide with future built-in opencode tools; the
  five names are specific enough to accept that risk.
