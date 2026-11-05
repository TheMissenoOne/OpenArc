// `openarc check <ids> --mutants` (engine.mutantCheck), on in-memory ports. No model. The fake proc stands in for the
// sandbox: it copies the in-memory stage to a temp dir and runs the real harness there with this node (no isolation).
// Run: node tests/mutants.check.ts
// 1. A strong spec kills the boundary mutant; a weak one (no example at the boundary) lets it survive.
// 2. A trivial body that passes the examples is reported as vacuous.
// 3. A mutant that does not type-check is invalid, not scored.
// 4. A region whose examples fail already (or that is pending) is skipped. --operators selects the mutant kinds.
// 5. guard drops an if without else that returns or throws; swap exchanges adjacent same-typed call arguments.
// 6. A survivor that agrees with the original on the oracle inputs is equivalent and not scored. One that differs prints
//    that input; with no inputs to try, the kind of input (W044's wording) or the line to reach.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CompileRequest, Ports } from "../src/types.ts";
import fakePorts from "./fakes/ports.memory.ts";
import * as engine from "../src/engine.ts";

const root = process.cwd(); // the stage0 checkout, so "open-arc" and "typescript" resolve for the type checker
const req: CompileRequest = { root, ids: [], model: { host: "http://h", model: "m", seed: 1, numCtx: 8192 }, sandbox: { nodeBin: "/n/bin/node", nodePrefix: "/n", heapMb: 256, addressSpaceBytes: 2 ** 32, cpuSeconds: 10 } };
const tmp = mkdtempSync(join(tmpdir(), "openarc-mutants-"));
let runs = 0;

const SRC = [
  'import * as arc from "open-arc";',
  "type Pos = (n: number) => boolean;",
  "type Trim = (s: string) => string;",
  "type Box = (n: number) => { v: number };",
  'export const strongSpec = arc.defineRegion<Pos>({ id: "m.strong", intent: "n is not negative", examples: [{ args: [0], expected: true }, { args: [1], expected: true }, { args: [-1], expected: false }] });',
  'export const weakSpec = arc.defineRegion<Pos>({ id: "m.weak", intent: "n is not negative", examples: [{ args: [5], expected: true }, { args: [-5], expected: false }] });',
  'export const trimSpec = arc.defineRegion<Trim>({ id: "m.trim", intent: "s without surrounding spaces", examples: [{ args: [""], expected: "" }] });',
  'export const boxSpec = arc.defineRegion<Box>({ id: "m.box", intent: "n in a box", examples: [{ args: [2], expected: { v: 2 } }] });',
  'export const badSpec = arc.defineRegion<Pos>({ id: "m.bad", intent: "n is not negative", examples: [{ args: [0], expected: true }] });',
  'export const todoSpec = arc.defineRegion<Pos>({ id: "m.todo", intent: "n is not negative", examples: [{ args: [0], expected: true }] });',
  "// @openarc:begin m.strong",
  "export const strong: Pos = (n) => {",
  "  return n >= 0;",
  "};",
  "// @openarc:end m.strong",
  "// @openarc:begin m.weak",
  "export const weak: Pos = (n) => {",
  "  return n >= 0;",
  "};",
  "// @openarc:end m.weak",
  "// @openarc:begin m.trim",
  "export const trim: Trim = (s) => {",
  "  return s.trim();",
  "};",
  "// @openarc:end m.trim",
  "// @openarc:begin m.box",
  "export const box: Box = (n) => {",
  "  return { v: n };",
  "};",
  "// @openarc:end m.box",
  "// @openarc:begin m.bad",
  "export const bad: Pos = (n) => {",
  "  return n > 0;",
  "};",
  "// @openarc:end m.bad",
  "// @openarc:begin m.todo",
  "export const todo: Pos = (n) => {",
  '  return arc.todo("m.todo");',
  "};",
  "// @openarc:end m.todo",
  "type Num = (n: number) => number;",
  "type Two = (a: number, b: number) => number;",
  'export const clampSpec = arc.defineRegion<Num>({ id: "m.clamp", intent: "n, at least 0", examples: [{ args: [5], expected: 5 }, { args: [7], expected: 7 }] });',
  'export const rejectSpec = arc.defineRegion<Num>({ id: "m.reject", intent: "n, not negative", examples: [{ args: [5], expected: 5 }, { args: [-1], throws: "neg" }] });',
  'export const lenSpec = arc.defineRegion<(s: string | null) => number>({ id: "m.len", intent: "length of s", examples: [{ args: ["ab"], expected: 2 }] });',
  'export const powSpec = arc.defineRegion<Two>({ id: "m.pow", intent: "a to the b", examples: [{ args: [2, 2], expected: 4 }] });',
  'export const maxSpec = arc.defineRegion<Two>({ id: "m.max", intent: "the larger", examples: [{ args: [1, 2], expected: 2 }, { args: [2, 1], expected: 2 }] });',
  'export const mixSpec = arc.defineRegion<Num>({ id: "m.mix", intent: "calls with arguments that cannot swap", examples: [{ args: [1], expected: 5 }] });',
  'export const nullSpec = arc.defineRegion<(a: string | null, n: number) => boolean>({ id: "m.nul", intent: "n is not negative", examples: [{ args: [null, 5], expected: true }] });',
  'export const noArgSpec = arc.defineRegion<() => boolean>({ id: "m.noarg", intent: "true", examples: [{ args: [], expected: true }] });',
  "// @openarc:begin m.clamp",
  "export const clamp: Num = (n) => {",
  "  if (n < 0) return 0;",
  "  return n;",
  "};",
  "// @openarc:end m.clamp",
  "// @openarc:begin m.reject",
  "export const reject: Num = (n) => {",
  '  if (n < 0) { throw new Error("neg"); }',
  "  if (n === 99) { n = 98; }",
  "  if (n === 77) return 1; else n = n + 0;",
  "  return n;",
  "};",
  "// @openarc:end m.reject",
  "// @openarc:begin m.len",
  "export const len = (s: string | null): number => {",
  "  if (s === null) return 0;",
  "  return s.length;",
  "};",
  "// @openarc:end m.len",
  "// @openarc:begin m.pow",
  "export const pow: Two = (a, b) => {",
  "  return Math.pow(a, b);",
  "};",
  "// @openarc:end m.pow",
  "// @openarc:begin m.max",
  "export const max: Two = (a, b) => {",
  "  return Math.max(a, b);",
  "};",
  "// @openarc:end m.max",
  "const lit = (a: 1 | 2, b: number) => a + b;",
  "// @openarc:begin m.mix",
  "export const mix: Num = (n) => {",
  '  return "x".padEnd(n, "y").length + Math.max(n, n) + Math.max(...[n], n) + lit(1, n);',
  "};",
  "// @openarc:end m.mix",
  "// @openarc:begin m.nul",
  "export const nul = (a: string | null, n: number): boolean => {",
  "  return n >= 0;",
  "};",
  "// @openarc:end m.nul",
  "// @openarc:begin m.noarg",
  "export const noarg = (): boolean => {",
  "  const k = 5;",
  "  return k >= 0;",
  "};",
  "// @openarc:end m.noarg",
  "",
].join("\n");

const o = fakePorts({ files: { "package.json": '{"type":"module"}\n', "src/m.ts": SRC } });
const memFiles = () => (o.snapshot() as { files: Record<string, string> }).files;
const ports: Ports = {
  ...o.instance,
  proc: {
    async run(argv) {
      if (argv[0] === "cp") return { code: 0, stdout: "", timedOut: false }; // staging node_modules: the temp dir links it below
      const id = argv[argv.findIndex((a) => a.endsWith("/.openarc/harness.mjs")) + 1]!;
      const dir = join(tmp, `run${++runs}`); // a fresh dir per run: the ESM cache is keyed by path
      for (const [rel, text] of Object.entries(memFiles())) {
        const m = /^\.openarc\/sandbox\/[^/]+\/(.+)$/.exec(rel);
        if (!m || m[1]!.startsWith("node_modules/")) continue;
        mkdirSync(dirname(join(dir, m[1]!)), { recursive: true });
        writeFileSync(join(dir, m[1]!), text);
      }
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      symlinkSync(join(root, "core"), join(dir, "node_modules", "open-arc"), "junction");
      const r = spawnSync(process.execPath, ["--no-warnings", join(dir, ".openarc", "harness.mjs"), id, dir], { encoding: "utf8", timeout: 20_000 });
      return { code: r.status ?? 1, stdout: `${r.stdout}${r.stderr}`, timedOut: r.error !== undefined };
    },
  },
};

try {
  const p = await engine.parse(ports, req, []);
  await engine.analyze(ports, req, p, [], { offline: true });
  const check = (id: string, ops?: engine.MutantOp[]) => engine.mutantCheck(ports, req, p, id, ops);

  // ── 1. boundary: killed by the example at 0, survives without it
  const strong = await check("m.strong");
  assert.equal(strong.skipped, undefined);
  assert.deepEqual(strong.survived, [], engine.mutantLines(strong).join("\n"));
  assert.ok(strong.killed >= 5, "trivial false, throw, > 0, < 0, >= 1, >= -1");
  assert.match(engine.mutantLines(strong)[0]!, /^mutants m\.strong: killed (\d+)\/\1 \(100%\), survived 0, equivalent 0, invalid 0, timeout 0$/);
  const weak = await check("m.weak", ["boundary"]);
  assert.deepEqual(engine.mutantLines(weak), ["mutants m.weak: killed 0/1 (0%), survived 1, equivalent 0, invalid 0, timeout 0", "survived m.weak line 18: n >= 0 -> n > 0; try: args [0] (original true, mutant false)"]);

  // ── 2. a vacuous body passes the examples: "" and echoing s
  const trim = await check("m.trim", ["trivial"]);
  assert.deepEqual(engine.mutantLines(trim), [
    "mutants m.trim: killed 1/3 (33%), survived 2, equivalent 0, invalid 0, timeout 0",
    'survived m.trim line 22: body -> return ""; (the examples pass for a vacuous body); try: args ["a"] (original "a", mutant "")',
    'survived m.trim line 22: body -> return s; (the examples pass for a vacuous body); try: args [" "] (original "", mutant " ")',
  ]);

  // ── 3. `return {}` is not a { v: number }: invalid, not scored
  const box = await check("m.box", ["trivial"]);
  assert.deepEqual([box.invalid, box.killed, box.survived.length], [1, 1, 0]);
  assert.equal(engine.mutantLines(box)[0], "mutants m.box: killed 1/1 (100%), survived 0, equivalent 0, invalid 1, timeout 0");

  // ── 4. no clean baseline: skipped, nothing run past it
  assert.deepEqual(engine.mutantLines(await check("m.bad")), ["mutants m.bad: skipped (baseline does not pass: an example or test fails)"]);
  assert.deepEqual(engine.mutantLines(await check("m.todo")), ["mutants m.todo: skipped (not implemented (pending))"]);
  assert.deepEqual(engine.mutantLines(await check("m.nope")), ["mutants m.nope: skipped (no function region)"]);
  // the mutant list itself: deterministic, filtered by kind, and only the region's own code
  const sf = p.program!.getSourceFile(`${root}/src/m.ts`)!, r = p.regions.find((x) => x.id === "m.strong")!;
  const all = engine.mutants(r, sf, p.program!.getTypeChecker());
  assert.deepEqual(all.map((m) => `${m.op} ${m.after}`), [
    "trivial return false;", 'trivial throw new Error("openarc mutant");',
    "boundary n > 0", "comparison n < 0", "constant n >= 1", "constant n >= -1",
  ]);
  assert.deepEqual(engine.mutants(r, sf, p.program!.getTypeChecker(), ["constant"], 1).map((m) => m.after), ["n >= 1"]);

  // ── 5. guard: survives without an example past it, killed with one; only an if without else that exits, even as an else's body
  const reportOf = async (id: string, ops: engine.MutantOp[]) => engine.mutantLines(await check(id, ops));
  const clamp = await reportOf("m.clamp", ["guard"]);
  assert.match(clamp[0]!, /^mutants m\.clamp: killed 0\/1 \(0%\), survived 1, equivalent 0, invalid 0, timeout 0$/);
  assert.match(clamp[1]!, /^survived m\.clamp line \d+: if \(n < 0\) return 0; -> \(guard dropped\); try: args \[-\d+\] \(original 0, mutant -\d+\)$/);
  assert.deepEqual(await reportOf("m.clamp", ["guard"]), clamp, "deterministic");
  assert.equal((await reportOf("m.reject", ["guard"]))[0], "mutants m.reject: killed 1/1 (100%), survived 0, equivalent 0, invalid 0, timeout 0");
  const listed = (id: string, ops: engine.MutantOp[]) => {
    const x = p.regions.find((y) => y.id === id)!;
    return engine.mutants(x, p.program!.getSourceFile(`${root}/src/m.ts`)!, p.program!.getTypeChecker(), ops);
  };
  assert.deepEqual(listed("m.reject", ["guard"]).map((m) => m.before), ['if (n < 0) { throw new Error("neg"); }'], "no exit or an else: not a guard");
  // dropping the guard loses the narrowing: invalid, not scored
  assert.equal((await reportOf("m.len", ["guard"]))[0], "mutants m.len: killed 0/0 (100%), survived 0, equivalent 0, invalid 1, timeout 0");

  // ── 5. swap: a difference is printed, mixed types and equal or spread arguments are no mutant, a bad swap is invalid
  const pow = await reportOf("m.pow", ["swap"]);
  assert.match(pow[0]!, /^mutants m\.pow: killed 0\/1 \(0%\), survived 1, equivalent 0, invalid 0, timeout 0$/);
  assert.match(pow[1]!, /^survived m\.pow line \d+: Math\.pow\(a, b\) -> Math\.pow\(b, a\); try: args \[.+\] \(original .+, mutant .+\)$/);
  assert.deepEqual(listed("m.mix", ["swap"]).map((m) => m.after), ["lit(n, 1)"]);
  assert.equal((await reportOf("m.mix", ["swap"]))[0], "mutants m.mix: killed 0/0 (100%), survived 0, equivalent 0, invalid 1, timeout 0");

  // ── 6. equivalent: listed without an example and out of the score (3/3, not 3/4)
  assert.deepEqual(await reportOf("m.max", ["trivial", "swap"]), [
    "mutants m.max: killed 3/3 (100%), survived 0, equivalent 1, invalid 0, timeout 0",
    `equivalent m.max line ${listed("m.max", ["swap"])[0]!.line}: Math.max(a, b) -> Math.max(b, a)`,
  ]);
  // ── 6. no input to vary (a null argument): W044's edge values. Nothing beyond the example: not equivalent, the line to reach
  assert.deepEqual((await reportOf("m.nul", ["boundary"]))[1]!.split("; "), [`survived m.nul line ${listed("m.nul", ["boundary"])[0]!.line}: n >= 0 -> n > 0`, "try: 0, a negative number"]);
  const line = listed("m.noarg", ["boundary"])[0]!.line;
  assert.deepEqual(await reportOf("m.noarg", ["boundary"]), [
    "mutants m.noarg: killed 0/1 (0%), survived 1, equivalent 0, invalid 0, timeout 0",
    `survived m.noarg line ${line}: k >= 0 -> k > 0; try: an input or test that reaches line ${line}`,
  ]);

  // nothing written outside the stage, and the stage is gone
  assert.deepEqual(Object.keys(memFiles()).sort(), ["package.json", "src/m.ts"]);
  assert.equal(memFiles()["src/m.ts"], SRC);
  console.log("mutants.check: ok");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
