import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDecoratorFix } from "../../src/indexing/tree-sitter/decorator-fix.js";
import { chunkWithTreeSitter } from "../../src/indexing/tree-sitter/treesitter-chunker.js";

/**
 * Unit tests for the Angular decorator-attachment fix -- TS port of
 * `.ai-context/watcher/chunker.py`'s `_apply_decorator_fix`/
 * `_find_decorator_start` (`port-tree-sitter-chunker-followups`, item 1).
 * A class/function chunk immediately preceded by an Angular decorator
 * (`@Component`/`@Injectable`/`@Directive`/`@Pipe`/`@NgModule`) should
 * carry the decorator with it rather than leaving it orphaned in the
 * previous chunk (or the preamble). `.ts`/`.tsx` only, applied as a
 * post-pass over an already-produced chunk list.
 */

test("applyDecoratorFix moves a single-line decorator from the preamble into the class chunk it precedes", async () => {
  const content = ['import { Component } from "@angular/core";', "", "@Component({})", "export class Foo {}", ""].join(
    "\n",
  );
  const chunks = await chunkWithTreeSitter(content, ".ts");
  assert.ok(chunks);
  const fixed = applyDecoratorFix(chunks!, content, ".ts");

  assert.equal(fixed.length, 2);
  assert.equal(fixed[0]!.chunkType, "block");
  assert.ok(!fixed[0]!.text.includes("@Component"));
  assert.equal(fixed[1]!.symbol, "Foo");
  assert.ok(fixed[1]!.text.startsWith("@Component({})"));
  assert.equal(fixed[1]!.startLine, 3);
});

test("applyDecoratorFix drops the previous chunk entirely when the decorator was its only content", async () => {
  const content = ["@Injectable()", "export class Svc {}", ""].join("\n");
  const chunks = await chunkWithTreeSitter(content, ".ts");
  assert.ok(chunks);
  const fixed = applyDecoratorFix(chunks!, content, ".ts");

  assert.equal(fixed.length, 1);
  assert.equal(fixed[0]!.symbol, "Svc");
  assert.equal(fixed[0]!.startLine, 1);
  assert.ok(fixed[0]!.text.startsWith("@Injectable()"));
});

test("applyDecoratorFix tolerates exactly one blank line between decorator and declaration", async () => {
  const content = ["@Component({})", "", "export class Foo {}", ""].join("\n");
  const chunks = await chunkWithTreeSitter(content, ".ts");
  assert.ok(chunks);
  const fixed = applyDecoratorFix(chunks!, content, ".ts");

  assert.equal(fixed.length, 1);
  assert.equal(fixed[0]!.startLine, 1);
  assert.ok(fixed[0]!.text.includes("@Component({})"));
});

test("applyDecoratorFix handles a multi-line decorator argument list", async () => {
  const content = [
    "@Component({",
    "  selector: 'app-foo',",
    "  template: '<div></div>',",
    "})",
    "export class Foo {}",
    "",
  ].join("\n");
  const chunks = await chunkWithTreeSitter(content, ".ts");
  assert.ok(chunks);
  const fixed = applyDecoratorFix(chunks!, content, ".ts");

  assert.equal(fixed.length, 1);
  assert.equal(fixed[0]!.startLine, 1);
  assert.equal(fixed[0]!.endLine, 6);
});

test("applyDecoratorFix leaves chunks untouched when there is no preceding decorator", async () => {
  const content = ["export class Foo {}", "export class Bar {}", ""].join("\n");
  const chunks = await chunkWithTreeSitter(content, ".ts");
  assert.ok(chunks);
  const fixed = applyDecoratorFix(chunks!, content, ".ts");
  assert.deepEqual(fixed, chunks);
});

test("applyDecoratorFix is a no-op for non-ts/tsx extensions", async () => {
  const content = ["public class Bar {}", ""].join("\n");
  const chunks = await chunkWithTreeSitter(content, ".java");
  assert.ok(chunks);
  const fixed = applyDecoratorFix(chunks!, content, ".java");
  assert.deepEqual(fixed, chunks);
});

test("applyDecoratorFix does not attach a non-Angular decorator", async () => {
  const content = ["@SomeOtherDecorator()", "export class Foo {}", ""].join("\n");
  const chunks = await chunkWithTreeSitter(content, ".ts");
  assert.ok(chunks);
  const fixed = applyDecoratorFix(chunks!, content, ".ts");
  assert.deepEqual(fixed, chunks);
});
