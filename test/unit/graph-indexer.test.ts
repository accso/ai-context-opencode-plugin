import { test } from "node:test";
import assert from "node:assert/strict";
import { createGraphStore } from "../../src/storage/graph-store.js";
import { createGraphIndexer } from "../../src/indexing/graph/graph-indexer.js";

function setup() {
  const store = createGraphStore({ path: ":memory:" });
  const indexer = createGraphIndexer({ store });
  return { store, indexer };
}

const callsTo = (store: ReturnType<typeof createGraphStore>, name: string) =>
  store.traverseCalls({ symbol: name, direction: "callers", depth: 1 }).edges;

test("update stores symbols, imports and calls for a supported file", async () => {
  const { store, indexer } = setup();
  await indexer.update("src/a.ts", 'import { b } from "./b";\nexport function a() { b(); }\n');
  indexer.finishBatch();
  const g = store.getFileGraph("src/a.ts")!;
  assert.equal(g.language, "typescript");
  assert.deepEqual(g.symbols.map((s) => s.name), ["a"]);
  assert.equal(g.imports[0]!.specifier, "./b");
  assert.deepEqual(g.calls.map((c) => c.calleeName), ["b"]);
});

test("imports resolve regardless of the order files are indexed in within one batch", async () => {
  const { store, indexer } = setup();
  await indexer.update("src/a.ts", 'import { b } from "./b";\nexport const x = b;\n');
  await indexer.update("src/b.ts", "export function b() {}\n");
  indexer.finishBatch();
  assert.deepEqual(store.importDependents("src/b.ts", 1).map((d) => d.relativePath), ["src/a.ts"]);
});

test("calls resolve to the defining file via imports and are not ambiguous", async () => {
  const { store, indexer } = setup();
  await indexer.update("src/a.ts", 'import { helper } from "./b";\nexport function a() { helper(); }\n');
  await indexer.update("src/b.ts", "export function helper() {}\n");
  await indexer.update("src/c.ts", "export function helper() {}\n");
  indexer.finishBatch();
  const [edge] = callsTo(store, "helper");
  assert.equal(edge!.calleePath, "src/b.ts");
  assert.equal(edge!.ambiguous, false);
});

test("a later batch that adds the missing file resolves earlier unresolved imports", async () => {
  const { store, indexer } = setup();
  await indexer.update("src/a.ts", 'import { b } from "./b";\nexport const x = b;\n');
  indexer.finishBatch();
  assert.deepEqual(store.importDependents("src/b.ts", 1), []);
  await indexer.update("src/b.ts", "export function b() {}\n");
  indexer.finishBatch();
  assert.deepEqual(store.importDependents("src/b.ts", 1).map((d) => d.relativePath), ["src/a.ts"]);
});

test("adding a second definition in a later batch turns an existing resolved call ambiguous", async () => {
  const { store, indexer } = setup();
  await indexer.update("far/a.ts", "export function a() { shared(); }\n");
  await indexer.update("other/one.ts", "export function shared() {}\n");
  indexer.finishBatch();
  assert.equal(callsTo(store, "shared")[0]!.ambiguous, true); // lone candidate without import evidence is a guess
  await indexer.update("elsewhere/two.ts", "export function shared() {}\n");
  indexer.finishBatch();
  const [edge] = callsTo(store, "shared");
  assert.equal(edge!.ambiguous, true);
  assert.equal(edge!.candidateCount, 2);
  assert.equal(edge!.calleePath, undefined);
});

test("removing a file (null content) deletes its rows and unresolves dependents", async () => {
  const { store, indexer } = setup();
  await indexer.update("src/a.ts", 'import { b } from "./b";\nexport function a() { b(); }\n');
  await indexer.update("src/b.ts", "export function b() {}\n");
  indexer.finishBatch();
  assert.equal(callsTo(store, "b")[0]!.calleePath, "src/b.ts");

  await indexer.update("src/b.ts", null);
  indexer.finishBatch();
  assert.equal(store.getFileGraph("src/b.ts"), null);
  assert.deepEqual(store.importDependents("src/b.ts", 1), []);
  const [edge] = callsTo(store, "b");
  assert.equal(edge!.calleePath, undefined);
  assert.equal(edge!.ambiguous, false);
});

test("unsupported extensions are ignored, and a file that becomes unsupported content-wise is removed", async () => {
  const { store, indexer } = setup();
  await indexer.update("README.md", "# hi\n");
  indexer.finishBatch();
  assert.equal(store.getFileGraph("README.md"), null);
  await indexer.update("src/a.ts", "export function a() {}\n");
  await indexer.update("src/a.ts", null);
  indexer.finishBatch();
  assert.equal(store.getFileGraph("src/a.ts"), null);
});

test("re-indexing a changed file replaces its symbols and edges", async () => {
  const { store, indexer } = setup();
  await indexer.update("src/a.ts", "export function old() { x(); }\n");
  indexer.finishBatch();
  await indexer.update("src/a.ts", "export function fresh() { y(); }\n");
  indexer.finishBatch();
  assert.deepEqual(store.findSymbols("old"), []);
  assert.equal(store.findSymbols("fresh").length, 1);
  assert.deepEqual(callsTo(store, "x"), []);
  assert.equal(callsTo(store, "y").length, 1);
});

test("finishBatch with nothing pending is a no-op", () => {
  const { indexer } = setup();
  indexer.finishBatch();
});

test("a file that fails extraction does not throw; its stale rows are dropped", async () => {
  const { store, indexer } = setup();
  await indexer.update("src/a.ts", "export function a() {}\n");
  indexer.finishBatch();
  await indexer.update("src/a.bin", "\u0000\u0001");
  indexer.finishBatch();
  assert.equal(store.getFileGraph("src/a.bin"), null);
});

test("python and go cross-file resolution works through the same pipeline", async () => {
  const { store, indexer } = setup();
  await indexer.update("app/main.py", "from . import helpers\n\ndef run():\n    helpers.go()\n");
  await indexer.update("app/helpers.py", "def go():\n    pass\n");
  indexer.finishBatch();
  assert.deepEqual(store.importDependents("app/helpers.py", 1).map((d) => d.relativePath), ["app/main.py"]);
  const [edge] = callsTo(store, "go");
  assert.equal(edge!.calleePath, "app/helpers.py");
  assert.equal(edge!.ambiguous, false);
});

const NG_HOST = "@Component({ selector: 'app-host', template: `<app-bar></app-bar><lib-ext></lib-ext>` })\nexport class Host {}\n";
const NG_BAR = "@Component({ selector: 'app-bar', template: '' })\nexport class BarComponent {}\n";

test("angular template tags resolve to the class owning the selector, even when it is indexed later", async () => {
  const { store, indexer } = setup();
  await indexer.update("src/host.ts", NG_HOST);
  indexer.finishBatch();
  assert.deepEqual(callsTo(store, "BarComponent"), []);

  await indexer.update("src/bar.ts", NG_BAR);
  indexer.finishBatch();
  const [edge] = callsTo(store, "BarComponent");
  assert.equal(edge!.callerSymbol, "Host");
  assert.equal(edge!.calleePath, "src/bar.ts");
  assert.equal(edge!.ambiguous, false);
  // an element no selector claims (third-party component) stays an unresolved edge to its tag
  assert.equal(callsTo(store, "lib-ext").length, 1);

  await indexer.update("src/bar.ts", null);
  indexer.finishBatch();
  assert.deepEqual(callsTo(store, "BarComponent"), []);
  assert.equal(callsTo(store, "app-bar").length, 1);
});

test("two classes claiming one selector make the template edge ambiguous", async () => {
  const { store, indexer } = setup();
  await indexer.update("src/host.ts", NG_HOST);
  await indexer.update("src/bar.ts", NG_BAR);
  await indexer.update("src/bar2.ts", NG_BAR.replace("BarComponent", "Bar2Component"));
  indexer.finishBatch();
  const edges = callsTo(store, "app-bar");
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.ambiguous, true);
  assert.equal(edges[0]!.candidateCount, 2);
});

test("dependency injection and jsx edges resolve across files", async () => {
  const { store, indexer } = setup();
  await indexer.update("src/svc.ts", "@Injectable()\nexport class DataService {}\n");
  await indexer.update("src/cmp.ts", 'import { DataService } from "./svc";\n@Component({selector: "x"})\nexport class Cmp { constructor(private d: DataService) {} }\n');
  await indexer.update("src/Item.tsx", "export function Item() { return null; }\n");
  await indexer.update("src/App.tsx", 'import { Item } from "./Item";\nexport function App() { return <Item/>; }\n');
  indexer.finishBatch();
  const di = callsTo(store, "DataService");
  assert.deepEqual(di.map((e) => [e.callerSymbol, e.calleePath, e.ambiguous]), [["Cmp", "src/svc.ts", false]]);
  const jsx = callsTo(store, "Item");
  assert.deepEqual(jsx.map((e) => [e.callerSymbol, e.calleePath, e.ambiguous]), [["App", "src/Item.tsx", false]]);
});
