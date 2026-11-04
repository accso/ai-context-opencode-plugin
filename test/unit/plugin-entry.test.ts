import assert from "node:assert/strict";
import test from "node:test";
import * as entry from "../../src/index.js";

// One default export serves both loaders: 2.x reads `id` + `setup`, 1.x
// (>= 1.18.29) reads `id` + `server`. Any additional function export would be
// treated as a second plugin by the legacy 1.x loader.
test("entry exports exactly one default { id, setup, server }", () => {
  assert.deepEqual(Object.keys(entry), ["default"]);
  const mod = entry.default as { id?: unknown; setup?: unknown; server?: unknown };
  assert.equal(typeof mod.id, "string");
  assert.ok((mod.id as string).trim().length > 0);
  assert.equal(typeof mod.setup, "function");
  assert.equal(typeof mod.server, "function");
});
