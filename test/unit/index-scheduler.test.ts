import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  createIndexScheduler,
  type FileChangeBatchEntry,
} from "../../src/indexing/index-scheduler.js";

/**
 * Unit tests for the in-process debounce scheduler that replaces the old
 * always-on watcher container's own debounce loop (see plan.md, phased
 * todo 5 "Replace the watcher container with plugin hooks"). These tests
 * use node:test's fake timers so debounce timing is deterministic.
 */

test("createIndexScheduler coalesces multiple notify() calls within the debounce window into one indexFiles() call", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const indexFiles = mock.fn(async (_batch: FileChangeBatchEntry[]) => {});
  const scheduler = createIndexScheduler({ debounceMs: 2000, indexFiles });

  scheduler.notify("src/a.ts", "change");
  t.mock.timers.tick(500);
  scheduler.notify("src/b.ts", "add");
  t.mock.timers.tick(1999);
  assert.equal(indexFiles.mock.callCount(), 0, "should not have flushed yet");

  t.mock.timers.tick(1);
  // Let the pending flush's microtasks settle.
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(indexFiles.mock.callCount(), 1, "expected exactly one flush");
  const batch = indexFiles.mock.calls[0]!.arguments[0];
  assert.deepEqual(
    [...batch].sort((a, b) => a.file.localeCompare(b.file)),
    [
      { file: "src/a.ts", event: "change" },
      { file: "src/b.ts", event: "add" },
    ],
  );
});

test("createIndexScheduler dedupes repeated notifications for the same file, keeping the latest event", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const indexFiles = mock.fn(async (_batch: FileChangeBatchEntry[]) => {});
  const scheduler = createIndexScheduler({ debounceMs: 2000, indexFiles });

  scheduler.notify("src/a.ts", "add");
  scheduler.notify("src/a.ts", "change");
  scheduler.notify("src/a.ts", "unlink");
  t.mock.timers.tick(2000);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(indexFiles.mock.callCount(), 1);
  assert.deepEqual(indexFiles.mock.calls[0]!.arguments[0], [
    { file: "src/a.ts", event: "unlink" },
  ]);
});

test("createIndexScheduler.flush() flushes immediately and is a no-op when nothing is pending", async () => {
  const indexFiles = mock.fn(async (_batch: FileChangeBatchEntry[]) => {});
  const scheduler = createIndexScheduler({ debounceMs: 2000, indexFiles });

  await scheduler.flush();
  assert.equal(indexFiles.mock.callCount(), 0, "flush with nothing pending should not call indexFiles");

  scheduler.notify("src/a.ts", "change");
  await scheduler.flush();
  assert.equal(indexFiles.mock.callCount(), 1);
});

test("createIndexScheduler starts a new debounce window after each flush", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const indexFiles = mock.fn(async (_batch: FileChangeBatchEntry[]) => {});
  const scheduler = createIndexScheduler({ debounceMs: 2000, indexFiles });

  scheduler.notify("src/a.ts", "change");
  t.mock.timers.tick(2000);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(indexFiles.mock.callCount(), 1);

  scheduler.notify("src/b.ts", "add");
  t.mock.timers.tick(2000);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(indexFiles.mock.callCount(), 2);
  assert.deepEqual(indexFiles.mock.calls[1]!.arguments[0], [
    { file: "src/b.ts", event: "add" },
  ]);
});
