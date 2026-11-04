import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createToolLog, summarizeResponse } from "../../src/observability/tool-log.js";

const tmp = () => join(mkdtempSync(join(tmpdir(), "toollog-")), "ai-context", "tool.log.md");
const base = { sessionID: "s1", callID: "c1" };

test("a request is logged with time, tool, session, call and its arguments", () => {
  const filePath = tmp();
  const log = createToolLog({ filePath, now: () => new Date("2026-10-13T09:00:00.000Z") });
  log.request({ ...base, tool: "find_symbol", args: { query: "BlobStore", project: "tlt-platform" } });
  const md = readFileSync(filePath, "utf8");
  assert.match(md, /^# Tool log/m);
  assert.match(md, /## 2026-10-13T09:00:00.000Z — find_symbol \(session s1, call c1\)/);
  assert.match(md, /"query":"BlobStore"/);
  assert.match(md, /"project":"tlt-platform"/);
});

test("long argument values are truncated", () => {
  const filePath = tmp();
  const log = createToolLog({ filePath });
  log.request({ ...base, tool: "write", args: { content: "x".repeat(5000) } });
  const md = readFileSync(filePath, "utf8");
  assert.ok(md.length < 1000);
  assert.match(md, /…/);
});

test("full mode keeps arguments untruncated too", () => {
  const filePath = tmp();
  const log = createToolLog({ filePath, fullResponses: true });
  log.request({ ...base, tool: "write", args: { content: "x".repeat(5000) + "END" } });
  assert.ok(readFileSync(filePath, "utf8").includes("x".repeat(5000) + "END"));
});

test("summary mode logs size, counts and first paths but not the content", () => {
  const filePath = tmp();
  let t = 0;
  const log = createToolLog({ filePath, now: () => new Date(2026, 9, 13, 9, 0, 0, (t += 40)) });
  log.request({ ...base, tool: "find_symbol", args: { query: "X" } });
  log.response({
    ...base,
    tool: "find_symbol",
    output: JSON.stringify({ matches: [{ path: "src/a.ts", code: "SECRET BODY" }, { path: "src/b.ts" }] }),
  });
  const md = readFileSync(filePath, "utf8");
  assert.match(md, /↳ find_symbol/);
  assert.match(md, /matches: 2/);
  assert.match(md, /src\/a\.ts/);
  assert.match(md, /\+40 ms/);
  assert.doesNotMatch(md, /SECRET BODY/);
});

test("summarizeResponse flags errors and empty results", () => {
  assert.match(summarizeResponse(JSON.stringify({ error: "Unknown or not allowed project \"x\"" })), /error: Unknown or not allowed/);
  assert.match(summarizeResponse(JSON.stringify({ matches: [] })), /empty/);
  assert.match(summarizeResponse(""), /empty/);
  const text = summarizeResponse("line one\nline two");
  assert.match(text, /17 chars/);
  assert.match(text, /line one/);
});

test("full mode adds the complete, untruncated response text", () => {
  const filePath = tmp();
  const log = createToolLog({ filePath, fullResponses: true });
  log.request({ ...base, tool: "read", args: { path: "a.ts" } });
  log.response({ ...base, tool: "read", output: "VISIBLE" + "y".repeat(50_000) + "END" });
  const md = readFileSync(filePath, "utf8");
  assert.match(md, /VISIBLE/);
  assert.ok(md.includes("y".repeat(50_000) + "END"));
});

test("when the file would exceed the size limit it is rotated to a timestamped *.log.md file and a new one is started", () => {
  const filePath = tmp();
  let t = 0;
  const log = createToolLog({ filePath, maxBytes: 3000, now: () => new Date(Date.UTC(2026, 9, 13, 9, 0, 0, (t += 1000))) });
  for (let i = 0; i < 100; i++) log.request({ sessionID: "s", callID: `c${i}`, tool: `tool-${i}`, args: { i } });
  const dir = dirname(filePath);
  const rotated = readdirSync(dir).filter((f) => /^tool\..+\.log\.md$/.test(f)).sort();
  assert.ok(rotated.length >= 2, `expected rotated files, got ${rotated}`);
  const current = readFileSync(filePath, "utf8");
  assert.match(current, /^# Tool log/);
  assert.match(current, /tool-99\b/);
  assert.doesNotMatch(current, /tool-0\b/);
  const all = [...rotated.map((f) => readFileSync(join(dir, f), "utf8")), current].join("");
  for (let i = 0; i < 100; i++) assert.match(all, new RegExp(`tool-${i}\\b`));
  for (const f of [...rotated, "tool.log.md"]) assert.ok(statSync(join(dir, f)).size <= 3500);
});

test("only the newest rotated files are kept", () => {
  const filePath = tmp();
  let t = 0;
  const log = createToolLog({ filePath, maxBytes: 1500, maxRotatedFiles: 2, now: () => new Date(Date.UTC(2026, 9, 13, 9, 0, 0, (t += 1000))) });
  for (let i = 0; i < 60; i++) log.request({ sessionID: "s", callID: `c${i}`, tool: `tool-${i}`, args: { i } });
  const rotated = readdirSync(dirname(filePath)).filter((f) => /^tool\..+\.log\.md$/.test(f));
  assert.equal(rotated.length, 2);
});

test("logging never throws, e.g. for unserializable arguments or an unwritable path", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const log = createToolLog({ filePath: tmp() });
  assert.doesNotThrow(() => log.request({ ...base, tool: "t", args: circular }));
  const bad = createToolLog({ filePath: "/proc/nope/tool.log.md" });
  assert.doesNotThrow(() => bad.request({ ...base, tool: "t", args: {} }));
  assert.equal(existsSync("/proc/nope/tool.log.md"), false);
});
