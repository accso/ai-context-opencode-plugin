import { test } from "node:test";
import assert from "node:assert/strict";
import { createRuntimeRegistry } from "../../src/hook/runtime-registry.js";

/**
 * opencode bootstraps plugins twice per session. Without sharing, both
 * instances indexed the same repo concurrently (two model sessions, a
 * locked database, double memory). The registry gives every plugin
 * instance of one worktree the same runtime.
 */

const fakeInit = () => ({ progress: { tag: "tracker" } as never });

test("the same worktree yields the same runtime, created only once", () => {
  const registry = createRuntimeRegistry();
  let created = 0;
  const a = registry.get("/repo", () => (created++, fakeInit()));
  const b = registry.get("/repo", () => (created++, fakeInit()));
  assert.equal(a, b);
  assert.equal(created, 1);
});

test("different worktrees get independent runtimes", () => {
  const registry = createRuntimeRegistry();
  assert.notEqual(registry.get("/a", fakeInit), registry.get("/b", fakeInit));
});

test("exclusive() runs jobs strictly one after another", async () => {
  const runtime = createRuntimeRegistry().get("/repo", fakeInit);
  const log: string[] = [];
  const job = (name: string, ms: number) => async () => {
    log.push(`start ${name}`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`end ${name}`);
  };
  await Promise.all([
    runtime.exclusive(job("a", 20)),
    runtime.exclusive(job("b", 1)),
  ]);
  assert.deepEqual(log, ["start a", "end a", "start b", "end b"]);
});

test("exclusive() keeps working after a job rejected, and still rejects that caller", async () => {
  const runtime = createRuntimeRegistry().get("/repo", fakeInit);
  await assert.rejects(
    () => runtime.exclusive(async () => Promise.reject(new Error("boom"))),
    /boom/,
  );
  assert.equal(await runtime.exclusive(async () => "next"), "next");
});

test("reconcileOnce() starts the work once; later callers share the same promise", async () => {
  const runtime = createRuntimeRegistry().get("/repo", fakeInit);
  let runs = 0;
  const work = async () => void runs++;
  const first = runtime.reconcileOnce(work);
  const second = runtime.reconcileOnce(work);
  await Promise.all([first, second]);
  assert.equal(runs, 1);
  assert.equal(first, second);
  await runtime.reconcileOnce(work); // even after completion: no second full pass in this process
  assert.equal(runs, 1);
});

test("embedder is created lazily once and shared", () => {
  const runtime = createRuntimeRegistry().get("/repo", fakeInit);
  let created = 0;
  const make = () => (created++, { id: created });
  assert.equal(runtime.sharedEmbedder(make), runtime.sharedEmbedder(make));
  assert.equal(created, 1);
});
