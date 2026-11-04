import type { Node } from "web-tree-sitter";
import { withParsedTree } from "./parse.js";
import type { LanguageSpec } from "./language-specs.js";
import { symbolsFromTree } from "./symbol-extractor.js";
import type { GraphSymbol } from "../../storage/graph-store.js";

/** A call site as written in source, before being matched against known symbols. */
export interface RawCall {
  /** Innermost declared function/method/constructor containing the call; absent at module scope. */
  callerSymbol?: string;
  calleeName: string;
  /** Receiver or scope text (`obj`, `a.b`, `Foo`, `this`) when it is a plain identifier chain. */
  qualifier?: string;
  /** `new` for constructor calls. */
  kind?: string;
  line: number;
}

interface CalleeRef {
  calleeName: string;
  qualifier?: string;
  kind?: string;
}

const CALLER_KINDS = new Set(["function", "method", "constructor"]);

/** Receivers like `a().d` or `x[0]` can't be matched to a type by name, so they carry no qualifier. */
function qualifierOf(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  const text = node.text.replace(/\s+/g, "");
  return /^[\w$.:@?!]+$/.test(text) ? text.replace(/[?!]/g, "") : undefined;
}

function typeName(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  const text = node.text.replace(/<.*$/s, "").split(/[.:]+/).filter(Boolean);
  return text[text.length - 1];
}

function scopedName(node: Node): CalleeRef | null {
  const parts = node.text.replace(/<[^<>]*>/g, "").replace(/\s+/g, "").split("::").filter(Boolean);
  const calleeName = parts[parts.length - 1];
  if (!calleeName) return null;
  return { calleeName, qualifier: parts.length > 1 ? parts.slice(0, -1).join("::") : undefined };
}

function member(receiver: Node | null, name: Node | null): CalleeRef | null {
  const calleeName = name?.type === "generic_name" ? name.namedChildren[0]?.text : name?.text;
  return calleeName ? { calleeName, qualifier: qualifierOf(receiver) } : null;
}

/** Callee behind an expression used as a function (handles generic wrappers). */
function calleeFromFunction(fn: Node | null, language: string): CalleeRef | null {
  if (!fn) return null;
  switch (fn.type) {
    case "identifier":
    case "field_identifier":
      return { calleeName: fn.text };
    case "member_expression":
      return member(fn.childForFieldName("object"), fn.childForFieldName("property"));
    case "attribute":
      return member(fn.childForFieldName("object"), fn.childForFieldName("attribute"));
    case "selector_expression":
      return member(fn.childForFieldName("operand"), fn.childForFieldName("field"));
    case "member_access_expression":
      return member(fn.childForFieldName("expression"), fn.childForFieldName("name"));
    case "field_expression":
      return language === "rust"
        ? member(fn.childForFieldName("value"), fn.childForFieldName("field"))
        : member(fn.childForFieldName("argument"), fn.childForFieldName("field"));
    case "scoped_identifier":
    case "qualified_identifier":
      return scopedName(fn);
    case "generic_function":
      return calleeFromFunction(fn.childForFieldName("function"), language);
    case "template_function":
      return calleeFromFunction(fn.childForFieldName("name"), language);
    case "generic_name":
      return fn.namedChildren[0] ? { calleeName: fn.namedChildren[0].text } : null;
    default:
      return null;
  }
}

function kotlinCallee(node: Node): CalleeRef | null {
  const first = node.namedChildren[0];
  if (!first) return null;
  if (first.type === "identifier") return { calleeName: first.text };
  if (first.type === "navigation_expression") {
    const parts = first.namedChildren;
    const name = parts[parts.length - 1];
    return name ? { calleeName: name.text, qualifier: qualifierOf(parts[0]) } : null;
  }
  return null;
}

const RUBY_REQUIRES = new Set(["require", "require_relative", "load"]);

function describeCall(node: Node, language: string): CalleeRef | null {
  switch (node.type) {
    case "call_expression": {
      if (language === "kotlin") return kotlinCallee(node);
      const fn = node.childForFieldName("function");
      if (fn?.type === "super" || fn?.type === "import") return null;
      if (fn?.type === "identifier" && fn.text === "require" && (language === "javascript" || language === "typescript")) return null;
      return calleeFromFunction(fn, language);
    }
    case "call": {
      if (language === "ruby") {
        const method = node.childForFieldName("method")?.text;
        const receiver = node.childForFieldName("receiver");
        if (!method || (!receiver && RUBY_REQUIRES.has(method))) return null;
        return { calleeName: method, qualifier: qualifierOf(receiver) };
      }
      return calleeFromFunction(node.childForFieldName("function"), language);
    }
    case "invocation_expression":
      return calleeFromFunction(node.childForFieldName("function"), language);
    case "method_invocation": {
      const name = node.childForFieldName("name");
      return name ? { calleeName: name.text, qualifier: qualifierOf(node.childForFieldName("object")) } : null;
    }
    case "new_expression":
    case "object_creation_expression": {
      const target = node.childForFieldName("constructor") ?? node.childForFieldName("type");
      const calleeName = typeName(target);
      return calleeName ? { calleeName, kind: "new" } : null;
    }
    default:
      return null;
  }
}

export function innermostCaller(symbols: GraphSymbol[], line: number): string | undefined {
  let best: GraphSymbol | undefined;
  for (const s of symbols) {
    if (!CALLER_KINDS.has(s.kind) || line < s.startLine || line > s.endLine) continue;
    if (!best || s.endLine - s.startLine < best.endLine - best.startLine || (s.endLine - s.startLine === best.endLine - best.startLine && s.startLine > best.startLine)) {
      best = s;
    }
  }
  return best?.name;
}

export function callsFromTree(root: Node, spec: LanguageSpec, symbols: GraphSymbol[]): RawCall[] {
  const out: RawCall[] = [];
  const visit = (n: Node): void => {
    const ref = describeCall(n, spec.language);
    if (ref) {
      const line = n.startPosition.row + 1;
      out.push({ callerSymbol: innermostCaller(symbols, line), ...ref, line });
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return out;
}

/** Raw calls of `content`, or `null` for unsupported extensions / parse failures. */
export function extractCalls(content: string, extension: string): Promise<RawCall[] | null> {
  return withParsedTree(content, extension, (root, spec) => callsFromTree(root, spec, symbolsFromTree(root, spec)));
}
