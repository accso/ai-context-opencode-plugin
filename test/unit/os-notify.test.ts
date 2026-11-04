import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { notifyOs, createOsNotifyGate, createFileOsNotifyGate, appleScriptString } from "../../src/observability/os-notify.js";
import { createProgressNotifier } from "../../src/observability/progress-notifier.js";
import type { IndexProgressSnapshot } from "../../src/indexing/index-progress.js";

function recorder() {
  const calls: { command: string; args: string[] }[] = [];
  return { calls, runner: { run: (command: string, args: string[]) => void calls.push({ command, args }) } };
}

test("notifyOs uses osascript on macOS and escapes quotes", () => {
  const { calls, runner } = recorder();
  notifyOs('say "hi"', { title: "T", platform: "darwin", runner });
  assert.equal(calls[0]!.command, "osascript");
  assert.match(calls[0]!.args[1]!, /display notification "say \\"hi\\"" with title "T"/);
});

test("notifyOs uses notify-send on linux and is a no-op elsewhere", () => {
  const { calls, runner } = recorder();
  notifyOs("m", { title: "T", platform: "linux", runner });
  assert.deepEqual(calls, [{ command: "notify-send", args: ["T", "m"] }]);
  notifyOs("m", { platform: "win32", runner });
  assert.equal(calls.length, 1);
});

test("appleScriptString escapes backslashes and quotes", () => {
  assert.equal(appleScriptString('a\\b"c'), 'a\\\\b\\"c');
});

test("gate suppresses a repeat inside the window, allows it afterwards", () => {
  let t = 0;
  const gate = createOsNotifyGate({ windowMs: 100, now: () => t });
  assert.equal(gate.shouldNotify(), true);
  t = 50;
  assert.equal(gate.shouldNotify(), false);
  t = 150;
  assert.equal(gate.shouldNotify(), true);
});

test("file gate dedups across separate gate instances (processes) inside the window", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "os-gate-"));
  try {
    let t = 1_000;
    const mk = () => createFileOsNotifyGate({ dir, key: "k", windowMs: 100, now: () => t });
    assert.equal(mk().shouldNotify(), true);
    t = 1_050;
    assert.equal(mk().shouldNotify(), false);
    t = 1_200;
    assert.equal(mk().shouldNotify(), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const snap = (over: Partial<IndexProgressSnapshot>): IndexProgressSnapshot =>
  ({ running: false, phase: "idle", done: 0, total: 0, failed: 0, lastError: null, reasons: {}, ...over }) as IndexProgressSnapshot;

test("a big run notifies start and finish exactly once", () => {
  const messages: string[] = [];
  const feed = createProgressNotifier({ notify: (m) => void messages.push(m), minFilesForNotice: 20 });
  feed(snap({ running: true, phase: "scanning" }));
  feed(snap({ running: true, phase: "indexing", total: 100, done: 1 }));
  feed(snap({ running: true, phase: "indexing", total: 100, done: 50 }));
  feed(snap({ running: false, phase: "done", total: 100, done: 100, failed: 2 }));
  assert.equal(messages.length, 2);
  assert.match(messages[0]!, /100/);
  assert.match(messages[1]!, /100.*2/);
});

test("small watcher runs stay silent", () => {
  const messages: string[] = [];
  const feed = createProgressNotifier({ notify: (m) => void messages.push(m), minFilesForNotice: 20 });
  feed(snap({ running: true, phase: "indexing", total: 1, done: 0 }));
  feed(snap({ running: false, phase: "done", total: 1, done: 1 }));
  assert.deepEqual(messages, []);
});

test("failure always notifies once with the reason, even for small runs", () => {
  const messages: string[] = [];
  const feed = createProgressNotifier({ notify: (m) => void messages.push(m), minFilesForNotice: 20 });
  feed(snap({ running: false, phase: "failed", lastError: "max_memory_mb=4096 exceeded" }));
  feed(snap({ running: false, phase: "failed", lastError: "max_memory_mb=4096 exceeded" }));
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /max_memory_mb=4096/);
});

test("a second big run notifies again", () => {
  const messages: string[] = [];
  const feed = createProgressNotifier({ notify: (m) => void messages.push(m), minFilesForNotice: 20 });
  for (let i = 0; i < 2; i++) {
    feed(snap({ running: true, phase: "indexing", total: 50, done: 1 }));
    feed(snap({ running: false, phase: "done", total: 50, done: 50 }));
  }
  assert.equal(messages.length, 4);
});

function runSnapshot(overrides: Record<string, unknown>) {
  return {
    running: true, phase: "indexing", done: 0, total: 0, percent: 0, failed: 0, failures: [],
    currentFile: null, filesPerSec: null, etaSeconds: null, startedAt: 1, updatedAt: 1, finishedAt: null,
    lastError: null, reasons: {}, ...overrides,
  } as never;
}

test("self-healing is announced even for a few files, with the reasons", () => {
  const messages: string[] = [];
  const feed = createProgressNotifier({ notify: (m) => void messages.push(m), minFilesForNotice: 20 });
  feed(runSnapshot({ total: 3, reasons: { upgrade: 2, repair: 1 } }));
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /Updating index/);
  assert.match(messages[0]!, /2 new index format/);
  assert.match(messages[0]!, /1 repaired/);
  feed(runSnapshot({ running: false, phase: "done", done: 3, total: 3, percent: 100, reasons: { upgrade: 2, repair: 1 } }));
  assert.match(messages[1]!, /Index update finished: 3 files/);
});

test("plain new/changed files keep the old wording and the size threshold", () => {
  const messages: string[] = [];
  const feed = createProgressNotifier({ notify: (m) => void messages.push(m), minFilesForNotice: 20 });
  feed(runSnapshot({ total: 5, reasons: { changed: 5 } }));
  assert.equal(messages.length, 0);
  feed(runSnapshot({ total: 30, reasons: { new: 30 } }));
  assert.match(messages[0]!, /Indexing started: 30 files/);
});
