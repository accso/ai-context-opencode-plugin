import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createStatusFileWriter, resolveStatusFilePath } from "../../src/indexing/status-file.js";
import { createProgressTracker, type IndexProgressSnapshot } from "../../src/indexing/index-progress.js";

function snap(over: Partial<IndexProgressSnapshot> = {}): IndexProgressSnapshot {
  const tracker = createProgressTracker({ now: () => 0 });
  return { ...tracker.snapshot(), ...over };
}

function fakeFs() {
  const files = new Map<string, string>();
  const log: string[] = [];
  return {
    files,
    log,
    fs: {
      mkdirSync: (p: string) => void log.push(`mkdir ${p}`),
      writeFileSync: (p: string, data: string) => {
        log.push(`write ${p}`);
        files.set(p, data);
      },
      renameSync: (from: string, to: string) => {
        log.push(`rename ${from} -> ${to}`);
        files.set(to, files.get(from)!);
        files.delete(from);
      },
    },
  };
}

test("resolveStatusFilePath puts the file in <worktree>/.opencode/ai-context/", () => {
  assert.equal(
    resolveStatusFilePath("/repo"),
    path.join("/repo", ".opencode", "ai-context", "index-status.json"),
  );
});

test("write() creates the directory and writes via tmp file + rename (atomic)", () => {
  const f = fakeFs();
  const writer = createStatusFileWriter({ filePath: "/repo/.opencode/ai-context/index-status.json", fs: f.fs, now: () => 0 });
  writer.write(snap({ phase: "indexing", running: true, done: 1, total: 2 }));
  assert.match(f.log[0]!, /^mkdir /);
  assert.match(f.log[1]!, /^write .*index-status\.json\..*\.tmp$/);
  assert.match(f.log[2]!, /^rename .* -> \/repo\/\.opencode\/ai-context\/index-status\.json$/);
  const parsed = JSON.parse(f.files.get("/repo/.opencode/ai-context/index-status.json")!);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.done, 1);
  assert.equal(parsed.total, 2);
});

test("progress updates within the throttle window are skipped; later ones are written", () => {
  const f = fakeFs();
  let t = 0;
  const writer = createStatusFileWriter({ filePath: "/s.json", fs: f.fs, now: () => t, throttleMs: 2000 });
  writer.write(snap({ phase: "indexing", running: true, done: 1 }));
  t = 500;
  writer.write(snap({ phase: "indexing", running: true, done: 2 }));
  assert.equal(JSON.parse(f.files.get("/s.json")!).done, 1);
  t = 2500;
  writer.write(snap({ phase: "indexing", running: true, done: 3 }));
  assert.equal(JSON.parse(f.files.get("/s.json")!).done, 3);
});

test("a phase change is always written immediately, even inside the throttle window", () => {
  const f = fakeFs();
  const writer = createStatusFileWriter({ filePath: "/s.json", fs: f.fs, now: () => 0, throttleMs: 2000 });
  writer.write(snap({ phase: "indexing", running: true, done: 1 }));
  writer.write(snap({ phase: "done", running: false, done: 2 }));
  assert.equal(JSON.parse(f.files.get("/s.json")!).phase, "done");
});

test("a newly recorded failure is written immediately", () => {
  const f = fakeFs();
  const writer = createStatusFileWriter({ filePath: "/s.json", fs: f.fs, now: () => 0, throttleMs: 2000 });
  writer.write(snap({ phase: "indexing", running: true, failed: 0 }));
  writer.write(snap({ phase: "indexing", running: true, failed: 1, failures: [{ file: "x.ts", error: "e", attempts: 1, lastFailedAt: 0 }] }));
  assert.equal(JSON.parse(f.files.get("/s.json")!).failures[0].file, "x.ts");
});

test("filesystem errors never propagate to the caller", () => {
  const writer = createStatusFileWriter({
    filePath: "/s.json",
    now: () => 0,
    fs: {
      mkdirSync: () => {},
      writeFileSync: () => {
        throw new Error("EACCES");
      },
      renameSync: () => {},
    },
  });
  assert.doesNotThrow(() => writer.write(snap({ phase: "done" })));
});

test("write errors go to onError (once per failing write) and never throw", () => {
  const errors: unknown[] = [];
  const writer = createStatusFileWriter({
    filePath: "/x/index-status.json",
    fs: {
      mkdirSync: () => {
        throw new Error("EACCES");
      },
      writeFileSync: () => {},
      renameSync: () => {},
    } as never,
    onError: (e) => void errors.push(e),
  });
  writer.write({ phase: "scanning", failed: 0, failures: [] } as never);
  assert.equal(errors.length, 1);
});
