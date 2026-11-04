import { test } from "node:test";
import assert from "node:assert/strict";
import { createProblemReporter } from "../../src/observability/problem-reporter.js";

function setup(over: Record<string, unknown> = {}) {
  const popups: string[] = [];
  const logs: string[] = [];
  let t = 0;
  const reporter = createProblemReporter({
    notify: (m) => void popups.push(m),
    log: (m) => void logs.push(m),
    now: () => t,
    windowMs: 1000,
    seen: new Map(),
    ...over,
  });
  return { popups, logs, reporter, setTime: (v: number) => (t = v) };
}

test("a problem is logged and shown as an OS popup with context and reason", () => {
  const { popups, logs, reporter } = setup();
  reporter.report("Config", new Error("bad yaml"));
  assert.equal(popups.length, 1);
  assert.match(popups[0]!, /Config.*bad yaml/);
  assert.match(logs[0]!, /Config.*bad yaml/);
});

test("accepts plain string reasons and truncates very long messages", () => {
  const { popups, reporter } = setup();
  reporter.report("Ctx", "x".repeat(1000));
  assert.ok(popups[0]!.length <= 240);
});

test("the same problem inside the window is shown once, but still logged each time", () => {
  const { popups, logs, reporter, setTime } = setup();
  reporter.report("A", "boom");
  setTime(500);
  reporter.report("A", "boom");
  assert.equal(popups.length, 1);
  assert.equal(logs.length, 2);
  setTime(1500);
  reporter.report("A", "boom");
  assert.equal(popups.length, 2);
});

test("different problems are not deduplicated against each other", () => {
  const { popups, reporter } = setup();
  reporter.report("A", "one");
  reporter.report("A", "two");
  assert.equal(popups.length, 2);
});

test("a throwing notifier or logger never propagates", () => {
  const { reporter } = setup({
    notify: () => {
      throw new Error("x");
    },
    log: () => {
      throw new Error("y");
    },
  });
  reporter.report("A", "b");
});
