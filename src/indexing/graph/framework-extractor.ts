import type { Node } from "web-tree-sitter";
import type { LanguageSpec } from "./language-specs.js";
import type { GraphSymbol } from "../../storage/graph-store.js";
import { innermostCaller, type RawCall } from "./call-extractor.js";

/**
 * Framework-level relationships that plain call extraction can't see, for
 * TypeScript/JavaScript:
 *
 *  - React: `<Component/>` usage is a `jsx` edge from the enclosing component.
 *  - Angular DI: constructor parameter types of decorated classes, `@Inject(X)`
 *    and `inject(X)` are `inject` edges.
 *  - Angular decorator metadata: `imports`/`declarations`/`providers`/... of
 *    `@NgModule`/`@Component`/... are `decorator` edges.
 *  - Angular selectors: `selector: 'app-x'` becomes a `selector` symbol on the
 *    class, and tags/attributes in inline templates become `template` edges
 *    that the graph indexer later maps to the class owning that selector.
 *
 * Templates in separate `templateUrl` files are not analysed.
 */

export interface FrameworkGraph {
  symbols: GraphSymbol[];
  calls: RawCall[];
}

const CLASS_NODES = new Set(["class_declaration", "abstract_class_declaration", "class"]);
const ANGULAR_DECORATORS = new Set(["Component", "Directive", "Pipe", "NgModule", "Injectable"]);
const METADATA_ARRAY_KEYS = new Set(["imports", "declarations", "providers", "exports", "bootstrap", "viewProviders"]);
const PROVIDER_KEYS = new Set(["provide", "useClass", "useExisting"]);

const line = (n: Node) => n.startPosition.row + 1;
const isUpper = (s: string) => /^[A-Z]/.test(s);

function decoratorName(decorator: Node): { name: string; args: Node | null } | null {
  const first = decorator.namedChildren[0];
  if (!first) return null;
  if (first.type === "identifier") return { name: first.text, args: null };
  if (first.type !== "call_expression") return null;
  const fn = first.childForFieldName("function");
  return fn?.type === "identifier" ? { name: fn.text, args: first.childForFieldName("arguments") } : null;
}

/** Decorators of a class; for `export class` they are siblings inside the export statement. */
function classDecorators(cls: Node): Node[] {
  const own = cls.namedChildren.filter((c) => c.type === "decorator");
  const exported = cls.parent?.type === "export_statement" ? cls.parent.namedChildren.filter((c) => c.type === "decorator") : [];
  return [...exported, ...own];
}

function typeNameOf(annotation: Node | null | undefined): string | undefined {
  const t = annotation?.namedChildren[0];
  if (!t) return undefined;
  if (t.type === "type_identifier") return t.text;
  if (t.type === "generic_type") return t.namedChildren[0]?.type === "type_identifier" ? t.namedChildren[0].text : undefined;
  if (t.type === "nested_type_identifier") return t.text.split(".").pop();
  return undefined;
}

function pairs(obj: Node): Map<string, Node> {
  const out = new Map<string, Node>();
  for (const p of obj.namedChildren) {
    if (p.type !== "pair") continue;
    const key = p.childForFieldName("key")?.text.replace(/^['"]|['"]$/g, "");
    const value = p.childForFieldName("value");
    if (key && value) out.set(key, value);
  }
  return out;
}

function stringValue(node: Node | undefined): string | undefined {
  if (!node || (node.type !== "string" && node.type !== "template_string")) return undefined;
  const text = node.text.slice(1, -1);
  return node.type === "template_string" && text.includes("${") ? undefined : text;
}

function selectorSymbols(selector: string, cls: Node, className: string): GraphSymbol[] {
  const out: GraphSymbol[] = [];
  for (const raw of selector.split(",")) {
    const part = raw.trim();
    let name: string | undefined;
    if (/^[a-z][\w-]*$/i.test(part)) name = part;
    else {
      const attr = /^[\w-]*\[([\w-]+)\]$/.exec(part);
      if (attr) name = `[${attr[1]}]`;
    }
    if (name) out.push({ name, kind: "selector", startLine: line(cls), endLine: cls.endPosition.row + 1, container: className });
  }
  return out;
}

function templateEdges(text: string, baseLine: number, className: string): RawCall[] {
  const seen = new Set<string>();
  const out: RawCall[] = [];
  const add = (name: string, offset: number) => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push({ callerSymbol: className, calleeName: name, qualifier: name, kind: "template", line: baseLine + (text.slice(0, offset).match(/\n/g)?.length ?? 0) });
  };
  for (const m of text.matchAll(/<([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const tag = m[1]!;
    if (tag.includes("-") && !tag.startsWith("ng-")) add(tag, m.index!);
    const attrs = (m[2] ?? "").replace(/"[^"]*"|'[^']*'/g, '""');
    for (const a of attrs.matchAll(/(?<=\s)[*[(]*([a-z]\w*[A-Z]\w*)/g)) add(`[${a[1]}]`, m.index!);
  }
  return out;
}

function decoratorMetadata(args: Node | null, cls: Node, className: string, out: FrameworkGraph): void {
  const obj = args?.namedChildren[0];
  if (!obj || obj.type !== "object") return;
  const meta = pairs(obj);
  for (const [key, value] of meta) {
    if (key === "selector") {
      const selector = stringValue(value);
      if (selector) out.symbols.push(...selectorSymbols(selector, cls, className));
    } else if (key === "template") {
      const text = stringValue(value);
      if (text) out.calls.push(...templateEdges(text, line(value), className));
    } else if (METADATA_ARRAY_KEYS.has(key) && value.type === "array") {
      for (const el of value.namedChildren) {
        const targets = el.type === "object" ? [...pairs(el)].filter(([k]) => PROVIDER_KEYS.has(k)).map(([, v]) => v) : [el];
        for (const t of targets) {
          if (t.type === "identifier") out.calls.push({ callerSymbol: className, calleeName: t.text, kind: "decorator", line: line(t) });
        }
      }
    }
  }
}

function constructorInjections(cls: Node, className: string, out: FrameworkGraph): void {
  const body = cls.childForFieldName("body");
  const ctor = body?.namedChildren.find((m) => m.type === "method_definition" && m.childForFieldName("name")?.text === "constructor");
  const params = ctor?.childForFieldName("parameters");
  if (!params) return;
  for (const p of params.namedChildren) {
    if (p.type !== "required_parameter" && p.type !== "optional_parameter") continue;
    for (const d of p.namedChildren.filter((c) => c.type === "decorator")) {
      const info = decoratorName(d);
      const arg = info?.name === "Inject" ? info.args?.namedChildren[0] : undefined;
      if (arg?.type === "identifier") out.calls.push({ callerSymbol: className, calleeName: arg.text, kind: "inject", line: line(arg) });
    }
    const type = p.namedChildren.find((c) => c.type === "type_annotation");
    const name = typeNameOf(type);
    if (name) out.calls.push({ callerSymbol: className, calleeName: name, kind: "inject", line: line(type!) });
  }
}

function jsxEdge(node: Node, symbols: GraphSymbol[]): RawCall | null {
  const name = node.namedChildren[0];
  if (!name) return null;
  let calleeName: string | undefined;
  let qualifier: string | undefined;
  if (name.type === "identifier") {
    if (isUpper(name.text)) calleeName = name.text;
  } else if (name.type === "member_expression") {
    const prop = name.childForFieldName("property")?.text;
    const object = name.childForFieldName("object")?.text;
    if (prop && isUpper(prop) && object && /^[\w$.]+$/.test(object)) {
      calleeName = prop;
      qualifier = object;
    }
  }
  if (!calleeName) return null;
  return { callerSymbol: innermostCaller(symbols, line(node)), calleeName, qualifier, kind: "jsx", line: line(node) };
}

export function frameworkFromTree(root: Node, spec: LanguageSpec, symbols: GraphSymbol[]): FrameworkGraph {
  const out: FrameworkGraph = { symbols: [], calls: [] };
  if (spec.language !== "typescript" && spec.language !== "javascript") return out;

  const visit = (n: Node, enclosingClass: string | undefined): void => {
    let cls = enclosingClass;
    if (CLASS_NODES.has(n.type)) {
      const className = n.childForFieldName("name")?.text;
      if (className) {
        cls = className;
        const decorators = classDecorators(n).flatMap((d) => decoratorName(d) ?? []);
        if (decorators.some((d) => ANGULAR_DECORATORS.has(d.name))) {
          constructorInjections(n, className, out);
          for (const d of decorators) if (ANGULAR_DECORATORS.has(d.name)) decoratorMetadata(d.args, n, className, out);
        }
      }
    } else if (n.type === "jsx_opening_element" || n.type === "jsx_self_closing_element") {
      const edge = jsxEdge(n, symbols);
      if (edge) out.calls.push(edge);
    } else if (n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      const arg = n.childForFieldName("arguments")?.namedChildren[0];
      if (fn?.type === "identifier" && fn.text === "inject" && arg?.type === "identifier") {
        out.calls.push({ callerSymbol: innermostCaller(symbols, line(n)) ?? enclosingClass, calleeName: arg.text, kind: "inject", line: line(n) });
      }
    }
    for (const c of n.namedChildren) visit(c, cls);
  };
  visit(root, undefined);
  return out;
}
