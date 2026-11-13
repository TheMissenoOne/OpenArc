// The `.arc` language round trip, and `openarc decompile` end to end on a plain JavaScript project: no tsconfig, no
// types, a node:test file, and the arguments its tests pass recorded as inputs. Nothing in the project's code may change.
// Run: node --no-warnings tests/decompile.check.ts
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { parseArc, printArc, printExample, printValue, type ArcExample, type ArcModule } from "../src/arc.ts";
import { instrument } from "../src/decompile.ts";

// ── pure: print and parse are inverses, values keep their shape, errors name the line
{
  const m: ArcModule = {
    name: "a.b", file: "src/a/b.js", intent: ["Module line."],
    types: [{ name: "Stats", type: "{ water: Num, food?: Num }" }],
    fns: [
      { name: "tick", params: [{ name: "stats", type: "Stats" }, { name: "opts", type: "{ fast: Bool }", optional: true }, { name: "rest", type: "[`Map<string, number>`]", rest: true }], returns: "Stats | Null", intent: ['Says "hi".', "Second line."], hold: true,
        examples: [{ args: [{ water: 1, "odd key": [true, null, -2.5e3] }, "a, b) => #"], expected: { ok: "x" }, name: "named # one" }, { args: [], throws: "bad" }, { args: [1], throws: true }, { args: [{ water: 1 }, 2], expected: "$undefined", after: [{ water: 3 }, 2], name: "mutates" }, { args: [7], expected: 8, observed: true }, { args: [{ water: 1 }, 2], expected: 3, after: [{ water: 0 }, 2], observed: true, name: "seen" }, { args: [null], throws: "stats", observed: true }], rules: [{ name: "bounded", text: "result.water in 0..100" }] },
      { name: "load", params: [], returns: "Str", async: true, intent: [], examples: [], rules: [] },
    ],
  };
  const text = printArc(m);
  assert.deepStrictEqual(parseArc(text), m);
  assert.strictEqual(printArc(parseArc(text)), text);
  assert.strictEqual(printValue({ a: 1, "b c": ["x"] }), '{a: 1, "b c": ["x"]}');
  assert.throws(() => parseArc(text.replace(") throws\n", ") gives\n")), /^Error: line \d+: expected => or throws/);
  assert.throws(() => parseArc("fn f(): Num\n"), /line 1: a file starts with/);
  assert.ok(text.includes('  example ({water: 1}, 2) => "$undefined" after ({water: 3}, 2) # mutates\n  observed (7) => 8\n  observed ({water: 1}, 2) => 3 after ({water: 0}, 2) # seen\n  observed (null) throws "stats"\n  rule bounded'));
  // canonical order: an observation written before an example prints after it
  const loose = 'module a from "a.js"\n\nfn f(x: Num): Num\n  rule r: result > 0\n  observed (1) => 2\n  example (2) => 4\n  "Doubles."\n';
  assert.strictEqual(printArc(parseArc(loose)), 'module a from "a.js"\n\nfn f(x: Num): Num\n  "Doubles."\n  example (2) => 4\n  observed (1) => 2\n  rule r: result > 0\n');
  // the `>` of an unquoted `=>` is no bracket: the parameters after a function type still split
  const arrow = 'module a from "a.js"\n\nfn each(cb: (x: Num) => Void, n: Int, m: [Int]): Void\n';
  assert.deepStrictEqual(parseArc(arrow).fns[0]!.params, [{ name: "cb", type: "(x: Num) => Void" }, { name: "n", type: "Int" }, { name: "m", type: "[Int]" }]);
  assert.strictEqual(printArc(parseArc(arrow)), arrow);
  assert.deepStrictEqual(parseArc('module a from "a.js"\n\nfn f(a: `x >> y`, b: Num>, c: Int): Void\n').fns[0]!.params.map((p) => p.name), ["a", "b", "c"]);
}

// ── pure: the instrumenter adds one recorder call per function, on the line it starts, and changes nothing else
{
  const src = `"use strict";
export function a(x, y) {
  "use strict";
  return x + (y ?? 2);
}
export default function (s) { return s; }
export async function b(o, step = 1) { o.n += step; return o.n; }
export function* g(n) { yield n; }
export const c = (p, q) => ({ p, q });
export const d = async (p) => p;
export const e = function (z) { return z; };
export const f = ({ k }) => k;
export const h = (...r) => r.length;
export const i = (m) => {
  return m;
};
`;
  const sf = ts.createSourceFile("m.js", src, ts.ScriptTarget.ESNext, true);
  const targets = sf.statements.flatMap((st): { name: string; node: ts.FunctionLikeDeclaration }[] => ts.isFunctionDeclaration(st) ? [{ name: st.name?.text ?? "default", node: st }]
    : ts.isVariableStatement(st) ? st.declarationList.declarations.map((v) => ({ name: (v.name as ts.Identifier).text, node: v.initializer as ts.ArrowFunction }))
    : []);
  const out = instrument(sf, "src/m.js", targets);
  const rec = (name: string, args: string) => `globalThis.__openarcRecord?.("src/m.js", "${name}", ${args})`;
  assert.strictEqual(out.split("\n").length, src.split("\n").length);
  assert.ok(out.includes(`export function a(x, y) {\n  "use strict"; ${rec("a", "arguments")};\n`), out);
  assert.ok(out.includes(`export default function (s) { ${rec("default", "arguments")}; return s; }\n`), out);
  assert.ok(out.includes(`export const c = (p, q) => (${rec("c", "[p, q]")}, ({ p, q }));\n`), out);
  assert.ok(out.includes(`export const i = (m) => { ${rec("i", "[m]")};\n  return m;\n};\n`), out);
  // a destructured or rest parameter: not instrumented
  assert.ok(out.includes("export const f = ({ k }) => k;\nexport const h = (...r) => r.length;\n"), out);
  assert.strictEqual(instrument(sf, "src/m.js", []), src);
  // the instrumented module runs as before, with or without a recorder, and hands over the arguments as they were at the call
  const calls: [string, unknown][] = [];
  const g = globalThis as { __openarcRecord?: (file: string, name: string, args: ArrayLike<unknown>) => void };
  type M = Record<string, (...a: unknown[]) => unknown>;
  for (const withRecorder of [true, false]) {
    if (withRecorder) g.__openarcRecord = (_file, name, args) => calls.push([name, JSON.parse(JSON.stringify(Array.from(args)))]);
    else delete g.__openarcRecord;
    const m = (await import(`data:text/javascript,${encodeURIComponent(out + (withRecorder ? "" : "\n"))}`)) as M;
    const o = { n: 1 };
    assert.deepStrictEqual([m.a!(1), m.default!("s"), await m.b!(o), o, [...(m.g!(5) as Iterable<number>)], m.c!(1, 2), await m.d!(3), m.e!(4), m.f!({ k: 6 }), m.h!(1, 2), m.i!(7)],
      [3, "s", 2, { n: 2 }, [5], { p: 1, q: 2 }, 3, 4, 6, 2, 7]);
  }
  assert.deepStrictEqual(calls, [["a", [1]], ["default", ["s"]], ["b", [{ n: 1 }]], ["g", [5]], ["c", [1, 2]], ["d", [3]], ["e", [4]], ["i", [7]]]);
}

if (process.platform === "win32") {
  console.log("decompile.check ok (pure checks only on Windows)");
  process.exit(0);
}
const MAIN = resolve("src/main.ts");
const dir = mkdtempSync(join(resolve(".."), ".decompile-check-"));
const oa = (...args: string[]) => {
  const r = spawnSync(process.execPath, ["--no-warnings", MAIN, ...args], { cwd: dir, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
};
const write = (f: string, t: string) => (mkdirSync(dirname(join(dir, f)), { recursive: true }), writeFileSync(join(dir, f), t));
const read = (f: string) => readFileSync(join(dir, f), "utf8");
try {
  // no node_modules: the project installs nothing, and the sandbox runs the compiler's own harness
  write("package.json", '{"name":"plain","version":"1.0.0","private":true}');
  write("src/survival.js", `const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Drains water by effort. Never leaves 0..100.
export function drain(stats, effort = 1) {
  return { water: clamp(stats.water - 10 * effort, 0, 100) };
}

/** Adds two numbers.
 *  @param {number} a
 *  @param {number} b */
export const add = (a, b) => a + b;

export function label(rain) {
  return rain > 0.6 ? 'heavy rain' : 'clear';
}

export function broken(n) {
  return n + 1; // the test below expects n * 2
}

// Spends water in place and returns what is left.
export function sip(stats, amount) {
  stats.water = clamp(stats.water - amount, 0, 100);
  return stats.water;
}

export function reset(stats) { stats.water = 100; }

export const LIMIT = 100;
`);
  write("src/deep/screen.js", `export function resize(width = 10) {
  return document.body.clientWidth - width;
}
export async function later(ms = 0) { return "done"; }
export function untouched(thing) { return thing; }
`);
  write("tests/survival.test.mjs", `import test from "node:test";
import assert from "node:assert";
import { drain, label, sip, reset } from "../src/survival.js";

const thirsty = { water: 5 };
test("drain", () => {
  assert.deepStrictEqual(drain({ water: 50 }), { water: 40 });
  assert.deepStrictEqual(drain(thirsty, 2), { water: 0 });
  assert.strictEqual(label(0.9), "heavy rain");
  assert.strictEqual(label(0), "clear");
  assert.strictEqual(sip({ water: 50 }, 5), 45);
  const flask = { water: 3 };
  reset(flask);
  assert.deepStrictEqual(flask, { water: 100 });
});
`);
  write("tests/broken.test.mjs", `import test from "node:test";
import assert from "node:assert";
import { broken } from "../src/survival.js";
test("broken", () => assert.strictEqual(broken(3), 6));
`);
  // values the tests build at run time: no literal to copy, so only recording gives these functions inputs
  write("src/runtime.js", `// Sums the prices.
export function total(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}

// Counts one more, in place.
export function bump(counter) { counter.n += 1; return counter.n; }

// Doubles.
export const twice = (n) => n * 2;

// Greets.
export async function greet(name) { return "hi " + name; }

// Applies f to x.
export function apply(f, x) { return f(x); }
`);
  write("tests/runtime.test.mjs", `import test from "node:test";
import assert from "node:assert";
import { total, bump, twice, greet, apply } from "../src/runtime.js";

const cart = (n) => Array.from({ length: n }, (_, i) => ({ price: i + 1 }));
test("runtime values", async () => {
  assert.strictEqual(total(cart(3)), 6);
  assert.strictEqual(total(cart(1)), 1);
  const counter = JSON.parse('{"n": 1}');
  assert.strictEqual(bump(counter), 2);
  assert.strictEqual(twice(cart(2).length), 4);
  assert.strictEqual(await greet(["a", "da"].join("")), "hi ada");
  assert.strictEqual(apply((x) => x + 1, cart(4).length), 5);
});
`);
  // passes only without the recorder: recording must not decide its outcome
  write("tests/probe.test.mjs", `import test from "node:test";
import assert from "node:assert";
import { twice } from "../src/runtime.js";
test("probe", () => {
  assert.strictEqual(twice(Number("21")), 42);
  assert.strictEqual(globalThis.__openarcRecord, undefined);
});
`);
  const sources = () => ["src/survival.js", "src/deep/screen.js", "src/runtime.js"].map(read).join("\0");
  const before = sources();

  let r = oa("decompile", "--run-tests");
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(sources(), before, "decompile changes no source");
  const arc = parseArc(read("arc/spec/survival.arc"));
  const fn = (name: string) => arc.fns.find((f) => f.name === name)!;
  const obs = (...es: ArcExample[]) => es.map((e) => ({ ...e, observed: true }));
  // everything decompile records is an observation: what the code did, not what it should do
  assert.deepStrictEqual([arc.name, arc.file, arc.fns.map((f) => f.name)], ["survival", "src/survival.js", ["drain", "add", "label", "broken", "sip", "reset"]]);
  // untyped JavaScript: the intent comes from the comment, the inputs from the literal calls in the test (also through a const)
  assert.deepStrictEqual(fn("drain").intent, ["Drains water by effort. Never leaves 0..100."]);
  assert.deepStrictEqual(fn("drain").params, [{ name: "stats", type: "Any" }, { name: "effort", type: "Num", optional: true }]);
  assert.deepStrictEqual(fn("drain").examples, obs({ args: [{ water: 50 }], expected: { water: 40 } }, { args: [{ water: 5 }, 2], expected: { water: 0 } }));
  assert.deepStrictEqual(fn("label").examples, obs({ args: [0.9], expected: "heavy rain" }, { args: [0], expected: "clear" }));
  // a function that changes its arguments records them as the call leaves them; one that returns nothing too
  assert.deepStrictEqual(fn("sip").examples, obs({ args: [{ water: 50 }, 5], expected: 45, after: [{ water: 45 }, 5] }));
  assert.deepStrictEqual(fn("reset").examples, obs({ args: [{ water: 3 }], expected: "$undefined", after: [{ water: 100 }] }));
  assert.ok(read("arc/spec/survival.arc").includes('  observed ({water: 50}, 5) => 45 after ({water: 45}, 5)\n'));
  assert.ok(read("arc/spec/survival.arc").includes('fn reset(stats: Any): Void\n  observed ({water: 3}) => "$undefined" after ({water: 100})\n'));
  // JSDoc types give inputs with no call to copy from
  assert.deepStrictEqual([fn("add").intent, fn("add").params.map((p) => p.type), fn("add").returns], [["Adds two numbers."], ["Num", "Num"], "Num"]);
  assert.ok(fn("add").examples.length >= 3 && fn("add").examples.every((e) => (e.args[0] as number) + (e.args[1] as number) === e.expected));
  type State = { modules: Record<string, { fns: Record<string, { status: string; tests: string[]; why?: string; origins?: Record<string, string> }> }> };
  const state = JSON.parse(read(".openarc/decompile.json")) as State;
  const s = state.modules["src/survival.js"]!.fns, d = state.modules["src/deep/screen.js"]!.fns;
  assert.deepStrictEqual([s.drain, s.label, s.add].map((f) => [f!.status, f!.tests]), [["tested", ["tests/survival.test.mjs"]], ["tested", ["tests/survival.test.mjs"]], ["observed", []]]);
  // where each observed input came from, in the state file only: a literal call (file:line) or the parameter types
  assert.deepStrictEqual(s.drain!.origins, { '[{"water":50}]': "call tests/survival.test.mjs:7", '[{"water":5},2]': "call tests/survival.test.mjs:8" });
  assert.ok(Object.keys(s.add!.origins!).length === fn("add").examples.length && Object.values(s.add!.origins!).every((o) => o === "types"));
  assert.ok(!read("arc/spec/survival.arc").includes("call tests"));
  // a function its own test fails is "failing", whatever examples its current behaviour gave, and the file is named
  assert.deepStrictEqual([s.broken!.status, s.broken!.tests, s.broken!.why], ["failing", ["tests/broken.test.mjs"], "tests/broken.test.mjs fails"]);
  // code that needs a browser is kept, with the reason; an async function's result is the awaited value
  assert.deepStrictEqual(d.resize, { status: "bare", tests: [], why: "every input throws: document is not defined" });
  assert.strictEqual(d.untouched!.why, "no inputs: the parameter types say too little and no call passes literals");
  const deep = parseArc(read("arc/spec/deep/screen.arc"));
  assert.deepStrictEqual([deep.name, deep.fns.find((f) => f.name === "later")!.async, deep.fns.find((f) => f.name === "later")!.examples], ["deep.screen", true, obs({ args: [], expected: "done" })]);
  assert.match(r.out, /decompiled 3 modules: tested 9, failing 1, specified 0, observed 2, described 0, bare 2, skipped 0\n/);
  // the arguments the tests passed at run time became inputs, recorded at the call (bump changes its argument after it)
  const rt = parseArc(read("arc/spec/runtime.arc")), rfn = (name: string) => rt.fns.find((f) => f.name === name)!;
  const rs = (JSON.parse(read(".openarc/decompile.json")) as State).modules["src/runtime.js"]!.fns;
  assert.deepStrictEqual(rfn("total").examples, obs({ args: [[{ price: 1 }, { price: 2 }, { price: 3 }]], expected: 6 }, { args: [[{ price: 1 }]], expected: 1 }));
  assert.deepStrictEqual(rs.total!.origins, { '[[{"price":1},{"price":2},{"price":3}]]': "recorded tests/runtime.test.mjs", '[[{"price":1}]]': "recorded tests/runtime.test.mjs" });
  assert.deepStrictEqual(rfn("bump").examples, obs({ args: [{ n: 1 }], expected: 2, after: [{ n: 2 }] }));
  assert.deepStrictEqual([rfn("greet").async, rfn("greet").examples], [true, obs({ args: ["ada"], expected: "hi ada" })]);
  // the expression-bodied arrow: recorded from runtime.test only, as probe.test fails under recording and passes without
  assert.deepStrictEqual([rfn("twice").examples, rs.twice!.origins, rs.twice!.status, rs.twice!.tests], [obs({ args: [2], expected: 4 }), { "[2]": "recorded tests/runtime.test.mjs" }, "tested", ["tests/probe.test.mjs", "tests/runtime.test.mjs"]]);
  assert.ok(r.out.includes("tests/probe.test.mjs: recording changed the outcome of this test file; its result without recording counts, and nothing recorded from it is used\n"), r.out);
  // a call with a function argument is not JSON: dropped
  assert.deepStrictEqual([rfn("apply").examples, rs.apply!.status, rs.apply!.why], [[], "tested", "no inputs: the parameter types say too little and no call passes literals"]);
  assert.ok(!existsSync(join(dir, ".openarc/recorded")), "the recording is removed after the run");
  assert.ok(read(".openarc/.gitignore").split("\n").includes("recorded/"));

  // what a person writes in the .arc file survives the next run. A new rule re-runs the module (an `example` or `rule`
  // line is part of the reuse key; this used to expect `(unchanged)`, which left the new rule unchecked)
  write("arc/spec/survival.arc", read("arc/spec/survival.arc").replace('fn label(rain: Any): "heavy rain" | "clear"\n', 'fn label(rain: Any): "heavy rain" | "clear"\n  "Names the weather from the rain level."\n').replace('  observed (0) => "clear"\n', '  observed (0) => "clear"\n  rule known: result in "heavy rain" | "clear"\n'));
  const kept = read("arc/spec/survival.arc");
  assert.ok(kept.includes("rule known"));
  assert.ok(kept.includes('  observed (0) => "clear"\n  rule known'));
  r = oa("decompile", "--run-tests");
  assert.match(r.out, /^src\/survival\.js: 6 functions$/m);
  const rerun = read("arc/spec/survival.arc"); // the observations re-recorded, the intent and rule as written
  assert.ok(rerun.includes('fn label(rain: Any): "heavy rain" | "clear"\n  "Names the weather from the rain level."\n') && rerun.includes('  observed (0) => "clear"\n  rule known'), rerun);
  // an intent edit alone is no reason to run again
  write("arc/spec/survival.arc", rerun.replace('  "Names the weather from the rain level."\n', '  "Names the weather."\n'));
  r = oa("decompile", "--run-tests");
  assert.match(r.out, /^src\/survival\.js: 6 functions \(unchanged\)$/m);
  write("arc/spec/survival.arc", rerun);
  r = oa("decompile", "--todo");
  assert.deepStrictEqual(r.out.trim().split("\n"), ["arc/spec/deep/screen.arc: resize", "arc/spec/deep/screen.arc: later", "arc/spec/deep/screen.arc: untouched", "arc/spec/survival.arc: broken", "arc/spec/survival.arc: reset"]);
  r = oa("decompile", "--report", "--json");
  assert.deepStrictEqual((JSON.parse(r.out) as { totals: unknown }).totals, { tested: 9, failing: 1, specified: 0, observed: 2, described: 0, bare: 2, skipped: 0 });
  assert.strictEqual(sources(), before);

  // promoting an observation is an edit: `observed` becomes `example`. It survives the next run and makes add `specified`
  const [req, other] = fn("add").examples as [ArcExample, ArcExample];
  const line = (e: ArcExample) => `  ${printExample(e)}\n`;
  write("arc/spec/survival.arc", read("arc/spec/survival.arc").replace(line(req), line({ ...req, observed: undefined })).replace(line(other), line({ ...other, name: "sum" })));
  const promoted = read("arc/spec/survival.arc");
  assert.ok(promoted.includes(`fn add(a: Num, b: Num): Num\n  "Adds two numbers."\n${line({ ...req, observed: undefined })}`));
  r = oa("decompile", "--run-tests");
  assert.strictEqual(r.code, 0, r.out);
  // the promotion re-runs the module: the example and the named line as written, the observations re-recorded
  const repromoted = read("arc/spec/survival.arc");
  assert.ok(repromoted.includes(`fn add(a: Num, b: Num): Num\n  "Adds two numbers."\n${line({ ...req, observed: undefined })}`) && repromoted.includes(line({ ...other, name: "sum" })), repromoted);
  assert.strictEqual(repromoted.replace(/\nfn add[^]*?\n\n/, ""), promoted.replace(/\nfn add[^]*?\n\n/, ""));
  const status = () => (JSON.parse(read(".openarc/decompile.json")) as State).modules["src/survival.js"]!.fns.add!;
  assert.strictEqual(status().status, "specified");
  assert.match(r.out, /specified 1, observed 1,/);
  // --check on an unchanged project: every line preserved, exit 0
  r = oa("decompile", "--check");
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /^src\/survival\.js: label: rule known: held on \d+ inputs\nchecked 14 functions: preserved \d+, changed 0, failing 0, unrunnable 0, removed 0, new 0\n$/);

  // the code changes behaviour: --check reports the changed observation and the failing example, and writes nothing
  write("src/survival.js", read("src/survival.js").replace("export const add = (a, b) => a + b;", "export const add = (a, b) => a + b + 1;"));
  const plus1 = (e: ArcExample) => printValue((e.expected as number) + 1);
  const changedLine = `src/survival.js: add(${other.args.map(printValue).join(", ")}) changed: was ${printValue(other.expected!)}, now ${plus1(other)}`;
  const failingWhy = `example (${req.args.map(printValue).join(", ")}) => ${printValue(req.expected!)}: the code returns ${plus1(req)}`;
  const snapshot = () => [read("arc/spec/survival.arc"), read("arc/spec/deep/screen.arc"), read(".openarc/decompile.json")].join("\0");
  const held = snapshot();
  r = oa("decompile", "--check");
  assert.strictEqual(r.code, 1, r.out);
  assert.ok(r.out.includes(`${changedLine}\n`), r.out);
  assert.ok(r.out.includes(`src/survival.js: add: ${failingWhy}\n`), r.out);
  assert.match(r.out, /checked 14 functions: preserved \d+, changed [1-9]\d*, failing 1, unrunnable 0, removed 0, new 0\n$/);
  r = oa("decompile", "--check", "--json");
  const report = JSON.parse(r.out) as { ok: boolean; summary: { failing: number }; items: { file: string; fn: string; kind: string; was?: string; now?: string; why?: string }[] };
  assert.strictEqual(report.ok, false);
  assert.ok(report.items.every((i) => (i.fn === "add" && (i.kind === "changed" || i.kind === "failing")) || (i.fn === "label" && i.kind === "held")));
  assert.deepStrictEqual(report.items.find((i) => i.kind === "failing"), { file: "src/survival.js", fn: "add", kind: "failing", args: req.args, was: printValue(req.expected!), now: plus1(req), why: failingWhy });
  assert.strictEqual(snapshot(), held, "--check writes nothing");

  // the next decompile re-records the observations (keeping a name), prints what changed, keeps the example as written,
  // and marks add failing with the reason
  r = oa("decompile", "--run-tests");
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.out.includes(`${changedLine}\n`), r.out);
  assert.match(r.out, /, changed [1-9]\d*\n/);
  const add = parseArc(read("arc/spec/survival.arc")).fns.find((f) => f.name === "add")!;
  const { observed: _, ...asWritten } = req;
  assert.deepStrictEqual(add.examples[0], asWritten);
  assert.strictEqual(add.examples.filter((e) => !e.observed).length, 1);
  assert.ok(add.examples.some((e) => e.observed && e.name === "sum" && printValue(e.expected!) === plus1(other)));
  assert.ok(read("arc/spec/survival.arc").includes(line({ ...req, observed: undefined })));
  assert.deepStrictEqual([status().status, status().why], ["failing", failingWhy]);
  // an unchanged rerun keeps it failing without running anything
  r = oa("decompile", "--run-tests");
  assert.match(r.out, /src\/survival\.js: 6 functions \(unchanged\)/);
  assert.deepStrictEqual([status().status, status().why], ["failing", failingWhy]);

  // a function the code no longer exports is `removed`, one the .arc file lacks is `new`
  write("src/survival.js", read("src/survival.js").replace("export function reset(stats)", "export function refill(stats)"));
  r = oa("decompile", "--check");
  assert.strictEqual(r.code, 1, r.out);
  assert.ok(r.out.includes("src/survival.js: reset removed: the code no longer exports it\n"), r.out);
  assert.ok(r.out.includes("src/survival.js: refill new: no entry in the .arc file\n"), r.out);
  assert.match(r.out, /failing 1, unrunnable 0, removed 1, new 1\n$/);

  // a state file from before `observed` (status `examples`, no origins) still loads
  const old = JSON.parse(read(".openarc/decompile.json")) as State;
  for (const m of Object.values(old.modules)) for (const f of Object.values(m.fns)) { if (f.status === "observed") f.status = "examples"; delete f.origins; }
  write(".openarc/decompile.json", JSON.stringify(old));
  r = oa("decompile", "--report");
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /src\/deep\/screen\.js: tested 0, failing 0, specified 0, observed 1, described 0, bare 2\n/);
  r = oa("decompile", "--run-tests");
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(sources(), before.replace("a + b;", "a + b + 1;").replace("function reset(", "function refill("));
  assert.deepStrictEqual(readdirSync(join(dir, "src")).sort(), ["deep", "runtime.js", "survival.js"]);
  assert.strictEqual(oa("decompile", "../x").code, 2);

  // --no-record: the old result, a function the tests call only with run-time values gets no inputs
  rmSync(join(dir, "arc/spec/runtime.arc"));
  r = oa("decompile", "--run-tests", "--no-record", "--fresh");
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!r.out.includes("recording changed"), r.out);
  const plainRun = (JSON.parse(read(".openarc/decompile.json")) as State).modules["src/runtime.js"]!.fns;
  assert.deepStrictEqual([parseArc(read("arc/spec/runtime.arc")).fns.find((f) => f.name === "total")!.examples, plainRun.total!.why], [[], "no inputs: the parameter types say too little and no call passes literals"]);
  assert.strictEqual(sources(), before.replace("a + b;", "a + b + 1;").replace("function reset(", "function refill("));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── more projects: how the dirs are spelled, what triggers a re-run, colliding module names, kept blocks, the state file
// across runs over different dirs, and a batch one bad input brings down
const project = () => {
  const root = mkdtempSync(join(resolve(".."), ".decompile-check-"));
  const run = (...args: string[]) => { const r = spawnSync(process.execPath, ["--no-warnings", MAIN, ...args], { cwd: root, encoding: "utf8" }); return { code: r.status, out: r.stdout + r.stderr }; };
  const put = (f: string, t: string) => (mkdirSync(dirname(join(root, f)), { recursive: true }), writeFileSync(join(root, f), t));
  const get = (f: string) => readFileSync(join(root, f), "utf8");
  type St = { modules: Record<string, { arc: string; fns: Record<string, { status: string; tests: string[]; why?: string }> }> };
  return { root, run, put, get, state: () => JSON.parse(get(".openarc/decompile.json")) as St };
};
const roots: string[] = [];
try {
  // `.`: a project with its code at the root, its test file beside it. Same paths as any other dir: no `./` prefix
  {
    const p = project();
    roots.push(p.root);
    p.put("package.json", '{"name":"flat","version":"1.0.0","private":true,"type":"module"}');
    p.put("util.js", "export function half(n) { return n / 2; }\n");
    p.put("util.test.js", 'import test from "node:test";\nimport assert from "node:assert";\nimport { half } from "./util.js";\ntest("h", () => assert.strictEqual(half(8), 4));\n');
    let r = p.run("decompile", ".");
    assert.strictEqual(r.code, 0, r.out);
    assert.strictEqual(p.get("arc/spec/util.arc"), 'module util from "util.js"\n\nfn half(n: Any): Num\n  observed (8) => 4\n');
    assert.deepStrictEqual(p.state().modules["util.js"]!.fns.half, { status: "observed", tests: ["util.test.js"], origins: { "[8]": "call util.test.js:4" } });
    r = p.run("decompile", "./");
    assert.match(r.out, /^util\.js: 1 functions \(unchanged\)$/m);
    // `./src/`, `src/` and `src` are one dir
    p.put("src/x.js", "export const one = () => 1;\n");
    r = p.run("decompile", "./src/");
    assert.match(r.out, /^src\/x\.js: 1 functions$/m);
    assert.match(p.run("decompile", "src/").out, /^src\/x\.js: 1 functions \(unchanged\)$/m);
    assert.match(p.run("decompile", "src").out, /^src\/x\.js: 1 functions \(unchanged\)$/m);
  }

  // the reuse key: an `example` or `rule` line written in the .arc file, and a file the module imports, re-run it
  {
    const p = project();
    roots.push(p.root);
    p.put("package.json", '{"name":"key","version":"1.0.0","private":true,"type":"module"}');
    p.put("src/k.js", "export const K = 2;\n");
    p.put("src/mid.js", 'import { K } from "./k.js";\nexport const k = () => K;\n');
    p.put("src/m.js", 'import { k } from "./mid.js";\n/** @param {number} n */\nexport const dbl = (n) => n * k();\n');
    assert.strictEqual(p.run("decompile").code, 0);
    const dbl = () => p.state().modules["src/m.js"]!.fns.dbl!;
    const spec = p.get("arc/spec/m.arc");
    assert.ok(spec.includes("  observed (1) => 2\n"), spec);
    // a wrong example is checked, not reused as "specified"
    p.put("arc/spec/m.arc", spec.replace("  observed (1) => 2\n", "  example (1) => 2\n  example (3) => 7\n"));
    let r = p.run("decompile");
    assert.match(r.out, /^src\/m\.js: 1 functions$/m);
    assert.deepStrictEqual([dbl().status, dbl().why], ["failing", "example (3) => 7: the code returns 6"]);
    assert.match(p.run("decompile").out, /^src\/m\.js: 1 functions \(unchanged\)$/m);
    // corrected, it is specified; a rule the code breaks makes it failing
    p.put("arc/spec/m.arc", p.get("arc/spec/m.arc").replace("example (3) => 7", "example (3) => 6"));
    p.run("decompile");
    assert.strictEqual(dbl().status, "specified");
    p.put("arc/spec/m.arc", p.get("arc/spec/m.arc") + "  rule big: result > 100\n");
    p.run("decompile");
    assert.strictEqual(dbl().status, "failing");
    assert.match(dbl().why!, /^rule big: broken by/);
    p.put("arc/spec/m.arc", p.get("arc/spec/m.arc").replace("  rule big: result > 100\n", ""));
    p.run("decompile");
    // a change two imports away re-runs it: the observations are of the code as it is now
    p.put("src/k.js", "export const K = 3;\n");
    r = p.run("decompile");
    assert.match(r.out, /^src\/m\.js: 1 functions$/m);
    assert.match(r.out, /^src\/m\.js: dbl\(-1\) changed: was -2, now -3$/m);
    assert.deepStrictEqual([dbl().status, dbl().why], ["failing", "example (1) => 2: the code returns 3"]);
  }

  // colliding module names: each gets a longer one, the same whatever the order; the others keep theirs
  {
    const p = project();
    roots.push(p.root);
    p.put("package.json", '{"name":"twins","version":"1.0.0","private":true,"type":"module"}');
    p.put("src/index.js", "/** @param {number} n */\nexport function inc(n) { return n + 1; }\n");
    p.put("lib/index.js", "/** @param {number} n */\nexport function dec(n) { return n - 1; }\n");
    p.put("src/a.js", "export const fromJs = () => 1;\n");
    p.put("src/a.ts", "export const fromTs = (): number => 2;\n");
    p.put("src/other.js", "export const other = () => 3;\n");
    let r = p.run("decompile", "lib", "src");
    assert.strictEqual(r.code, 0, r.out);
    for (const l of ["lib/index.js: its .arc file is arc/spec/lib/index.arc: arc/spec/index.arc would be another module's too", "src/index.js: its .arc file is arc/spec/src/index.arc: arc/spec/index.arc would be another module's too", "src/a.js: its .arc file is arc/spec/a.js.arc: arc/spec/a.arc would be another module's too", "src/a.ts: its .arc file is arc/spec/a.ts.arc: arc/spec/a.arc would be another module's too"]) assert.ok(r.out.includes(`${l}\n`), r.out);
    const heads = () => Object.fromEntries(Object.entries(p.state().modules).map(([f, m]) => [f, `${m.arc}: ${p.get(m.arc).split("\n")[0]}`]));
    const want = {
      "lib/index.js": 'arc/spec/lib/index.arc: module lib.index from "lib/index.js"', "src/index.js": 'arc/spec/src/index.arc: module src.index from "src/index.js"',
      "src/a.js": 'arc/spec/a.js.arc: module a.js from "src/a.js"', "src/a.ts": 'arc/spec/a.ts.arc: module a.ts from "src/a.ts"', "src/other.js": 'arc/spec/other.arc: module other from "src/other.js"',
    };
    assert.deepStrictEqual(heads(), want);
    assert.ok(!existsSync(join(p.root, "arc/spec/index.arc")) && !existsSync(join(p.root, "arc/spec/a.arc")));
    // the other order, from scratch: the same files
    rmSync(join(p.root, "arc"), { recursive: true });
    rmSync(join(p.root, ".openarc"), { recursive: true });
    assert.strictEqual(p.run("decompile", "src", "lib").code, 0);
    assert.deepStrictEqual(heads(), want);
    // a second run: each module keeps its file, nothing is lengthened again
    r = p.run("decompile", "src", "lib");
    assert.ok(!r.out.includes("would be another"), r.out);
    assert.match(r.out, /^lib\/index\.js: 1 functions \(unchanged\)$/m);
    // the longer names address the modules everywhere
    p.put("arc/spec/lib/index.arc", p.get("arc/spec/lib/index.arc").replace("  observed (1) => 0\n", "  example (1) => 0\n"));
    r = p.run("arc", "status", "lib.index");
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /^lib\.index\.dec: ok$/m);
    assert.match(p.run("arc", "status", "a.js").out, /^a\.js\.fromJs: no examples$/m);
    const accept = spawnSync(process.execPath, ["--no-warnings", MAIN, "arc", "accept", "lib.index.dec"], { cwd: p.root, encoding: "utf8", input: "return n - 1;" });
    assert.deepStrictEqual([accept.status, accept.stdout], [0, "accepted lib.index.dec\n"]);
    assert.match(p.run("decompile", "src", "lib").out, /^lib\/index\.js: 1 functions$/m);
    assert.ok(p.run("decompile", "--report").out.includes("lib/index.js: tested 0, failing 0, specified 1,"));
    assert.ok(p.run("decompile", "--todo").out.split("\n").includes("arc/spec/lib/index.arc: dec"));
    assert.strictEqual(p.run("decompile", "--check", "src", "lib").code, 0);
    assert.strictEqual(p.run("arch", "src", "lib").code, 0);
    assert.match(p.run("status").out, /^total: 5 modules, 5 functions/m);
  }

  // one dir at a time: the second run never takes (or reads as its own) the .arc file of a module from the first
  {
    const p = project();
    roots.push(p.root);
    p.put("package.json", '{"name":"steps","version":"1.0.0","private":true,"type":"module"}');
    p.put("src/index.js", "/** @param {number} n */\nexport function inc(n) { return n + 1; }\n");
    p.put("lib/index.js", "/** @param {number} n */\nexport function dec(n) { return n - 1; }\n");
    assert.strictEqual(p.run("decompile", "src").code, 0);
    const srcArc = p.get("arc/spec/index.arc");
    const r = p.run("decompile", "lib");
    assert.ok(r.out.includes("lib/index.js: its .arc file is arc/spec/lib/index.arc: arc/spec/index.arc would be another module's too\n"), r.out);
    assert.strictEqual(p.get("arc/spec/index.arc"), srcArc);
    assert.ok(p.get("arc/spec/lib/index.arc").startsWith('module lib.index from "lib/index.js"\n\nfn dec(n: Num): Num\n'));
  }

  // a function the code no longer exports: its block stays when it holds lines written by hand, else it goes
  {
    const p = project();
    roots.push(p.root);
    p.put("package.json", '{"name":"gone","version":"1.0.0","private":true,"type":"module"}');
    const fn = (name: string, doc = "") => `/** ${doc}\n *  @param {number} n */\nexport function ${name}(n) { return n; }\n`;
    p.put("src/r.js", fn("a", "Code comment a.") + fn("b") + fn("c") + fn("d", "Code comment d.") + fn("e") + fn("f"));
    assert.strictEqual(p.run("decompile").code, 0);
    const block = (name: string) => new RegExp(`\\nfn ${name}\\(n: Num\\): Num\\n(  .*\\n)*`).exec(p.get("arc/spec/r.arc"))?.[0];
    p.put("arc/spec/r.arc", p.get("arc/spec/r.arc")
      .replace(/(fn b\(n: Num\): Num\n)  observed/, "$1  example")
      .replace("fn c(n: Num): Num\n", 'fn c(n: Num): Num\n  "Written by hand."\n')
      .replace('  "Code comment d."\n', '  "Edited by hand."\n')
      .replace("fn f(n: Num): Num\n", "fn f(n: Num): Num\n  hold\n"));
    assert.strictEqual(p.run("decompile").code, 0);
    const written = Object.fromEntries(["b", "c", "d", "f"].map((n) => [n, block(n)]));
    assert.ok(Object.values(written).every(Boolean) && block("a") && block("e"), p.get("arc/spec/r.arc"));
    p.put("src/r.js", p.get("src/r.js").replaceAll("export function", "function") + "export const keep = () => 1;\n");
    const r = p.run("decompile");
    for (const [n, kept] of [["a", false], ["b", true], ["c", true], ["d", true], ["e", false], ["f", true]] as const)
      assert.ok(r.out.includes(`src/r.js: ${n} is not in the code; ${kept ? "its block stays in the .arc file: it has lines written by hand" : "its block is dropped from the .arc file: it had observations only"}\n`), r.out);
    assert.deepStrictEqual(Object.fromEntries(["b", "c", "d", "f"].map((n) => [n, block(n)])), written);
    assert.ok(!block("a") && !block("e") && p.get("arc/spec/r.arc").startsWith('module r from "src/r.js"\n\nfn keep(): Num\n'), p.get("arc/spec/r.arc"));
    // --check and arc status say they are gone
    const c = p.run("decompile", "--check");
    assert.strictEqual(c.code, 1, c.out);
    assert.ok(["b", "c", "d", "f"].every((n) => c.out.includes(`src/r.js: ${n} removed: the code no longer exports it\n`)), c.out);
    assert.match(p.run("arc", "status", "r.b").out, /^r\.b: unrunnable: the code no longer exports it$/m);
  }
} finally {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
}
console.log("decompile.check ok");
