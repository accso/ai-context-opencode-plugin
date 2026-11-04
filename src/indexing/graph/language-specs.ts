import type { Node } from "web-tree-sitter";

/**
 * Per-language rules that turn a tree-sitter node into a graph symbol.
 * Adding a language means adding one entry here (grammar name, extensions,
 * a `describe` function) plus a fixture in the symbol-extractor tests; the
 * walker in symbol-extractor.ts is language-agnostic.
 *
 * Node and field names were checked against the real grammars (see
 * ADR-0016 for the grammar packages), not copied from another project.
 */

/** The enclosing container of the node being visited (class, namespace, impl, ...). */
export interface SymbolContext {
  name: string;
  kind: string;
}

export interface Described {
  /** Symbol to record for this node; `container` overrides the enclosing context's name. */
  emit?: { name: string; kind: string; container?: string };
  /** When set, children are visited inside this container. Without it, an emitted node is not descended into. */
  enter?: SymbolContext;
  /** Container for the *following siblings* (C# file-scoped namespaces). */
  siblingContext?: SymbolContext;
}

export interface LanguageSpec {
  /** Language id stored in the graph (matches indexing.ts's `guessLanguage` ids). */
  language: string;
  /** Key understood by parser-loader.ts. */
  grammar: string;
  describe(node: Node, context: SymbolContext | undefined): Described | null;
  /** Node types whose bodies are never searched for symbols (anonymous function bodies). */
  opaque?: ReadonlySet<string>;
}

const CLASS_LIKE = new Set(["class", "interface", "enum", "struct", "record", "object", "trait", "impl", "namespace", "module"]);

const nameOf = (node: Node, field = "name"): string | undefined => node.childForFieldName(field)?.text || undefined;

function simple(kinds: Record<string, string>, enterTypes: ReadonlySet<string> = new Set()) {
  return (node: Node): Described | null => {
    const kind = kinds[node.type];
    if (!kind) return null;
    const name = nameOf(node);
    if (!name) return null;
    return enterTypes.has(node.type) ? { emit: { name, kind }, enter: { name, kind } } : { emit: { name, kind } };
  };
}

const FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);

function describeEcmaScript(node: Node): Described | null {
  switch (node.type) {
    case "class_declaration":
    case "abstract_class_declaration": {
      const name = nameOf(node);
      return name ? { emit: { name, kind: "class" }, enter: { name, kind: "class" } } : null;
    }
    case "internal_module":
    case "module": {
      const name = nameOf(node)?.replace(/^["']|["']$/g, "");
      return name ? { emit: { name, kind: "namespace" }, enter: { name, kind: "namespace" } } : null;
    }
    case "function_declaration":
    case "generator_function_declaration": {
      const name = nameOf(node);
      return name ? { emit: { name, kind: "function" } } : null;
    }
    case "method_definition": {
      const name = nameOf(node);
      return name ? { emit: { name, kind: "method" } } : null;
    }
    case "interface_declaration":
    case "enum_declaration":
    case "type_alias_declaration": {
      const name = nameOf(node);
      const kind = node.type === "interface_declaration" ? "interface" : node.type === "enum_declaration" ? "enum" : "typealias";
      return name ? { emit: { name, kind } } : null;
    }
    case "variable_declarator": {
      const value = node.childForFieldName("value");
      const name = node.childForFieldName("name");
      if (value && name?.type === "identifier" && FUNCTION_VALUES.has(value.type)) {
        return { emit: { name: name.text, kind: "function" } };
      }
      return {}; // plain variable: nothing to record and nothing worth searching inside
    }
    case "public_field_definition":
    case "field_definition": {
      const value = node.childForFieldName("value");
      const name = nameOf(node) ?? nameOf(node, "property");
      if (value && name && FUNCTION_VALUES.has(value.type)) return { emit: { name, kind: "method" } };
      return {};
    }
    default:
      return null;
  }
}

const ECMASCRIPT_OPAQUE = new Set(["arrow_function", "function_expression", "function", "generator_function"]);

function describePython(node: Node, context: SymbolContext | undefined): Described | null {
  if (node.type === "class_definition") {
    const name = nameOf(node);
    return name ? { emit: { name, kind: "class" }, enter: { name, kind: "class" } } : null;
  }
  if (node.type === "function_definition") {
    const name = nameOf(node);
    return name ? { emit: { name, kind: context?.kind === "class" ? "method" : "function" } } : null;
  }
  return null;
}

const describeJava = simple(
  {
    class_declaration: "class",
    interface_declaration: "interface",
    annotation_type_declaration: "interface",
    enum_declaration: "enum",
    record_declaration: "record",
    method_declaration: "method",
    constructor_declaration: "constructor",
  },
  new Set(["class_declaration", "interface_declaration", "annotation_type_declaration", "enum_declaration", "record_declaration"]),
);

function describeKotlin(node: Node, context: SymbolContext | undefined): Described | null {
  switch (node.type) {
    case "class_declaration": {
      const name = nameOf(node);
      if (!name) return null;
      const isInterface = node.children.some((c) => c.type === "interface");
      const isEnum = node.children.some((c) => c.type === "modifiers" && /\benum\b/.test(c.text));
      const kind = isInterface ? "interface" : isEnum ? "enum" : "class";
      return { emit: { name, kind }, enter: { name, kind } };
    }
    case "object_declaration": {
      const name = nameOf(node);
      return name ? { emit: { name, kind: "object" }, enter: { name, kind: "object" } } : null;
    }
    case "companion_object": {
      const name = nameOf(node) ?? "Companion";
      return { emit: { name, kind: "object" }, enter: { name, kind: "object" } };
    }
    case "function_declaration": {
      const name = nameOf(node);
      if (!name) return null;
      return { emit: { name, kind: context && CLASS_LIKE.has(context.kind) ? "method" : "function" } };
    }
    case "secondary_constructor":
      return context ? { emit: { name: context.name, kind: "constructor" } } : null;
    case "type_alias": {
      const name = nameOf(node, "type");
      return name ? { emit: { name, kind: "typealias" } } : null;
    }
    default:
      return null;
  }
}

function describeCSharp(node: Node): Described | null {
  switch (node.type) {
    case "namespace_declaration": {
      const name = nameOf(node);
      return name ? { emit: { name, kind: "namespace" }, enter: { name, kind: "namespace" } } : null;
    }
    case "file_scoped_namespace_declaration": {
      const name = nameOf(node);
      return name ? { emit: { name, kind: "namespace" }, siblingContext: { name, kind: "namespace" } } : null;
    }
    default:
      return csharpMembers(node);
  }
}

const csharpMembers = simple(
  {
    class_declaration: "class",
    interface_declaration: "interface",
    struct_declaration: "struct",
    enum_declaration: "enum",
    record_declaration: "record",
    record_struct_declaration: "record",
    method_declaration: "method",
    constructor_declaration: "constructor",
    property_declaration: "property",
  },
  new Set(["class_declaration", "interface_declaration", "struct_declaration", "record_declaration", "record_struct_declaration"]),
);

function goReceiverType(node: Node): string | undefined {
  const receiver = node.childForFieldName("receiver");
  const stack = receiver ? [...receiver.namedChildren] : [];
  while (stack.length > 0) {
    const n = stack.shift()!;
    if (n.type === "type_identifier") return n.text;
    stack.push(...n.namedChildren);
  }
  return undefined;
}

function describeGo(node: Node, context: SymbolContext | undefined): Described | null {
  switch (node.type) {
    case "function_declaration": {
      const name = nameOf(node);
      return name ? { emit: { name, kind: "function" } } : null;
    }
    case "method_declaration": {
      const name = nameOf(node);
      return name ? { emit: { name, kind: "method", container: goReceiverType(node) } } : null;
    }
    case "type_spec": {
      const name = nameOf(node);
      if (!name) return null;
      const typeType = node.childForFieldName("type")?.type;
      const kind = typeType === "struct_type" ? "struct" : typeType === "interface_type" ? "interface" : "type";
      return { emit: { name, kind }, enter: { name, kind } };
    }
    case "type_alias": {
      const name = nameOf(node);
      return name ? { emit: { name, kind: "typealias" } } : null;
    }
    case "method_elem": {
      const name = nameOf(node);
      return name && context?.kind === "interface" ? { emit: { name, kind: "method" } } : null;
    }
    default:
      return null;
  }
}

function rustImplTypeName(node: Node): string | undefined {
  let type = node.childForFieldName("type");
  while (type && (type.type === "generic_type" || type.type === "reference_type")) {
    type = type.childForFieldName("type");
  }
  if (type?.type === "scoped_type_identifier") type = type.childForFieldName("name");
  return type?.text;
}

function describeRust(node: Node, context: SymbolContext | undefined): Described | null {
  switch (node.type) {
    case "function_item": {
      const name = nameOf(node);
      if (!name) return null;
      const inType = context?.kind === "impl" || context?.kind === "trait";
      return { emit: { name, kind: inType ? "method" : "function" } };
    }
    case "function_signature_item": {
      const name = nameOf(node);
      return name ? { emit: { name, kind: "method" } } : null;
    }
    case "struct_item":
    case "union_item": {
      const name = nameOf(node);
      return name ? { emit: { name, kind: "struct" } } : null;
    }
    case "enum_item": {
      const name = nameOf(node);
      return name ? { emit: { name, kind: "enum" } } : null;
    }
    case "trait_item": {
      const name = nameOf(node);
      return name ? { emit: { name, kind: "trait" }, enter: { name, kind: "trait" } } : null;
    }
    case "mod_item": {
      const name = nameOf(node);
      return name ? { emit: { name, kind: "module" }, enter: { name, kind: "module" } } : null;
    }
    case "type_item": {
      const name = nameOf(node);
      return name ? { emit: { name, kind: "typealias" } } : null;
    }
    case "macro_definition": {
      const name = nameOf(node);
      return name ? { emit: { name, kind: "macro" } } : null;
    }
    case "impl_item": {
      const name = rustImplTypeName(node);
      return name ? { enter: { name, kind: "impl" } } : null;
    }
    default:
      return null;
  }
}

function describeRuby(node: Node, context: SymbolContext | undefined): Described | null {
  switch (node.type) {
    case "class":
    case "module": {
      const name = nameOf(node);
      const kind = node.type === "class" ? "class" : "module";
      return name ? { emit: { name, kind }, enter: { name, kind } } : null;
    }
    case "method":
    case "singleton_method": {
      const name = nameOf(node);
      return name ? { emit: { name, kind: context ? "method" : "function" } } : null;
    }
    default:
      return null;
  }
}

const DECLARATOR_WRAPPERS = new Set([
  "function_declarator",
  "pointer_declarator",
  "reference_declarator",
  "parenthesized_declarator",
  "array_declarator",
]);

/** Name (and `Scope::` owner, for out-of-class C++ definitions) behind a C/C++ declarator chain. */
function declaratorName(node: Node | null): { name: string; scope?: string } | undefined {
  let n = node;
  while (n && DECLARATOR_WRAPPERS.has(n.type)) {
    n = n.childForFieldName("declarator") ?? n.namedChild(0);
  }
  if (!n) return undefined;
  if (n.type === "qualified_identifier") {
    const parts = n.text.replace(/<[^<>]*>/g, "").split("::").filter(Boolean);
    const name = parts[parts.length - 1];
    return name ? { name, scope: parts.length > 1 ? parts[parts.length - 2] : undefined } : undefined;
  }
  return n.text ? { name: n.text } : undefined;
}

function describeC(node: Node, context: SymbolContext | undefined): Described | null {
  switch (node.type) {
    case "function_definition": {
      const d = declaratorName(node.childForFieldName("declarator"));
      if (!d) return null;
      const owner = d.scope ?? (context && CLASS_LIKE.has(context.kind) && context.kind !== "namespace" ? context.name : undefined);
      if (!owner) return { emit: { name: d.name, kind: "function" } };
      return { emit: { name: d.name, kind: d.name === owner ? "constructor" : "method", container: owner } };
    }
    case "struct_specifier":
    case "union_specifier":
    case "class_specifier": {
      const name = nameOf(node);
      if (!name || !node.childForFieldName("body")) return null;
      const kind = node.type === "class_specifier" ? "class" : "struct";
      return { emit: { name, kind }, enter: { name, kind } };
    }
    case "enum_specifier": {
      const name = nameOf(node);
      return name && node.childForFieldName("body") ? { emit: { name, kind: "enum" } } : null;
    }
    case "type_definition": {
      const d = declaratorName(node.childForFieldName("declarator"));
      return d ? { emit: { name: d.name, kind: "typedef" } } : null;
    }
    case "alias_declaration": {
      const name = nameOf(node);
      return name ? { emit: { name, kind: "typealias" } } : null;
    }
    case "namespace_definition": {
      const name = nameOf(node);
      return name ? { emit: { name, kind: "namespace" }, enter: { name, kind: "namespace" } } : null;
    }
    case "preproc_function_def": {
      const name = nameOf(node);
      return name ? { emit: { name, kind: "macro" } } : null;
    }
    default:
      return null;
  }
}

const ecma = (language: string, grammar: string): LanguageSpec => ({
  language,
  grammar,
  describe: describeEcmaScript,
  opaque: ECMASCRIPT_OPAQUE,
});

export const LANGUAGE_SPECS: Readonly<Record<string, LanguageSpec>> = {
  typescript: ecma("typescript", "typescript"),
  tsx: ecma("typescript", "tsx"),
  javascript: ecma("javascript", "javascript"),
  python: { language: "python", grammar: "python", describe: describePython },
  java: { language: "java", grammar: "java", describe: describeJava },
  kotlin: { language: "kotlin", grammar: "kotlin", describe: describeKotlin },
  csharp: { language: "csharp", grammar: "c_sharp", describe: describeCSharp },
  go: { language: "go", grammar: "go", describe: describeGo },
  rust: { language: "rust", grammar: "rust", describe: describeRust },
  ruby: { language: "ruby", grammar: "ruby", describe: describeRuby },
  c: { language: "c", grammar: "c", describe: describeC },
  cpp: { language: "cpp", grammar: "cpp", describe: describeC },
};

/** File extension (lowercase, with dot) -> key of `LANGUAGE_SPECS`. `.h` is treated as C. */
export const EXTENSION_TO_SPEC: Readonly<Record<string, string>> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python",
  ".java": "java",
  ".kt": "kotlin", ".kts": "kotlin",
  ".cs": "csharp",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".c": "c", ".h": "c",
  ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp", ".hxx": "cpp",
};
