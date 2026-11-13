// `openarc decompile`: read a project's code (TypeScript or JavaScript) into `.arc` specs without changing a byte of it.
// No markers, no model. Per exported function: the signature from the type checker (inference and JSDoc for JavaScript),
// the intent from its comment, examples by running it in the sandbox on inputs taken from its parameter types and from
// literal calls found in the project (its tests above all), and the test files that use it.
// What it records is `observed`: what the code did, not what it should do. An `example` line is a requirement a person
// confirmed; a later run checks it and never rewrites it. `--check` (checkSpecs below) re-runs both kinds and writes nothing.
// Resumable: a module whose source is unchanged since the last run is not run again.
// With `--run-tests`, the arguments the exported functions receive while the mapped tests run are recorded too
// (core/record.mjs) and become inputs: inputs only, results still come from the sandbox.
import ts from "typescript";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { CompileRequest, Ports } from "./types.ts";
import * as engine from "./engine.ts";
import { parseArc, printArc, printExample, printOutcome, printValue, type ArcExample, type ArcFn, type ArcModule, type ArcType } from "./arc.ts";
import { inputsFor, valuesOf } from "./sync.ts";
import { argsFit, checkRules } from "./rules.ts";

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
  /** With testCmd: record the arguments the exported functions receive while the tests run (core/record.mjs). */
  record?: boolean;
  /** `--check`: at most this many generated inputs per function with rules (default 50). */
  ruleInputs?: number;
}

/** tested: its test files ran and passed. failing: one of them fails, or an `example` line does not hold. specified: it has
 *  `example` lines and all hold. observed: only recorded observations. described: an intent only. bare: a signature only.
 *  A state file from before `observed` says `examples` for observed: report() reads it as such. */
export type FnStatus = "tested" | "failing" | "specified" | "observed" | "described" | "bare";
/** origins: per observed line (JSON of its args), where the input came from: `call <file>:<line>`, `recorded <test file>`,
 *  `types` or `kept`. */
export interface FnState { status: FnStatus; tests: string[]; why?: string; origins?: Record<string, string> }
export interface ModuleState { hash: string; arc: string; fns: Record<string, FnState>; skipped: Record<string, string> }
export interface DecompileState { version: 1; modules: Record<string, ModuleState> }
export const STATE_FILE = ".openarc/decompile.json";

export const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
export const isTest = (rel: string) => /(^|\/)(tests?|__tests__)\//.test(rel) || /\.(test|spec)\.[^/]+$/.test(rel);
const sha = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 16);

const codeOrJson = (name: string) => CODE.test(name) || name.endsWith(".json");
export async function walk(ports: Ports, dir: string, out: string[] = [], keep = codeOrJson): Promise<string[]> {
  for (const name of (await ports.fs.list(dir)).sort()) {
    const rel = `${dir}/${name}`;
    if (name === "node_modules" || name.startsWith(".")) continue;
    if (keep(name)) { if (!name.endsWith(".d.ts")) out.push(rel); }
    else if (!name.includes(".")) await walk(ports, rel, out, keep);
  }
  return out;
}

export function makeProgram(root: string, files: string[]): ts.Program {
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
/** node: the function itself (its body is where the recorder call goes), when it is one. */
interface Found { fn: ArcFn; symbol: ts.Symbol; inputs: Json[][] | null; pos: number; node?: ts.FunctionLikeDeclaration }

/** The function a declaration binds: `function f`, `const f = <fn>`, `export default <fn>`, `exports.f = <fn>`. */
export function fnOf(d: ts.Node): ts.FunctionLikeDeclaration | undefined {
  let n: ts.Node | undefined = ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d) ? d.initializer : ts.isExportAssignment(d) ? d.expression
    : ts.isBinaryExpression(d) ? d.right : ts.isBinaryExpression(d.parent) && d.parent.left === d ? d.parent.right : d;
  while (n && ts.isParenthesizedExpression(n)) n = n.expression;
  return n && (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) && n.body ? n : undefined;
}

/** The module's text with one recorder call at the start of each target function's body, on the line of its opening
 *  brace, so every line number stays the same. Function declarations and expressions hand over `arguments`; an arrow its
 *  parameter names (an expression body `(a) => e` becomes `(a) => (<call>, e)`). `?.`: without a recorder installed the
 *  code behaves as before. A generator's call runs at its first `next()`. */
export function instrument(sf: ts.SourceFile, file: string, targets: { name: string; node: ts.FunctionLikeDeclaration }[]): string {
  const at: [number, string][] = [];
  for (const { name, node } of targets) {
    const body = node.body!;
    const call = (args: string) => `globalThis.__openarcRecord?.(${JSON.stringify(file)}, ${JSON.stringify(name)}, ${args})`;
    let args = "arguments";
    if (ts.isArrowFunction(node)) {
      // ponytail: an arrow with a destructured or rest parameter is not recorded; its arguments have no names to hand over
      if (!node.parameters.every((p) => ts.isIdentifier(p.name) && !p.dotDotDotToken)) continue;
      args = `[${node.parameters.map((p) => p.name.getText(sf)).join(", ")}]`;
    }
    if (ts.isBlock(body)) {
      let n = 0; // after a "use strict" prologue: it stays a directive
      while (n < body.statements.length && ts.isExpressionStatement(body.statements[n]!) && ts.isStringLiteral((body.statements[n] as ts.ExpressionStatement).expression)) n++;
      at.push([n ? body.statements[n - 1]!.getEnd() : body.getStart(sf) + 1, ` ${call(args)};`]);
    } else at.push([body.getStart(sf), `(${call(args)}, `], [body.getEnd(), ")"]);
  }
  let text = sf.text;
  for (const [pos, ins] of at.sort((a, b) => b[0] - a[0])) text = text.slice(0, pos) + ins + text.slice(pos);
  return text;
}

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
    const node = (sym.declarations ?? [decl]).filter((d) => d.getSourceFile() === sf).map(fnOf).find(Boolean); // an overloaded function: the one with a body
    found.push({ fn, symbol: sym, inputs: typed, pos: decl.getStart(sf), ...(node ? { node } : {}) });
  }
  return { types, found: found.sort((a, b) => a.pos - b.pos), skipped }; // source order: the file reads like the code
}

/** Every use of the given functions across the project: which test files name them, and their literal argument lists with
 *  where they are (`<file>:<1-based line>`). */
function usesOf(checker: ts.TypeChecker, files: readonly ts.SourceFile[], rel: (sf: ts.SourceFile) => string, wanted: Set<ts.Symbol>): { tests: Map<ts.Symbol, Set<string>>; calls: Map<ts.Symbol, { args: Json[]; at: string }[]> } {
  const tests = new Map<ts.Symbol, Set<string>>(), calls = new Map<ts.Symbol, { args: Json[]; at: string }[]>();
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
            if (args.every((a) => a !== undefined)) (calls.get(s) ?? calls.set(s, []).get(s)!).push({ args: args as Json[], at: `${name}:${sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1}` });
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
const key = (args: Json[]) => JSON.stringify(args);
const firstLine = (s: string) => s.split("\n")[0]!.slice(0, 200);

/** One call as the code made it: `stable` when a second run gave the same result and changed arguments. */
interface Ran { args: Json[]; got: Json; after?: Json[]; stable: boolean }

/** One sandbox for a whole run: the source tree is staged on the first call, later calls add only the reference module.
 *  Each input runs twice. */
async function sandbox(ctx: DecompileCtx, texts: Map<string, string>) {
  const p = await engine.parse(ctx.ports, ctx.request(null, []), []);
  const req = ctx.request(p, []);
  let staged = texts;
  return {
    run: async (file: string, symbol: string, inputs: Json[][]): Promise<Ran[] | { error: string }> => {
      const got = await engine.observeExport(ctx.ports, req, p, { file, symbol }, [...inputs, ...inputs], staged);
      staged = new Map();
      if ("error" in got) return got;
      return inputs.map((_, i) => {
        const a = got[i]!, b = got[i + inputs.length]!;
        return { args: a.args, got: a.got, ...(a.after ? { after: a.after } : {}), stable: JSON.stringify([a.got, a.after]) === JSON.stringify([b.got, b.after]) };
      });
    },
    close: () => engine.closeSandbox(ctx.ports, p),
  };
}

/** A call's outcome as an `observed` line. */
const recorded = (r: Ran): ArcExample => isThrown(r.got) ? { args: r.args, throws: r.got.throws, observed: true } : { args: r.args, expected: r.got, ...(r.after ? { after: r.after } : {}), observed: true };

/** The observations worth keeping: repeatable, distinct results, at most 4 returns and 1 throw. An observation of a
 *  function that changes its arguments states them with `after`. */
function observations(ran: Ran[]): ArcExample[] | { error: string } {
  const seen = new Set<string>();
  const distinct = ran.filter((x) => { const k = JSON.stringify([x.got, x.after]); return x.stable && k.length <= 600 && !seen.has(k) && !!seen.add(k); }); // ponytail: a long result is no readable example
  const returned = distinct.filter((x) => !isThrown(x.got)), thrown = distinct.filter((x) => isThrown(x.got));
  if (!returned.length) return thrown.length ? { error: `every input throws: ${(thrown[0]!.got as { throws: string }).throws}` } : [];
  return [...returned.slice(0, 4), ...thrown.slice(0, 1)].map(recorded);
}

/** Why the code does not satisfy requirement `e`, given what the call did (`example (3) => 6: the code returns 4`). */
function unmet(e: ArcExample, r: Ran): string | undefined {
  const now = recorded(r);
  const ok = e.throws !== undefined
    ? now.throws !== undefined && (e.throws === true || (now.throws as string).includes(e.throws))
    : now.throws === undefined && isDeepStrictEqual(now.expected, e.expected) && (e.after === undefined || isDeepStrictEqual(r.after ?? e.args, e.after));
  return ok ? undefined : `${printExample({ ...e, name: undefined })}: the code ${now.throws !== undefined ? printOutcome(now) : `returns ${printOutcome(now)}`}`;
}

/** The project as decompile and check read it: source modules with their exported functions, and their uses. */
async function scan(ctx: DecompileCtx) {
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
  const texts = new Map<string, string>();
  for (const f of all) if (!isTest(f)) texts.set(f, (await ports.fs.read(f)) ?? "");
  const instrumented = new Map<string, string>(); // for recording: per source file with exported functions
  for (const [f, m] of read) {
    const targets = m.found.flatMap((x) => (x.node ? [{ name: x.fn.name, node: x.node }] : []));
    if (targets.length) instrumented.set(f, instrument(program.getSourceFile(`${ctx.root}/${f}`)!, f, targets));
  }
  return { read, uses, texts, instrumented };
}

const RECORDED = ".openarc/recorded";
const RECORDER = fileURLToPath(new URL("../core/record.mjs", import.meta.url)); // the same relative place in the npm build

/** Recording: the instrumented texts under .openarc/recorded/src/ (the sources stay as they are) and their manifest.
 *  Returns the environment a test process gets, and how to collect what it recorded: per "<file>\0<name>", the
 *  argument lists (plain JSON, at most 600 characters each). Recorded files are read as JSON lines only, at most 1 MB
 *  per file; a malformed line, or one naming no exported function, is ignored. */
async function recorder(ctx: DecompileCtx, instrumented: Map<string, string>, wanted: Set<string>) {
  const { ports } = ctx, abs = `${ctx.root}/${RECORDED}`, manifest: Record<string, string> = {};
  await ports.fs.remove(RECORDED); // left by an interrupted run
  for (const [f, text] of instrumented) {
    await ports.fs.write(`${RECORDED}/src/${f}`, text);
    manifest[`${ctx.root}/${f}`] = `${abs}/src/${f}`;
  }
  await ports.fs.write(`${RECORDED}/manifest.json`, JSON.stringify(manifest));
  const env = (test: string) => ({
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(RECORDER).href}`].filter(Boolean).join(" "),
    OPENARC_RECORD_MANIFEST: `${abs}/manifest.json`, OPENARC_RECORD_OUT: abs, OPENARC_RECORD_TEST: test,
  });
  const collect = async (): Promise<Map<string, Json[][]>> => {
    const got = new Map<string, Json[][]>();
    for (const name of (await ports.fs.list(RECORDED)).filter((n) => /^calls-\d+\.jsonl$/.test(n))) {
      const text = (await ports.fs.read(`${RECORDED}/${name}`)) ?? "";
      await ports.fs.remove(`${RECORDED}/${name}`);
      if (text.length > 1_000_000) continue;
      for (const line of text.split("\n")) {
        try {
          const r = JSON.parse(line) as { file: unknown; name: unknown; args: unknown };
          const k = `${r.file}\0${r.name}`;
          if (typeof r.file !== "string" || typeof r.name !== "string" || !wanted.has(k) || !Array.isArray(r.args)) continue;
          const lists = got.get(k) ?? got.set(k, []).get(k)!;
          for (const a of r.args) if (Array.isArray(a) && key(a).length <= 600) lists.push(a as Json[]);
        } catch { /* a malformed line */ }
      }
    }
    return got;
  };
  return { env, collect };
}

/** The state, and how many re-recorded observations differ from the line that was in the file. */
export async function decompile(ctx: DecompileCtx): Promise<DecompileState & { changed: number }> {
  const { ports } = ctx;
  const { read, uses, texts, instrumented } = await scan(ctx);
  const prev = JSON.parse((await ports.fs.read(STATE_FILE)) ?? "null") as DecompileState | null;
  const state: DecompileState = { version: 1, modules: {} };
  const box = await sandbox(ctx, texts);
  let changed = 0;
  const testRuns = new Map<string, boolean>();
  let rec: Awaited<ReturnType<typeof recorder>> | null = null;
  const fromTests = new Map<string, { args: Json[]; test: string }[]>(); // per "<file>\0<name>", in the order the tests ran
  /** Runs a test file once per decompile. With recording, a file that fails runs again without it, and that run decides:
   *  when the two disagree, what was recorded from it is dropped. */
  const passes = async (file: string): Promise<boolean> => {
    if (testRuns.has(file)) return testRuns.get(file)!;
    const run = async (env?: Record<string, string>) => (await ports.proc.run([...ctx.testCmd!, file], 300_000, { cwd: ctx.root, ...(env ? { env } : {}) })).code === 0;
    let ok = await run(rec?.env(file));
    const got = rec ? await rec.collect() : new Map<string, Json[][]>();
    if (rec && !ok && (ok = await run())) ctx.log(`${file}: recording changed the outcome of this test file; its result without recording counts, and nothing recorded from it is used`);
    else for (const [k, lists] of got) (fromTests.get(k) ?? fromTests.set(k, []).get(k)!).push(...lists.map((args) => ({ args, test: file })));
    testRuns.set(file, ok);
    return ok;
  };
  try {
    if (ctx.testCmd && ctx.record) rec = await recorder(ctx, instrumented, new Set([...read].flatMap(([f, m]) => m.found.map((x) => `${f}\0${x.fn.name}`))));
    for (const [file, m] of read) {
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
      // the module's test files run first: what they record feeds its inputs
      if (ctx.testCmd) for (const t of new Set(m.found.flatMap(testsOf).sort())) await passes(t);
      for (const x of m.found) {
        const name = x.fn.name, was = old?.fns.find((f) => f.name === name), had = known?.fns[name];
        // what a person (or the host agent) wrote in the .arc file stays: intent, rules, hold, and its `example` lines
        if (was?.intent.length) x.fn.intent = was.intent;
        if (was) Object.assign(x.fn, { rules: was.rules, ...(was.hold ? { hold: true } : {}) });
        const reqs = (was?.examples ?? []).filter((e) => !e.observed), olds = (was?.examples ?? []).filter((e) => e.observed);
        let why: string | undefined, failed: string | undefined, origins: Record<string, string> | undefined;
        if (reuse && had) {
          x.fn.examples = was?.examples ?? [];
          why = had.why;
          origins = had.origins;
          if (why?.startsWith("example ")) failed = why; // an `example` that failed then fails now: nothing changed
        } else {
          // inputs: recorded from the tests first (real usage), then literal calls, then the types. An input's origin: a
          // literal call (it names the line), else the test it was recorded from, else the types, else its observed line
          const calls = (uses.calls.get(x.symbol) ?? []).slice(0, 6), from = new Map<string, string>();
          const seen = [...new Map((fromTests.get(`${file}\0${name}`) ?? []).map((r) => [key(r.args), r])).values()].slice(0, 6);
          for (const c of calls) if (!from.has(key(c.args))) from.set(key(c.args), `call ${c.at}`);
          for (const r of seen) if (!from.has(key(r.args))) from.set(key(r.args), `recorded ${r.test}`);
          for (const a of x.inputs ?? []) if (!from.has(key(a))) from.set(key(a), "types");
          for (const e of olds) if (!from.has(key(e.args))) from.set(key(e.args), had?.origins?.[key(e.args)] ?? "kept");
          const required = new Set(reqs.map((e) => key(e.args)));
          const inputs = [...new Map([...olds.map((e) => e.args), ...seen.map((r) => r.args), ...calls.map((c) => c.args), ...(x.inputs ?? [])].map((a) => [key(a), a])).values()].filter((a) => !required.has(key(a))).slice(0, 18);
          x.fn.examples = [...reqs, ...olds];
          if (!inputs.length && !reqs.length) why = "no inputs: the parameter types say too little and no call passes literals";
          else {
            const ran = await box.run(file, name, [...reqs.map((e) => e.args), ...inputs]);
            if ("error" in ran) { why = firstLine(ran.error); if (reqs.length) failed = `${printExample({ ...reqs[0]!, name: undefined })}: ${why}`; }
            else {
              failed = reqs.map((e, i) => unmet(e, ran[i]!)).find(Boolean);
              const now = ran.slice(reqs.length);
              for (const e of olds) {
                const r = now[inputs.findIndex((a) => key(a) === key(e.args))];
                if (r && printOutcome(e) !== printOutcome(recorded(r))) {
                  changed++;
                  ctx.log(`${file}: ${name}(${e.args.map(printValue).join(", ")}) changed: was ${printOutcome(e)}, now ${printOutcome(recorded(r))}`);
                }
              }
              const obs = observations(now);
              if ("error" in obs) why = firstLine(obs.error);
              else if (!obs.length && inputs.length) why = "no repeatable result";
              const names = new Map(olds.flatMap((e) => (e.name ? [[key(e.args), e.name] as const] : [])));
              x.fn.examples = [...reqs, ...("error" in obs ? [] : obs.map((e) => (names.has(key(e.args)) ? { ...e, name: names.get(key(e.args))! } : e)))];
            }
          }
          const obsArgs = x.fn.examples.filter((e) => e.observed).map((e) => key(e.args));
          if (obsArgs.length) origins = Object.fromEntries(obsArgs.map((k) => [k, from.get(k) ?? had?.origins?.[k] ?? "kept"]));
        }
        const mapped = testsOf(x);
        let ran: "tested" | "failing" | null = null, testWhy: string | undefined;
        if (ctx.testCmd && mapped.length) {
          ran = "tested";
          for (const t of mapped) if (!(await passes(t))) { ran = "failing"; testWhy = `${t} fails`; }
        }
        why = failed ?? testWhy ?? why;
        const status: FnStatus = failed || ran === "failing" ? "failing" : ran ?? (reqs.length ? "specified" : x.fn.examples.length ? "observed" : x.fn.intent.length ? "described" : "bare");
        fns[name] = { status, tests: mapped, ...(why ? { why } : {}), ...(origins ? { origins } : {}) };
      }
      const next: ArcModule = { name: stem.replaceAll("/", "."), file, intent: old?.intent ?? [], types: m.types, fns: m.found.map((x) => x.fn) };
      const out = printArc(next);
      if (out !== before) await ports.fs.write(arcFile, out);
      state.modules[file] = { hash, arc: arcFile, fns, skipped: m.skipped };
      await ports.fs.write(STATE_FILE, JSON.stringify({ ...state, modules: { ...prev?.modules, ...state.modules } }, null, 1) + "\n"); // a checkpoint: an interrupted run resumes here
      ctx.log(`${file}: ${m.found.length} functions${reuse ? " (unchanged)" : ""}`);
    }
  } finally {
    await box.close();
    if (ctx.testCmd && ctx.record) await ports.fs.remove(RECORDED);
  }
  await ports.fs.write(STATE_FILE, JSON.stringify(state, null, 1) + "\n");
  return { ...state, changed };
}

/** One finding of `decompile --check`. `was`/`now`: outcomes as `.arc` prints them. */
/** Rules: `held` (on `inputs` calls), `broken` (the first call it was false on: `args`, `now`), `unparsable`. */
export interface CheckItem { file: string; fn: string; kind: "changed" | "failing" | "unrunnable" | "removed" | "new" | "held" | "broken" | "unparsable"; args?: Json[]; was?: string; now?: string; why?: string; rule?: string; inputs?: number }
export interface CheckSummary { functions: number; preserved: number; changed: number; failing: number; unrunnable: number; removed: number; new: number; held: number; broken: number; unparsable: number }

/** `decompile --check`: every `example` and `observed` line in the `.arc` files under `ctx.out` against the code as it is
 *  now. Reads only the `.arc` files and the code (not the state file) and writes nothing. ok: nothing changed, failed or
 *  was removed. `only`: check just the functions it accepts. ponytail: finite inputs; agreeing on them does not prove two versions equal. */
export async function checkSpecs(ctx: DecompileCtx, only?: (file: string, fn: string) => boolean): Promise<{ ok: boolean; summary: CheckSummary; items: CheckItem[] }> {
  const { read, texts } = await scan(ctx);
  const arcs: ArcModule[] = [];
  for (const f of await walk(ctx.ports, ctx.out, [], (n) => n.endsWith(".arc"))) {
    try { arcs.push(parseArc((await ctx.ports.fs.read(f)) ?? "")); } catch (e) { ctx.log(`${f}: ${(e as Error).message}; not checked`); }
  }
  const items: CheckItem[] = [], summary: CheckSummary = { functions: 0, preserved: 0, changed: 0, failing: 0, unrunnable: 0, removed: 0, new: 0, held: 0, broken: 0, unparsable: 0 };
  const add = (i: CheckItem) => { items.push(i); summary[i.kind]++; };
  const box = await sandbox(ctx, texts);
  try {
    for (const m of arcs) {
      const exported = new Set(read.get(m.file)?.found.map((x) => x.fn.name));
      for (const f of m.fns) {
        if (only && !only(m.file, f.name)) continue; // openarc arc: one function, or a few
        if (!exported.has(f.name)) { add({ file: m.file, fn: f.name, kind: "removed" }); continue; }
        summary.functions++;
        if (!f.examples.length) continue;
        const ran = await box.run(m.file, f.name, f.examples.map((e) => e.args));
        if ("error" in ran) { add({ file: m.file, fn: f.name, kind: "unrunnable", why: firstLine(ran.error) }); continue; }
        f.examples.forEach((e, i) => {
          const now = printOutcome(recorded(ran[i]!)), why = e.observed ? undefined : unmet(e, ran[i]!);
          if (why) add({ file: m.file, fn: f.name, kind: "failing", args: e.args, was: printOutcome(e), now, why });
          else if (e.observed && printOutcome(e) !== now) add({ file: m.file, fn: f.name, kind: "changed", args: e.args, was: printOutcome(e), now });
          else summary.preserved++;
        });
        if (f.rules.length) {
          // the rules, on every call above and on generated inputs: structural edits of these arguments that fit the types
          const seen = new Set(f.examples.map((e) => key(e.args))), cap = ctx.ruleInputs ?? 50;
          const extra = engine.oracleInputs(f.examples.map((e) => ({ args: e.args })), seen.size + cap, 1, [], argsFit(f, m.types)).filter((a) => !seen.has(key(a))).slice(0, cap);
          const more = extra.length ? await box.run(m.file, f.name, extra) : [];
          if ("error" in more) ctx.log(`${m.file}: ${f.name}: generated inputs unrunnable, rules checked on the written lines only: ${firstLine(more.error)}`);
          const runs = [...ran, ...("error" in more ? [] : more)].map((r) => (isThrown(r.got) ? { args: r.args, threw: true } : { args: r.args, result: r.got, ...(r.after ? { after: r.after } : {}), threw: false }));
          for (const r of checkRules(f, m.types, runs)) {
            const at = { file: m.file, fn: f.name, rule: r.rule };
            if (r.broken) add({ ...at, kind: "broken", args: r.broken.args, now: r.broken.result === undefined ? "throws" : printOutcome({ args: [], expected: r.broken.result, ...(r.broken.after ? { after: r.broken.after } : {}) }), ...(r.error ? { why: r.error } : {}) });
            else if (r.error) add({ ...at, kind: "unparsable", why: r.error });
            else add({ ...at, kind: "held", inputs: r.held });
          }
        }
      }
    }
    for (const [file, m] of read) {
      const specified = new Set(arcs.filter((a) => a.file === file).flatMap((a) => a.fns.map((f) => f.name)));
      for (const x of m.found) if (!specified.has(x.fn.name) && (!only || only(file, x.fn.name))) add({ file, fn: x.fn.name, kind: "new" });
    }
  } finally {
    await box.close();
  }
  return { ok: !summary.changed && !summary.failing && !summary.removed && !summary.broken && !summary.unparsable, summary, items };
}

/** One line per finding: the text `decompile --check` prints. */
export function checkLine(i: CheckItem): string {
  const call = `${i.file}: ${i.fn}${i.args ? `(${i.args.map(printValue).join(", ")})` : ""}`;
  if (i.rule) return `${i.file}: ${i.fn}: rule ${i.rule}: ${i.kind === "held" ? `held on ${i.inputs} input${i.inputs === 1 ? "" : "s"}` : i.kind === "broken" ? `broken by (${i.args!.map(printValue).join(", ")}) -> ${i.now}${i.why ? `: ${i.why}` : ""}` : i.why}`;
  return i.kind === "changed" ? `${call} changed: was ${i.was}, now ${i.now}`
    : i.kind === "failing" ? `${i.file}: ${i.fn}: ${i.why}`
    : i.kind === "unrunnable" ? `${call} unrunnable: ${i.why}`
    : i.kind === "removed" ? `${call} removed: the code no longer exports it`
    : `${call} new: no entry in the .arc file`;
}

export function report(s: DecompileState): { totals: Record<FnStatus | "skipped", number>; lines: string[] } {
  const totals = { tested: 0, failing: 0, specified: 0, observed: 0, described: 0, bare: 0, skipped: 0 };
  const lines: string[] = [];
  for (const [file, m] of Object.entries(s.modules)) {
    const c = { tested: 0, failing: 0, specified: 0, observed: 0, described: 0, bare: 0 };
    for (const f of Object.values(m.fns)) {
      const st = (f.status as string) === "examples" ? "observed" : f.status; // a state file written before `observed`
      c[st]++, totals[st]++;
    }
    totals.skipped += Object.keys(m.skipped).length;
    lines.push(`${file}: tested ${c.tested}, failing ${c.failing}, specified ${c.specified}, observed ${c.observed}, described ${c.described}, bare ${c.bare}${Object.keys(m.skipped).length ? `, skipped ${Object.keys(m.skipped).length}` : ""}`);
  }
  return { totals, lines };
}

/** Functions with no intent yet, for whoever writes them (the host agent): `<arc file>: <name>`. */
export const todo = (s: DecompileState, arcs: Map<string, ArcModule>): string[] =>
  Object.values(s.modules).flatMap((m) => (arcs.get(m.arc)?.fns ?? []).filter((f) => !f.intent.length).map((f) => `${m.arc}: ${f.name}`));
