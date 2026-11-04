import type { Node } from "web-tree-sitter";
import { withParsedTree } from "./parse.js";
import type { LanguageSpec } from "./language-specs.js";

/** An import as written in source, before being resolved to a repo file. */
export interface RawImport {
  specifier: string;
  /**
   * Language-specific flavor the resolver needs: `mod` (Rust `mod x;`),
   * `local`/`system` (C/C++ `#include "x"` vs `<x>`), `relative` (Ruby `require_relative`).
   */
  kind?: string;
  /** Names pulled in (`default`, `*`, or identifiers) when the syntax lists them. */
  importedNames?: string[];
  line: number;
}

const line = (n: Node) => n.startPosition.row + 1;

function stringValue(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  const fragment = node.namedChildren.find((c) => c.type === "string_fragment" || c.type === "string_content");
  if (fragment) return fragment.text;
  const text = node.text;
  return /^["'`].*["'`]$/.test(text) ? text.slice(1, -1) : undefined;
}

function ecmaScriptImports(root: Node): RawImport[] {
  const out: RawImport[] = [];
  const visit = (n: Node): void => {
    if (n.type === "import_statement" || n.type === "export_statement") {
      const source = n.childForFieldName("source") ?? n.namedChildren.find((c) => c.type === "import_require_clause")?.childForFieldName("source");
      const specifier = stringValue(source);
      if (specifier !== undefined) {
        const names: string[] = [];
        for (const child of n.namedChildren) {
          if (child.type === "import_clause") {
            for (const part of child.namedChildren) {
              if (part.type === "identifier") names.push("default");
              else if (part.type === "namespace_import") names.push("*");
              else if (part.type === "named_imports") {
                for (const s of part.namedChildren) if (s.type === "import_specifier") names.push(s.childForFieldName("name")!.text);
              }
            }
          } else if (child.type === "export_clause") {
            for (const s of child.namedChildren) if (s.type === "export_specifier") names.push(s.childForFieldName("name")!.text);
          }
        }
        if (n.type === "export_statement" && names.length === 0) names.push("*");
        out.push({ specifier, importedNames: names.length > 0 ? names : undefined, line: line(n) });
        return;
      }
    }
    if (n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      if (fn && ((fn.type === "identifier" && fn.text === "require") || fn.type === "import")) {
        const arg = n.childForFieldName("arguments")?.namedChildren[0];
        const specifier = arg?.type === "string" ? stringValue(arg) : undefined;
        if (specifier !== undefined) out.push({ specifier, line: line(n) });
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return out;
}

function pythonImports(root: Node): RawImport[] {
  const out: RawImport[] = [];
  const plainName = (n: Node) => (n.type === "aliased_import" ? n.childForFieldName("name")!.text : n.text);
  const visit = (n: Node): void => {
    if (n.type === "import_statement") {
      for (const name of n.childrenForFieldName("name")) out.push({ specifier: plainName(name), line: line(n) });
      return;
    }
    if (n.type === "import_from_statement") {
      const module = n.childForFieldName("module_name")!.text;
      const names = n.childrenForFieldName("name").map(plainName);
      if (n.namedChildren.some((c) => c.type === "wildcard_import")) names.push("*");
      out.push({ specifier: module, importedNames: names.length > 0 ? names : undefined, line: line(n) });
      return;
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return out;
}

function dottedImports(root: Node, nodeType: string, pattern: RegExp): RawImport[] {
  const out: RawImport[] = [];
  const visit = (n: Node): void => {
    if (n.type === nodeType) {
      const match = pattern.exec(n.text.replace(/\s+/g, " ").trim());
      if (match) {
        const wildcard = match[2] !== undefined || n.namedChildren.some((c) => c.type === "asterisk");
        out.push({ specifier: match[1]!, importedNames: wildcard ? ["*"] : undefined, line: line(n) });
      }
      return;
    }
    // Java/Kotlin/C# imports live at the top level (or directly inside a namespace/package body).
    if (n.type.endsWith("_declaration") && n.type !== "namespace_declaration" && n.type !== "package_declaration") return;
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return out;
}

function goImports(root: Node): RawImport[] {
  const out: RawImport[] = [];
  const visit = (n: Node): void => {
    if (n.type === "import_spec") {
      const path = n.childForFieldName("path");
      if (path) out.push({ specifier: path.text.slice(1, -1), line: line(n) });
      return;
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return out;
}

function expandRustUse(node: Node, prefix: string[]): string[][] {
  switch (node.type) {
    case "scoped_use_list": {
      const p = node.childForFieldName("path")?.text.split("::") ?? [];
      const list = node.childForFieldName("list");
      return (list?.namedChildren ?? []).flatMap((c) => expandRustUse(c, [...prefix, ...p]));
    }
    case "use_list":
      return node.namedChildren.flatMap((c) => expandRustUse(c, prefix));
    case "use_as_clause": {
      const path = node.childForFieldName("path");
      return path ? expandRustUse(path, prefix) : [];
    }
    case "use_wildcard": {
      const path = node.namedChildren[0];
      return path ? [[...prefix, ...path.text.split("::")]] : [prefix];
    }
    default:
      return [[...prefix, ...node.text.split("::")]];
  }
}

function rustImports(root: Node): RawImport[] {
  const out: RawImport[] = [];
  const visit = (n: Node): void => {
    if (n.type === "use_declaration") {
      const arg = n.childForFieldName("argument");
      if (arg) {
        const wildcard = arg.type === "use_wildcard";
        for (const segs of expandRustUse(arg, [])) {
          out.push({ specifier: segs.join("::"), importedNames: wildcard ? ["*"] : undefined, line: line(n) });
        }
      }
      return;
    }
    if (n.type === "mod_item" && !n.childForFieldName("body")) {
      const name = n.childForFieldName("name")?.text;
      if (name) out.push({ specifier: name, kind: "mod", line: line(n) });
      return;
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return out;
}

const RUBY_REQUIRES = new Set(["require", "require_relative", "load"]);

function rubyImports(root: Node): RawImport[] {
  const out: RawImport[] = [];
  const visit = (n: Node): void => {
    if (n.type === "call" && !n.childForFieldName("receiver")) {
      const method = n.childForFieldName("method")?.text;
      const arg = n.childForFieldName("arguments")?.namedChildren[0];
      if (method && RUBY_REQUIRES.has(method) && arg?.type === "string") {
        const specifier = stringValue(arg);
        if (specifier !== undefined) {
          out.push({ specifier, kind: method === "require_relative" ? "relative" : undefined, line: line(n) });
        }
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return out;
}

function cIncludes(root: Node): RawImport[] {
  const out: RawImport[] = [];
  const visit = (n: Node): void => {
    if (n.type === "preproc_include") {
      const path = n.childForFieldName("path");
      if (path) {
        const system = path.type === "system_lib_string";
        out.push({ specifier: system ? path.text.slice(1, -1) : (stringValue(path) ?? path.text), kind: system ? "system" : "local", line: line(n) });
      }
      return;
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return out;
}

export function importsFromTree(root: Node, spec: LanguageSpec): RawImport[] {
  switch (spec.language) {
    case "typescript":
    case "javascript":
      return ecmaScriptImports(root);
    case "python":
      return pythonImports(root);
    case "java":
      return dottedImports(root, "import_declaration", /^import (?:static )?([\w.]+?)(\.\*)?\s*;?$/);
    case "kotlin":
      return dottedImports(root, "import", /^import ([\w.`]+?)(\.\*)?(?: as \w+)?$/);
    case "csharp":
      return dottedImports(root, "using_directive", /^(?:global )?using (?:static )?(?:\w+ = )?([\w.]+)(\.\*)?\s*;?$/);
    case "go":
      return goImports(root);
    case "rust":
      return rustImports(root);
    case "ruby":
      return rubyImports(root);
    case "c":
    case "cpp":
      return cIncludes(root);
    default:
      return [];
  }
}

/** Raw imports of `content`, or `null` for unsupported extensions / parse failures. */
export function extractImports(content: string, extension: string): Promise<RawImport[] | null> {
  return withParsedTree(content, extension, (root, spec) => importsFromTree(root, spec));
}
