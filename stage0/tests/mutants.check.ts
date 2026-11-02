// `openarc check <ids> --mutants` (engine.mutantCheck), on in-memory ports. No model. The fake proc stands in for the
// sandbox: it copies the in-memory stage to a temp dir and runs the real harness there with this node (no isolation).
// Run: node tests/mutants.check.ts
// 1. A strong spec kills the boundary mutant; a weak one (no example at the boundary) lets it survive.
// 2. A trivial body that passes the examples is reported as vacuous.
// 3. A mutant that does not type-check is invalid, not scored.
// 4. A region whose examples fail already (or that is pending) is skipped. --operators selects the mutant kinds.
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
  assert.match(engine.mutantLines(strong)[0]!, /^mutants m\.strong: killed (\d+)\/\1 \(100%\), survived 0, invalid 0, timeout 0$/);
  const weak = await check("m.weak", ["boundary"]);
  assert.deepEqual(engine.mutantLines(weak), ["mutants m.weak: killed 0/1 (0%), survived 1, invalid 0, timeout 0", "survived m.weak line 18: n >= 0 -> n > 0"]);

  // ── 2. a vacuous body passes the examples: "" and echoing s
  const trim = await check("m.trim", ["trivial"]);
  assert.deepEqual(engine.mutantLines(trim), [
    "mutants m.trim: killed 1/3 (33%), survived 2, invalid 0, timeout 0",
    'survived m.trim line 22: body -> return ""; (the examples pass for a vacuous body)',
    "survived m.trim line 22: body -> return s; (the examples pass for a vacuous body)",
  ]);

  // ── 3. `return {}` is not a { v: number }: invalid, not scored
  const box = await check("m.box", ["trivial"]);
  assert.deepEqual([box.invalid, box.killed, box.survived.length], [1, 1, 0]);
  assert.equal(engine.mutantLines(box)[0], "mutants m.box: killed 1/1 (100%), survived 0, invalid 1, timeout 0");

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
  // nothing written outside the stage, and the stage is gone
  assert.deepEqual(Object.keys(memFiles()).sort(), ["package.json", "src/m.ts"]);
  assert.equal(memFiles()["src/m.ts"], SRC);
  console.log("mutants.check: ok");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
