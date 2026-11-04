import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_HINT, appendAgentHint, linkedReposHint } from "../../src/hook/agent-hint.js";
import { createSemanticSearchTool } from "../../src/tools/semantic-search.js";

test("the hint steers the agent to the context tools before grep/glob for conceptual questions", () => {
  assert.match(AGENT_HINT, /semantic_search/);
  assert.match(AGENT_HINT, /analyze_impact/);
  assert.match(AGENT_HINT, /search_docs/);
  assert.match(AGENT_HINT, /before.*(grep|glob)/is);
  assert.match(AGENT_HINT, /exact (identifier|string)/i);
});

test("the hint names the backup and index-export tools so requests like 'create an ai context backup' map to them", () => {
  assert.match(AGENT_HINT, /ai_context_export_backup/);
  assert.match(AGENT_HINT, /ai_context_export_index_tree/);
  assert.match(AGENT_HINT, /backup/i);
});

test("the hint stays short (it is paid for on every request)", () => {
  assert.ok(AGENT_HINT.length < 2000, `hint is ${AGENT_HINT.length} chars`);
});

test("appendAgentHint adds the hint once, even if the hook runs repeatedly", () => {
  const system = ["base prompt"];
  appendAgentHint(system);
  appendAgentHint(system);
  assert.equal(system.length, 2);
  assert.equal(system[1], AGENT_HINT);
});

test("semantic_search no longer tells the agent to prefer grep/glob first", () => {
  const description = createSemanticSearchTool({
    vectorStore: { search: () => [] } as never,
    embedQuery: async () => [1],
  }).description;
  assert.doesNotMatch(description, /Prefer grep\/glob first/i);
  assert.match(description, /grep|glob/i); // still says when grep/glob is the right tool
  assert.match(description, /first|before/i);
});

test("the static hint tells the agent to check indexed projects before assuming a library is not indexed", () => {
  assert.match(AGENT_HINT, /ai_context_list_projects/);
  assert.match(AGENT_HINT, /project:/);
});

test("linkedReposHint lists the stable names and is empty without linked repos", () => {
  assert.equal(linkedReposHint([]), undefined);
  const block = linkedReposHint(["tlt-platform", "libfoo"])!;
  assert.match(block, /tlt-platform/);
  assert.match(block, /libfoo/);
  assert.match(block, /project:/);
});

test("appendAgentHint adds the Code Mode line only when requested", () => {
  const plain: string[] = [];
  appendAgentHint(plain);
  assert.doesNotMatch(plain[0]!, /Code Mode/);
  const v2: string[] = [];
  appendAgentHint(v2, { codeMode: true });
  appendAgentHint(v2, { codeMode: true });
  assert.equal(v2.length, 1);
  assert.match(v2[0]!, /execute/);
  assert.match(v2[0]!, /ai_context_rescan|ai_context_\*/);
});
