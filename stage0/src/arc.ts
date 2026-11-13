// The `.arc` spec language, v0: one module per file, types, functions with intent, examples and rules. Language-neutral:
// nothing here knows TypeScript. printArc(parseArc(x)) === x for any text printArc produced.
//
//   module survival from "src/survival.js"
//     "Hunger, thirst and health."
//
//   type Stats = { water: Num, food: Num }
//
//   fn survivalTick(stats: Stats, env: Weather, opts?: TickOpts): Tick
//     "Drains water and food by effort."
//     example ({water: 50, food: 50}, {temperature: 20}) => {cold: 0}
//     example (null, null) throws "stats"
//     rule bounded: after.stats in Stats
//
// Types are kept as text. Built-ins: Int Float Num Bool Str Any Void Null, `[T]`, `{ k: T, k?: T }`, `A | B`, `T?`, literals,
// names of `type` declarations, and a backticked native type (`Map<string, number>`) for what v0 has no spelling for.
// ponytail: types and rule predicates are not parsed further here; the checker that needs their structure parses them.

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface ArcParam { name: string; type: string; optional?: boolean; rest?: boolean }
/** `throws`: true for any error, a string that must appear in the message. */
export interface ArcExample { args: Json[]; expected?: Json; throws?: string | true; name?: string }
export interface ArcRule { name: string; text: string }
export interface ArcFn { name: string; params: ArcParam[]; returns: string; async?: boolean; hold?: boolean; intent: string[]; examples: ArcExample[]; rules: ArcRule[] }
export interface ArcType { name: string; type: string }
export interface ArcModule { name: string; file: string; intent: string[]; types: ArcType[]; fns: ArcFn[] }

const IDENT = /^[A-Za-z_$][\w$]*$/;

// ── values: JSON, with object keys unquoted when they are identifiers ──
export function printValue(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(printValue).join(", ")}]`;
  if (v !== null && typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${IDENT.test(k) ? k : JSON.stringify(k)}: ${printValue(x)}`).join(", ")}}`;
  return JSON.stringify(v);
}

class Cursor {
  i = 0;
  readonly s: string;
  constructor(s: string) { this.s = s; }
  ws(): void { while (this.s[this.i] === " ") this.i++; }
  eat(t: string): boolean { this.ws(); if (!this.s.startsWith(t, this.i)) return false; this.i += t.length; return true; }
  need(t: string): void { if (!this.eat(t)) throw new Error(`expected ${JSON.stringify(t)} at column ${this.i + 1}`); }
  rest(): string { return this.s.slice(this.i); }
  string(): string {
    this.ws();
    const m = /^"(?:[^"\\]|\\.)*"/.exec(this.rest());
    if (!m) throw new Error(`expected a string at column ${this.i + 1}`);
    this.i += m[0].length;
    return JSON.parse(m[0]) as string;
  }
  value(): Json {
    this.ws();
    const c = this.s[this.i];
    if (c === '"') return this.string();
    if (c === "[") {
      this.i++;
      const out: Json[] = [];
      if (this.eat("]")) return out;
      do out.push(this.value()); while (this.eat(","));
      this.need("]");
      return out;
    }
    if (c === "{") {
      this.i++;
      const out: Record<string, Json> = Object.create(null) as Record<string, Json>;
      if (!this.eat("}")) {
        do {
          this.ws();
          const id = /^[A-Za-z_$][\w$]*/.exec(this.rest());
          const key = id ? ((this.i += id[0].length), id[0]) : this.string();
          this.need(":");
          out[key] = this.value();
        } while (this.eat(","));
        this.need("}");
      }
      return { ...out };
    }
    const m = /^(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|true|false|null)/.exec(this.rest());
    if (!m) throw new Error(`expected a value at column ${this.i + 1}`);
    this.i += m[0].length;
    return JSON.parse(m[0]) as Json;
  }
}

// ── signatures ──
const printParam = (p: ArcParam) => `${p.rest ? "..." : ""}${p.name}${p.optional ? "?" : ""}: ${p.type}`;
export const printSignature = (f: Pick<ArcFn, "name" | "params" | "returns">) => `${f.name}(${f.params.map(printParam).join(", ")}): ${f.returns}`;

/** Split at top-level `sep`: brackets, strings and backticked native types keep their commas. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0, from = 0, quote = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; }
    else if (c === '"' || c === "`") quote = c;
    else if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c)) depth--;
    else if (c === sep && depth === 0) { out.push(s.slice(from, i)); from = i + 1; }
  }
  out.push(s.slice(from));
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Index of the `)` that closes the `(` at `open`. */
function closing(s: string, open: number): number {
  let depth = 0, quote = "";
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; }
    else if (c === '"' || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  throw new Error("unclosed (");
}

function parseSignature(text: string): Pick<ArcFn, "name" | "params" | "returns"> {
  const open = text.indexOf("(");
  const name = text.slice(0, open).trim();
  if (open < 0 || !IDENT.test(name)) throw new Error("expected name(params): Type");
  const close = closing(text, open);
  const ret = /^\s*:\s*(\S.*)$/.exec(text.slice(close + 1));
  if (!ret) throw new Error("expected `: Type` after the parameters");
  const params = splitTop(text.slice(open + 1, close), ",").map((p): ArcParam => {
    const m = /^(\.\.\.)?([A-Za-z_$][\w$]*)(\?)?\s*:\s*(\S.*)$/.exec(p);
    if (!m) throw new Error(`bad parameter ${JSON.stringify(p)}`);
    return { name: m[2]!, type: m[4]!, ...(m[3] ? { optional: true } : {}), ...(m[1] ? { rest: true } : {}) };
  });
  return { name, params, returns: ret[1]!.trim() };
}

// ── modules ──
export function printArc(m: ArcModule): string {
  const out = [`module ${m.name} from ${JSON.stringify(m.file)}`, ...m.intent.map((l) => `  ${JSON.stringify(l)}`)];
  for (const t of m.types) out.push("", `type ${t.name} = ${t.type}`);
  for (const f of m.fns) {
    out.push("", `${f.async ? "async " : ""}fn ${printSignature(f)}`, ...f.intent.map((l) => `  ${JSON.stringify(l)}`));
    if (f.hold) out.push("  hold");
    for (const e of f.examples) {
      const tail = e.throws !== undefined ? ` throws${e.throws === true ? "" : ` ${JSON.stringify(e.throws)}`}` : ` => ${printValue(e.expected ?? null)}`;
      out.push(`  example (${e.args.map(printValue).join(", ")})${tail}${e.name ? ` # ${e.name}` : ""}`);
    }
    for (const r of f.rules) out.push(`  rule ${r.name}: ${r.text}`);
  }
  return out.join("\n") + "\n";
}

function parseExample(text: string): ArcExample {
  const c = new Cursor(text);
  c.need("(");
  const args: Json[] = [];
  if (!c.eat(")")) {
    do args.push(c.value()); while (c.eat(","));
    c.need(")");
  }
  const ex: ArcExample = { args };
  if (c.eat("=>")) ex.expected = c.value();
  else if (c.eat("throws")) { c.ws(); ex.throws = c.rest().startsWith('"') ? c.string() : true; }
  else throw new Error("expected => or throws");
  c.ws();
  const tail = c.rest();
  if (tail.startsWith("#")) ex.name = tail.slice(1).trim();
  else if (tail) throw new Error(`unexpected ${JSON.stringify(tail)}`);
  return ex;
}

/** Parse one `.arc` file. Errors carry the 1-based line: `line 7: expected => or throws`. */
export function parseArc(text: string): ArcModule {
  let mod: ArcModule | null = null, fn: ArcFn | null = null;
  for (const [n, raw] of text.replaceAll("\r\n", "\n").split("\n").entries()) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    try {
      const body = line.startsWith("  ") ? line.trim() : null;
      if (body === null) {
        fn = null;
        let m: RegExpExecArray | null;
        if ((m = /^module\s+([\w$.-]+)\s+from\s+(".*")$/.exec(line))) {
          if (mod) throw new Error("a file holds one module");
          mod = { name: m[1]!, file: JSON.parse(m[2]!) as string, intent: [], types: [], fns: [] };
        } else if (!mod) throw new Error('a file starts with `module <name> from "<file>"`');
        else if ((m = /^type\s+([A-Za-z_$][\w$]*)\s*=\s*(\S.*)$/.exec(line))) mod.types.push({ name: m[1]!, type: m[2]! });
        else if ((m = /^(async\s+)?fn\s+(.*)$/.exec(line))) mod.fns.push((fn = { ...parseSignature(m[2]!), ...(m[1] ? { async: true } : {}), intent: [], examples: [], rules: [] }));
        else throw new Error("expected module, type or fn");
        continue;
      }
      if (!mod) throw new Error('a file starts with `module <name> from "<file>"`');
      if (body.startsWith('"')) {
        const c = new Cursor(body);
        const s = c.string();
        if (c.rest().trim()) throw new Error("text after the string");
        (fn ?? mod).intent.push(s);
      } else if (!fn) throw new Error("only intent strings belong under module");
      else if (body === "hold") fn.hold = true;
      else if (body.startsWith("example")) fn.examples.push(parseExample(body.slice("example".length)));
      else {
        const m = /^rule\s+([\w$-]+)\s*:\s*(\S.*)$/.exec(body);
        if (!m) throw new Error("expected an intent string, example, rule or hold");
        fn.rules.push({ name: m[1]!, text: m[2]! });
      }
    } catch (e) {
      throw new Error(`line ${n + 1}: ${(e as Error).message}`);
    }
  }
  if (!mod) throw new Error('line 1: a file starts with `module <name> from "<file>"`');
  return mod;
}
