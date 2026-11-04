// The plugin is off unless enabled (config `enabled` / this env var); the suite tests the enabled plugin.
process.env.AI_CONTEXT_PLUGIN_ENABLED ??= "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createAiContextHooks } from "../../src/hook/plugin.js";

const RESEARCH_TOOLS = ["semantic_search", "repo_structure", "analyze_impact", "search_docs", "index_status", "find_symbol"];

async function tools() {
  const hooks = await createAiContextHooks({ worktree: "/tmp/tool-descriptions-test" } as never);
  return hooks.tool as Record<string, { description: string }>;
}

test("research tools are unprefixed, every other tool is prefixed ai_context_", async () => {
  const t = await tools();
  for (const name of RESEARCH_TOOLS) assert.ok(t[name], `missing research tool ${name}`);
  for (const name of Object.keys(t)) {
    if (!RESEARCH_TOOLS.includes(name)) assert.match(name, /^ai_context_/, `${name} should be prefixed`);
  }
});

test("semantic_search covers code only and points to search_docs for documentation", async () => {
  const d = (await tools()).semantic_search!.description;
  assert.doesNotMatch(d, /code and docs/i);
  assert.match(d, /search_docs/);
  assert.match(d, /\bread\b/);
  assert.match(d, /project/);
});

test("search_docs says it is keyword based, covers Markdown docs and points back to semantic_search", async () => {
  const d = (await tools()).search_docs!.description;
  assert.match(d, /keyword/i);
  assert.match(d, /semantic_search/);
  assert.match(d, /\bread\b/);
});

test("index_status states when to call it", async () => {
  const d = (await tools()).index_status!.description;
  assert.match(d, /empty|incomplete|partial/i);
  assert.match(d, /indexingNotice/);
});

test("repo_structure and analyze_impact tell the agent what to do next", async () => {
  const t = await tools();
  assert.match(t.repo_structure!.description, /semantic_search|read/);
  assert.match(t.analyze_impact!.description, /\bread\b/);
});

test("find_symbol is a quick name lookup that points to analyze_impact and semantic_search", async () => {
  const d = (await tools()).find_symbol!.description;
  assert.match(d, /analyze_impact/);
  assert.doesNotMatch(d, /lsp/);
  assert.match(d, /semantic_search/);
  assert.match(d, /\bread\b/);
});

test("admin tools carry the phrases a user would say", async () => {
  const t = await tools();
  assert.match(t.ai_context_export_backup!.description, /create|make|save/i);
  assert.match(t.ai_context_export_backup!.description, /ai.context backup/i);
  assert.match(t.ai_context_export_index_tree!.description, /which files|what is indexed/i);
});

test("telemetry, project list and delete describe when to use them", async () => {
  const t = await tools();
  assert.match(t.ai_context_telemetry_report!.description, /how often|token/i);
  assert.doesNotMatch(t.ai_context_telemetry_report!.description, /bench\.js/);
  assert.match(t.ai_context_list_projects!.description, /which (repos|projects)|disk/i);
  assert.match(t.ai_context_delete_project!.description, /confirm/i);
});

test("cross-repo tools talk about project NAMES, not hashed keys", async () => {
  const t = await tools();
  for (const name of ["find_symbol", "repo_structure", "search_docs", "analyze_impact"]) {
    const arg = String((t[name] as any).args.project.description);
    assert.doesNotMatch(arg, /\bkey\b/i, `${name}.project still mentions a key`);
    assert.match(arg, /name/i, `${name}.project should mention the name`);
  }
  assert.match(t.ai_context_allow_repo!.description, /name/i);
  assert.doesNotMatch(t.ai_context_allow_repo!.description, /\bkey\b/i);
});
