import type { TreeSitterChunk } from "./treesitter-chunker.js";

/**
 * Angular decorator-attachment fix -- TS port of
 * `.ai-context/watcher/chunker.py`'s `_apply_decorator_fix`/
 * `_find_decorator_start` (`port-tree-sitter-chunker-followups`, item
 * 1). A class/function chunk immediately preceded by an Angular
 * decorator (`@Component`/`@Injectable`/`@Directive`/`@Pipe`/
 * `@NgModule`) should carry the decorator with it, not leave it
 * orphaned in the previous chunk (or the preamble) -- the decorator IS
 * a sibling of `class_declaration` inside TypeScript's
 * `export_statement` wrapper node, not a child of it, so
 * `treesitter-chunker.ts`'s boundary detection (which starts each
 * chunk at the matched declaration node itself) never includes it.
 * Applied as a post-pass over an already-produced chunk list; `.ts`/
 * `.tsx` only, matching the original's own scope.
 */

const NG_DECORATOR_RE = /^\s*@(?:Component|Injectable|Directive|Pipe|NgModule)/;

/**
 * Given a class/function chunk's current 1-based start line, looks
 * backward for an immediately-preceding Angular decorator line,
 * tolerating exactly one blank line in between and a multi-line
 * decorator argument list (e.g. a multi-line
 * `@Component({ selector: ..., template: ... })`). Returns the
 * decorator's own 1-based start line, or `undefined` if there isn't one.
 */
function findDecoratorStart(declarationStartLine: number, lines: string[]): number | undefined {
  let idx = declarationStartLine - 2; // 0-based index of the line just above
  if (idx >= 0 && !lines[idx]!.trim()) {
    idx -= 1; // allow exactly one blank line between decorator and declaration
  }
  if (idx < 0) return undefined;

  const candidate = lines[idx]!.trim();
  if (NG_DECORATOR_RE.test(candidate)) {
    return idx + 1; // single-line decorator, e.g. "@Injectable()"
  }

  if (!/[)}\]]$/.test(candidate)) {
    return undefined; // not the tail of a bracketed decorator call
  }

  // Walk backward, depth-counting brackets, to find the decorator
  // call's own opening line.
  let depth = 0;
  for (let j = idx; j >= 0; j--) {
    const line = lines[j]!;
    for (let k = line.length - 1; k >= 0; k--) {
      const ch = line[k];
      if (ch === ")" || ch === "}" || ch === "]") {
        depth += 1;
      } else if (ch === "(" || ch === "{" || ch === "[") {
        depth -= 1;
        if (depth === 0) {
          return NG_DECORATOR_RE.test(line.trim()) ? j + 1 : undefined;
        }
      }
    }
  }
  return undefined; // unbalanced brackets -- bail out rather than overshoot
}

/**
 * Extends class/function chunks backward across a preceding Angular
 * decorator, shrinking the previous chunk's end line to match so the
 * two chunks stay non-overlapping (dropping the previous chunk
 * entirely if it becomes empty -- e.g. it was only the decorator,
 * nothing else). No-op for any extension other than `.ts`/`.tsx`.
 */
export function applyDecoratorFix(chunks: TreeSitterChunk[], content: string, extension: string): TreeSitterChunk[] {
  if (extension !== ".ts" && extension !== ".tsx") return chunks;

  const lines = content.split("\n");
  const result = chunks.map((c) => ({ ...c }));

  for (let i = 0; i < result.length; i++) {
    const chunk = result[i]!;
    if (chunk.chunkType !== "class" && chunk.chunkType !== "function") continue;

    const decoratorStart = findDecoratorStart(chunk.startLine, lines);
    if (decoratorStart === undefined || decoratorStart >= chunk.startLine) continue;

    if (i > 0) {
      const prev = result[i - 1]!;
      if (prev.endLine >= decoratorStart) {
        prev.endLine = decoratorStart - 1;
        prev.text = lines
          .slice(prev.startLine - 1, prev.endLine)
          .join("\n")
          .trim();
      }
    }

    chunk.startLine = decoratorStart;
    chunk.text = lines
      .slice(decoratorStart - 1, chunk.endLine)
      .join("\n")
      .trim();
  }

  return result.filter((c) => c.text);
}
