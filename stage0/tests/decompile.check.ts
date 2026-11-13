// The `.arc` language round trip, and `openarc decompile` end to end on a plain JavaScript project: no tsconfig, no
// types, a node:test file. Nothing in the project's code may change. Run: node --no-warnings tests/decompile.check.ts
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArc, printArc, printValue, type ArcModule } from "../src/arc.ts";

// ── pure: print and parse are inverses, values keep their shape, errors name the line
{
  const m: ArcModule = {
    name: "a.b", file: "src/a/b.js", intent: ["Module line."],
    types: [{ name: "Stats", type: "{ water: Num, food?: Num }" }],
    fns: [
      { name: "tick", params: [{ name: "stats", type: "Stats" }, { name: "opts", type: "{ fast: Bool }", optional: true }, { name: "rest", type: "[`Map<string, number>`]", rest: true }], returns: "Stats | Null", intent: ['Says "hi".', "Second line."], hold: true,
        examples: [{ args: [{ water: 1, "odd key": [true, null, -2.5e3] }, "a, b) => #"], expected: { ok: "x" }, name: "named # one" }, { args: [], throws: "bad" }, { args: [1], throws: true }], rules: [{ name: "bounded", text: "result.water in 0..100" }] },
      { name: "load", params: [], returns: "Str", async: true, intent: [], examples: [], rules: [] },
    ],
  };
  const text = printArc(m);
  assert.deepStrictEqual(parseArc(text), m);
  assert.strictEqual(printArc(parseArc(text)), text);
  assert.strictEqual(printValue({ a: 1, "b c": ["x"] }), '{a: 1, "b c": ["x"]}');
  assert.throws(() => parseArc(text.replace(") throws\n", ") gives\n")), /^Error: line \d+: expected => or throws/);
  assert.throws(() => parseArc("fn f(): Num\n"), /line 1: a file starts with/);
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
  write("package.json", '{"name":"plain","version":"1.0.0","type":"module","private":true}');
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
import { drain, label } from "../src/survival.js";

const thirsty = { water: 5 };
test("drain", () => {
  assert.deepStrictEqual(drain({ water: 50 }), { water: 40 });
  assert.deepStrictEqual(drain(thirsty, 2), { water: 0 });
  assert.strictEqual(label(0.9), "heavy rain");
  assert.strictEqual(label(0), "clear");
});
`);
  write("tests/broken.test.mjs", `import test from "node:test";
import assert from "node:assert";
import { broken } from "../src/survival.js";
test("broken", () => assert.strictEqual(broken(3), 6));
`);
  const sources = () => ["src/survival.js", "src/deep/screen.js"].map(read).join("\0");
  const before = sources();

  let r = oa("decompile", "--run-tests");
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(sources(), before, "decompile changes no source");
  const arc = parseArc(read("arc/survival.arc"));
  const fn = (name: string) => arc.fns.find((f) => f.name === name)!;
  assert.deepStrictEqual([arc.name, arc.file, arc.fns.map((f) => f.name)], ["survival", "src/survival.js", ["drain", "add", "label", "broken"]]);
  // untyped JavaScript: the intent comes from the comment, the inputs from the literal calls in the test (also through a const)
  assert.deepStrictEqual(fn("drain").intent, ["Drains water by effort. Never leaves 0..100."]);
  assert.deepStrictEqual(fn("drain").params, [{ name: "stats", type: "Any" }, { name: "effort", type: "Num", optional: true }]);
  assert.deepStrictEqual(fn("drain").examples, [{ args: [{ water: 50 }], expected: { water: 40 } }, { args: [{ water: 5 }, 2], expected: { water: 0 } }]);
  assert.deepStrictEqual(fn("label").examples, [{ args: [0.9], expected: "heavy rain" }, { args: [0], expected: "clear" }]);
  // JSDoc types give inputs with no call to copy from
  assert.deepStrictEqual([fn("add").intent, fn("add").params.map((p) => p.type), fn("add").returns], [["Adds two numbers."], ["Num", "Num"], "Num"]);
  assert.ok(fn("add").examples.length >= 3 && fn("add").examples.every((e) => (e.args[0] as number) + (e.args[1] as number) === e.expected));
  const state = JSON.parse(read(".openarc/decompile.json")) as { modules: Record<string, { fns: Record<string, { status: string; tests: string[]; why?: string }> }> };
  const s = state.modules["src/survival.js"]!.fns, d = state.modules["src/deep/screen.js"]!.fns;
  assert.deepStrictEqual([s.drain, s.label, s.add], [{ status: "tested", tests: ["tests/survival.test.mjs"] }, { status: "tested", tests: ["tests/survival.test.mjs"] }, { status: "examples", tests: [] }]);
  // a function its own test fails is "failing", whatever examples its current behaviour gave, and the file is named
  assert.deepStrictEqual([s.broken!.status, s.broken!.tests, s.broken!.why], ["failing", ["tests/broken.test.mjs"], "tests/broken.test.mjs fails"]);
  // code that needs a browser is kept, with the reason; an async function's result is the awaited value
  assert.deepStrictEqual(d.resize, { status: "bare", tests: [], why: "every input throws: document is not defined" });
  assert.strictEqual(d.untouched!.why, "no inputs: the parameter types say too little and no call passes literals");
  const deep = parseArc(read("arc/deep/screen.arc"));
  assert.deepStrictEqual([deep.name, deep.fns.find((f) => f.name === "later")!.async, deep.fns.find((f) => f.name === "later")!.examples], ["deep.screen", true, [{ args: [], expected: "done" }]]);
  assert.match(r.out, /decompiled 2 modules: tested 2, failing 1, examples 2, described 0, bare 2, skipped 0/);

  // what a person writes in the .arc file survives the next run, and an unchanged module is not run again
  write("arc/survival.arc", read("arc/survival.arc").replace('fn label(rain: Any): "heavy rain" | "clear"\n', 'fn label(rain: Any): "heavy rain" | "clear"\n  "Names the weather from the rain level."\n').replace('  example (0) => "clear"\n', '  example (0) => "clear"\n  rule known: result in ["heavy rain", "clear"]\n'));
  const kept = read("arc/survival.arc");
  assert.ok(kept.includes("rule known"));
  r = oa("decompile", "--run-tests");
  assert.match(r.out, /src\/survival\.js: 4 functions \(unchanged\)/);
  assert.strictEqual(read("arc/survival.arc"), kept);
  r = oa("decompile", "--todo");
  assert.deepStrictEqual(r.out.trim().split("\n"), ["arc/deep/screen.arc: resize", "arc/deep/screen.arc: later", "arc/deep/screen.arc: untouched", "arc/survival.arc: broken"]);
  r = oa("decompile", "--report", "--json");
  assert.deepStrictEqual((JSON.parse(r.out) as { totals: unknown }).totals, { tested: 2, failing: 1, examples: 2, described: 0, bare: 2, skipped: 0 });
  assert.strictEqual(sources(), before);
  assert.deepStrictEqual(readdirSync(join(dir, "src")).sort(), ["deep", "survival.js"]);
  assert.strictEqual(oa("decompile", "../x").code, 2);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("decompile.check ok");
