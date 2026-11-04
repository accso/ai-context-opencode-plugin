import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyNativeSearch,
  isExploratoryGrep,
  isExtensionOnlyGlob,
  NATIVE_TOOL_HINTS,
} from "../../src/hook/search-nudge.js";
import { createAiContextHooks } from "../../src/hook/plugin.js";
import { appendToResult, registerHooks } from "../../src/hook/v2-plugin.js";

test("extension-only globs are exploratory, named files are not", () => {
  for (const p of ["**/*.kt", "*.java", "src/**/*.{ts,tsx}", "**/*"]) assert.equal(isExtensionOnlyGlob(p), true, p);
  for (const p of ["**/UserService.kt", "src/**/build.gradle.kts", "package.json"]) assert.equal(isExtensionOnlyGlob(p), false, p);
});

test("grep for an exact token is fine, descriptive or guessing patterns are exploratory", () => {
  for (const p of ["UserService", "retry_count", "com.acme.Foo", "ERR_TIMEOUT"]) assert.equal(isExploratoryGrep(p), false, p);
  for (const p of ["where is the retry handled", "retry|backoff|timeout|delay", "foo.*bar.*baz"]) assert.equal(isExploratoryGrep(p), true, p);
  assert.equal(isExploratoryGrep("a|b|c", true), false); // literal text, not an alternation
});

test("classifyNativeSearch maps calls to a nudge kind", () => {
  assert.equal(classifyNativeSearch("glob", { pattern: "**/*.kt" }, "a.kt"), "extension-glob");
  assert.equal(classifyNativeSearch("glob", { pattern: "**/Foo.kt" }, "Foo.kt"), null);
  assert.equal(classifyNativeSearch("grep", { pattern: "how is auth handled" }, "x"), "exploratory-grep");
  assert.equal(classifyNativeSearch("grep", { pattern: "FooBar" }, "a.kt:1:FooBar"), null);
  assert.equal(classifyNativeSearch("grep", { pattern: "FooBar" }, "No matches found"), "empty-result");
  assert.equal(classifyNativeSearch("read", { pattern: "**/*.kt" }, ""), null);
});

async function core(agentHint?: boolean) {
  return createAiContextHooks({
    worktree: "/tmp/project",
    reconcileOnStartup: async () => {},
    configFile: { enabled: true, agentHint } as never,
  } as never);
}

test("core appends the nudge to grep/glob output and describes the native tools", async () => {
  const hooks = await core();
  const out = { output: "a.kt\nb.kt" };
  await hooks["tool.execute.after"]!({ tool: "glob", sessionID: "s", callID: "c", args: { pattern: "**/*.kt" } }, out);
  assert.match(out.output, /^a\.kt\nb\.kt\n\n\[ai-context\]/);
  assert.match(out.output, /repo_structure/);

  const def = { description: "Fast file pattern matching" };
  await hooks["tool.definition"]!({ toolID: "grep" }, def);
  assert.ok(def.description.endsWith(NATIVE_TOOL_HINTS.grep));
  await hooks["tool.definition"]!({ toolID: "grep" }, def); // idempotent
  assert.equal(def.description.split(NATIVE_TOOL_HINTS.grep).length, 2);
  const other = { description: "x" };
  await hooks["tool.definition"]!({ toolID: "read" }, other);
  assert.equal(other.description, "x");
});

test("agentHint: false disables the nudges", async () => {
  const hooks = await core(false);
  const out = { output: "a.kt" };
  await hooks["tool.execute.after"]!({ tool: "glob", sessionID: "s", callID: "c", args: { pattern: "**/*.kt" } }, out);
  assert.equal(out.output, "a.kt");
  const def = { description: "d" };
  await hooks["tool.definition"]!({ toolID: "glob" }, def);
  assert.equal(def.description, "d");
});

test("appendToResult handles string and part-list content", () => {
  assert.deepEqual(appendToResult({ content: "a" }, "\n\nX"), { content: "a\n\nX" });
  assert.deepEqual(appendToResult({ content: [{ type: "text", text: "a" }] }, "\n\nX"), {
    content: [{ type: "text", text: "a" }, { type: "text", text: "X" }],
  });
});

test("2.x adapter writes the nudge back into the result and patches grep/glob descriptions", async () => {
  const hooks = await core();
  const registered: Record<string, any> = {};
  const nativeTools: Record<string, { description: string }> = { grep: { description: "grep it" }, glob: { description: "glob it" } };
  const ctx: any = {
    tool: {
      transform: async (cb: any) => cb({ add() {}, update: (id: string, fn: any) => nativeTools[id] && fn(nativeTools[id]) }),
      hook: async (name: string, cb: any) => void (registered[name] = cb),
    },
    session: { hook: async () => {} },
    event: { subscribe: () => (async function* () {})() },
  };
  await registerHooks(ctx, hooks);
  assert.ok(nativeTools.grep.description.includes(NATIVE_TOOL_HINTS.grep));
  assert.ok(nativeTools.glob.description.includes(NATIVE_TOOL_HINTS.glob));

  const event = { tool: "glob", sessionID: "s", id: "c", input: { pattern: "**/*.kt" }, status: "completed", result: { content: "a.kt" } };
  await registered["execute.after"](event);
  assert.match(event.result.content as string, /^a\.kt\n\n\[ai-context\]/);
});
