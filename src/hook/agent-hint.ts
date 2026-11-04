/**
 * Short rule block appended to the system prompt (opencode's
 * `experimental.chat.system.transform`, which also runs under ACP). Tool
 * descriptions alone were not enough: agents default to grep/glob/read.
 * Kept brief because it is sent with every request.
 */
export const AGENT_HINT = [
  "## Code context tools (ai-context plugin)",
  "This project has a semantic index. Use it before reading files one by one:",
  "- Unfamiliar project or area: call `repo_structure` first to see the directory layout, then drill down with dir_path.",
  '- Questions like "where/how/why does X work", "what handles Y", or any search whose exact wording is unknown: call `semantic_search` FIRST, before grep/glob/read.',
  "- Before changing, renaming or removing a function, class or method: call `analyze_impact` to see callers and dependents.",
  "- Where is a class/function/method defined and you know (part of) its name: call `find_symbol` (then `read` the file/lines). For all usages, call `analyze_impact`.",
  "- Documentation, ADRs and design questions (Markdown): call `search_docs` with concrete keywords; `semantic_search` covers code only.",
  '- User asks to create/save/export an "ai context backup" (or to share the index with the team): call `ai_context_export_backup`, then tell them to commit `.opencode/ai-context/backup/`. To show which files are indexed: call `ai_context_export_index_tree`.',
  '- Library, sibling service or symbol not found here: call `ai_context_list_projects` BEFORE assuming it is not indexed, then pass `project: "<name>"` to find_symbol/semantic_search/repo_structure/search_docs/analyze_impact.',
  "- Files look missing or stale in the index (e.g. after shell commands or git operations): call `ai_context_rescan`.",
  "- Never explore with `glob **/*.kt` (or any extension listing) or by grepping a file type: use `repo_structure` for layout, `find_symbol` for a name, `semantic_search` for a concept.",
  "- Use grep/glob only for an exact identifier or literal string you already know (e.g. an error message you saw).",
  "- If results look empty or incomplete, check `index_status` (indexing may still be running) before falling back.",
].join("\n");

/** Extra line for hosts with a native `lsp` tool (OpenCode 1.x only). */
export const LSP_HINT =
  "- Exact references/definitions/call hierarchy (after `find_symbol`/`analyze_impact` narrowed it down): use the native `lsp` tool.";

/** Extra line for OpenCode 2.x, where the admin tools are only reachable through Code Mode `execute`. */
export const CODE_MODE_HINT =
  "- `semantic_search`, `find_symbol`, `repo_structure`, `analyze_impact`, `search_docs` and `index_status` are direct tools. The `ai_context_*` tools (backup, index tree, list projects, rescan, allow repo, delete project, telemetry) are only reachable in Code Mode: use `execute` with `await tools.<name>({...})`, and look up a signature with `search({ query: \"<name>\" })` if it is not listed.";

/** Appends the hint once; safe if the hook runs several times on the same array. */
export function appendAgentHint(system: string[], options: { lsp?: boolean; codeMode?: boolean } = {}): void {
  let hint = AGENT_HINT;
  if (options.lsp) hint += `\n${LSP_HINT}`;
  if (options.codeMode) hint += `\n${CODE_MODE_HINT}`;
  if (!system.some((s) => s === hint)) system.push(hint);
}

/** Per-session block naming the repos the user linked (allow-list); undefined when there are none. */
export function linkedReposHint(projectNames: string[]): string | undefined {
  const names = [...new Set(projectNames)];
  if (names.length === 0) return undefined;
  return [
    "## Linked repos (ai-context plugin)",
    `Also indexed and searchable: ${names.join(", ")}.`,
    'Query one with `project: "<name>"` on find_symbol, repo_structure, search_docs and analyze_impact; semantic_search already includes them.',
  ].join("\n");
}
