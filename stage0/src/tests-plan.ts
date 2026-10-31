// The static test plan (SPEC §9.3): arc.test, arc.test.hidden, arc.law and arc.configure statements, read as syntax
// with the checker, never run. HAND-WRITTEN bootstrap code, not a region. From the plan the compiler picks the tests
// of a region, shows the shown ones to the model, rewrites the staged copies (assertion indexes, fakes by type) and
// checks that what registers in the sandbox is exactly what it read.
import ts from "typescript";
import type { Json } from "open-arc";
import type { Diagnostic } from "./types.ts";
import type { SpecInfo } from "./engine.ts";
import type { TestPlan } from "../core/test-runner.ts";

export interface Assertion {
  line: number; // 1-based, in its file
  text: string; // the expect(…).matcher(…) call as written
  summary?: string; // `call → value` / `call throws "m"` when the call and the value are literal (SPEC §5.3)
}
export interface TestInfo {
  file: string;
  kind: "test" | "law";
  hidden: boolean;
  name: string;
  target: string; // the target expression as written
  targetNode: ts.Expression;
  regions: string[]; // the regions this test runs for (SPEC §8.10)
  narrow: boolean; // the target is one member (`C.prototype.m`): it runs for that member only
  source: string; // the statement as written
  assertions: Assertion[];
  fakes: string[]; // the tests/fakes/ name of each `fakes.of<T>()` call, in walk order
  consts: string[]; // module-level const statements of its file that it reads (shown with it)
}
export interface ConfigureInfo {
  file: string;
  line: number;
  target: string;
  decl: ts.Node | undefined;
  config: Record<string, Json>;
}

const err = (code: Diagnostic["code"], extra: Omit<Diagnostic, "code"> = {}): Diagnostic => ({ code, ...extra });
const KINDS: Record<string, { kind: "test" | "law"; hidden: boolean }> = {
  "arc.test": { kind: "test", hidden: false },
  "arc.test.hidden": { kind: "test", hidden: true },
  "arc.law": { kind: "law", hidden: false },
};
/** The test statement a top-level statement is, or null. */
const testCall = (st: ts.Statement, sf: ts.SourceFile): { call: ts.CallExpression; k: (typeof KINDS)[string] } | null => {
  if (!ts.isExpressionStatement(st) || !ts.isCallExpression(st.expression)) return null;
  const k = KINDS[st.expression.expression.getText(sf)];
  return k ? { call: st.expression, k } : null;
};
/** Files that may hold tests: src/ and tests/ (not fixtures or fakes). */
export const testFile = (rel: string) => /\.tsx?$/.test(rel) && (rel.startsWith("src/") || (rel.startsWith("tests/") && !rel.startsWith("tests/fakes/") && !rel.startsWith("tests/fixtures/")));

function staticJson(n: ts.Expression): Json | undefined {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isNumericLiteral(n)) return Number(n.text);
  if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(n.operand)) return -Number(n.operand.text);
  if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (n.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(n)) {
    const out = n.elements.map(staticJson);
    return out.every((v) => v !== undefined) ? (out as Json[]) : undefined;
  }
  if (ts.isObjectLiteralExpression(n)) {
    const out: { [k: string]: Json } = {};
    for (const p of n.properties) {
      if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return undefined;
      const v = staticJson(p.initializer);
      if (v === undefined) return undefined;
      out[p.name.text] = v;
    }
    return out;
  }
  return undefined;
}

/** The declaration a target names: `hash32`, `RoundRobin`, `RoundRobin.prototype.pick`. */
export function declOf(checker: ts.TypeChecker, e: ts.Expression): ts.Node | undefined {
  let sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e) ? e.name : e);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  return sym?.valueDeclaration;
}

/** Walk a test body in a fixed order: each `expect(…)` call (the body's 2nd parameter) and each `fakes.of<T>(…)` call
 *  (its 3rd). The reader and the stage's rewriter both use it, so their indexes agree. */
function walkBody({ call, k }: { call: ts.CallExpression; k: { kind: string } }, sf: ts.SourceFile, onExpect: (n: ts.CallExpression) => void, onFake: (n: ts.CallExpression) => void) {
  const body = call.arguments[2] as ts.ArrowFunction | ts.FunctionExpression;
  const expectName = body.parameters[1]?.name.getText(sf);
  const fakesName = k.kind === "test" ? body.parameters[2]?.name.getText(sf) : undefined;
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && expectName && ts.isIdentifier(n.expression) && n.expression.text === expectName && n.arguments.length === 1) onExpect(n);
    if (ts.isCallExpression(n) && fakesName && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === fakesName && n.expression.name.text === "of") onFake(n);
    n.forEachChild(walk);
  };
  walk(body.body);
}

/** Fakes by type: every `export default defineFake<T>(…)` in tests/fakes/, as [type, name]. */
function fakeRegistry(p: { root: string; files: Map<string, string>; program?: ts.Program }, checker: ts.TypeChecker): [ts.Type, string][] {
  const out: [ts.Type, string][] = [];
  for (const rel of p.files.keys()) {
    if (!rel.startsWith("tests/fakes/")) continue;
    const sf = p.program!.getSourceFile(`${p.root}/${rel}`);
    for (const st of sf?.statements ?? [])
      if (ts.isExportAssignment(st) && ts.isCallExpression(st.expression) && /defineFake$/.test(st.expression.expression.getText(sf)) && st.expression.typeArguments?.[0])
        out.push([checker.getTypeFromTypeNode(st.expression.typeArguments[0]), rel.slice("tests/fakes/".length).replace(/\.tsx?$/, "")]);
  }
  return out;
}

/** Every test and arc.configure statement of the project, in file order then source order. */
export function readStatements(p: { root: string; files: Map<string, string>; program?: ts.Program }, checker: ts.TypeChecker, diagnostics: Diagnostic[]): { tests: TestInfo[]; configures: ConfigureInfo[] } {
  const tests: TestInfo[] = [];
  const configures: ConfigureInfo[] = [];
  let fakes: [ts.Type, string][] | null = null;
  for (const [rel, text] of [...p.files].filter(([f]) => testFile(f)).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!/\barc\.(test|law|configure)\b/.test(text)) continue;
    const sf = p.program!.getSourceFile(`${p.root}/${rel}`)!;
    for (const st of sf.statements) {
      const line = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1;
      if (ts.isExpressionStatement(st) && ts.isCallExpression(st.expression) && st.expression.expression.getText(sf) === "arc.configure") {
        const [target, cfg] = st.expression.arguments;
        const config = cfg ? staticJson(cfg) : undefined;
        if (!target || !config || typeof config !== "object" || Array.isArray(config)) diagnostics.push(err("OARC-E010", { file: rel, line, detail: "configure:not-static" }));
        else configures.push({ file: rel, line, target: target.getText(sf), decl: declOf(checker, target), config });
        continue;
      }
      const c = testCall(st, sf);
      if (!c) continue;
      const [target, name, body, opts] = c.call.arguments;
      const what = !target ? "target" : !name || !ts.isStringLiteral(name) ? "name" : !body || !(ts.isArrowFunction(body) || ts.isFunctionExpression(body)) ? "body"
        : !(ts.isIdentifier(target) || ts.isPropertyAccessExpression(target)) ? "target" : opts && (c.k.kind !== "law" || staticJson(opts) === undefined) ? "options" : null;
      if (what) {
        diagnostics.push(err("OARC-E010", { file: rel, line, detail: `test:${what}` }));
        continue;
      }
      const t: TestInfo = {
        file: rel, kind: c.k.kind, hidden: c.k.hidden, name: (name as ts.StringLiteral).text, target: target!.getText(sf), targetNode: target!,
        regions: [], narrow: ts.isPropertyAccessExpression(target!) && /\.prototype\./.test(target!.getText(sf)), source: st.getText(sf), assertions: [], fakes: [], consts: [],
      };
      walkBody(c, sf, (n) => {
        const chain = n.parent;
        const m = ts.isPropertyAccessExpression(chain) && ts.isCallExpression(chain.parent) ? chain : undefined;
        const actual = n.arguments[0]!;
        const expected = m ? (m.parent as ts.CallExpression).arguments[0] : undefined;
        let summary: string | undefined;
        if (m && /^(toBe|toEqual)$/.test(m.name.text) && expected && staticJson(expected) !== undefined && ts.isCallExpression(actual) && actual.arguments.every((a) => staticJson(a) !== undefined))
          summary = `${actual.getText(sf)} → ${expected.getText(sf)}`;
        else if (m && m.name.text === "toThrow" && ts.isArrowFunction(actual) && !ts.isBlock(actual.body))
          summary = `${actual.body.getText(sf)} throws ${expected?.getText(sf) ?? "an error"}`;
        t.assertions.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text: (m ? m.parent : n).getText(sf), ...(summary ? { summary } : {}) });
      }, (n) => {
        const typeArg = n.typeArguments?.[0];
        if (!typeArg) return void diagnostics.push(err("OARC-E010", { file: rel, line, detail: "fake:of-needs-a-type" }));
        fakes ??= fakeRegistry(p, checker);
        const ty = checker.getTypeFromTypeNode(typeArg);
        const hits = fakes.filter(([x]) => x === ty);
        if (hits.length !== 1) diagnostics.push(err("OARC-E010", { file: rel, line, detail: `fake:${checker.typeToString(ty)}${hits.length ? ":ambiguous" : ""}` }));
        else t.fakes.push(hits[0]![1]);
      });
      // the test-file consts it reads, shown with it (`const three: Backend[] = …`)
      const consts = new Set<ts.Node>();
      const visit = (n: ts.Node): void => {
        if (ts.isIdentifier(n)) {
          const d = checker.getSymbolAtLocation(n)?.valueDeclaration;
          if (d && ts.isVariableDeclaration(d) && d.getSourceFile() === sf && ts.isVariableStatement(d.parent.parent) && d.parent.parent.parent === sf) consts.add(d.parent.parent);
        }
        n.forEachChild(visit);
      };
      visit(st);
      t.consts = [...consts].sort((a, b) => a.pos - b.pos).map((n) => n.getText(sf));
      tests.push(t);
    }
  }
  return { tests, configures };
}

/** Which regions each test runs for (SPEC §8.10): the target is the region's function, its class, or a class its class
 *  extends; `C.prototype.m` narrows to that member. */
export function mapTests(tests: TestInfo[], specs: SpecInfo[], checker: ts.TypeChecker): void {
  const baseOf = (cls: ts.ClassDeclaration, target: ts.Node): boolean =>
    (cls.heritageClauses ?? []).some((h) => h.token === ts.SyntaxKind.ExtendsKeyword && h.types.some((t) => {
      const b = declOf(checker, t.expression);
      return b === target || (!!b && ts.isClassDeclaration(b) && baseOf(b, target));
    }));
  for (const t of tests) {
    const target = declOf(checker, t.targetNode);
    if (!target) continue;
    for (const s of specs) {
      const cf = s.codeFirst!;
      const hit = target === cf.decl || target === cf.decl.parent || (!t.narrow && !!cf.cls && (target === cf.cls || baseOf(cf.cls, target)));
      if (!hit) continue;
      t.regions.push(s.id);
      cf.tests.push(t);
    }
  }
}

/** The harness plan's `tests` for regions `ids`: every test statement (the registry must match all of them) and the
 *  indexes of the ones that run. */
export function harnessTests(all: TestInfo[], ids: string[]): TestPlan | null {
  const run = all.flatMap((t, i) => (t.regions.some((r) => ids.includes(r)) ? [i] : []));
  if (!run.length) return null;
  const fakes = [...new Set(run.flatMap((i) => all[i]!.fakes))];
  return { all: all.map((t) => ({ file: t.file, kind: t.kind, hidden: t.hidden, name: t.name })), run, ...(fakes.length ? { fakes } : {}) };
}

/** The staged copy of a file with tests: `expect(x)` gets its assertion index (`expect(x, 3)`) and `fakes.of<T>(…)` the
 *  name of its fake (`fakes.of<T>("net.memory", …)`). Never written outside the stage. */
export function instrument(text: string, rel: string, all: TestInfo[]): string {
  const mine = all.filter((t) => t.file === rel);
  if (!mine.length) return text;
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edits: [number, number, string][] = [];
  let k = 0;
  for (const st of sf.statements) {
    const c = testCall(st, sf);
    if (!c || c.call.arguments.length < 3) continue;
    const t = mine[k++];
    if (!t) break;
    let a = 0, f = 0;
    walkBody(c, sf, (n) => void edits.push([n.arguments[0]!.end, n.arguments[0]!.end, `, ${a++}`]), (n) => {
      const name = t.fakes[f++];
      if (name !== undefined) edits.push([n.arguments.pos, n.arguments.pos, `${JSON.stringify(name)}${n.arguments.length ? ", " : ""}`]);
    });
  }
  let out = text;
  for (const [from, to, s] of edits.sort((x, y) => y[0] - x[0])) out = out.slice(0, from) + s + out.slice(to);
  return out;
}

/** The context package's Tests section: the shown tests' source with the consts they read, the hidden count. */
export function testsSection(tests: TestInfo[]): string {
  const shown = tests.filter((t) => !t.hidden);
  const consts = [...new Set(shown.flatMap((t) => t.consts))];
  const hidden = tests.length - shown.length;
  return [...consts, ...shown.map((t) => t.source)].join("\n\n") + (hidden ? `\n// plus ${hidden} hidden test(s), not shown` : "");
}
/** The budget fallback (SPEC §5.3): the literal assertions as `call → value` lines. */
export function summarySection(tests: TestInfo[]): string {
  const shown = tests.filter((t) => !t.hidden);
  const lines = shown.flatMap((t) => t.assertions.flatMap((a) => (a.summary ? [a.summary] : [])));
  const rest = shown.reduce((n, t) => n + t.assertions.filter((a) => !a.summary).length, 0);
  const hidden = tests.length - shown.length;
  return [...lines, ...(rest ? [`// plus ${rest} assertion(s) not shown (they need their test's setup)`] : []), ...(hidden ? [`// plus ${hidden} hidden test(s), not shown`] : [])].join("\n");
}

/** One repair-prompt line per failing test outcome (SPEC §8.5): each failing assertion with its line and source; a hidden
 *  test by name only. */
export function failureText(t: TestInfo | undefined, name: string, actual: Json | undefined): string {
  const a = (actual ?? {}) as { hidden?: boolean; failures?: { i: number; detail: string }[]; threw?: string; law?: string; registry?: string };
  if (a.registry) return `OARC-E090 test registry differs from the static plan: ${a.registry}`;
  if (!t || a.hidden || t.hidden) return `OARC-E090 hidden test failed: ${JSON.stringify(t?.name ?? name)}`;
  const lines = [`OARC-E090 ${t.kind} ${JSON.stringify(t.name)} failed${a.law ? ` (${a.law})` : ""}:`];
  for (const f of a.failures ?? []) {
    const at = t.assertions[f.i];
    lines.push(at ? `  line ${at.line}: ${at.text}\n    ${f.detail}` : `  ${f.detail}`);
  }
  if (a.threw !== undefined) lines.push(`  threw: ${a.threw}`);
  return lines.join("\n");
}

/** The outcome-line name of a test (core/test-runner.ts prints the same). */
export const outcomeName = (t: { kind: string; name: string }) => `${t.kind} ${JSON.stringify(t.name)}`;
export const isTestOutcome = (name: string) => name === "test-registry" || /^(test|law) "/.test(name);

/** Provenance `verifiedBy` entries for a sandbox run of a code-first region: examples, tests (laws included), hidden. */
export function verifiedBy(spec: SpecInfo, res: { passed: number; failed: { name: string; actual?: Json }[] }): string[] {
  const exTotal = spec.examples.length;
  const exFailed = res.failed.filter((o) => !isTestOutcome(o.name)).length;
  const tFailed = res.failed.filter((o) => isTestOutcome(o.name));
  const tTotal = res.passed + res.failed.length - exTotal;
  const pending = tFailed.filter((o) => typeof o.actual === "object" && o.actual !== null && "pending" in o.actual).length;
  const hidden = (spec.codeFirst?.tests ?? []).filter((t) => t.hidden).length;
  return [
    ...(exTotal ? [`examples:${exTotal - exFailed}/${exTotal}`] : []),
    ...(tTotal ? [`tests:${tTotal - tFailed.length}/${tTotal}${pending ? ` (${pending} inconclusive: pending regions)` : ""}`] : []),
    ...(hidden ? [`hidden:${hidden}`] : []),
  ];
}
