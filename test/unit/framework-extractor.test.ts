import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFileGraph } from "../../src/indexing/graph/file-graph-extractor.js";

async function graph(src: string, ext = ".ts") {
  const g = await extractFileGraph(src, ext);
  assert.ok(g);
  return g;
}
const framework = (calls: { kind?: string }[]) => calls.filter((c) => c.kind === "jsx" || c.kind === "inject" || c.kind === "decorator" || c.kind === "template");

/** React JSX: component usage is an edge from the enclosing component. */

test("JSX component tags become jsx edges from the enclosing component; DOM tags do not", async () => {
  const g = await graph(
    `export function App() { return <Layout><Item a={1}/><div><span/></div></Layout>; }\n`,
    ".tsx",
  );
  const jsx = g.calls.filter((c) => c.kind === "jsx");
  assert.deepEqual(jsx.map((c) => [c.callerSymbol, c.calleeName]).sort(), [["App", "Item"], ["App", "Layout"]]);
});

test("a JSX member tag keeps its namespace as qualifier and ignores library DOM-ish members", async () => {
  const g = await graph(`function A() { return <Foo.Bar/>; }\nfunction B() { return <motion.div/>; }\n`, ".tsx");
  const jsx = g.calls.filter((c) => c.kind === "jsx");
  assert.deepEqual(jsx.map((c) => [c.callerSymbol, c.calleeName, c.qualifier]), [["A", "Bar", "Foo"]]);
});

test("closing tags are not counted twice and arrow-function components are the caller", async () => {
  const g = await graph(`const Page = () => { return <Item></Item>; };\n`, ".jsx");
  const jsx = g.calls.filter((c) => c.kind === "jsx");
  assert.equal(jsx.length, 1);
  assert.equal(jsx[0]!.callerSymbol, "Page");
  assert.equal(jsx[0]!.line, 1);
});

/** Angular dependency injection. */

test("constructor parameter types in a decorated class are inject edges from the class", async () => {
  const g = await graph(
    `@Injectable()\nexport class Svc {\n  constructor(private http: HttpClient, @Inject(TOKEN) t: Token, readonly b?: Bar, n: number) {}\n}\n`,
  );
  const inj = g.calls.filter((c) => c.kind === "inject");
  assert.deepEqual(
    inj.map((c) => [c.callerSymbol, c.calleeName]),
    [["Svc", "HttpClient"], ["Svc", "TOKEN"], ["Svc", "Token"], ["Svc", "Bar"]],
  );
});

test("inject(X) calls become inject edges, attributed to the class for field initializers", async () => {
  const g = await graph(
    `@Component({selector: 'x'})\nclass C {\n  private http = inject(HttpClient);\n  go() { const r = inject(Router); }\n}\nfunction guard() { return inject(AuthService); }\n`,
  );
  const inj = g.calls.filter((c) => c.kind === "inject");
  assert.deepEqual(
    inj.map((c) => [c.callerSymbol, c.calleeName]),
    [["C", "HttpClient"], ["go", "Router"], ["guard", "AuthService"]],
  );
});

test("constructors of undecorated classes are not DI edges", async () => {
  const g = await graph(`class Plain { constructor(private a: Foo) {} }\n`);
  assert.deepEqual(g.calls.filter((c) => c.kind === "inject"), []);
});

/** Angular decorator metadata. */

test("NgModule / standalone Component metadata arrays become decorator edges", async () => {
  const g = await graph(
    `@NgModule({ declarations: [A, B], imports: [CommonModule, Other], providers: [{ provide: TOK, useClass: Impl }, Svc], bootstrap: [A], unknown: [Z] })\nexport class AppModule {}\n`,
  );
  const dec = g.calls.filter((c) => c.kind === "decorator");
  assert.deepEqual(
    dec.map((c) => c.calleeName).sort(),
    ["A", "A", "B", "CommonModule", "Impl", "Other", "Svc", "TOK"].sort(),
  );
  assert.ok(dec.every((c) => c.callerSymbol === "AppModule"));
});

/** Angular selectors and templates. */

test("Component/Directive selectors become selector symbols attached to the class", async () => {
  const g = await graph(
    `@Component({ selector: 'app-foo' })\nexport class FooComponent {}\n@Directive({ selector: '[appHi], button.x, input[type=text]' })\nclass HiDirective {}\n`,
  );
  const sel = g.symbols.filter((s) => s.kind === "selector").map((s) => [s.name, s.container]);
  assert.deepEqual(sel, [["app-foo", "FooComponent"], ["[appHi]", "HiDirective"]]);
});

test("inline templates produce template edges for custom elements and camelCase attributes, once each", async () => {
  const g = await graph(
    "@Component({ selector: 'app-host', template: `<div class=\"a\" appHi>\n<app-bar [x]=\"1\"></app-bar><app-bar/>\n<mat-icon></mat-icon></div>` })\nexport class Host {}\n",
  );
  const tpl = g.calls.filter((c) => c.kind === "template");
  const lineOf = (name: string) => tpl.find((c) => c.calleeName === name)?.line;
  assert.equal(tpl.length, 3);
  assert.ok(tpl.every((c) => c.callerSymbol === "Host" && c.qualifier === c.calleeName));
  assert.deepEqual([lineOf("app-bar"), lineOf("mat-icon"), lineOf("[appHi]")], [2, 3, 1]);
  assert.deepEqual(tpl.map((c) => c.calleeName).sort(), ["[appHi]", "app-bar", "mat-icon"]);
});

test("plain TypeScript without framework constructs yields no framework edges", async () => {
  const g = await graph(`export class A { m() { b(); } }\nfunction b() {}\n`);
  assert.deepEqual(framework(g.calls), []);
});
