import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeVector16, encodeVector16 } from "../../src/storage/float16.js";

test("float16 round-trips typical embedding values within half precision", () => {
  const vector = [0, 1, -1, 0.5, -0.0123456, 0.3333333, 0.99951, -0.000061, 1e-7];
  const decoded = decodeVector16(encodeVector16(vector));
  assert.equal(decoded.length, vector.length);
  vector.forEach((v, i) => assert.ok(Math.abs(decoded[i]! - v) <= Math.max(Math.abs(v) * 1e-3, 6e-8), `${v} -> ${decoded[i]}`));
});

test("float16 encoding is two bytes per dimension and idempotent after one round trip", () => {
  const vector = Array.from({ length: 768 }, (_, i) => Math.sin(i) / 7);
  const encoded = encodeVector16(vector);
  assert.equal(Buffer.from(encoded, "base64").length, 768 * 2);
  assert.equal(encodeVector16(decodeVector16(encoded)), encoded);
});

test("float16 keeps infinities and clamps values beyond the half range to infinity", () => {
  assert.deepEqual(decodeVector16(encodeVector16([Infinity, -Infinity, 1e10])), [Infinity, -Infinity, Infinity]);
});

test("decodeVector16 rejects a payload with an odd byte length", () => {
  assert.throws(() => decodeVector16(Buffer.from([1, 2, 3]).toString("base64")));
});
