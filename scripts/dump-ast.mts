// Prints the tree-sitter syntax tree the graph extractors see.
// Usage: npm run dump-ast -- <ext> [file|-] [maxDepth]
//   echo 'class A {}' | npm run dump-ast -- .ts -
import fs from "node:fs";
import type { Node } from "web-tree-sitter";
import { withParsedTree } from "../src/indexing/graph/parse.js";

const [ext, source = "-", depthArg] = process.argv.slice(2);
if (!ext) {
  console.error("usage: npm run dump-ast -- <ext> [file|-] [maxDepth]");
  process.exit(2);
}
const maxDepth = depthArg ? Number(depthArg) : 12;
const content = fs.readFileSync(source === "-" ? 0 : source, "utf8");

const show = (n: Node, depth: number): void => {
  if (depth > maxDepth) return;
  const leaf = n.namedChildCount === 0;
  console.log(`${"  ".repeat(depth)}${n.type}${leaf ? ` ${JSON.stringify(n.text.slice(0, 60))}` : ""} [${n.startPosition.row + 1}]`);
  for (const c of n.namedChildren) show(c, depth + 1);
};

const ok = await withParsedTree(content, ext.startsWith(".") ? ext : `.${ext}`, (root) => show(root, 0));
if (ok === null) {
  console.error(`no grammar for ${ext}, or parse failed`);
  process.exit(1);
}
