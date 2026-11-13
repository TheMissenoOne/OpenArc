// `openarc decompile`: read a project's code (TypeScript or JavaScript) into `.arc` specs without changing a byte of it.
// No markers, no model. Per exported function: the signature from the type checker (inference and JSDoc for JavaScript),
// the intent from its comment, examples by running it in the sandbox on inputs taken from its parameter types and from
// literal calls found in the project (its tests above all), and the test files that use it.
// Resumable: a module whose source is unchanged since the last run is not run again.
import ts from "typescript";
import { createHash } from "node:crypto";
import type { CompileRequest, Ports } from "./types.ts";
import * as engine from "./engine.ts";
import { parseArc, printArc, type ArcExample, type ArcFn, type ArcModule, type ArcType } from "./arc.ts";
import { inputsFor, valuesOf } from "./sync.ts";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface DecompileCtx {
  ports: Ports;
  root: string;
  request: (p: engine.Project | null, ids: string[]) => CompileRequest;
  log: (line: string) => void;
  /** Source directories, relative to the root. */
  dirs: string[];
  /** Where the `.arc` files go, relative to the root. */
  out: string;
  /** Run the mapped test files with this command (the file is appended), e.g. ["node", "--test"]. Unsandboxed: it is the
   *  project's own test run. Without it, mapped tests are listed and not run. */
  testCmd?: string[];
  /** Run every module again, also unchanged ones. */
  fresh?: boolean;
}

/** tested: its test files ran and passed. failing: one of them fails, so its recorded examples describe behaviour the
 *  project's own tests reject. examples: recorded examples it satisfies. described: an intent only. bare: a signature only. */
export type FnStatus = "tested" | "failing" | "examples" | "described" | "bare";
export interface FnState { status: FnStatus; tests: string[]; why?: string }
export interface ModuleState { hash: string; arc: string; fns: Record<string, FnState>; skipped: Record<string, string> }
export interface DecompileState { version: 1; modules: Record<string, ModuleState> }
export const STATE_FILE = ".openarc/decompile.json";

export const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
export const isTest = (rel: string) => /(^|\/)(tests?|__tests__)\//.test(rel) || /\.(test|spec)\.[^/]+$/.test(rel);
const sha = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 16);

export async function walk(ports: Ports, dir: string, out: string[] = []): Promise<string[]> {
  for (const name of (await ports.fs.list(dir)).sort()) {
    const rel = `${dir}/${name}`;
    if (name === "node_modules" || name.startsWith(".")) continue;
    if (CODE.test(name) || name.endsWith(".json")) { if (!name.endsWith(".d.ts")) out.push(rel); }
    else if (!name.includes(".")) await walk(ports, rel, out);
  }
  return out;
}

function makeProgram(root: string, files: string[]): ts.Program {
  const cfg = ts.readConfigFile(`${root}/tsconfig.json`, ts.sys.readFile);
  const parsed = cfg.config ? ts.parseJsonConfigFileContent(cfg.config, ts.sys, root).options : {};
  // a project with no tsconfig (plain JavaScript) gets modern defaults; JavaScript is read, never reported on
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, ...parsed, allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true };
  return ts.createProgram(files.map((f) => `${root}/${f}`), options);
}

// ── types, as `.arc` text ──
const opaque = (text: string) => (text.length > 100 ? "Any" : `\`${text.replaceAll("`", "'")}\``);

export function arcType(checker: ts.TypeChecker, t: ts.Type, inProject: (s: ts.Symbol) => boolean, depth = 0, top = false): string {
  const f = t.flags;
  if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return "Any";
  if (f & ts.TypeFlags.BooleanLiteral) return checker.typeToString(t);
  if (f & ts.TypeFlags.Boolean) return "Bool";
  if (t.isStringLiteral()) return JSON.stringify(t.value);
  if (t.isNumberLiteral()) return String(t.value);
  if (f & ts.TypeFlags.String) return "Str";
  if (f & ts.TypeFlags.Number) return "Num";
  if (f & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) return "Void";
  if (f & ts.TypeFlags.Null) return "Null";
  const named = t.aliasSymbol ?? (t.symbol && !(t.symbol.flags & (ts.SymbolFlags.TypeLiteral | ts.SymbolFlags.ObjectLiteral)) ? t.symbol : undefined);
  if (!top && named && inProject(named) && /^[A-Za-z_$][\w$]*$/.test(named.name) && !(t as ts.TypeReference).typeArguments?.length && !t.aliasTypeArguments?.length) return named.name;
  if (t.isUnion()) {
    const parts = t.types.filter((x) => !(x.flags & ts.TypeFlags.Undefined));
    // boolean is the union true | false: print it as one type
    const names = [...new Set(parts.map((x) => arcType(checker, x, inProject, depth)))];
    const bools = names.includes("true") && names.includes("false") ? ["Bool", ...names.filter((n) => n !== "true" && n !== "false")] : names;
    const text = bools.join(" | ");
    return parts.length < t.types.length ? (bools.length === 1 ? `${text}?` : `(${text})?`) : text;
  }
  if (checker.isArrayType(t)) return `[${arcType(checker, checker.getTypeArguments(t as ts.TypeReference)[0]!, inProject, depth + 1)}]`;
  const props = t.getProperties();
  if (f & ts.TypeFlags.Object && !t.getCallSignatures().length && !t.getConstructSignatures().length && !(t.symbol?.flags & ts.SymbolFlags.Class) && (top || !named) && depth < 3 && props.length && props.length <= 12) {
    const fields = props.map((s) => {
      const decl = s.valueDeclaration ?? s.declarations?.[0];
      const type = decl ? arcType(checker, checker.getTypeOfSymbolAtLocation(s, decl), inProject, depth + 1) : "Any";
      const optional = !!(s.flags & ts.SymbolFlags.Optional);
      return `${/^[A-Za-z_$][\w$]*$/.test(s.name) ? s.name : JSON.stringify(s.name)}${optional ? "?" : ""}: ${optional ? type.replace(/\?$/, "") : type}`;
    });
    return `{ ${fields.join(", ")} }`;
  }
  return opaque(checker.typeToString(t));
}

// ── intent from the code's own comments ──
function statementOf(n: ts.Node): ts.Node {
  let s = n;
  while (s.parent && !ts.isSourceFile(s.parent)) s = s.parent;
  return s;
}

/** The declaration's JSDoc, else the `//` lines directly above it. At most 6 lines. */
export function commentOf(decl: ts.Node, sf: ts.SourceFile): string[] {
  const st = statementOf(decl);
  const doc = ts.getJSDocCommentsAndTags(st).find(ts.isJSDoc) ?? ts.getJSDocCommentsAndTags(decl).find(ts.isJSDoc);
  const text = doc ? ts.getTextOfJSDocComment(doc.comment) ?? "" : (ts.getLeadingCommentRanges(sf.text, st.getFullStart()) ?? [])
    .filter((r) => r.kind === ts.SyntaxKind.SingleLineCommentTrivia && !/\S/.test(sf.text.slice(r.end, st.getStart(sf)).replace(/\/\/.*$/gm, "")))
    .map((r) => sf.text.slice(r.pos + 2, r.end).trim()).join("\n");
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !/^(eslint|@ts-|prettier|ponytail:)/.test(l)).slice(0, 6);
}

// ── inputs from literal calls in the project ──
function staticValue(checker: ts.TypeChecker, n: ts.Expression, depth = 0): Json | undefined {
  if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) return staticValue(checker, n.expression, depth);
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isNumericLiteral(n)) return Number(n.text);
  if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(n.operand)) return -Number(n.operand.text);
  if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (n.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(n)) {
    const out: Json[] = [];
    for (const e of n.elements) {
      const v = ts.isSpreadElement(e) ? undefined : staticValue(checker, e, depth);
      if (v === undefined) return undefined;
      out.push(v);
    }
    return out;
  }
  if (ts.isObjectLiteralExpression(n)) {
    const out: Record<string, Json> = {};
    for (const p of n.properties) {
      const key = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name)) ? p.name.text : undefined;
      const v = key === undefined ? undefined : ts.isPropertyAssignment(p) ? staticValue(checker, p.initializer, depth) : ts.isShorthandPropertyAssignment(p) ? staticValue(checker, p.name, depth) : undefined;
      if (key === undefined || key === "__proto__" || v === undefined) return undefined;
      out[key] = v;
    }
    return out;
  }
  // a name bound once to a literal (`const stats = { water: 50 }`): its value at the declaration
  if (ts.isIdentifier(n) && depth < 3) {
    const d = (ts.isShorthandPropertyAssignment(n.parent) ? checker.getShorthandAssignmentValueSymbol(n.parent) : checker.getSymbolAtLocation(n))?.valueDeclaration;
    if (d && ts.isVariableDeclaration(d) && d.initializer && ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const) return staticValue(checker, d.initializer, depth + 1);
  }
  return undefined;
}

const resolved = (checker: ts.TypeChecker, s: ts.Symbol | undefined) => (s && s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s);

// ── one module ──
interface Found { fn: ArcFn; symbol: ts.Symbol; inputs: Json[][] | null; pos: number }

function readModule(checker: ts.TypeChecker, sf: ts.SourceFile, inProject: (s: ts.Symbol) => boolean): { types: ArcType[]; found: Found[]; skipped: Record<string, string> } {
  const types: ArcType[] = [], found: Found[] = [], skipped: Record<string, string> = {};
  const mod = checker.getSymbolAtLocation(sf);
  for (const exp of mod ? checker.getExportsOfModule(mod) : []) {
    const sym = resolved(checker, exp)!;
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    if (!decl || decl.getSourceFile() !== sf) continue; // a re-export belongs to the module that declares it
    if (sym.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias) && !(sym.flags & ts.SymbolFlags.Value)) {
      types.push({ name: exp.name, type: arcType(checker, checker.getDeclaredTypeOfSymbol(sym), inProject, 0, true) });
      continue;
    }
    if (sym.flags & ts.SymbolFlags.Class) { skipped[exp.name] = "a class (v0 reads exported functions)"; continue; }
    const sigs = checker.getTypeOfSymbolAtLocation(sym, decl).getCallSignatures();
    if (!sigs.length) continue; // a constant
    const sig = sigs.at(-1)!;
    if (sig.typeParameters?.length) { skipped[exp.name] = "generic"; continue; }
    const paramTypes = sig.parameters.map((p) => checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? decl));
    const decls = sig.parameters.map((p) => p.valueDeclaration as ts.ParameterDeclaration | undefined);
    let ret = sig.getReturnType(), isAsync = false;
    if (ret.symbol?.name === "Promise" && !inProject(ret.symbol)) { isAsync = true; ret = checker.getTypeArguments(ret as ts.TypeReference)[0] ?? ret; }
    const fn: ArcFn = {
      name: exp.name === "default" ? "default" : exp.name,
      params: sig.parameters.map((p, i) => {
        const d = decls[i];
        const optional = !!d && checker.isOptionalParameter(d);
        const type = arcType(checker, paramTypes[i]!, inProject);
        return { name: d && ts.isIdentifier(d.name) ? p.name : `arg${i + 1}`, type: optional ? type.replace(/\?$/, "") : type, ...(optional && !d.dotDotDotToken ? { optional: true } : {}), ...(d?.dotDotDotToken ? { rest: true } : {}) };
      }),
      returns: arcType(checker, ret, inProject),
      ...(isAsync ? { async: true } : {}),
      intent: commentOf(decl, sf), examples: [], rules: [],
    };
    if (!/^[A-Za-z_$][\w$]*$/.test(fn.name)) { skipped[exp.name] = "not a plain name"; continue; }
    // inputs the types allow: the required parameters only, so an optional one keeps its default
    const required = decls.findIndex((d) => !d || checker.isOptionalParameter(d) || !!d.dotDotDotToken);
    const typed = inputsFor(paramTypes.slice(0, required < 0 ? paramTypes.length : required).map((t) => valuesOf(checker, t)), 8);
    found.push({ fn, symbol: sym, inputs: typed, pos: decl.getStart(sf) });
  }
  return { types, found: found.sort((a, b) => a.pos - b.pos), skipped }; // source order: the file reads like the code
}

/** Every use of the given functions across the project: which test files name them, and their literal argument lists. */
function usesOf(checker: ts.TypeChecker, files: readonly ts.SourceFile[], rel: (sf: ts.SourceFile) => string, wanted: Set<ts.Symbol>): { tests: Map<ts.Symbol, Set<string>>; calls: Map<ts.Symbol, Json[][]> } {
  const tests = new Map<ts.Symbol, Set<string>>(), calls = new Map<ts.Symbol, Json[][]>();
  for (const sf of files) {
    const name = rel(sf), inTest = isTest(name);
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && !ts.isImportSpecifier(n.parent) && !ts.isImportClause(n.parent)) {
        const s = resolved(checker, checker.getSymbolAtLocation(n));
        if (s && wanted.has(s)) {
          if (inTest) (tests.get(s) ?? tests.set(s, new Set()).get(s)!).add(name);
          const callee = ts.isPropertyAccessExpression(n.parent) && n.parent.name === n ? n.parent : n;
          const call = callee.parent;
          if (ts.isCallExpression(call) && call.expression === callee) {
            const args = call.arguments.map((a) => (ts.isSpreadElement(a) ? undefined : staticValue(checker, a)));
            if (args.every((a) => a !== undefined)) (calls.get(s) ?? calls.set(s, []).get(s)!).push(args as Json[]);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { tests, calls };
}

const isThrown = (v: Json): v is { throws: string } => v !== null && typeof v === "object" && !Array.isArray(v) && typeof v.throws === "string" && Object.keys(v).length === 1;

/** Examples the function satisfies now: each input runs twice, and one whose results differ is dropped. */
async function examplesOf(ctx: DecompileCtx, p: engine.Project, req: CompileRequest, file: string, symbol: string, inputs: Json[][], files: Map<string, string>): Promise<ArcExample[] | { error: string }> {
  const got = await engine.observeExport(ctx.ports, req, p, { file, symbol }, [...inputs, ...inputs], files);
  if ("error" in got) return got;
  const stable = inputs.flatMap((args, i) => {
    const a = got[i]!.got, key = JSON.stringify(a);
    return key === JSON.stringify(got[i + inputs.length]!.got) && key.length <= 600 ? [{ args, got: a }] : []; // ponytail: a long result is no readable example
  });
  const seen = new Set<string>();
  const distinct = stable.filter((x) => { const k = JSON.stringify(x.got); return !seen.has(k) && !!seen.add(k); });
  const returned = distinct.filter((x) => !isThrown(x.got)), thrown = distinct.filter((x) => isThrown(x.got));
  if (!returned.length) return thrown.length ? { error: `every input throws: ${(thrown[0]!.got as { throws: string }).throws}` } : [];
  return [...returned.slice(0, 4).map((x) => ({ args: x.args, expected: x.got })), ...thrown.slice(0, 1).map((x) => ({ args: x.args, throws: (x.got as { throws: string }).throws }))];
}

const firstLine = (s: string) => s.split("\n")[0]!.slice(0, 200);

export async function decompile(ctx: DecompileCtx): Promise<DecompileState> {
  const { ports } = ctx;
  const all = (await Promise.all(ctx.dirs.map((d) => walk(ports, d)))).flat();
  const code = all.filter((f) => CODE.test(f));
  const sources = code.filter((f) => !isTest(f));
  // tests may live outside the source directories
  const tests = [...new Set([...code.filter(isTest), ...(await Promise.all(["tests", "test", "__tests__"].map((d) => walk(ports, d)))).flat().filter((f) => CODE.test(f))])];
  const program = makeProgram(ctx.root, [...sources, ...tests]);
  const checker = program.getTypeChecker();
  const rel = (sf: ts.SourceFile) => sf.fileName.slice(ctx.root.length + 1);
  const mine = new Set([...sources, ...tests]);
  const inProject = (s: ts.Symbol) => !!s.declarations?.length && s.declarations.every((d) => mine.has(rel(d.getSourceFile())));
  const read = new Map(sources.flatMap((f) => { const sf = program.getSourceFile(`${ctx.root}/${f}`); return sf ? [[f, readModule(checker, sf, inProject)] as const] : []; }));
  const wanted = new Set([...read.values()].flatMap((m) => m.found.map((x) => x.symbol)));
  const uses = usesOf(checker, program.getSourceFiles().filter((sf) => mine.has(rel(sf))), rel, wanted);

  const prev = JSON.parse((await ports.fs.read(STATE_FILE)) ?? "null") as DecompileState | null;
  const state: DecompileState = { version: 1, modules: {} };
  const p = await engine.parse(ports, ctx.request(null, []), []);
  const req = ctx.request(p, []);
  // the whole source tree is staged once; later runs add only the reference module
  const texts = new Map<string, string>();
  for (const f of all) if (!isTest(f)) texts.set(f, (await ports.fs.read(f)) ?? "");
  let staged = texts;
  const testRuns = new Map<string, boolean>();
  const passes = async (file: string): Promise<boolean> => {
    if (!testRuns.has(file)) testRuns.set(file, (await ports.proc.run([...ctx.testCmd!, file], 300_000, { cwd: ctx.root })).code === 0);
    return testRuns.get(file)!;
  };
  try {
    for (const [file, m] of read) {
      if (!m.found.length && !m.types.length) continue;
      const text = texts.get(file) ?? "";
      const dir = ctx.dirs.find((d) => file.startsWith(`${d}/`))!;
      const stem = file.slice(dir.length + 1).replace(CODE, "");
      const arcFile = `${ctx.out}/${stem}.arc`;
      const before = await ports.fs.read(arcFile);
      let old: ArcModule | null = null;
      try { old = before === null ? null : parseArc(before); } catch (e) { ctx.log(`${arcFile}: ${(e as Error).message}; left as it is`); state.modules[file] = prev?.modules[file] ?? { hash: "", arc: arcFile, fns: {}, skipped: {} }; continue; }
      const testsOf = (x: Found) => [...(uses.tests.get(x.symbol) ?? [])].sort();
      const hash = sha(`${text}\0${m.found.map((x) => testsOf(x).join(",")).join(";")}\0${ctx.testCmd?.join(" ") ?? ""}`);
      const known = prev?.modules[file];
      const reuse = !ctx.fresh && !!old && known?.hash === hash;
      const fns: Record<string, FnState> = {};
      for (const x of m.found) {
        const was = old?.fns.find((f) => f.name === x.fn.name);
        // what a person (or the host agent) wrote in the .arc file stays: intent, rules, hold, and its examples
        if (was?.intent.length) x.fn.intent = was.intent;
        if (was) Object.assign(x.fn, { rules: was.rules, ...(was.hold ? { hold: true } : {}) });
        let why: string | undefined;
        if (reuse && known.fns[x.fn.name]) { x.fn.examples = was?.examples ?? []; why = known.fns[x.fn.name]!.why; }
        else if (was?.examples.length) x.fn.examples = was.examples;
        else {
          const inputs = [...new Map([...(uses.calls.get(x.symbol) ?? []).slice(0, 6), ...(x.inputs ?? [])].map((a) => [JSON.stringify(a), a])).values()].slice(0, 12);
          if (!inputs.length) why = "no inputs: the parameter types say too little and no call passes literals";
          else {
            const ex = await examplesOf(ctx, p, req, file, x.fn.name, inputs, staged);
            staged = new Map();
            if ("error" in ex) why = firstLine(ex.error);
            else if (!ex.length) why = "no repeatable result";
            else x.fn.examples = ex;
          }
        }
        const mapped = testsOf(x);
        let ran: "tested" | "failing" | null = null;
        if (ctx.testCmd && mapped.length) {
          ran = "tested";
          for (const t of mapped) if (!(await passes(t))) { ran = "failing"; why = `${t} fails`; }
        }
        fns[x.fn.name] = { status: ran ?? (x.fn.examples.length ? "examples" : x.fn.intent.length ? "described" : "bare"), tests: mapped, ...(why ? { why } : {}) };
      }
      const next: ArcModule = { name: stem.replaceAll("/", "."), file, intent: old?.intent ?? [], types: m.types, fns: m.found.map((x) => x.fn) };
      const out = printArc(next);
      if (out !== before) await ports.fs.write(arcFile, out);
      state.modules[file] = { hash, arc: arcFile, fns, skipped: m.skipped };
      await ports.fs.write(STATE_FILE, JSON.stringify({ ...state, modules: { ...prev?.modules, ...state.modules } }, null, 1) + "\n"); // a checkpoint: an interrupted run resumes here
      ctx.log(`${file}: ${m.found.length} functions${reuse ? " (unchanged)" : ""}`);
    }
  } finally {
    await engine.closeSandbox(ports, p);
  }
  await ports.fs.write(STATE_FILE, JSON.stringify(state, null, 1) + "\n");
  return state;
}

export function report(s: DecompileState): { totals: Record<FnStatus | "skipped", number>; lines: string[] } {
  const totals = { tested: 0, failing: 0, examples: 0, described: 0, bare: 0, skipped: 0 };
  const lines: string[] = [];
  for (const [file, m] of Object.entries(s.modules)) {
    const c = { tested: 0, failing: 0, examples: 0, described: 0, bare: 0 };
    for (const f of Object.values(m.fns)) c[f.status]++, totals[f.status]++;
    totals.skipped += Object.keys(m.skipped).length;
    lines.push(`${file}: tested ${c.tested}, failing ${c.failing}, examples ${c.examples}, described ${c.described}, bare ${c.bare}${Object.keys(m.skipped).length ? `, skipped ${Object.keys(m.skipped).length}` : ""}`);
  }
  return { totals, lines };
}

/** Functions with no intent yet, for whoever writes them (the host agent): `<arc file>: <name>`. */
export const todo = (s: DecompileState, arcs: Map<string, ArcModule>): string[] =>
  Object.values(s.modules).flatMap((m) => (arcs.get(m.arc)?.fns ?? []).filter((f) => !f.intent.length).map((f) => `${m.arc}: ${f.name}`));
