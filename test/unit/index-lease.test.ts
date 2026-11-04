import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createIndexLease } from "../../src/indexing/index-lease.js";

function tmp() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lease-")), "index.lock");
}

test("only one holder at a time, released lease can be taken again", () => {
  const file = tmp();
  const a = createIndexLease({ filePath: file, pid: 1, isAlive: () => true });
  const b = createIndexLease({ filePath: file, pid: 2, isAlive: () => true });
  assert.equal(a.tryAcquire(), true);
  assert.equal(b.tryAcquire(), false);
  a.release();
  assert.equal(b.tryAcquire(), true);
  b.release();
  assert.equal(fs.existsSync(file), false);
});

test("a lease of a dead process is taken over", () => {
  const file = tmp();
  fs.writeFileSync(file, JSON.stringify({ pid: 99, ts: Date.now() }));
  const b = createIndexLease({ filePath: file, pid: 2, isAlive: (pid) => pid !== 99 });
  assert.equal(b.tryAcquire(), true);
  b.release();
});

test("a lease without a recent heartbeat is stale even if the pid is alive", () => {
  const file = tmp();
  let now = 1_000_000;
  fs.writeFileSync(file, JSON.stringify({ pid: 1, ts: now }));
  const b = createIndexLease({ filePath: file, pid: 2, isAlive: () => true, staleMs: 30_000, now: () => now });
  assert.equal(b.tryAcquire(), false);
  now += 31_000;
  assert.equal(b.tryAcquire(), true);
  b.release();
});

test("heartbeat refreshes the timestamp; release by a non-holder does not delete", () => {
  const file = tmp();
  let now = 1000;
  const a = createIndexLease({ filePath: file, pid: 1, isAlive: () => true, now: () => now, heartbeatMs: 0 });
  const other = createIndexLease({ filePath: file, pid: 2, isAlive: () => true, now: () => now });
  assert.equal(a.tryAcquire(), true);
  now = 5000;
  a.heartbeat();
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).ts, 5000);
  other.release();
  assert.equal(fs.existsSync(file), true);
  a.release();
});

test("run waits for the lease, then runs the job and releases", async () => {
  const file = tmp();
  const a = createIndexLease({ filePath: file, pid: 1, isAlive: () => true });
  const b = createIndexLease({ filePath: file, pid: 2, isAlive: () => true, pollMs: 5 });
  a.tryAcquire();
  let ran = false;
  const p = b.run(async () => {
    ran = true;
    return 7;
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ran, false);
  a.release();
  assert.equal(await p, 7);
  assert.equal(fs.existsSync(file), false);
});

test("run releases the lease when the job throws", async () => {
  const file = tmp();
  const a = createIndexLease({ filePath: file, pid: 1, isAlive: () => true });
  await assert.rejects(() => a.run(async () => { throw new Error("x"); }), /x/);
  assert.equal(fs.existsSync(file), false);
});
