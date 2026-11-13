// `rule` lines of an `.arc` function, made mechanical: a small expression language, parsed by hand and evaluated on the
// calls a check already makes (examples, observations, generated inputs). A rule is a property check, not a proof: a pass
// means "held on N inputs", nothing more. Pure: no I/O, no TypeScript compiler.
//
//   rule bounded: result in 0..100
//   rule keeps: after.stats in Stats and len(after.log) >= len(old.log)
//   rule sorted: threw or all(result, x => x >= 0)
//
// Names: each parameter (its value before the call), `result`, `threw`, `after.<param>` (as the call left it), `old.<param>`
// (the value before, said explicitly). Operators, loosest first: `implies` (right to left), `or`, `and`, `not`, comparison
// (`== != < <= > >=`, `x in lo..hi`, `x in <type>`), `+ -`, `* / %`, unary `-`, then `a.b` and `a[i]`. Calls: `len(x)`,
// `all(xs, x => e)`, `any(xs, x => e)`. Nothing else: no definitions, no assignment, no calls into the program.
import type { ArcFn, ArcType } from "./arc.ts";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
/** A value while a rule runs: JSON with its value tokens decoded ("$NaN" is NaN, "$undefined" is undefined). */
type V = Json | undefined;

export type RuleType =
  | { k: "name"; n: string } | { k: "lit"; v: Json } | { k: "list"; t: RuleType } | { k: "native" }
  | { k: "rec"; fields: { key: string; opt: boolean; t: RuleType }[] } | { k: "union"; ts: RuleType[] } | { k: "opt"; t: RuleType };
export type RuleExpr =
  | { k: "lit"; v: Json } | { k: "name"; n: string } | { k: "field"; e: RuleExpr; f: string } | { k: "index"; e: RuleExpr; i: RuleExpr }
  | { k: "un"; op: "-" | "not"; e: RuleExpr } | { k: "bin"; op: string; l: RuleExpr; r: RuleExpr }
  | { k: "range"; e: RuleExpr; lo: RuleExpr; hi: RuleExpr } | { k: "is"; e: RuleExpr; t: RuleType } | { k: "len"; e: RuleExpr }
  | { k: "quant"; all: boolean; xs: RuleExpr; v: string; body: RuleExpr };

// ── tokens ──
interface Tok { t: "num" | "str" | "id" | "native" | "op" | "end"; v: string; at: number }
const TOKEN = /(?:(\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)|("(?:[^"\\]|\\.)*")|([A-Za-z_$][\w$]*)|(`[^`]*`)|(\.\.|==|!=|<=|>=|=>|[-+*/%<>()[\]{},.|?:]))/y;
const KEYWORDS = new Set(["and", "or", "not", "in", "implies"]);
/** Thrown while parsing; parseRule turns it into { error, column }. */
interface Fail { msg: string; at: number }

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  for (;;) {
    while (/\s/.test(s[i] ?? "")) i++;
    if (i >= s.length) return out.push({ t: "end", v: "", at: i }), out;
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(s);
    if (!m) throw { msg: `unexpected ${JSON.stringify(s[i])}`, at: i } satisfies Fail;
    out.push({ t: m[1] ? "num" : m[2] ? "str" : m[3] ? "id" : m[4] ? "native" : "op", v: m[0], at: i });
    i = TOKEN.lastIndex;
  }
}

class Parser {
  i = 0;
  readonly toks: Tok[];
  constructor(toks: Tok[]) { this.toks = toks; }
  get peek(): Tok { return this.toks[this.i]!; }
  fail(what: string): never { const t = this.peek; throw { msg: `expected ${what}, found ${t.t === "end" ? "the end" : JSON.stringify(t.v)}`, at: t.at } satisfies Fail; }
  op(v: string): boolean { if (this.peek.t === "op" && this.peek.v === v) return this.i++, true; return false; }
  word(v: string): boolean { if (this.peek.t === "id" && this.peek.v === v) return this.i++, true; return false; }
  need(v: string): void { if (!this.op(v)) this.fail(JSON.stringify(v)); }
  ident(): string { const t = this.peek; if (t.t !== "id" || KEYWORDS.has(t.v)) this.fail("a name"); this.i++; return t.v; }
  end(): void { if (this.peek.t !== "end") this.fail("the end"); }

  expr(): RuleExpr { const l = this.or(); return this.word("implies") ? { k: "bin", op: "implies", l, r: this.expr() } : l; }
  or(): RuleExpr { let l = this.and(); while (this.word("or")) l = { k: "bin", op: "or", l, r: this.and() }; return l; }
  and(): RuleExpr { let l = this.not(); while (this.word("and")) l = { k: "bin", op: "and", l, r: this.not() }; return l; }
  not(): RuleExpr { return this.word("not") ? { k: "un", op: "not", e: this.not() } : this.cmp(); }
  cmp(): RuleExpr {
    const l = this.add();
    for (const op of ["==", "!=", "<=", ">=", "<", ">"]) if (this.op(op)) return { k: "bin", op, l, r: this.add() };
    if (!this.word("in")) return l;
    // `x in lo..hi` when what follows reads as a number range, else `x in <type>`
    const at = this.i;
    let lo: RuleExpr | undefined;
    try { lo = this.add(); } catch { /* not an expression: a type */ }
    if (lo && this.op("..")) return { k: "range", e: l, lo, hi: this.add() };
    this.i = at;
    return { k: "is", e: l, t: this.type() };
  }
  add(): RuleExpr { let l = this.mul(); for (let op; (op = ["+", "-"].find((o) => this.op(o)));) l = { k: "bin", op, l, r: this.mul() }; return l; }
  mul(): RuleExpr { let l = this.unary(); for (let op; (op = ["*", "/", "%"].find((o) => this.op(o)));) l = { k: "bin", op, l, r: this.unary() }; return l; }
  unary(): RuleExpr { return this.op("-") ? { k: "un", op: "-", e: this.unary() } : this.postfix(); }
  postfix(): RuleExpr {
    let e = this.primary();
    for (;;) {
      if (this.op(".")) { const t = this.peek; if (t.t !== "id") this.fail("a field name"); this.i++; e = { k: "field", e, f: t.v }; }
      else if (this.op("[")) { e = { k: "index", e, i: this.expr() }; this.need("]"); }
      else return e;
    }
  }
  primary(): RuleExpr {
    const t = this.peek;
    if (t.t === "num") return this.i++, { k: "lit", v: Number(t.v) };
    if (t.t === "str") return this.i++, { k: "lit", v: JSON.parse(t.v) as string };
    if (this.op("(")) { const e = this.expr(); this.need(")"); return e; }
    if (t.t === "id" && ["true", "false", "null"].includes(t.v)) return this.i++, { k: "lit", v: JSON.parse(t.v) as Json };
    if (t.t === "id" && ["len", "all", "any"].includes(t.v) && this.toks[this.i + 1]?.v === "(") {
      this.i += 2;
      if (t.v === "len") { const e = this.expr(); this.need(")"); return { k: "len", e }; }
      const xs = this.expr();
      this.need(",");
      const v = this.ident();
      this.need("=>");
      const body = this.expr();
      this.need(")");
      return { k: "quant", all: t.v === "all", xs, v, body };
    }
    if (t.t === "id" && !KEYWORDS.has(t.v)) return this.i++, { k: "name", n: t.v };
    return this.fail("a value");
  }

  // types, as `.arc` writes them
  type(): RuleType {
    const ts = [this.optType()];
    while (this.op("|")) ts.push(this.optType());
    return ts.length === 1 ? ts[0]! : { k: "union", ts };
  }
  optType(): RuleType { let t = this.atomType(); while (this.op("?")) t = { k: "opt", t }; return t; }
  atomType(): RuleType {
    const t = this.peek;
    if (this.op("(")) { const x = this.type(); this.need(")"); return x; }
    if (this.op("[")) { const x = this.type(); this.need("]"); return { k: "list", t: x }; }
    if (this.op("{")) {
      const fields: { key: string; opt: boolean; t: RuleType }[] = [];
      if (!this.op("}")) {
        do {
          const k = this.peek;
          if (k.t !== "id" && k.t !== "str") this.fail("a key");
          this.i++;
          const opt = this.op("?");
          this.need(":");
          fields.push({ key: k.t === "str" ? (JSON.parse(k.v) as string) : k.v, opt, t: this.type() });
        } while (this.op(","));
        this.need("}");
      }
      return { k: "rec", fields };
    }
    if (t.t === "str") return this.i++, { k: "lit", v: JSON.parse(t.v) as string };
    if (t.t === "num") return this.i++, { k: "lit", v: Number(t.v) };
    if (this.op("-")) { const n = this.peek; if (n.t !== "num") this.fail("a number"); this.i++; return { k: "lit", v: -Number(n.v) }; }
    if (t.t === "native") return this.i++, { k: "native" };
    if (t.t === "id" && ["true", "false"].includes(t.v)) return this.i++, { k: "lit", v: t.v === "true" };
    if (t.t === "id" && t.v === "null") return this.i++, { k: "name", n: "Null" };
    if (t.t === "id" && !KEYWORDS.has(t.v)) return this.i++, { k: "name", n: t.v };
    return this.fail("a type");
  }
}

/** Parse a rule's predicate. column: 1-based, where the text stops making sense. */
export function parseRule(text: string): RuleExpr | { error: string; column: number } {
  try {
    const p = new Parser(tokenize(text));
    const e = p.expr();
    p.end();
    return e;
  } catch (e) {
    if (e && typeof e === "object" && "msg" in e) return { error: (e as Fail).msg, column: (e as Fail).at + 1 };
    throw e;
  }
}

// ── values ──
const TOKENS: Record<string, V> = { $NaN: NaN, $Infinity: Infinity, "$-Infinity": -Infinity, "$-0": -0, $undefined: undefined };
const decode = (v: Json): V =>
  typeof v === "string" ? (Object.hasOwn(TOKENS, v) ? TOKENS[v] : v)
  : Array.isArray(v) ? (v.map(decode) as Json[])
  : v !== null && typeof v === "object" ? (Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)])) as Json)
  : v;
const isObj = (v: V): v is { [k: string]: Json } => v !== null && typeof v === "object" && !Array.isArray(v);
const show = (v: V): string => (v === undefined ? "undefined" : typeof v === "number" && !Number.isFinite(v) ? String(v) : JSON.stringify(v));

/** `==`: deep structural equality. ponytail: numbers equal within 1e-9 relative (as example checks compare), NaN equals
 *  NaN; an exact comparison would need its own operator. */
function same(a: V, b: V): boolean {
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
    return a === b || (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)));
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (isObj(a) && isObj(b)) { const ka = Object.keys(a); return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && same(a[k], b[k])); }
  return a === b;
}

// ── types ──
const parsedTypes = new Map<string, RuleType>();
function typeOf(text: string): RuleType {
  let t = parsedTypes.get(text);
  if (!t) {
    const p = new Parser(tokenize(text));
    try { t = p.type(); p.end(); } catch (e) { throw new Error(`type ${text}: ${(e as Fail).msg ?? e}`); }
    parsedTypes.set(text, t);
  }
  return t;
}

/** Does a value fit a type? Records are open (extra keys fit, as in TypeScript); `T?` also takes undefined and null (JSON
 *  turns an undefined array item into null); a backticked native type takes anything. Throws on an unknown type name. */
function fits(t: RuleType, v: V, types: Record<string, string>, depth = 0): boolean {
  switch (t.k) {
    case "native": return true;
    case "lit": return v === t.v;
    case "opt": return v === undefined || v === null || fits(t.t, v, types, depth);
    case "union": return t.ts.some((x) => fits(x, v, types, depth));
    case "list": return Array.isArray(v) && v.every((x) => fits(t.t, x, types, depth));
    case "rec": return isObj(v) && t.fields.every((f) => (v[f.key] === undefined ? f.opt : fits(f.t, v[f.key], types, depth)));
    case "name":
      switch (t.n) {
        case "Any": return true;
        case "Int": return typeof v === "number" && Number.isInteger(v);
        case "Float": case "Num": return typeof v === "number";
        case "Bool": return typeof v === "boolean";
        case "Str": return typeof v === "string";
        case "Void": return v === undefined;
        case "Null": return v === null;
      }
      if (!Object.hasOwn(types, t.n)) throw new Error(`unknown type ${t.n}`);
      if (depth > 32) throw new Error(`type ${t.n} never ends`);
      return fits(typeOf(types[t.n]!), v, types, depth + 1);
  }
}

/** Does a JSON value (value tokens allowed) fit `.arc` type text? `types`: the module's `type` declarations by name. */
export const fitsArcType = (type: string, v: Json, types: Record<string, string> = {}): boolean => fits(typeOf(type), decode(v), types);

/** Argument lists a caller could pass, by the parameter types: what generated inputs keep. ponytail: a type this module
 *  cannot read (a name declared in another module's `.arc` file) takes anything; resolve imported names if that lets
 *  ill-typed inputs break rules. */
export function argsFit(fn: ArcFn, types: ArcType[]): (args: Json[]) => boolean {
  const named = Object.fromEntries(types.map((t) => [t.name, t.type]));
  const ok = (type: string, v: Json) => { try { return fitsArcType(type, v, named); } catch { return true; } };
  return (args) => fn.params.every((p, i) => (p.rest ? args.slice(i).every((a) => ok(p.type, a)) : i >= args.length ? !!p.optional : ok(p.type, args[i]!))) && (fn.params.at(-1)?.rest || args.length <= fn.params.length);
}

// ── evaluation ──
export interface RuleEnv { params: Record<string, Json>; after?: Record<string, Json>; result?: Json; threw: boolean; types: Record<string, string> }

const bool = (v: V, what: string): boolean => { if (typeof v !== "boolean") throw new Error(`${what} is ${show(v)}, not true or false`); return v; };
const num = (v: V, what: string): number => { if (typeof v !== "number") throw new Error(`${what} is ${show(v)}, not a number`); return v; };

function ev(e: RuleExpr, s: Map<string, V>, types: Record<string, string>): V {
  const go = (x: RuleExpr) => ev(x, s, types);
  switch (e.k) {
    case "lit": return e.v;
    case "name": if (!s.has(e.n)) throw new Error(`unknown name ${e.n}`); return s.get(e.n);
    case "field": {
      const o = go(e.e);
      if (!isObj(o)) throw new Error(`${show(o)} has no field ${e.f}`);
      return Object.hasOwn(o, e.f) ? o[e.f] : undefined;
    }
    case "index": {
      const o = go(e.e), i = go(e.i);
      if ((Array.isArray(o) || typeof o === "string") && typeof i === "number" && Number.isInteger(i)) return o[i < 0 ? o.length + i : i];
      if (isObj(o) && typeof i === "string") return Object.hasOwn(o, i) ? o[i] : undefined;
      throw new Error(`cannot index ${show(o)} with ${show(i)}`);
    }
    case "un": return e.op === "not" ? !bool(go(e.e), "the operand of not") : -num(go(e.e), "the operand of -");
    case "len": {
      const v = go(e.e);
      if (typeof v !== "string" && !Array.isArray(v)) throw new Error(`len of ${show(v)}: not a string or a list`);
      return v.length;
    }
    case "range": {
      const v = go(e.e), lo = num(go(e.lo), "the range start"), hi = num(go(e.hi), "the range end");
      return typeof v === "number" && v >= lo && v <= hi;
    }
    case "is": return fits(e.t, go(e.e), types);
    case "quant": {
      const xs = go(e.xs);
      if (!Array.isArray(xs)) throw new Error(`${e.all ? "all" : "any"} over ${show(xs)}: not a list`);
      const test = (x: Json) => bool(ev(e.body, new Map(s).set(e.v, x), types), `${e.all ? "all" : "any"}(..., ${e.v} => ...)`);
      return e.all ? xs.every(test) : xs.some(test);
    }
    case "bin": {
      if (e.op === "and") return bool(go(e.l), "the left of and") && bool(go(e.r), "the right of and");
      if (e.op === "or") return bool(go(e.l), "the left of or") || bool(go(e.r), "the right of or");
      if (e.op === "implies") return !bool(go(e.l), "the left of implies") || bool(go(e.r), "the right of implies");
      const l = go(e.l), r = go(e.r);
      if (e.op === "==") return same(l, r);
      if (e.op === "!=") return !same(l, r);
      if (["<", "<=", ">", ">="].includes(e.op)) {
        if (!((typeof l === "number" && typeof r === "number") || (typeof l === "string" && typeof r === "string"))) throw new Error(`cannot compare ${show(l)} ${e.op} ${show(r)}`);
        return e.op === "<" ? l < r : e.op === "<=" ? l <= r : e.op === ">" ? l > r : l >= r;
      }
      if (e.op === "+" && typeof l === "string" && typeof r === "string") return l + r;
      const a = num(l, `the left of ${e.op}`), b = num(r, `the right of ${e.op}`);
      return e.op === "+" ? a + b : e.op === "-" ? a - b : e.op === "*" ? a * b : e.op === "/" ? a / b : a % b;
    }
  }
}

/** Evaluate a parsed rule on one call. An error: the rule cannot be evaluated on these values (a field of null, a
 *  comparison of a string with a number, a result that is not true or false). */
export function checkRule(ast: RuleExpr, env: RuleEnv): boolean | { error: string } {
  const params = decode(env.params) as Record<string, V>;
  const s = new Map<string, V>(Object.entries(params));
  // on a call that threw, `result` is undefined
  s.set("old", params as Json).set("after", env.after ? decode(env.after) : (params as Json)).set("threw", env.threw).set("result", env.threw || env.result === undefined ? undefined : decode(env.result));
  try {
    const v = ev(ast, s, env.types);
    return typeof v === "boolean" ? v : { error: `the rule gives ${show(v)}, not true or false` };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** The free names a rule reads (a lambda's own name excluded). */
function names(e: RuleExpr, bound: Set<string> = new Set(), out: Set<string> = new Set()): Set<string> {
  const go = (x: RuleExpr) => names(x, bound, out);
  switch (e.k) {
    case "name": if (!bound.has(e.n)) out.add(e.n); break;
    case "field": case "un": case "len": case "is": go(e.e); break;
    case "index": go(e.e), go(e.i); break;
    case "bin": go(e.l), go(e.r); break;
    case "range": go(e.e), go(e.lo), go(e.hi); break;
    case "quant": go(e.xs), names(e.body, new Set(bound).add(e.v), out); break;
  }
  return out;
}

/** The arguments by parameter name: a rest parameter takes the remaining ones as a list, a missing one is undefined. */
const bind = (fn: ArcFn, args: Json[]): Record<string, Json> =>
  Object.fromEntries(fn.params.map((p, i) => [p.name, p.rest ? args.slice(i) : i < args.length ? args[i]! : "$undefined"]));

/** Every rule of `fn` on these calls. held: the calls it was true on. broken: the first call it was false on (or could not
 *  be evaluated on: then `error` says why). error alone: the rule does not parse or names something unknown. A rule that
 *  reads `result` skips the calls that threw, unless it also reads `threw`. */
export function checkRules(fn: ArcFn, types: ArcType[], runs: { args: Json[]; result?: Json; after?: Json[]; threw: boolean }[]): { rule: string; held: number; broken?: { args: Json[]; result?: Json; after?: Json[] }; error?: string }[] {
  const named = Object.fromEntries(types.map((t) => [t.name, t.type]));
  const known = new Set([...fn.params.map((p) => p.name), "result", "threw", "after", "old"]);
  return fn.rules.map((r) => {
    const ast = parseRule(r.text);
    if ("error" in ast) return { rule: r.name, held: 0, error: `cannot parse: ${ast.error} at column ${ast.column}` };
    const free = names(ast);
    const unknown = [...free].filter((n) => !known.has(n));
    if (unknown.length) return { rule: r.name, held: 0, error: `unknown name ${unknown.join(", ")} (known: ${[...known].join(", ")})` };
    let held = 0;
    for (const run of runs) {
      if (run.threw && free.has("result") && !free.has("threw")) continue;
      const got = checkRule(ast, { params: bind(fn, run.args), ...(run.after ? { after: bind(fn, run.after) } : {}), ...(run.threw ? {} : { result: run.result ?? "$undefined" }), threw: run.threw, types: named });
      if (got === true) { held++; continue; }
      const broken = { args: run.args, ...(run.threw ? {} : { result: run.result ?? "$undefined" }), ...(run.after ? { after: run.after } : {}) };
      return { rule: r.name, held, broken, ...(got === false ? {} : { error: `cannot evaluate: ${got.error}` }) };
    }
    return { rule: r.name, held };
  });
}
