import { test } from "node:test";
import assert from "node:assert/strict";
import { extractImports } from "../../src/indexing/graph/import-extractor.js";

/** Compact `specifier|kind|names` rendering, one entry per import in document order. */
async function importsOf(extension: string, source: string): Promise<string[]> {
  const result = await extractImports(source, extension);
  assert.ok(result, `no extractor for ${extension}`);
  return result!.map((i) => [i.specifier, i.kind ?? "", (i.importedNames ?? []).join(",")].join("|"));
}

test("extractImports returns null for unsupported extensions", async () => {
  assert.equal(await extractImports("x", ".md"), null);
});

test("extractImports records 1-based lines", async () => {
  const r = await extractImports('\n\nimport a from "./a";\n', ".ts");
  assert.equal(r![0]!.line, 3);
});

test("typescript/javascript: static, namespace, side-effect, re-export, require and dynamic import", async () => {
  const src = [
    'import a, { b as c, type D } from "./x";',
    'import * as ns from "y";',
    'import "side";',
    'export { e } from "./z";',
    'export * from "./w";',
    'const r = require("r");',
    'const m = await import("./dyn");',
    'import q = require("q");',
    "const dynamicName = require(name);",
    "const t = `x`; export const local = 1;",
  ].join("\n");
  assert.deepEqual(await importsOf(".ts", src), [
    "./x||default,b,D", "y||*", "side||", "./z||e", "./w||*", "r||", "./dyn||", "q||",
  ]);
  assert.deepEqual(await importsOf(".jsx", 'import React from "react";'), ["react||default"]);
});

test("python: import, aliased import, from-import with relative prefixes and wildcard", async () => {
  const src = "import a.b, c as d\nfrom . import x\nfrom ..p.q import (r, s as t)\nfrom m import *\n";
  assert.deepEqual(await importsOf(".py", src), ["a.b||", "c||", ".||x", "..p.q||r,s", "m||*"]);
});

test("java: plain, static and wildcard imports", async () => {
  assert.deepEqual(await importsOf(".java", "import a.b.C;\nimport static a.b.C.m;\nimport a.b.*;\n"), [
    "a.b.C||", "a.b.C.m||", "a.b||*",
  ]);
});

test("kotlin: plain, wildcard and aliased imports", async () => {
  assert.deepEqual(await importsOf(".kt", "import a.b.C\nimport a.b.*\nimport a.b.D as E\n"), [
    "a.b.C||", "a.b||*", "a.b.D||",
  ]);
});

test("csharp: using, using static, alias and global using", async () => {
  assert.deepEqual(await importsOf(".cs", "using System;\nusing static A.B.C;\nusing X = A.B;\nglobal using Z.Y;\n"), [
    "System||", "A.B.C||", "A.B||", "Z.Y||",
  ]);
});

test("go: grouped imports with alias and blank identifier, single-line import", async () => {
  assert.deepEqual(await importsOf(".go", 'package m\nimport (\n  "fmt"\n  al "a/b"\n  _ "c"\n)\nimport "d"\n'), [
    "fmt||", "a/b||", "c||", "d||",
  ]);
});

test("rust: use trees are expanded to one path per leaf; mod declarations are imports, inline mods are not", async () => {
  const src = "use crate::a::{b, c::d as e};\nuse super::f;\nuse g::*;\nmod h;\nmod i { }\nuse j;\n";
  assert.deepEqual(await importsOf(".rs", src), [
    "crate::a::b||", "crate::a::c::d||", "super::f||", "g||*", "h|mod|", "j||",
  ]);
});

test("ruby: require, require_relative and load with string literals; method calls on receivers are ignored", async () => {
  const src = 'require "a"\nrequire_relative "../b"\nload "c.rb"\nfoo.require "x"\nrequire name\n';
  assert.deepEqual(await importsOf(".rb", src), ["a||", "../b|relative|", "c.rb||"]);
});

test("c/cpp: quoted includes are local, angle includes are system", async () => {
  assert.deepEqual(await importsOf(".c", '#include "a.h"\n#include <stdio.h>\n'), ["a.h|local|", "stdio.h|system|"]);
  assert.deepEqual(await importsOf(".hpp", "#include <vector>\n"), ["vector|system|"]);
});
