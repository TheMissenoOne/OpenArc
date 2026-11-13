// `rule` lines (src/rules.ts): the parser, the evaluator on every construct, type fit, checkRules, and `decompile --check`
// end to end on a plain JavaScript project where one rule holds and a generated input breaks another.
// Run: node --no-warnings tests/rules.check.ts
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ArcFn } from "../src/arc.ts";
import { argsFit, checkRule, checkRules, fitsArcType, parseRule, type RuleEnv, type RuleExpr } from "../src/rules.ts";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const ast = (t: string): RuleExpr => { const a = parseRule(t); assert.ok(!("error" in a), `${t}: ${JSON.stringify(a)}`); return a; };
/** A compact print of the tree, to read precedence off it. */
const tree = (e: RuleExpr): string => {
  switch (e.k) {
    case "lit": return JSON.stringify(e.v);
    case "name": return e.n;
    case "field": return `${tree(e.e)}.${e.f}`;
    case "index": return `${tree(e.e)}[${tree(e.i)}]`;
    case "un": return `(${e.op} ${tree(e.e)})`;
    case "bin": return `(${tree(e.l)} ${e.op} ${tree(e.r)})`;
    case "range": return `(${tree(e.e)} in ${tree(e.lo)}..${tree(e.hi)})`;
    case "is": return `(${tree(e.e)} in <${e.t.k}>)`;
    case "len": return `len(${tree(e.e)})`;
    case "quant": return `${e.all ? "all" : "any"}(${tree(e.xs)}, ${e.v} => ${tree(e.body)})`;
  }
};

// ── parser: precedence, associativity, errors with columns
{
  assert.strictEqual(tree(ast("1 + 2 * 3 == 7")), "((1 + (2 * 3)) == 7)");
  assert.strictEqual(tree(ast("a - b - c")), "((a - b) - c)");
  assert.strictEqual(tree(ast("-a.b[0] % 2")), "((- a.b[0]) % 2)");
  assert.strictEqual(tree(ast("not a and b or c")), "(((not a) and b) or c)");
  assert.strictEqual(tree(ast("a or b and c")), "(a or (b and c))");
  assert.strictEqual(tree(ast("a implies b implies c")), "(a implies (b implies c))");
  assert.strictEqual(tree(ast("a or b implies c and d")), "((a or b) implies (c and d))");
  assert.strictEqual(tree(ast("x in 0..n + 1 and y")), "((x in 0..(n + 1)) and y)");
  assert.strictEqual(tree(ast("after.s in Stats and threw == false")), "((after.s in <name>) and (threw == false))");
  assert.strictEqual(tree(ast('x in "a" | "b"')), "(x in <union>)");
  assert.strictEqual(tree(ast("x in { a: Num, b?: [Str] }?")), "(x in <opt>)");
  assert.strictEqual(tree(ast("all(result, x => x > 0 and any(old.xs, y => y == x))")), "all(result, x => ((x > 0) and any(old.xs, y => (y == x))))");
  assert.strictEqual(tree(ast("len(result) <= len(xs)")), "(len(result) <= len(xs))");
  assert.strictEqual(tree(ast("(a or b) and c")), "((a or b) and c)");
  assert.deepStrictEqual(parseRule("result >"), { error: "expected a value, found the end", column: 9 });
  assert.deepStrictEqual(parseRule("a == b == c"), { error: 'expected the end, found "=="', column: 8 });
  assert.deepStrictEqual(parseRule("result # 2"), { error: 'unexpected "#"', column: 8 });
  assert.deepStrictEqual(parseRule("all(xs, 1 => x)"), { error: 'expected a name, found "1"', column: 9 });
  assert.deepStrictEqual(parseRule("x in [Num"), { error: 'expected "]", found the end', column: 10 });
  assert.deepStrictEqual(parseRule("(a and b"), { error: 'expected ")", found the end', column: 9 });
  assert.deepStrictEqual(parseRule("a and"), { error: "expected a value, found the end", column: 6 });
  assert.deepStrictEqual(parseRule("x in 1.."), { error: "expected a value, found the end", column: 9 });
  assert.deepStrictEqual(parseRule('o["a"].b == [1]'), { error: 'expected a value, found "["', column: 13 }); // no list literals
}

// ── evaluator: every construct
{
  const env = (params: Record<string, Json>, more: Partial<RuleEnv> = {}): RuleEnv => ({ params, threw: false, types: { Stats: "{ water: Num, food?: Num }" }, ...more });
  const is = (t: string, e: RuleEnv, want: boolean | RegExp) => {
    const got = checkRule(ast(t), e);
    if (want instanceof RegExp) assert.match((got as { error: string }).error ?? "", want, `${t}: ${JSON.stringify(got)}`);
    else assert.strictEqual(got, want, t);
  };
  const e = env({ n: 3, s: "abc", xs: [1, 2, 3], o: { a: { b: [10, 20] } } }, { result: 6, after: { n: 3, s: "abc", xs: [1, 2, 3, 4], o: {} } });
  is("result == n * 2", e, true);
  is("result == 6.0000000001", e, true); // within the tolerance
  is("result != 7 and result >= 6 and result <= 6 and result > 5 and result < 7", e, true);
  is("n + 1 == 4 and n - 4 == -1 and 7 / 2 == 3.5 and 7 % 4 == 3 and -n == 0 - 3", e, true);
  is('s + "d" == "abcd" and s < "abd"', e, true);
  is("o.a.b[1] == 20 and xs[-1] == 3 and xs[9] == null", e, false); // out of range is undefined, not null
  is('o.a.b[1] == 20 and xs[-1] == 3 and o["a"].b[0] == 10 and s[0] == "a"', e, true);
  is("old.xs == xs and after.xs != xs and len(after.xs) == len(old.xs) + 1", e, true);
  is("len(s) == 3 and len(xs) == 3", e, true);
  is("n in 1..3 and not (n in 4..5) and not (s in 0..9)", e, true);
  is("all(xs, x => x > 0) and any(xs, x => x == 2) and not all(xs, x => x > 1)", e, true);
  is("all(after.o, x => true)", e, /not a list/);
  is("true implies false", e, false);
  is("false implies result.missing.x", e, true); // short circuit
  is("true or nope", e, true);
  is("result in Int and n in Num and s in Str and threw in Bool and null in Null and result in Any", e, true);
  is("result in Stats", e, false);
  is("o in { a: { b: [Int] } } and o in {} and not (o in { z: Num })", e, true);
  is('s in "abc" | "x" and n in 3 and n in 1 | 2 | 3 and not (n in -3)', e, true);
  is("n in `Map<string, number>`", e, true);
  is("result in Nope", e, /unknown type Nope/);
  is("result.x > 0", e, /6 has no field x/);
  is("s > 1", e, /cannot compare "abc" > 1/);
  is("n and true", e, /not true or false/);
  is("n + 1", e, /gives 4, not true or false/);
  is("len(n) == 1", e, /not a string or a list/);
  // value tokens decode: NaN, -0, undefined
  is('result in Num and not (result in Int) and result == result', env({}, { result: "$NaN" }), true);
  is("result in Void and result in Num? and not (result in Num)", env({}, { result: "$undefined" }), true);
  is("x == 0", env({ x: "$-0" }), true);
  // a call that threw: result is undefined, threw is true
  is("threw and result in Void", env({}, { threw: true }), true);
  // named types, optional keys, recursion
  is("after.s in Stats", env({ s: { water: 1 } }, { after: { s: { water: 1, food: 2 } } }), true);
  is("s in Stats", env({ s: { water: "1" } }), false);
  is("t in Tree", env({ t: { kids: [{ kids: [] }] } }, { types: { Tree: "{ kids: [Tree] }" } }), true);
  is("t in Loop", env({ t: 1 }, { types: { Loop: "Loop" } }), /never ends/);
}

// ── type fit on its own, and the argument filter generated inputs go through
{
  assert.ok(fitsArcType("[Int]", [1, 2]) && !fitsArcType("[Int]", [1, 2.5]));
  assert.ok(fitsArcType("(Str | Num)?", null) && fitsArcType("(Str | Num)?", "$undefined") && !fitsArcType("Str | Num", true));
  assert.ok(fitsArcType('{ "odd key": true, k?: Null }', { "odd key": true }) && !fitsArcType('{ "odd key": true }', { "odd key": false }));
  assert.ok(fitsArcType("Float", "$Infinity") && !fitsArcType("Int", "$Infinity"));
  assert.ok(fitsArcType("P", { x: 1 }, { P: "{ x: Num }" }));
  assert.throws(() => fitsArcType("[Num", []), /expected "\]"/);
  const fn: ArcFn = { name: "f", params: [{ name: "a", type: "Int" }, { name: "b", type: "Elsewhere", optional: true }], returns: "Num", intent: [], examples: [], rules: [] };
  const fit = argsFit(fn, []);
  assert.ok(fit([1]) && fit([1, "anything"]) && !fit([1.5]) && !fit([]) && !fit([1, 2, 3]));
  const rest = argsFit({ ...fn, params: [{ name: "xs", type: "Str", rest: true }] }, []);
  assert.ok(rest([]) && rest(["a", "b"]) && !rest(["a", 1]));
}

// ── checkRules: held counts, the first breaking call, skipped throws, parse and name errors
{
  const fn: ArcFn = { name: "push", params: [{ name: "xs", type: "[Num]" }, { name: "x", type: "Num" }], returns: "Int", intent: [], examples: [], rules: [
    { name: "grows", text: "len(after.xs) == len(xs) + 1" },
    { name: "size", text: "result == len(after.xs)" },
    { name: "safe", text: "threw implies x < 0" },
    { name: "typo", text: "len(reslt) > 0" },
    { name: "bad", text: "result in" },
    { name: "eval", text: "result.n > 0" },
  ] };
  const runs = [
    { args: [[1], 2], result: 2, after: [[1, 2], 2], threw: false },
    { args: [[], 5], result: 1, after: [[5], 5], threw: false },
    { args: [[], -1], threw: true },
    { args: [[1, 2], 3], result: 2, after: [[1, 2], 3], threw: false }, // a push that did nothing
  ];
  const got = checkRules(fn, [], runs);
  assert.deepStrictEqual(got[0], { rule: "grows", held: 2, broken: { args: [[], -1] } }); // `after` on a throw: unchanged
  assert.deepStrictEqual(got[1], { rule: "size", held: 3 }); // the throw is skipped: it reads result, not threw
  assert.deepStrictEqual(got[2], { rule: "safe", held: 4 });
  assert.match(got[3]!.error!, /^unknown name reslt \(known: xs, x, result, threw, after, old\)$/);
  assert.deepStrictEqual(got[4], { rule: "bad", held: 0, error: "cannot parse: expected a type, found the end at column 10" });
  assert.deepStrictEqual(got[5], { rule: "eval", held: 0, broken: { args: [[1], 2], result: 2, after: [[1, 2], 2] }, error: "cannot evaluate: 2 has no field n" });
}

// ── a parameter named like a keyword: the keyword wins, the parameter is old.<name> / after.<name>, an error says so
{
  const fn: ArcFn = { name: "f", params: [{ name: "threw", type: "{ n: Num }" }, { name: "old", type: "Num" }], returns: "Num", intent: [], examples: [], rules: [
    { name: "bare", text: "threw.n > 0" },
    { name: "spelled", text: "old.threw.n > 0 and after.threw.n > 0 and old.old == 1" },
    { name: "parse", text: "threw.n >" },
    { name: "fine", text: "result > 0" },
    { name: "other", text: "result.x > 0" },
  ] };
  const got = checkRules(fn, [], [{ args: [{ n: 1 }, 1], result: 2, threw: false }]);
  const hint = "; the parameter threw is shadowed by the keyword threw: write old.threw for its value before the call, after.threw for after it";
  assert.strictEqual(got[0]!.error, `cannot evaluate: false has no field n${hint}`);
  assert.deepStrictEqual(got[1], { rule: "spelled", held: 1 });
  assert.strictEqual(got[2]!.error, `cannot parse: expected a value, found the end at column 10${hint}`);
  assert.deepStrictEqual(got[3], { rule: "fine", held: 1 });
  assert.strictEqual(got[4]!.error, "cannot evaluate: 2 has no field x"); // names no shadowed parameter: no hint
}

// ── end to end: `openarc decompile --check` on a plain JavaScript project
{
  const MAIN = resolve("src/main.ts");
  const dir = mkdtempSync(join(resolve(".."), ".rules-check-"));
  const write = (f: string, t: string) => (mkdirSync(dirname(join(dir, f)), { recursive: true }), writeFileSync(join(dir, f), t));
  const oa = (...args: string[]) => { const r = spawnSync(process.execPath, ["--no-warnings", MAIN, ...args], { cwd: dir, encoding: "utf8" }); return { code: r.status, out: r.stdout + r.stderr }; };
  try {
    write("package.json", '{"name":"plain","version":"1.0.0","private":true}');
    // forgets the lower bound: no written example passes a negative number
    write("src/pct.js", "export function clampPct(n) { return n > 100 ? 100 : n; }\n");
    write("arc/spec/pct.arc", `module pct from "src/pct.js"

fn clampPct(n: Num): Num
  "Clamps a percentage to 0..100."
  example (50) => 50
  example (150) => 100
  rule capped: result <= 100
  rule bounded: result in 0..100
`);
    let r = oa("decompile", "--check");
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /^src\/pct\.js: clampPct: rule capped: held on (\d+) inputs$/m);
    assert.match(r.out, /^src\/pct\.js: clampPct: rule bounded: broken by \(-\d+(\.\d+)?\) -> -\d+(\.\d+)?$/m);
    const held = Number(/rule capped: held on (\d+)/.exec(r.out)![1]);
    assert.ok(held > 2 && held <= 52, r.out); // the two examples and at most 50 generated inputs
    assert.ok(!/proved|verified/.test(r.out));
    r = oa("decompile", "--check", "--rule-inputs", "3", "--json");
    const report = JSON.parse(r.out) as { ok: boolean; summary: { held: number; broken: number }; items: { kind: string; rule?: string; inputs?: number }[] };
    assert.strictEqual(report.ok, false);
    assert.deepStrictEqual([report.summary.held, report.summary.broken], [1, 1]);
    assert.ok(report.items.find((i) => i.rule === "capped")!.inputs! <= 5);
    // fixed code: both rules hold, exit 0
    write("src/pct.js", "export function clampPct(n) { return Math.max(0, Math.min(100, n)); }\n");
    r = oa("decompile", "--check");
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /rule bounded: held on \d+ inputs/);
    // a rule that does not parse fails the check
    write("arc/spec/pct.arc", 'module pct from "src/pct.js"\n\nfn clampPct(n: Num): Num\n  example (50) => 50\n  rule bad: result in 0..\n');
    r = oa("decompile", "--check");
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /rule bad: cannot parse: expected a value, found the end at column 14/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log("rules.check: ok");
