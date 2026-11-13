// `openarc decompile` on classes, methods and generics, and on CommonJS `.js` files in a package with no "type" field.
// The `.arc` method forms round-trip; a decompile and a `--check` run end to end on temp projects.
// Run: node --no-warnings tests/classes.check.ts
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArc, printArc, type ArcExample, type ArcModule } from "../src/arc.ts";

// ── pure: every method form prints and parses back
{
  const m: ArcModule = {
    name: "inventory", file: "src/inventory.ts", intent: [], types: [{ name: "Inventory", type: "{ capacity: Num }" }],
    fns: [
      { name: "Inventory.add", params: [{ name: "item", type: "Str" }, { name: "count", type: "Int", optional: true }], returns: "Int", intent: ["Adds."], rules: [],
        examples: [{ receiver: [10], args: ["apple", 2], expected: 2, name: "two" }, { receiver: [], args: [{ n: 1 }], expected: "$undefined", after: [{ n: 2 }] }, { receiver: [1, "x"], args: [], throws: "full" }, { receiver: [10], args: ["a"], expected: 1, observed: true }, { receiver: [], args: [], throws: true, observed: true }] },
      { name: "Inventory.fromJSON", static: true, params: [{ name: "data", type: "Any" }], returns: "Inventory", intent: [], rules: [], examples: [{ args: [{ capacity: 1 }], expected: { capacity: 1 }, observed: true }] },
      { name: "Inventory.load", async: true, params: [], returns: "Str", intent: [], rules: [], examples: [] },
      { name: "Inventory.open", async: true, static: true, params: [], returns: "Inventory", intent: [], rules: [], examples: [] },
      { name: "first", params: [{ name: "xs", type: "[Any]" }], returns: "Any", intent: [], rules: [], examples: [] },
    ],
  };
  const text = printArc(m);
  assert.deepStrictEqual(parseArc(text), m);
  assert.strictEqual(printArc(parseArc(text)), text);
  for (const line of ["fn Inventory.add(item: Str, count?: Int): Int", '  example new (10) . ("apple", 2) => 2 # two', '  example new () . ({n: 1}) => "$undefined" after ({n: 2})', '  example new (1, "x") . () throws "full"',
    '  observed new (10) . ("a") => 1', "  observed new () . () throws", "fn static Inventory.fromJSON(data: Any): Inventory", "async fn Inventory.load(): Str", "async fn static Inventory.open(): Inventory"])
    assert.ok(text.includes(`${line}\n`), line);
  assert.throws(() => parseArc('module a from "a.ts"\n\nfn static f(): Num\n'), /line 3: `static` belongs to a method/);
  assert.throws(() => parseArc('module a from "a.ts"\n\nfn A.b.c(): Num\n'), /line 3: expected name\(params\)/);
  assert.throws(() => parseArc('module a from "a.ts"\n\nfn A.b(): Num\n  example new (1) (2) => 3\n'), /line 4: expected "\."/);
}

if (process.platform === "win32") {
  console.log("classes.check ok (pure checks only on Windows)");
  process.exit(0);
}
const MAIN = resolve("src/main.ts");
type State = { modules: Record<string, { fns: Record<string, { status: string; tests: string[]; why?: string; origins?: Record<string, string> }>; skipped: Record<string, string> }> };
const project = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(resolve(".."), ".classes-check-"));
  for (const [f, t] of Object.entries(files)) (mkdirSync(dirname(join(dir, f)), { recursive: true }), writeFileSync(join(dir, f), t));
  return {
    dir,
    oa: (...args: string[]) => { const r = spawnSync(process.execPath, ["--no-warnings", MAIN, ...args], { cwd: dir, encoding: "utf8" }); return { code: r.status, out: r.stdout + r.stderr }; },
    read: (f: string) => readFileSync(join(dir, f), "utf8"),
    write: (f: string, t: string) => writeFileSync(join(dir, f), t),
  };
};
const obs = (...es: ArcExample[]) => es.map((e) => ({ ...e, observed: true }));

// ── CommonJS `.js` in a package with no "type": every export shape is found, run, and recorded through require()
{
  const p = project({
    "package.json": '{"name":"cjs","version":"1.0.0","private":true}',
    "src/shorthand.js": "function inc(n) { return n + 1; }\nfunction dec(n) { return n - 1; }\nmodule.exports = { inc, dec };\n",
    "src/whole.js": "// Doubles.\nmodule.exports = function double(n) { return n * 2; };\n",
    "src/assigned.js": "exports.neg = function (n) { return -n; };\nmodule.exports.sq = (n) => n * n;\n",
    "src/literal.js": "module.exports = {\n  // Halves.\n  half(n) { return n / 2; },\n  third: function (n) { return n / 3; },\n};\n",
    "src/runtime.js": "function total(items) { return items.reduce((s, i) => s + i.price, 0); }\nmodule.exports = { total };\n",
    "tests/all.test.js": `const test = require("node:test");
const assert = require("node:assert");
const { inc, dec } = require("../src/shorthand.js");
const double = require("../src/whole.js");
const { neg, sq } = require("../src/assigned.js");
const { half, third } = require("../src/literal.js");
const { total } = require("../src/runtime.js");
const cart = (n) => Array.from({ length: n }, (_, i) => ({ price: i + 1 }));
test("all", () => {
  assert.strictEqual(inc(1), 2);
  assert.strictEqual(dec(5), 4);
  assert.strictEqual(double(3), 6);
  assert.strictEqual(neg(4), -4);
  assert.strictEqual(sq(3), 9);
  assert.strictEqual(half(8), 4);
  assert.strictEqual(third(9), 3);
  assert.strictEqual(total(cart(2)), 3);
});
`,
  });
  try {
    const r = p.oa("decompile", "--run-tests");
    assert.strictEqual(r.code, 0, r.out);
    const fns = (m: string) => parseArc(p.read(`arc/spec/${m}.arc`)).fns.map((f) => [f.name, f.intent, f.examples]);
    assert.deepStrictEqual(fns("shorthand"), [["inc", [], obs({ args: [1], expected: 2 })], ["dec", [], obs({ args: [5], expected: 4 })]]);
    assert.deepStrictEqual(fns("whole"), [["default", ["Doubles."], obs({ args: [3], expected: 6 })]]);
    assert.deepStrictEqual(fns("assigned"), [["neg", [], obs({ args: [4], expected: -4 })], ["sq", [], obs({ args: [3], expected: 9 })]]);
    assert.deepStrictEqual(fns("literal"), [["half", ["Halves."], obs({ args: [8], expected: 4 })], ["third", [], obs({ args: [9], expected: 3 })]]);
    // built at run time, so only recording through the test's require() gives it an input
    assert.deepStrictEqual(fns("runtime"), [["total", [], obs({ args: [[{ price: 1 }, { price: 2 }]], expected: 3 })]]);
    const s = JSON.parse(p.read(".openarc/decompile.json")) as State;
    assert.deepStrictEqual(s.modules["src/runtime.js"]!.fns.total!.origins, { '[[{"price":1},{"price":2}]]': "recorded tests/all.test.js" });
    assert.deepStrictEqual(s.modules["src/whole.js"]!.fns.default!.tests, ["tests/all.test.js"]);
    assert.match(r.out, /decompiled 5 modules: tested 8, failing 0,/);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
}

// ── classes: methods with receivers, statics, private members, a getter, a generic, a class nobody constructs
{
  const inventory = `/** A bounded stock of items. */
export class Inventory {
  capacity: number;
  label?: string;
  readonly counts: Record<string, number> = {};
  #secret = 1;
  private hidden = 0;
  _internal = 2;
  constructor(capacity: number) { this.capacity = capacity; }
  /** Adds count of item; returns the stock's new total. */
  add(item: string, count = 1): number {
    this.counts[item] = (this.counts[item] ?? 0) + count;
    return this.total();
  }
  total(): number { return Object.values(this.counts).reduce((a, b) => a + b, 0); }
  get full(): boolean { return this.total() >= this.capacity; }
  private drop(): void {}
  protected keep(): void {}
  _reset(): void {}
  #wipe(): void {}
  static fromJSON(data: { capacity: number }): Inventory { return new Inventory(data.capacity); }
  static async load(n: number): Promise<number> { return n; }
  // The first of a list.
  pick<T>(xs: T[]): T | undefined { return xs[0]; }
}

export class Big extends Inventory {
  grow(): number { return this.capacity * 2; }
}

export class Lonely {
  constructor(name: string, size: number) {}
  // Greets.
  hello(): string { return "hi"; }
}

export class Counter {
  n: number;
  constructor(start: number) { this.n = start; }
  inc(): number { return ++this.n; }
}

export class Free {
  // Always 7.
  seven(): number { return 7; }
}

export function first<T>(xs: T[]): T | undefined { return xs[0]; }
`;
  const p = project({
    "package.json": '{"name":"cls","version":"1.0.0","private":true,"type":"module"}',
    "src/inventory.ts": inventory,
    "src/use.ts": `import { Inventory, Big } from "./inventory.ts";
export function demo(): number {
  const inv = new Inventory(10);
  new Big(3);
  inv.pick([4, 5]);
  return inv.add("apple", 2);
}
`,
    "tests/counter.test.mjs": `import test from "node:test";
import assert from "node:assert";
import { Counter } from "../src/inventory.ts";
test("counter", () => {
  const c = new Counter(Number("5"));
  assert.strictEqual(c.inc(), 6);
});
`,
  });
  try {
    let r = p.oa("decompile", "--run-tests");
    assert.strictEqual(r.code, 0, r.out);
    const text = p.read("arc/spec/inventory.arc");
    assert.strictEqual(printArc(parseArc(text)), text);
    assert.strictEqual(p.read("src/inventory.ts"), inventory, "decompile changes no source");
    const arc = parseArc(text), fn = (name: string) => arc.fns.find((f) => f.name === name)!;
    // public data fields only; no private, protected, `#` or `_` member, no getter, no constructor; inherited methods
    // stay on the class that declares them
    assert.deepStrictEqual(arc.types, [{ name: "Inventory", type: "{ capacity: Num, label?: Str, counts: `Record<string, number>` }" }, { name: "Big", type: "{ capacity: Num, label?: Str, counts: `Record<string, number>` }" }, { name: "Counter", type: "{ n: Num }" }]);
    assert.deepStrictEqual(arc.fns.map((f) => f.name), ["Inventory.add", "Inventory.total", "Inventory.fromJSON", "Inventory.load", "Inventory.pick", "Big.grow", "Lonely.hello", "Counter.inc", "Free.seven", "first"]);
    const s = (JSON.parse(p.read(".openarc/decompile.json")) as State).modules["src/inventory.ts"]!;
    assert.deepStrictEqual(s.skipped, { "Inventory.full": "a getter or setter (not read yet)" });
    // an instance method runs on a fresh receiver built from a `new` call found in the code; the receiver's state shows
    // through the return value
    const add = fn("Inventory.add");
    assert.deepStrictEqual([add.intent, add.params, add.returns, add.static], [["Adds count of item; returns the stock's new total."], [{ name: "item", type: "Str" }, { name: "count", type: "Num", optional: true }], "Num", undefined]);
    assert.ok(text.includes('  observed new (10) . ("apple", 2) => 2\n'), text);
    assert.strictEqual(s.fns["Inventory.add"]!.origins!['[[10],"apple",2]'], "call src/use.ts:6");
    assert.deepStrictEqual(fn("Inventory.total").examples, obs({ receiver: [10], args: [], expected: 0 }));
    // static methods run like functions
    assert.deepStrictEqual([fn("Inventory.fromJSON").static, fn("Inventory.fromJSON").returns, fn("Inventory.fromJSON").examples[0]!.receiver], [true, "Inventory", undefined]);
    assert.ok(text.includes("async fn static Inventory.load(n: Num): Num\n  observed (0) => 0\n"), text);
    // generics are erased to Any, not skipped
    assert.deepStrictEqual([fn("first").params, fn("first").returns], [[{ name: "xs", type: "[Any]" }], "Any"]);
    assert.deepStrictEqual([fn("Inventory.pick").intent, fn("Inventory.pick").examples], [["The first of a list."], obs({ receiver: [10], args: [[4, 5]], expected: 4 })]);
    assert.deepStrictEqual(fn("Big.grow").examples, obs({ receiver: [3], args: [], expected: 6 }));
    // the constructor's arguments recorded from a test (`Number("5")` is no literal), and a constructor that needs none.
    // The origin names where the method's arguments came from, not the receiver's
    assert.deepStrictEqual([fn("Counter.inc").examples, s.fns["Counter.inc"]!.origins], [obs({ receiver: [5], args: [], expected: 6 }), { "[[5]]": "call tests/counter.test.mjs:6" }]);
    assert.deepStrictEqual(fn("Free.seven").examples, obs({ receiver: [], args: [], expected: 7 }));
    // nobody constructs it: listed, with why
    assert.deepStrictEqual([fn("Lonely.hello").intent, fn("Lonely.hello").examples, s.fns["Lonely.hello"]!.status, s.fns["Lonely.hello"]!.why], [["Greets."], [], "described", "no way to construct Lonely found"]);

    // --check re-runs the method forms: unchanged passes, a changed method is reported as the call that differs
    r = p.oa("decompile", "--check");
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /^checked 11 functions: preserved \d+, changed 0, failing 0, unrunnable 0, removed 0, new 0\n$/);
    p.write("src/inventory.ts", inventory.replace("return this.total();", "return this.total() + 1;"));
    r = p.oa("decompile", "--check");
    assert.strictEqual(r.code, 1, r.out);
    assert.ok(r.out.includes('src/inventory.ts: new Inventory(10).add("apple", 2) changed: was 2, now 3\n'), r.out);
    const report = JSON.parse(p.oa("decompile", "--check", "--json").out) as { items: { fn: string; kind: string; receiver?: unknown }[] };
    assert.ok(report.items.some((i) => i.fn === "Inventory.add" && i.kind === "changed" && JSON.stringify(i.receiver) === "[10]"), JSON.stringify(report));
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
}
console.log("classes.check ok");
