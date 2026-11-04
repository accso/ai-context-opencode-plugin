import { test } from "node:test";
import assert from "node:assert/strict";
import { createProgressTracker } from "../../src/indexing/index-progress.js";

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

test("a fresh tracker is idle with zeroed counters", () => {
  const s = createProgressTracker({ now: () => 0 }).snapshot();
  assert.equal(s.running, false);
  assert.equal(s.phase, "idle");
  assert.equal(s.done, 0);
  assert.equal(s.total, 0);
  assert.equal(s.percent, 0);
  assert.deepEqual(s.failures, []);
});

test("setPhase('scanning') marks the tracker running before any batch begins", () => {
  const tracker = createProgressTracker({ now: () => 0 });
  tracker.setPhase("scanning");
  assert.equal(tracker.snapshot().running, true);
  assert.equal(tracker.snapshot().phase, "scanning");
});

test("beginBatch/fileDone track done, total and percent", () => {
  const tracker = createProgressTracker({ now: () => 0 });
  tracker.beginBatch(4);
  tracker.fileDone("a.ts");
  const s = tracker.snapshot();
  assert.equal(s.running, true);
  assert.equal(s.phase, "indexing");
  assert.equal(s.done, 1);
  assert.equal(s.total, 4);
  assert.equal(s.percent, 25);
  assert.equal(s.currentFile, "a.ts");
});

test("endBatch finishes the run once every file is accounted for", () => {
  const c = clock(1000);
  const tracker = createProgressTracker({ now: c.now });
  tracker.beginBatch(2);
  tracker.fileDone("a.ts");
  tracker.fileDone("b.ts");
  c.advance(500);
  tracker.endBatch();
  const s = tracker.snapshot();
  assert.equal(s.running, false);
  assert.equal(s.phase, "done");
  assert.equal(s.percent, 100);
  assert.equal(s.startedAt, 1000);
  assert.equal(s.finishedAt, 1500);
});

test("an empty batch completes immediately without dividing by zero", () => {
  const tracker = createProgressTracker({ now: () => 0 });
  tracker.beginBatch(0);
  tracker.endBatch();
  const s = tracker.snapshot();
  assert.equal(s.phase, "done");
  assert.equal(s.percent, 100);
  assert.equal(s.etaSeconds, null);
});

test("a batch beginning while another is running extends the total instead of resetting", () => {
  const tracker = createProgressTracker({ now: () => 0 });
  tracker.beginBatch(3);
  tracker.fileDone("a.ts");
  tracker.beginBatch(2);
  tracker.endBatch(); // first batch ends -- 1 of 5 done, so the run must stay open
  assert.equal(tracker.snapshot().running, true);
  assert.equal(tracker.snapshot().total, 5);
});

test("etaSeconds is derived from the observed per-file rate", () => {
  const c = clock(0);
  const tracker = createProgressTracker({ now: c.now });
  tracker.beginBatch(10);
  tracker.fileDone("a.ts"); // rate window starts here
  c.advance(2000);
  tracker.fileDone("b.ts");
  c.advance(2000);
  tracker.fileDone("c.ts"); // 2 files in 4s => 0.5 files/s, 7 left => 14s
  const s = tracker.snapshot();
  assert.equal(s.filesPerSec, 0.5);
  assert.equal(s.etaSeconds, 14);
});

test("etaSeconds is null until a rate can be measured", () => {
  const tracker = createProgressTracker({ now: () => 0 });
  tracker.beginBatch(10);
  tracker.fileDone("a.ts");
  assert.equal(tracker.snapshot().etaSeconds, null);
});

test("fileFailed counts the file as processed, records the failure and keeps going", () => {
  const tracker = createProgressTracker({ now: () => 5 });
  tracker.beginBatch(2);
  tracker.fileFailed("bad.ts", new Error("boom"));
  const s = tracker.snapshot();
  assert.equal(s.done, 1);
  assert.equal(s.failed, 1);
  assert.deepEqual(s.failures, [{ file: "bad.ts", error: "boom", attempts: 1, lastFailedAt: 5 }]);
});

test("a repeated failure of the same file increments attempts instead of duplicating", () => {
  const tracker = createProgressTracker({ now: () => 0 });
  tracker.beginBatch(1);
  tracker.fileFailed("bad.ts", new Error("one"));
  tracker.endBatch();
  tracker.beginBatch(1);
  tracker.fileFailed("bad.ts", "two");
  const s = tracker.snapshot();
  assert.equal(s.failures.length, 1);
  assert.equal(s.failures[0]!.attempts, 2);
  assert.equal(s.failures[0]!.error, "two");
});

test("a later successful re-index clears a recorded failure", () => {
  const tracker = createProgressTracker({ now: () => 0 });
  tracker.beginBatch(1);
  tracker.fileFailed("flaky.ts", new Error("boom"));
  tracker.endBatch();
  tracker.beginBatch(1);
  tracker.fileDone("flaky.ts");
  const s = tracker.snapshot();
  assert.deepEqual(s.failures, []);
  assert.equal(s.failed, 0);
});

test("a new run keeps earlier failures visible until the file is re-indexed", () => {
  const tracker = createProgressTracker({ now: () => 0 });
  tracker.beginBatch(1);
  tracker.fileFailed("bad.ts", new Error("boom"));
  tracker.endBatch();
  tracker.beginBatch(1);
  assert.equal(tracker.snapshot().failures.length, 1);
});

test("fail() ends the run in phase 'failed' with the error message", () => {
  const tracker = createProgressTracker({ now: () => 0 });
  tracker.setPhase("scanning");
  tracker.fail(new Error("walk exploded"));
  const s = tracker.snapshot();
  assert.equal(s.running, false);
  assert.equal(s.phase, "failed");
  assert.equal(s.lastError, "walk exploded");
});

test("setModelLoading switches phase only while a run is active and restores it afterwards", () => {
  const tracker = createProgressTracker({ now: () => 0 });
  tracker.setModelLoading(true); // idle: a search-triggered model load must not look like indexing
  assert.equal(tracker.snapshot().running, false);
  tracker.setModelLoading(false);

  tracker.beginBatch(1);
  tracker.setModelLoading(true);
  assert.equal(tracker.snapshot().phase, "loading-model");
  tracker.setModelLoading(false);
  assert.equal(tracker.snapshot().phase, "indexing");
});

test("onChange fires on every state change with a snapshot", () => {
  const seen: string[] = [];
  const tracker = createProgressTracker({ now: () => 0, onChange: (s) => seen.push(s.phase) });
  tracker.setPhase("scanning");
  tracker.beginBatch(1);
  tracker.fileDone("a.ts");
  tracker.endBatch();
  assert.deepEqual(seen, ["scanning", "indexing", "indexing", "done"]);
});

test("the failure list is capped, dropping the oldest entries", () => {
  const tracker = createProgressTracker({ now: () => 0, maxFailures: 3 });
  tracker.beginBatch(5);
  for (const f of ["a", "b", "c", "d", "e"]) tracker.fileFailed(f, new Error("x"));
  const s = tracker.snapshot();
  assert.deepEqual(s.failures.map((f) => f.file), ["c", "d", "e"]);
  assert.equal(s.failed, 3);
});

test("beginBatch accumulates reasons for the run and a new run starts from zero", () => {
  const tracker = createProgressTracker();
  tracker.beginBatch(3, { upgrade: 2, new: 1 });
  tracker.beginBatch(1, { upgrade: 1 });
  assert.deepEqual(tracker.snapshot().reasons, { upgrade: 3, new: 1 });
  for (const f of ["a", "b", "c", "d"]) tracker.fileDone(f);
  tracker.endBatch();
  tracker.beginBatch(1, { changed: 1 });
  assert.deepEqual(tracker.snapshot().reasons, { changed: 1 });
});

test("a batch without work finishes immediately", () => {
  const tracker = createProgressTracker();
  tracker.beginBatch(0, {});
  tracker.endBatch();
  assert.equal(tracker.snapshot().phase, "done");
});

test("notices are deduplicated, appear in the snapshot and are cleared when a new run starts", () => {
  const tracker = createProgressTracker({ now: () => 0 });
  assert.deepEqual(tracker.snapshot().notices, []);
  tracker.beginBatch(1);
  tracker.addNotice("API key not set");
  tracker.addNotice("API key not set");
  assert.deepEqual(tracker.snapshot().notices, ["API key not set"]);
  tracker.fileDone("a.ts");
  tracker.endBatch();
  assert.deepEqual(tracker.snapshot().notices, ["API key not set"]);
  tracker.beginBatch(1);
  assert.deepEqual(tracker.snapshot().notices, []);
});
