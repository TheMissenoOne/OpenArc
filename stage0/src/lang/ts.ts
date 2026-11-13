// TypeScript and JavaScript behind the language seam (lang/lang.ts): the type checker reads signatures (inference and
// JSDoc for JavaScript), comments give the intent, literal calls the inputs, and the sandbox (engine.observeExport) runs.
import ts from "typescript";
import { resolve } from "node:path";
import { builtinModules } from "node:module";
import type { Ports } from "../types.ts";
import * as engine from "../engine.ts";
import type { ArcFn, ArcType } from "../arc.ts";
import { inputsFor, valuesOf } from "../sync.ts";
import type { DecompileCtx } from "../decompile.ts";
import type { Edge } from "../levels.ts";
import type { FoundFn, Json, Lang, Located, Read, ReadModule, Runner } from "./lang.ts";

export const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
export const isTest = (rel: string) => /(^|\/)(tests?|__tests__)\//.test(rel) || /\.(test|spec)\.[^/]+$/.test(rel);

export function makeProgram(root: string, files: string[]): ts.Program {
  const cfg = ts.readConfigFile(`${root}/tsconfig.json`, ts.sys.readFile);
  const parsed = cfg.config ? ts.parseJsonConfigFileContent(cfg.config, ts.sys, root).options : {};
  // a project with no tsconfig (plain JavaScript) gets modern defaults; JavaScript is read, never reported on
  // moduleDetection Force: a CommonJS `.js` file (only `module.exports`/`exports.x`, no import or export) is otherwise not
  // a module to the checker unless the package says `"type"` or the extension is `.cjs`, so it has no module symbol and
  // its exports are not found
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, ...parsed, allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true, moduleDetection: ts.ModuleDetectionKind.Force };
  return ts.createProgram(files.map((f) => `${root}/${f}`), options);
}

// ── types, as `.arc` text ──
const opaque = (text: string) => (text.length > 100 ? "Any" : `\`${text.replaceAll("`", "'")}\``);

export function arcType(checker: ts.TypeChecker, t: ts.Type, inProject: (s: ts.Symbol) => boolean, depth = 0, top = false): string {
  const f = t.flags;
  if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) return "Any"; // a generic's type parameters are erased
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
  while (s.parent && !ts.isSourceFile(s.parent) && !ts.isClassElement(s)) s = s.parent; // a method's comment is its own
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
/** node: the function itself (its body is where the recorder call goes), when it is one. cls: an instance method's class:
 *  its symbol (its `new` calls are receivers), whether it can be built with no arguments, and its constructor. */
interface Found { fn: ArcFn; symbol: ts.Symbol; inputs: Json[][] | null; pos: number; node?: ts.FunctionLikeDeclaration; cls?: Cls }
interface Cls { symbol: ts.Symbol; name: string; bare: boolean; ctor?: ts.ConstructorDeclaration }

/** The function a declaration binds: `function f`, `const f = <fn>`, `export default <fn>`, `exports.f = <fn>`. */
export function fnOf(d: ts.Node): ts.FunctionLikeDeclaration | undefined {
  let n: ts.Node | undefined = ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d) ? d.initializer : ts.isExportAssignment(d) ? d.expression
    : ts.isBinaryExpression(d) ? d.right : ts.isBinaryExpression(d.parent) && d.parent.left === d ? d.parent.right : d;
  while (n && ts.isParenthesizedExpression(n)) n = n.expression;
  return n && (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)) && n.body ? n : undefined;
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

/** A function's `.arc` entry from its call signature, and the inputs its required parameter types allow. */
function fromSignature(checker: ts.TypeChecker, inProject: (s: ts.Symbol) => boolean, sig: ts.Signature, name: string, decl: ts.Node, sf: ts.SourceFile): { fn: ArcFn; inputs: Json[][] | null } {
  const paramTypes = sig.parameters.map((p) => checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? decl));
  const decls = sig.parameters.map((p) => p.valueDeclaration as ts.ParameterDeclaration | undefined);
  let ret = sig.getReturnType(), isAsync = false;
  if (ret.symbol?.name === "Promise" && !inProject(ret.symbol)) { isAsync = true; ret = checker.getTypeArguments(ret as ts.TypeReference)[0] ?? ret; }
  const fn: ArcFn = {
    name,
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
  // inputs the types allow: the required parameters only, so an optional one keeps its default
  const required = decls.findIndex((d) => !d || checker.isOptionalParameter(d) || !!d.dotDotDotToken);
  return { fn, inputs: inputsFor(paramTypes.slice(0, required < 0 ? paramTypes.length : required).map((t) => valuesOf(checker, t)), 8) };
}

/** Not part of a class's public face: `#x`, TypeScript `private`/`protected`, and a name starting with `_`. */
const hidden = (name: string, d: ts.Node | undefined) => /^(_|#)/.test(name) || (!!d && !!(ts.getCombinedModifierFlags(d as ts.Declaration) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)));

/** An exported class: a `type` line of its public data fields (when the checker knows any) and its public methods, each
 *  named `<Class>.<method>`. Inherited methods belong to the class that declares them. */
function readClass(checker: ts.TypeChecker, sf: ts.SourceFile, inProject: (s: ts.Symbol) => boolean, name: string, sym: ts.Symbol, decl: ts.Node, out: { types: ArcType[]; found: Found[]; skipped: Record<string, string> }): void {
  const cd = (sym.declarations ?? []).find((d): d is ts.ClassLikeDeclaration => ts.isClassLike(d));
  if (!cd) return;
  const fields = checker.getDeclaredTypeOfSymbol(sym).getProperties().flatMap((p) => {
    const d = p.valueDeclaration;
    if (!d || p.flags & (ts.SymbolFlags.Method | ts.SymbolFlags.Accessor) || hidden(p.name, d)) return []; // a `#x` field's symbol is named `__#...`
    const t = checker.getTypeOfSymbolAtLocation(p, d);
    if (t.getCallSignatures().length) return []; // a function-valued field is behaviour, not data
    const optional = !!(p.flags & ts.SymbolFlags.Optional), type = arcType(checker, t, inProject);
    return [`${/^[A-Za-z_$][\w$]*$/.test(p.name) ? p.name : JSON.stringify(p.name)}${optional ? "?" : ""}: ${optional ? type.replace(/\?$/, "") : type}`];
  });
  if (fields.length) out.types.push({ name, type: `{ ${fields.join(", ")} }` });
  const ctorSig = checker.getTypeOfSymbolAtLocation(sym, decl).getConstructSignatures().at(-1);
  const bare = !ctorSig || ctorSig.parameters.every((p) => { const d = p.valueDeclaration as ts.ParameterDeclaration | undefined; return !d || checker.isOptionalParameter(d) || !!d.dotDotDotToken; });
  const ctor = cd.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body);
  const cls: Cls = { symbol: sym, name, bare, ...(ctor ? { ctor } : {}) };
  for (const m of cd.members) {
    if (!m.name || ts.isConstructorDeclaration(m)) continue;
    const mname = ts.isPrivateIdentifier(m.name) ? m.name.text : m.name.getText(sf);
    if (hidden(mname, m)) continue;
    const full = `${name}.${mname}`;
    if (ts.isGetAccessor(m) || ts.isSetAccessor(m)) { out.skipped[full] = "a getter or setter (not read yet)"; continue; }
    if (!ts.isMethodDeclaration(m) || !m.body) continue; // a data field (the type line has it), an overload or an abstract method
    if (!/^[A-Za-z_$][\w$]*$/.test(mname)) { out.skipped[full] = "not a plain name"; continue; }
    const msym = checker.getSymbolAtLocation(m.name);
    const sig = msym && checker.getTypeOfSymbolAtLocation(msym, m).getCallSignatures().at(-1);
    if (!msym || !sig) continue;
    const isStatic = !!(ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Static);
    const { fn, inputs } = fromSignature(checker, inProject, sig, full, m, sf);
    out.found.push({ fn: isStatic ? { ...fn, static: true } : fn, symbol: msym, inputs, pos: m.getStart(sf), node: m, ...(isStatic ? {} : { cls }) });
  }
}

function readModule(checker: ts.TypeChecker, sf: ts.SourceFile, inProject: (s: ts.Symbol) => boolean): { types: ArcType[]; found: Found[]; skipped: Record<string, string> } {
  const out = { types: [] as ArcType[], found: [] as Found[], skipped: {} as Record<string, string> };
  const { types, found, skipped } = out;
  const mod = checker.getSymbolAtLocation(sf);
  // with `module.exports = { a() {} }` the exports are the object's properties; `module.exports = <function or class>`
  // is what Node's `import` calls `default`
  const exports = new Map<string, ts.Symbol>(mod ? checker.getExportsOfModule(mod).map((e) => [e.name, e]) : []);
  const eq = resolved(checker, mod?.exports?.get(ts.InternalSymbolName.ExportEquals));
  const eqDecl = eq?.valueDeclaration ?? eq?.declarations?.[0];
  const eqType = eq && eqDecl && checker.getTypeOfSymbolAtLocation(eq, eqDecl);
  if (eqType && eqType.getConstructSignatures().length && eqType.symbol?.flags & ts.SymbolFlags.Class) exports.set("default", eqType.symbol);
  else if (eqType?.getCallSignatures().length) exports.set("default", eq!);
  else if (eqType) for (const p of eqType.getProperties()) if (!exports.has(p.name)) exports.set(p.name, p);
  for (const [expName, exp] of exports) {
    const sym = resolved(checker, exp)!;
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    if (!decl || decl.getSourceFile() !== sf) continue; // a re-export belongs to the module that declares it
    if (sym.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias) && !(sym.flags & ts.SymbolFlags.Value)) {
      types.push({ name: expName, type: arcType(checker, checker.getDeclaredTypeOfSymbol(sym), inProject, 0, true) });
      continue;
    }
    if (sym.flags & ts.SymbolFlags.Class) { readClass(checker, sf, inProject, expName, sym, decl, out); continue; }
    const sigs = checker.getTypeOfSymbolAtLocation(sym, decl).getCallSignatures();
    if (!sigs.length) continue; // a constant
    if (!/^[A-Za-z_$][\w$]*$/.test(expName)) { skipped[expName] = "not a plain name"; continue; }
    const { fn, inputs } = fromSignature(checker, inProject, sigs.at(-1)!, expName, decl, sf);
    const node = (sym.declarations ?? [decl]).filter((d) => d.getSourceFile() === sf).map(fnOf).find(Boolean); // an overloaded function: the one with a body
    found.push({ fn, symbol: sym, inputs, pos: decl.getStart(sf), ...(node ? { node } : {}) });
  }
  return { types, found: found.sort((a, b) => a.pos - b.pos), skipped }; // source order: the file reads like the code
}

/** Every use of the given functions across the project: which test files name them, and their literal argument lists with
 *  where they are (`<file>:<1-based line>`). For a class, its `new X(...)` expressions. */
function usesOf(checker: ts.TypeChecker, files: readonly ts.SourceFile[], rel: (sf: ts.SourceFile) => string, wanted: Set<ts.Symbol>): { tests: Map<ts.Symbol, Set<string>>; calls: Map<ts.Symbol, { args: Json[]; at: string }[]> } {
  const tests = new Map<ts.Symbol, Set<string>>(), calls = new Map<ts.Symbol, { args: Json[]; at: string }[]>();
  for (const sf of files) {
    const name = rel(sf), inTest = isTest(name);
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && !ts.isImportSpecifier(n.parent) && !ts.isImportClause(n.parent)) {
        // a method through an instance (`inv.add`) is a symbol of the instantiated class type: its root is the declared one
        const r = resolved(checker, checker.getSymbolAtLocation(n)), s = r && [r, ...checker.getRootSymbols(r)].find((x) => wanted.has(x));
        if (s) {
          if (inTest) (tests.get(s) ?? tests.set(s, new Set()).get(s)!).add(name);
          const callee = ts.isPropertyAccessExpression(n.parent) && n.parent.name === n ? n.parent : n;
          const call = callee.parent;
          if ((ts.isCallExpression(call) || ts.isNewExpression(call)) && call.expression === callee) {
            const args = (call.arguments ?? []).map((a) => (ts.isSpreadElement(a) ? undefined : staticValue(checker, a)));
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

// ── the function in the source file (arc accept) ──
const unwrap = (n: ts.Expression | undefined) => { while (n && ts.isParenthesizedExpression(n)) n = n.expression; return n; };
const isExports = (n: ts.Expression, sf: ts.SourceFile) => /^(module\.)?exports$/.test(n.getText(sf));

/** The class `name` binds at the top level of `sf`: `class C`, `const C = class`, `exports.C = class`, and for `default`
 *  `export default class`, `export default C`, `module.exports = class` (or `= C`). ponytail: `export { C as D }`
 *  renames are not followed. */
function classOf(sf: ts.SourceFile, name: string): ts.ClassLikeDeclaration | undefined {
  const named = (e: ts.Expression | undefined) => { const n = unwrap(e); return n && ts.isClassExpression(n) ? n : n && ts.isIdentifier(n) && n.text !== name ? classOf(sf, n.text) : undefined; };
  for (const st of sf.statements) {
    if (ts.isClassDeclaration(st) && (name === "default" ? !!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) : st.name?.text === name)) return st;
    if (ts.isVariableStatement(st)) {
      const d = st.declarationList.declarations.find((v) => ts.isIdentifier(v.name) && v.name.text === name);
      const c = unwrap(d?.initializer);
      if (c && ts.isClassExpression(c)) return c;
    } else if (ts.isExportAssignment(st) && name === "default") { const c = named(st.expression); if (c) return c; }
    else if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const l = st.expression.left;
      const hit = name === "default" ? isExports(l, sf) && l.getText(sf) === "module.exports" : ts.isPropertyAccessExpression(l) && l.name.text === name && isExports(l.expression, sf);
      const c = hit ? named(st.expression.right) : undefined;
      if (c) return c;
    }
  }
  return undefined;
}

/** The function `name` binds at the top level of `sf`, found the way decompile finds exports: `function f`,
 *  `const f = <fn>`, `export default <fn>`, `exports.f = <fn>` (and `module.exports.f`), a property of
 *  `module.exports = { f() {} }`, and a method `C.m` (instance or static) of a class classOf finds. */
export function locate(sf: ts.SourceFile, name: string): ts.FunctionLikeDeclaration | undefined {
  const dot = name.indexOf(".");
  if (dot > 0) {
    // ponytail: an instance and a static method with the same name: the first in the class is found
    const m = classOf(sf, name.slice(0, dot))?.members.find((x) => ts.isMethodDeclaration(x) && !!x.body && !!x.name && !ts.isComputedPropertyName(x.name) && x.name.text === name.slice(dot + 1));
    return m as ts.MethodDeclaration | undefined;
  }
  let inObject: ts.FunctionLikeDeclaration | undefined; // `module.exports = { f() {} }`: only when nothing above binds f
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st)) {
      const isDefault = !!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      if (st.body && (name === "default" ? isDefault : st.name?.text === name)) return st;
    } else if (ts.isVariableStatement(st)) {
      const d = st.declarationList.declarations.find((v) => ts.isIdentifier(v.name) && v.name.text === name);
      if (d) return fnOf(d);
    } else if (ts.isExportAssignment(st) && !st.isExportEquals && name === "default") return fnOf(st);
    else if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const l = st.expression.left, r = unwrap(st.expression.right);
      if (ts.isPropertyAccessExpression(l) && l.name.text === name && isExports(l.expression, sf)) {
        const f = fnOf(st.expression);
        if (f) return f;
      } else if (r && ts.isObjectLiteralExpression(r) && l.getText(sf) === "module.exports") {
        const p = r.properties.find((x) => x.name && (ts.isIdentifier(x.name) || ts.isStringLiteral(x.name)) && x.name.text === name);
        inObject ??= p && fnOf(p);
      }
    }
  }
  return inObject;
}

const parse = (file: string, text: string) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, isTs(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS);

/** Type and syntax errors the new text adds: syntax in the file; types (TypeScript) in the file and in every TypeScript
 *  file that imports it, directly or through others, so a caller the new body breaks (a narrower inferred return, say) is
 *  named. The program is the project's tsconfig files (or its defaults) with the file. Errors are matched by file and
 *  message, at most 6 lines. ponytail: dependents come from the import specifiers (importsOf), so a file affected only
 *  through a global declaration or a tsconfig `paths` alias is not checked; checking the whole program would catch those
 *  at the cost of type-checking every file twice. */
function tsProblems(root: string, file: string, after: string): string[] {
  const abs = resolve(root, file);
  const cfg = ts.readConfigFile(`${root}/tsconfig.json`, ts.sys.readFile);
  const project = ts.parseJsonConfigFileContent(cfg.config ?? {}, ts.sys, root).fileNames.filter((f) => !f.includes("/node_modules/"));
  const before = makeProgram(root, [...new Set([file, ...project.map((f) => f.slice(root.length + 1))])]);
  const host = ts.createCompilerHost(before.getCompilerOptions());
  const get = host.getSourceFile.bind(host);
  host.getSourceFile = (f, lang, ...rest) => (resolve(f) === abs ? ts.createSourceFile(f, after, lang) : get(f, lang, ...rest));
  const next = ts.createProgram(before.getRootFileNames(), before.getCompilerOptions(), host, before);
  // the files that import `file`, transitively: the reverse of importsOf over the program's own files
  const mine = new Map(before.getSourceFiles().filter((sf) => sf.fileName.startsWith(`${root}/`) && !sf.fileName.includes("/node_modules/")).map((sf) => [sf.fileName.slice(root.length + 1), sf.text]));
  const edges = importsOf(mine).filter((e) => !e.external);
  const deps = new Set([file]);
  for (let grew = true; grew;) { grew = false; for (const e of edges) if (deps.has(e.to) && !deps.has(e.from)) deps.add(e.from), grew = true; }
  const diags = (p: ts.Program) => [...deps].flatMap((f) => {
    const sf = p.getSourceFile(resolve(root, f));
    if (!sf) return [];
    return [...(f === file ? p.getSyntacticDiagnostics(sf) : []), ...(isTs(f) ? p.getSemanticDiagnostics(sf) : [])];
  });
  const text = (d: ts.Diagnostic) => `TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
  const where = (d: ts.Diagnostic) => (d.file ? d.file.fileName.slice(root.length + 1) : "");
  const had = new Map<string, number>();
  for (const d of diags(before)) had.set(`${where(d)}\0${text(d)}`, (had.get(`${where(d)}\0${text(d)}`) ?? 0) + 1);
  const added = diags(next).flatMap((d) => {
    const k = `${where(d)}\0${text(d)}`, n = had.get(k) ?? 0;
    if (n) return had.set(k, n - 1), [];
    const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0;
    return [text(d).replace(/^(TS\d+) /, `$1 ${where(d) && where(d) !== file ? `${where(d)} ` : ""}line ${line}: `)];
  });
  return added.length > 6 ? [...added.slice(0, 6), `and ${added.length - 6} more`] : added;
}

/** The top-level statement holding `n`: the whole `export const f = (a) => ...;`, not only the arrow. */
const top = (n: ts.Node): ts.Node => (ts.isSourceFile(n.parent) ? n : top(n.parent));

// ── imports (the architecture level) ──
const EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function packageOf(spec: string): string {
  const [a, b] = spec.split("/") as [string, string?];
  if (spec.startsWith("node:")) return a;
  if (builtinModules.includes(a)) return `node:${a}`;
  return a.startsWith("@") && b ? `${a}/${b}` : a;
}

/** Every import between the given files (relative specifiers resolved to a file in the set) and to packages, deduplicated.
 *  A relative import that resolves to no file in the set (JSON, a test, a missing file) is left out.
 *  ponytail: tsconfig `paths` aliases read as packages; resolve them when a project uses them. */
export function importsOf(files: Map<string, string>): Edge[] {
  const seen = new Map<string, Edge>();
  for (const [from, text] of files) {
    for (const { fileName: spec } of ts.preProcessFile(text, true, true).importedFiles) {
      let e: Edge | undefined;
      if (spec.startsWith("/")) continue; // an absolute path is no part of the project
      if (spec.startsWith(".")) {
        const parts: string[] = [];
        for (const s of `${dirOf(from)}/${spec}`.split("/")) {
          if (s === "..") parts.pop();
          else if (s && s !== ".") parts.push(s);
        }
        const base = parts.join("/"), bare = base.replace(/\.[cm]?jsx?$/, "");
        const to = [base, ...EXTS.map((x) => base + x), ...EXTS.map((x) => bare + x), ...EXTS.map((x) => `${base}/index${x}`)].find((c) => files.has(c));
        if (to && to !== from) e = { from, to, external: false };
      } else e = { from, to: packageOf(spec), external: true };
      if (e) seen.set(`${e.from}\0${e.to}`, e);
    }
  }
  return [...seen.values()];
}

const isTs = (file: string) => /\.[cm]?tsx?$/.test(file);
const dirOf = (f: string) => f.slice(0, Math.max(0, f.lastIndexOf("/")));

export const tsLang: Lang = {
  code: CODE,
  isTest,
  label: (file) => (isTs(file) ? "TypeScript" : "JavaScript"),
  forms: "function f, const f = <fn>, export default <fn>, exports.f = <fn>, module.exports = { f() {} } or a class method C.m",
  indent: "  ",
  read: async (ctx: DecompileCtx, sources: string[], tests: string[]): Promise<Read> => {
    const program = makeProgram(ctx.root, [...sources, ...tests]);
    const checker = program.getTypeChecker();
    const rel = (sf: ts.SourceFile) => sf.fileName.slice(ctx.root.length + 1);
    const mine = new Set([...sources, ...tests]);
    const inProject = (s: ts.Symbol) => !!s.declarations?.length && s.declarations.every((d) => mine.has(rel(d.getSourceFile())));
    const read = new Map(sources.flatMap((f) => { const sf = program.getSourceFile(`${ctx.root}/${f}`); return sf ? [[f, readModule(checker, sf, inProject)] as const] : []; }));
    const wanted = new Set([...read.values()].flatMap((m) => m.found.flatMap((x) => (x.cls ? [x.symbol, x.cls.symbol] : [x.symbol]))));
    const uses = usesOf(checker, program.getSourceFiles().filter((sf) => mine.has(rel(sf))), rel, wanted);
    const instrumented = new Map<string, string>(); // for recording: per source file with exported functions
    const modules = new Map<string, ReadModule>();
    for (const [f, m] of read) {
      // a constructor records as `new <Class>`: its arguments are receivers for the instance methods
      const ctors = new Map(m.found.flatMap((x) => (x.cls?.ctor ? [[x.cls.name, x.cls.ctor] as const] : [])));
      const targets = [...m.found.flatMap((x) => (x.node ? [{ name: x.fn.name, node: x.node }] : [])), ...[...ctors].map(([name, node]) => ({ name: `new ${name}`, node }))];
      if (targets.length) instrumented.set(f, instrument(program.getSourceFile(`${ctx.root}/${f}`)!, f, targets));
      const found = m.found.map((x): FoundFn => ({
        fn: x.fn, inputs: x.inputs, tests: [...(uses.tests.get(x.symbol) ?? [])].sort(), calls: uses.calls.get(x.symbol) ?? [],
        ...(x.cls ? { cls: { name: x.cls.name, bare: x.cls.bare, calls: uses.calls.get(x.cls.symbol) ?? [] } } : {}),
      }));
      modules.set(f, { types: m.types, found, skipped: m.skipped });
    }
    return { modules, instrumented };
  },
  // One sandbox for a whole run: the source tree is staged on the first call, later calls add only the reference module
  open: (ctx: DecompileCtx, texts: Map<string, string>): Runner => {
    let staged = texts, init: Promise<{ p: engine.Project; req: ReturnType<DecompileCtx["request"]> }> | undefined;
    return {
      observe: async (file, fn, inputs) => {
        const { p, req } = await (init ??= engine.parse(ctx.ports, ctx.request(null, []), []).then((p) => ({ p, req: ctx.request(p, []) })));
        const [symbol, member] = fn.name.split(".") as [string, string | undefined];
        const got = await engine.observeExport(ctx.ports, req, p, { file, symbol, ...(member ? { member: { name: member, ...(fn.static ? { static: true } : {}) } } : {}) }, inputs, staged);
        staged = new Map();
        return got;
      },
      close: async () => { if (init) await engine.closeSandbox(ctx.ports, (await init).p); },
    };
  },
  runTest: async (ctx, file, env) => ({ ok: (await ctx.ports.proc.run([...ctx.testCmd!, file], 300_000, { cwd: ctx.root, ...(env ? { env } : {}) })).code === 0 }),
  locate: async (_ctx, file, text, name): Promise<Located | undefined> => {
    const sf = parse(file, text), node = locate(sf, name);
    if (!node) return undefined;
    const lineOf = (n: ts.Node) => text.lastIndexOf("\n", n.getStart(sf)) + 1;
    const indent = /^[ \t]*/.exec(text.slice(lineOf(node)))![0];
    let code = top(node).getText(sf);
    const box = node.parent;
    if (ts.isClassLike(box) || ts.isObjectLiteralExpression(box)) {
      // a method or an object's property: the class (or object) header, the function, the closing brace; `...` for the rest
      const items: ts.NodeArray<ts.Node> = ts.isClassLike(box) ? box.members : box.properties, i = items.indexOf(node);
      const more = `${indent}...`;
      code = [text.slice(top(box).getStart(sf), items.pos).trimEnd(), ...(i > 0 ? [more] : []), text.slice(lineOf(node), node.getEnd()), ...(i < items.length - 1 ? [more] : []), "}"].join("\n");
    }
    return { start: node.body!.getStart(sf), end: node.body!.getEnd(), indent, code };
  },
  notBody: (file, body, name) => {
    const sf = parse(file, body);
    if (sf.statements.some((s) => ts.canHaveModifiers(s) && ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) || !!locate(sf, name)) return true;
    // a method's (or an object property's) declaration: read inside a class, the reply opens with that method
    const first = parse(file, `class C {\n${body}\n}`).statements[0];
    const m = first && ts.isClassDeclaration(first) ? first.members[0] : undefined;
    return !!m && ts.isMethodDeclaration(m) && !!m.body && !!m.name && !ts.isComputedPropertyName(m.name) && m.name.text === name.split(".").at(-1);
  },
  problems: async (ctx, file, after) => tsProblems(ctx.root, file, after),
  imports: async (_ports: Ports, files) => importsOf(files),
};
