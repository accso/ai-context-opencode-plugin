import { test } from "node:test";
import assert from "node:assert/strict";
import { createRescanTrigger, editedFiles, mayChangeFiles } from "../../src/indexing/rescan-trigger.js";
import { createRescanTool } from "../../src/tools/rescan.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("mayChangeFiles covers bash, write and edit but not read-only tools", () => {
  for (const t of ["bash", "write", "edit", "apply_patch", "idea_apply_patch"]) assert.equal(mayChangeFiles(t), true, t);
  for (const t of ["read", "grep", "semantic_search", "glob"]) assert.equal(mayChangeFiles(t), false, t);
});

test("a burst of notifications runs one rescan after the debounce", async () => {
  let runs = 0;
  const trigger = createRescanTrigger({ debounceMs: 20, run: async () => (runs++, 7) });
  trigger.notify("bash");
  trigger.notify("bash");
  trigger.notify("write");
  assert.equal(runs, 0);
  await sleep(80);
  assert.equal(runs, 1);
  assert.deepEqual(
    { runs: trigger.stats().runs, last: trigger.stats().lastTrigger, files: trigger.stats().lastFilesOnDisk },
    { runs: 1, last: "write", files: 7 },
  );
});

test("a request during a running rescan triggers exactly one more run", async () => {
  let runs = 0;
  const trigger = createRescanTrigger({
    debounceMs: 1000,
    run: async () => {
      runs++;
      await sleep(30);
      return 1;
    },
  });
  const first = trigger.runNow("manual");
  await sleep(5);
  const second = trigger.runNow("manual");
  await Promise.all([first, second]);
  assert.equal(runs, 2);
});

test("a failing rescan is reported and does not break later runs", async () => {
  const errors: unknown[] = [];
  let n = 0;
  const trigger = createRescanTrigger({
    debounceMs: 1000,
    onError: (e) => errors.push(e),
    run: async () => {
      if (n++ === 0) throw new Error("boom");
      return 3;
    },
  });
  await trigger.runNow("a");
  await trigger.runNow("b");
  assert.equal(errors.length, 1);
  assert.equal(trigger.stats().runs, 1);
});

test("ai_context_rescan runs now and reports the stats", async () => {
  const trigger = createRescanTrigger({ debounceMs: 1000, run: async () => 5 });
  const def = createRescanTool({ trigger });
  const out = JSON.parse((await def.execute({}, {} as never)) as string);
  assert.equal(out.rescanned, true);
  assert.equal(out.lastFilesOnDisk, 5);
  assert.equal(out.lastTrigger, "manual");
});

test("editedFiles reads the touched files from edit/write/patch arguments, null when unknown", () => {
  assert.deepEqual(editedFiles("edit", { filePath: "/w/a.ts", oldString: "x" }), [{ file: "/w/a.ts", event: "change" }]);
  assert.deepEqual(editedFiles("write", { path: "b.ts" }), [{ file: "b.ts", event: "change" }]);
  assert.deepEqual(
    editedFiles("apply_patch", {
      patchText: "*** Begin Patch\n*** Add File: n.ts\n+x\n*** Update File: u.ts\n*** Move to: m.ts\n*** Delete File: d.ts\n*** End Patch",
    }),
    [
      { file: "n.ts", event: "change" },
      { file: "u.ts", event: "change" },
      { file: "m.ts", event: "change" },
      { file: "d.ts", event: "unlink" },
    ],
  );
  assert.equal(editedFiles("shell", { command: "sed -i s/a/b/ x" }), null);
  assert.equal(editedFiles("edit", {}), null);
  assert.equal(editedFiles("apply_patch", { patchText: "garbage" }), null);
});
