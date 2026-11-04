import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createErrorLog } from "../../src/observability/error-log.js";
import { createProblemReporter } from "../../src/observability/problem-reporter.js";
import { createProgressTracker } from "../../src/indexing/index-progress.js";

const tmp = () => join(mkdtempSync(join(tmpdir(), "errlog-")), "ai-context", "error.log.md");

test("record appends a markdown entry with time, context and message, newest last", () => {
  const filePath = tmp();
  const log = createErrorLog({ filePath, now: () => new Date("2026-10-12T10:00:00.000Z") });
  log.activate();
  log.record("Embedding model could not be loaded", new Error("boom"));
  log.record("Second problem");
  const md = readFileSync(filePath, "utf8");
  assert.match(md, /^# Error log/m);
  assert.match(md, /## 2026-10-12T10:00:00.000Z — Embedding model could not be loaded/);
  assert.match(md, /boom/);
  assert.ok(md.indexOf("boom") < md.indexOf("Second problem"));
});

test("nothing is written before activate; buffered entries are flushed on activate", () => {
  const filePath = tmp();
  const log = createErrorLog({ filePath });
  log.record("early config problem", "bad yaml");
  assert.equal(existsSync(filePath), false);
  log.activate();
  assert.match(readFileSync(filePath, "utf8"), /early config problem[\s\S]*bad yaml/);
});

test("file is capped: oldest entries are dropped, header stays", () => {
  const filePath = tmp();
  const log = createErrorLog({ filePath, maxBytes: 2000 });
  log.activate();
  for (let i = 0; i < 100; i++) log.record(`problem-${i}`, "x".repeat(50));
  const md = readFileSync(filePath, "utf8");
  assert.ok(statSync(filePath).size <= 2500);
  assert.match(md, /^# Error log/);
  assert.match(md, /problem-99/);
  assert.doesNotMatch(md, /problem-0\b/);
});

test("problem reporter records every report, also deduplicated ones", () => {
  const recorded: string[] = [];
  const reporter = createProblemReporter({
    notify: () => {},
    log: () => {},
    seen: new Map(),
    record: (context, error) => recorded.push(`${context}|${error}`),
  });
  reporter.report("ctx", "e1");
  reporter.report("ctx", "e1");
  assert.equal(recorded.length, 2);
});

test("progress tracker reports each failed file", () => {
  const failed: string[] = [];
  const tracker = createProgressTracker({ onFileFailed: (file, message) => failed.push(`${file}:${message}`) });
  tracker.beginBatch(1);
  tracker.fileFailed("a.ts", new Error("parse error"));
  assert.deepEqual(failed, ["a.ts:parse error"]);
});
