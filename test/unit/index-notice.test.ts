import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIndexingNotice, attachIndexingNotice } from "../../src/indexing/index-notice.js";
import { createProgressTracker } from "../../src/indexing/index-progress.js";

test("buildIndexingNotice is null when no run is active", () => {
  const tracker = createProgressTracker({ now: () => 0 });
  assert.equal(buildIndexingNotice(tracker.snapshot()), null);
  tracker.beginBatch(1);
  tracker.fileDone("a.ts");
  tracker.endBatch();
  assert.equal(buildIndexingNotice(tracker.snapshot()), null);
});

test("buildIndexingNotice reports progress and warns about incomplete results while indexing", () => {
  const tracker = createProgressTracker({ now: () => 0 });
  tracker.beginBatch(1900);
  for (let i = 0; i < 412; i++) tracker.fileDone(`f${i}.ts`);
  const notice = buildIndexingNotice(tracker.snapshot())!;
  assert.match(notice, /412\/1900/);
  assert.match(notice, /21%/);
  assert.match(notice, /incomplete/i);
});

test("buildIndexingNotice mentions the ETA once one is known", () => {
  let t = 0;
  const tracker = createProgressTracker({ now: () => t });
  tracker.beginBatch(100);
  tracker.fileDone("a");
  t = 10_000;
  tracker.fileDone("b"); // 1 file / 10s => 98 left => ~980s
  assert.match(buildIndexingNotice(tracker.snapshot())!, /~16 min/);
});

test("buildIndexingNotice describes the scanning and model-loading phases", () => {
  const tracker = createProgressTracker({ now: () => 0 });
  tracker.setPhase("scanning");
  assert.match(buildIndexingNotice(tracker.snapshot())!, /scanning/i);
  tracker.beginBatch(5);
  tracker.setModelLoading(true);
  assert.match(buildIndexingNotice(tracker.snapshot())!, /model/i);
});

test("attachIndexingNotice leaves the value untouched without a notice", () => {
  const value = [{ a: 1 }];
  assert.equal(attachIndexingNotice(value, null), value);
});

test("attachIndexingNotice wraps arrays and extends objects", () => {
  assert.deepEqual(attachIndexingNotice([1, 2], "n"), { indexingNotice: "n", results: [1, 2] });
  assert.deepEqual(attachIndexingNotice({ a: 1 }, "n"), { a: 1, indexingNotice: "n" });
});
