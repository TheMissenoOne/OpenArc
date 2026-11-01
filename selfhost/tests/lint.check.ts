// `openarc lint` (src/lint.ts): spec rules, offline. In-memory ports with no HTTP responses and no proc results, so any
// model call or sandbox run would throw; the request log must stay empty. Run: node tests/lint.check.ts
// 1. Each rule fires, and doesn't on a spec that satisfies it.
// 2. Severities: profile < rules < a matching override's profile < its rules; --profile; config validation.
// 3. Suppressions: with a reason they silence the named rule; without one they are spec/suppression-reason and ignored.
// 4. The command: text and JSON output, exit codes (warnings, --strict, failOnWarnings, usage), ids/files, zero requests.
import assert from "node:assert/strict";
import type { CompileRequest, Ports } from "../src/types.ts";
import fakePorts from "./fakes/ports.memory.ts";
import { lintCommand, severities, type Finding } from "../src/lint.ts";
import { parseConfig, type LintConfig } from "../src/config.ts";

const root = process.cwd(); // the stage0 checkout, so "open-arc" and "typescript" resolve for the type checker
const req: CompileRequest = { root, ids: [], model: { host: "http://h", model: "m", seed: 1, numCtx: 8192 }, sandbox: { nodeBin: "/n/bin/node", nodePrefix: "/n", heapMb: 256, addressSpaceBytes: 2 ** 32, cpuSeconds: 10 } };
const CONFIG = { version: 1, backends: { local: { provider: "ollama", model: "qwen3.5:9b", maxContextTokens: 8192 } } };

// classic specs
const A = [
  'import * as arc from "open-arc";',
  'import { helper } from "./h.ts";',
  "type Abs = (n: number) => number;",
  "// openarc-lint-disable-next-line spec/thin-examples -- two examples are the point of this fixture",
  'export const absSpec = arc.defineRegion<Abs>({ id: "a.abs", intent: "absolute value", examples: [{ args: [1], expected: 1 }, { args: [1], expected: 2 }] });',
  'type Sign = (n: number) => "neg" | "zero" | "pos";',
  'export const signSpec = arc.defineRegion<Sign>({ id: "a.sign", intent: "the sign of n via `helper`; logs each call", examples: [',
  '  { name: "x", args: [5], expected: "pos" }, { name: "x", args: [-1], expected: "neg" }, { args: [3], expected: "pos" }] });',
  "type Pick = (s: string) => string;",
  'export const pickSpec = arc.defineRegion<Pick>({ id: "a.pick", intent: "" });',
  "type Good = (xs: number[], n: number | null) => number;",
  'export const goodSpec = arc.defineRegion<Good>({ id: "a.good", intent: "sum of xs plus n (0 when null)", effects: ["log"], deps: ["./h.ts"], examples: [',
  "  { args: [[], 0], expected: 0 }, { args: [[1, 2], null], expected: 3 }, { args: [[4], -1], expected: 3 }] });",
  "",
].join("\n");
const H = "export function helper(n: number): number {\n  return n;\n}\n";
// code-first
const CF = [
  'import * as arc from "open-arc";',
  "",
  "/** Picks a random side of a die. */",
  "export function roll(sides: number): number {",
  "  return arc.todo();",
  "}",
  "",
  "// openarc-lint-disable-next-line spec/require-tests",
  "export function bare(x: number): number {",
  "  return arc.todo();",
  "}",
  "",
  "/** Doubles n. */",
  "export function twice(n: number): number {",
  "  return arc.todo();",
  "}",
  "",
].join("\n");
const CF_TEST = [
  'import * as arc from "open-arc";',
  'import { roll, twice } from "../src/cf.ts";',
  'arc.test(roll, "in range", (f, expect) => { expect(f(6) >= 1).toBe(true); });',
  'arc.test(roll, "in range", (f, expect) => { expect(f(6) <= 6).toBe(true); });',
  'arc.test(twice, "doubles", (f, expect) => { expect(f(0)).toBe(0); expect(f(-2)).toBe(-4); expect(f(3)).toBe(6); });',
  "",
].join("\n");
const FILES = { "src/a.ts": A, "src/h.ts": H, "src/cf.ts": CF, "tests/cf.test.ts": CF_TEST };

async function lint(args: string[], lintCfg?: unknown, files: Record<string, string> = FILES) {
  const fake = fakePorts({ files: { ...files, "openarc.config.json": JSON.stringify({ ...CONFIG, ...(lintCfg ? { lint: lintCfg } : {}) }) } });
  const out: string[] = [], err: string[] = [];
  const exit = await lintCommand(fake.instance as Ports, req, args, { out: (l) => out.push(l), err: (l) => err.push(l) });
  const snap = fake.snapshot() as { requests: unknown[]; runs: unknown[] };
  assert.deepStrictEqual([snap.requests, snap.runs], [[], []], "lint makes no HTTP request and runs nothing");
  return { exit, out, err, json: () => JSON.parse(out.join("\n")) as Finding[] };
}
const brief = (fs: Finding[]) => fs.map((f) => `${f.severity} ${f.rule} ${f.id}`);

// ── 1. rules, recommended profile
{
  const r = await lint(["--format", "json"]);
  assert.deepStrictEqual(brief(r.json()), [
    "error spec/contradictory-examples a.abs",
    "warn spec/duplicate-test-names a.sign",
    "warn spec/undeclared-effects a.sign",
    "warn spec/require-intent a.pick",
    "warn spec/require-tests a.pick",
    "warn spec/duplicate-test-names cf.roll",
    "warn spec/undeclared-effects cf.roll",
    "error spec/suppression-reason cf.bare",
    "warn spec/require-intent cf.bare",
    "warn spec/require-tests cf.bare",
  ]);
  assert.equal(r.exit, 1, "an error-level finding fails");
  const f = r.json();
  const abs = f.find((x) => x.id === "a.abs")!;
  assert.deepStrictEqual([abs.file, abs.line], ["src/a.ts", 5], "the line of the defineRegion statement on disk");
  assert.match(abs.message, /same args \[1\] but different outcomes/);
  assert.deepStrictEqual(f.filter((x) => x.id === "cf.bare").map((x) => x.line), [8, 9, 9], "the suppression's own line; the declaration line");
  assert.match(f.find((x) => x.rule === "spec/undeclared-effects" && x.id === "a.sign")!.message, /"logs".*"log"/);
  assert.match(f.find((x) => x.rule === "spec/undeclared-effects" && x.id === "cf.roll")!.message, /"random"/);
  assert.match(f.find((x) => x.rule === "spec/duplicate-test-names" && x.id === "cf.roll")!.message, /test "in range"/);
}

// ── 1b. strict profile: the off-by-default rules, and a.good / cf.twice stay clean
{
  const r = await lint(["--format", "json", "--profile", "strict"]);
  const f = r.json();
  assert.deepStrictEqual(brief(f.filter((x) => x.rule === "spec/boundary-cases")), ["warn spec/boundary-cases a.abs", "warn spec/boundary-cases a.pick", "warn spec/boundary-cases cf.roll", "warn spec/boundary-cases cf.bare"]);
  assert.match(f.find((x) => x.rule === "spec/boundary-cases" && x.id === "a.pick")!.message, /parameter s: .*empty string/);
  assert.match(f.find((x) => x.rule === "spec/return-union-coverage")!.message, /"zero" never appears/);
  assert.deepStrictEqual(brief(f.filter((x) => x.rule === "spec/explicit-deps")), ["warn spec/explicit-deps a.sign"]);
  assert.match(f.find((x) => x.rule === "spec/explicit-deps")!.message, /helper \(imported from "\.\/h\.ts"\)/);
  assert.equal(f.filter((x) => x.id === "a.good" || x.id === "cf.twice").length, 0, JSON.stringify(f));
  assert.deepStrictEqual(brief(f.filter((x) => x.id === "a.pick")), ["warn spec/boundary-cases a.pick", "warn spec/require-intent a.pick", "error spec/require-tests a.pick"]);
}

// ── 1c. thin examples (W044's condition), and the spec errors analysis finds
{
  const thin = 'import * as arc from "open-arc";\ntype Inc = (n: number) => number;\nexport const incSpec = arc.defineRegion<Inc>({ id: "t.inc", intent: "add one", examples: [{ args: [1], expected: 2 }] });\n';
  const r = await lint(["--format", "json"], undefined, { "src/t.ts": thin });
  assert.deepStrictEqual(r.json().map((x) => [x.rule, x.message]), [["spec/thin-examples", "thin examples (examples:1): fewer than 3, or none with an edge case (empty, zero, negative, null)"]]);
  assert.equal(r.exit, 0, "warnings alone pass");
  const e022 = await lint(["--format", "json"], undefined, { "src/u.ts": 'import * as arc from "open-arc";\n/** x */\nexport function f(n: number) {\n  return arc.todo();\n}\n' });
  assert.deepStrictEqual(e022.json().map((x) => [x.rule, x.severity, x.file, x.line]), [["OARC-E022", "error", "src/u.ts", 3]]);
  assert.equal(e022.exit, 1);
}

// ── 2. severities and config
{
  const rec = severities(undefined, "src/x.ts");
  assert.deepStrictEqual([rec["spec/require-tests"], rec["spec/boundary-cases"], rec["spec/suppression-reason"]], ["warn", "off", "error"]);
  const lintCfg: LintConfig = {
    extends: "recommended",
    rules: { "spec/require-tests": "error", "spec/require-intent": "off" },
    overrides: [
      { files: ["src/pay/**"], extends: "strict", rules: { "spec/boundary-cases": "off" } },
      { files: ["src/pay/legacy/*.ts"], rules: { "spec/require-tests": "warn" } },
    ],
  };
  const top = severities(lintCfg, "src/a.ts");
  assert.deepStrictEqual([top["spec/require-tests"], top["spec/require-intent"], top["spec/boundary-cases"]], ["error", "off", "off"]);
  const pay = severities(lintCfg, "src/pay/deep/x.ts");
  assert.deepStrictEqual([pay["spec/require-tests"], pay["spec/require-intent"], pay["spec/boundary-cases"], pay["spec/explicit-deps"]], ["error", "warn", "off", "warn"], "the override's profile replaces the top-level rules");
  const legacy = severities(lintCfg, "src/pay/legacy/old.ts");
  assert.equal(legacy["spec/require-tests"], "warn", "a later override wins");
  assert.equal(severities(lintCfg, "src/a.ts", "strict")["spec/require-intent"], "off", "--profile replaces extends; rules still apply");
  // end to end: rules from the config file
  const r = await lint(["--format", "json"], { rules: { "spec/require-intent": "off", "spec/contradictory-examples": "warn", "spec/suppression-reason": "warn" } });
  assert.equal(r.json().filter((x) => x.rule === "spec/require-intent").length, 0);
  assert.equal(r.exit, 0, "no error-level finding left");
  // validation
  const bad = (l: unknown) => parseConfig(JSON.stringify({ ...CONFIG, lint: l })).error;
  assert.equal(bad({ rules: { "spec/require-tests": "error" }, overrides: [{ files: ["src/**"], extends: "strict" }] }), undefined);
  assert.match(bad({ rules: { "spec/nope": "warn" } })!, /lint: unknown rule "spec\/nope"/);
  assert.match(bad({ rules: { "spec/require-tests": "warning" } })!, /lint: rule "spec\/require-tests" must be "off", "warn" or "error"/);
  assert.match(bad({ extends: "all" })!, /lint: extends must be "recommended" or "strict"/);
  assert.match(bad({ overrides: [{ files: [] }] })!, /lint: overrides\[0\]\.files must be a non-empty array/);
  assert.match(bad({ overrides: [{ files: ["x"], rules: { "spec/x": "off" } }] })!, /lint: overrides\[0\]\.unknown rule/);
  assert.match(bad({ failOnWarnings: "yes" })!, /failOnWarnings must be true or false/);
  assert.match(bad([])!, /lint: must be an object/);
  const cfgErr = await lint([], { rules: { "spec/nope": "warn" } });
  assert.equal(cfgErr.exit, 1);
  assert.match(cfgErr.err[0]!, /unknown rule/);
}

// ── 3. suppressions
{
  const withReason = A.replace("spec/thin-examples -- two", "spec/thin-examples, spec/contradictory-examples -- two");
  const r = await lint(["--format", "json", "a.abs"], undefined, { ...FILES, "src/a.ts": withReason });
  assert.deepStrictEqual(r.json(), [], "both rules named before -- are suppressed");
  const noReason = A.replace(" -- two examples are the point of this fixture", "");
  const n = await lint(["--format", "json", "a.abs"], undefined, { ...FILES, "src/a.ts": noReason });
  assert.deepStrictEqual(n.json().map((x) => `${x.rule} ${x.line}`), ["spec/suppression-reason 4", "spec/contradictory-examples 5", "spec/thin-examples 5"], "a suppression without a reason is a finding and suppresses nothing");
  // a JSDoc between the comment and the declaration, and a class-level suppression for its methods
  const cls = [
    'import * as arc from "open-arc";',
    "// openarc-lint-disable-next-line spec/require-tests -- covered by the integration suite",
    "export class Q {",
    "  /** Next item. */",
    "  next(): number {",
    "    return arc.todo();",
    "  }",
    "}",
    "// openarc-lint-disable-next-line spec/require-tests -- same",
    "/** Size. */",
    "export function size(): number {",
    "  return arc.todo();",
    "}",
    "",
  ].join("\n");
  const c = await lint(["--format", "json"], undefined, { "src/q.ts": cls });
  assert.deepStrictEqual(c.json(), []);
}

// ── 4. the command: text output, exit codes, selection, usage
{
  const t = await lint(["a.pick"]);
  assert.deepStrictEqual(t.out, [
    "warn  spec/require-intent a.pick src/a.ts:10  empty intent",
    "warn  spec/require-tests a.pick src/a.ts:10  no example, arc.test or arc.law verifies this region: only its type is checked",
    "lint: 0 error(s), 2 warning(s) in 1 function region(s)",
  ]);
  assert.equal(t.exit, 0);
  assert.equal((await lint(["a.pick", "--strict"])).exit, 1, "--strict fails on warnings");
  assert.equal((await lint(["a.pick"], { failOnWarnings: true })).exit, 1, "so does lint.failOnWarnings");
  assert.equal((await lint(["a.good"])).exit, 0);
  const byFile = await lint(["--format", "json", "src/cf.ts"]);
  assert.ok(byFile.json().every((x) => x.file === "src/cf.ts") && byFile.json().length > 0);
  const none = await lint(["nope.x"]);
  assert.equal(none.exit, 2);
  assert.match(none.err[0]!, /no region or spec file nope\.x/);
  assert.equal((await lint(["--format", "xml"])).exit, 2);
  assert.equal((await lint(["--profile", "max"])).exit, 2);
}

console.log("lint: all checks passed");
