// Fixes from the three-project evaluation (openarc-eval/REPORT.md), on in-memory ports: no model, no sandbox.
// Run: node tests/eval-fixes.check.ts
// 1. Context and scope: L0 shows the file's imports and implemented same-file values; a closure type that isn't in scope
//    is marked and imported by the compiler; imports from modules the file already imports pass; default imports merge.
// 2. Retries: every retry varies sampling (temperature 0.4, then 0.7, seed + attempt - 1; 0.9.1); failed attempts are
//    logged and saved under .openarc/attempts/<id>/ (last 20). Repeat-stop is in tests/efficiency.check.ts.
// 3. A compiler-owned region whose recompile failed: OARC-W043, displayed as stale.
// 4. Thin examples (OARC-W044) and `openarc check --oracle` (inputs, plan, report).
// 5. Date.parse without 'clock'; scaffold without a clean tsc; COMPILER_VERSION from core/package.json.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import type { Json } from "open-arc";
import { runOracle } from "open-arc/harness";
import type { CompileRequest, Ports } from "../src/types.ts";
import fakePorts from "./fakes/ports.memory.ts";
import { run } from "../src/compile.ts";
import * as engine from "../src/engine.ts";

const root = process.cwd(); // the stage0 checkout, so "open-arc" and "typescript" resolve for the type checker
const req: CompileRequest = { root, ids: [], model: { host: "http://h", model: "m", seed: 1, numCtx: 8192 }, sandbox: { nodeBin: "/n/bin/node", nodePrefix: "/n", heapMb: 256, addressSpaceBytes: 2 ** 32, cpuSeconds: 10 } };
const M = ".openarc/manifest.json";
const TAGS = JSON.stringify({ models: [{ name: "qwen3.5:9b", digest: "d1" }] });
const chat = (content: string) => JSON.stringify({ message: { role: "assistant", content }, done: true });
type Snap = { files: Record<string, string>; requests: { url: string; body: Json }[] };
type ChatBody = { options: { temperature: number; seed: number; num_predict: number }; messages: { content: string }[] };
const chats = (s: Snap) => s.requests.filter((q) => q.url.endsWith("/api/chat")).map((q) => q.body as unknown as ChatBody);

// ── 1. context and scope
{
  const fx = [
    'import * as arc from "open-arc";',
    'import type { Entry } from "./fx-types.ts";',
    'import { twice } from "./fx-lib.ts";',
    "type Total = (es: Entry[]) => number;",
    "type Lefts = (es: Entry[]) => Entry[];",
    "type Later = (n: number) => number;",
    'export const totalSpec = arc.defineRegion<Total>({ id: "fx.total", intent: "sum of kg" });',
    'export const leftsSpec = arc.defineRegion<Lefts>({ id: "fx.lefts", intent: "left-side entries, kg unchanged" });',
    'export const laterSpec = arc.defineRegion<Later>({ id: "fx.later", intent: "not written yet" });',
    "const helper = (e: Entry): boolean => e.kg > 0;",
    "// @openarc:begin fx.total",
    "export const total: Total = (es) => {",
    "  return es.filter(helper).reduce((s, e) => s + e.kg, 0);",
    "};",
    "// @openarc:end fx.total",
    "",
  ].join("\n");
  const files = {
    "src/fx-types.ts": 'export type Side = "L" | "R";\nexport interface Entry { side: Side; kg: number }\n',
    "src/fx-lib.ts": "export const twice = (n: number): number => n * 2;\nexport default function half(n: number): number { return n / 2; }\n",
    "src/fx.ts": fx,
    [M]: '{"schema":1,"regions":{}}',
  };
  // The body names Side (not imported by fx.ts), asks for a default import, and a named import from a module the file
  // already imports (fx-lib.ts is not in deps).
  const reply = JSON.stringify({
    body: 'const want: Side = "L";\nreturn es.filter((e) => e.side === want).map((e) => ({ ...e, kg: half(twice(e.kg)) }));',
    imports: [{ from: "./fx-lib.ts", names: ["twice"], default: "half" }],
  });
  const fake = fakePorts({ files, http: [TAGS, chat(reply)] });
  const res = await run(fake.instance as Ports, { ...req, ids: ["fx.lefts"] });
  const snap = fake.snapshot() as Snap;
  assert.equal(res.exit, 0, JSON.stringify(res.diagnostics));
  const prompt = chats(snap)[0]!.messages[1]!.content;
  assert.match(prompt, /## Imports already in the file\nimport \* as arc from "open-arc";\nimport type \{ Entry \} from "\.\/fx-types\.ts";\nimport \{ twice \} from "\.\/fx-lib\.ts";/, "L0 shows the file's imports");
  assert.match(prompt, /## Already in src\/fx\.ts \(call these, don't re-implement them\)\nconst helper: \(e: Entry\) => boolean\nconst total: Total/, "L0 shows implemented same-file values");
  assert.match(prompt, /const total: Total\n\n## Intent/, "pending regions and the region itself are not offered");
  assert.match(prompt, /\/\/ Side: not in scope; the compiler adds import type \{ Side \} from "\.\/fx-types\.ts" if you use it\nexport type Side/);
  assert.doesNotMatch(prompt, /\/\/ Entry: not in scope/, "Entry is imported");
  const out = snap.files["src/fx.ts"]!;
  assert.match(out, /^import half from "\.\/fx-lib\.ts";$/m, "default import");
  assert.match(out, /^import type \{ Side \} from "\.\/fx-types\.ts";$/m, "closure type imported by the compiler");
  assert.equal(out.match(/import \{ twice \}/g)?.length, 1, "already-imported names are not imported twice");

  // a module the file doesn't import and deps don't list is still E071; a closure type from the wrong path too
  const bad = fakePorts({ files, http: [TAGS, ...["./elsewhere.ts", "./fx-lib.ts"].map((from) => chat(JSON.stringify({ body: "return es;", imports: [{ from, names: ["x"] }] }))), chat(JSON.stringify({ body: "return es;", imports: [{ from: "./types.ts", names: ["Side"] }] }))] });
  const r2 = await run(bad.instance as Ports, { ...req, ids: ["fx.lefts"] });
  assert.equal(r2.exit, 1);
  const attempts = (bad.snapshot() as Snap).files;
  const problems = [1, 2, 3].map((n) => (JSON.parse(attempts[`.openarc/attempts/fx.lefts/${n}.json`]!) as { problems: string[] }).problems[0]!);
  assert.match(problems[0]!, /^OARC-E071 import "\.\/elsewhere\.ts" is not allowed/);
  assert.match(problems[1]!, /^OARC-E070 TS(2305|2614)/, "an already-imported module passes the import rule (tsc then rejects the unknown name)");
  assert.match(problems[2]!, /^OARC-E071 import "\.\/types\.ts"/);
}

// ── 2 + 3. retries vary sampling; attempts saved; a failing compiler region is W043 / stale
{
  const src = (intent: string) => [
    'import * as arc from "open-arc";',
    "type Inc = (n: number) => number;",
    `export const incSpec = arc.defineRegion<Inc>({ id: "fx2.inc", intent: "${intent}" });`,
    "// @openarc:begin fx2.inc",
    "export const inc: Inc = (n) => {",
    "  return n + 1;",
    "};",
    "// @openarc:end fx2.inc",
    "",
  ].join("\n");
  const probe = fakePorts({ files: { "src/fx2.ts": src("add one") } }).instance;
  const pp = await engine.parse(probe, req, []);
  await engine.analyze(probe, req, pp, [], { offline: true });
  const entry = { kind: "function", parent: null, file: "src/fx2.ts", symbol: "inc", ownership: "compiler", hash: pp.regions[0]!.hash, specHash: pp.regions[0]!.specHash, fingerprint: "sha256:f", provenance: { source: "generated" } };
  const files = {
    "src/fx2.ts": src("add two"), // the spec changed since the body was verified
    [M]: JSON.stringify({ schema: 1, regions: { "fx2.inc": entry } }),
    "openarc.config.json": JSON.stringify({ version: 1, backends: { local: { provider: "ollama", model: "qwen3.5:9b", maxContextTokens: 8192, outputReserveTokens: 1500 } }, compilation: { defaultBackend: "local", maxAttempts: 4 } }),
    // 20 older attempts: the dump keeps the last 20
    ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`.openarc/attempts/fx2.inc/${i + 1}.json`, "{}"])),
  };
  const logs: string[] = [];
  const fake = fakePorts({ files, http: [TAGS, chat("nope"), chat("nope2"), chat("nope3"), chat("nope4")] }); // distinct: a repeat would stop early
  const ports = { ...(fake.instance as Ports), log: (l: string) => logs.push(l) };
  const res = await run(ports, { ...req, keepGoing: true });
  const snap = fake.snapshot() as Snap;
  const sent = chats(snap).map((b) => b.options);
  assert.deepStrictEqual(sent.map((o) => [o.temperature, o.seed, o.num_predict]), [[0, 1, 1500], [0.4, 2, 1500], [0.7, 3, 1500], [0.7, 4, 1500]],
    "attempt 1 samples as configured; every retry varies, whether or not its prompt repeats");
  assert.equal(logs.filter((l) => /✗ output was not valid: invalid-json \(\d chars/.test(l)).length, 4, "every invalid output is logged with its reason");
  assert.ok(logs.some((l) => /retry sampling: temperature 0\.4, seed 2/.test(l)));
  const dumped = Object.keys(snap.files).filter((f) => f.startsWith(".openarc/attempts/fx2.inc/")).map((f) => Number(f.split("/").at(-1)!.split(".")[0])).sort((a, b) => a - b);
  assert.deepStrictEqual(dumped, Array.from({ length: 20 }, (_, i) => i + 5), "numbered after the old ones, capped at 20");
  const a24 = JSON.parse(snap.files[".openarc/attempts/fx2.inc/24.json"]!);
  assert.deepStrictEqual([a24.attempt, a24.raw, a24.problems, a24.sampling], [4, "nope4", ["output was not valid: invalid-json"], { temperature: 0.7, seed: 4 }]);
  assert.deepStrictEqual(res.diagnostics.map((d) => d.code), ["OARC-W044", "OARC-E082", "OARC-W043"]);
  assert.equal(res.exit, 1);
  assert.equal(snap.files["src/fx2.ts"], src("add two"), "the old body stays");
  // graph/inspect (offline analyze) show it as stale; ownership itself is unchanged
  const p = await engine.parse(fake.instance, req, []);
  await engine.analyze(fake.instance, req, p, [], { offline: true });
  assert.equal(p.regions[0]!.state, "compiler");
  assert.equal(engine.displayState(p, p.regions[0]!), "stale");
  // and once the spec matches the manifest again it is plain compiler
  await fake.instance.fs.write("src/fx2.ts", src("add one"));
  const q = await engine.parse(fake.instance, req, []);
  await engine.analyze(fake.instance, req, q, [], { offline: true });
  assert.equal(engine.displayState(q, q.regions[0]!), "compiler");

  // a varied attempt that succeeds records its sampling in provenance and in the cache entry
  const ok = fakePorts({ files: { ...files, "openarc.config.json": files["openarc.config.json"].replace('"maxAttempts":4', '"maxAttempts":3') }, http: [TAGS, chat("nope"), chat("nope2"), chat('{"body":"return n + 2;"}')] });
  const r2 = await run(ok.instance as Ports, req);
  const s2 = ok.snapshot() as Snap;
  assert.equal(r2.exit, 0, JSON.stringify(r2.diagnostics));
  const prov = JSON.parse(s2.files[M]!).regions["fx2.inc"].provenance;
  assert.deepStrictEqual([prov.attempts, prov.sampling], [3, { temperature: 0.7, seed: 3 }]);
  const cache = Object.entries(s2.files).find(([f]) => f.startsWith(".openarc/cache/"))![1];
  assert.deepStrictEqual(JSON.parse(cache).sampling, { temperature: 0.7, seed: 3 });
}

// ── 4. thin examples and the oracle check
{
  assert.equal(engine.thinExamples([{ args: [1], expected: 2 }]), "examples:1");
  assert.equal(engine.thinExamples([{ args: [1] }, { args: [2] }, { args: ["a"] }]), "no-edge-case");
  for (const edge of [0, "", [], {}, null, -3, "$NaN"]) assert.equal(engine.thinExamples([{ args: [1] }, { args: [2] }, { args: [[{ k: edge }]] }]), null, `edge ${JSON.stringify(edge)}`);
  const w = fakePorts({ files: { "src/w.ts": 'import * as arc from "open-arc";\ntype F = (n: number) => number;\nexport const fSpec = arc.defineRegion<F>({ id: "w.f", intent: "x", examples: [{ args: [1], expected: 1 }] });\n' } });
  const p = await engine.parse(w.instance, req, []);
  await engine.analyze(w.instance, req, p, [], { offline: true });
  const ds: { code: string; detail?: string }[] = [];
  engine.plan(p, req, ds as never);
  assert.deepStrictEqual(ds, [{ code: "OARC-W044", id: "w.f", detail: "examples:1" }]);

  // inputs: the examples first, then deterministic shape-preserving variations
  const exs = [{ args: [[[0, 0], [1, 0], [2, 0]], "speed", true] }, { args: [[[0, 1], [1, 1]], "power", false] }, { args: [{ $fake: "x" }] }];
  const a = engine.oracleInputs(exs, 40, 7);
  assert.deepStrictEqual(a, engine.oracleInputs(exs, 40, 7), "same seed, same inputs");
  assert.notDeepStrictEqual(a, engine.oracleInputs(exs, 40, 8));
  assert.equal(a.length, 40);
  assert.deepStrictEqual(a.slice(0, 2), [exs[0]!.args, exs[1]!.args], "fake args are skipped");
  for (const args of a) {
    assert.equal(args.length, 3);
    assert.ok((args[0] as Json[]).every((pt) => Array.isArray(pt) && pt.length === 2 && pt.every((n) => typeof n === "number")), "points stay [x, y]");
    assert.equal(typeof args[1], "string");
    assert.equal(typeof args[2], "boolean");
  }
  assert.ok(a.some((args) => (args[0] as Json[]).length !== 2 && (args[0] as Json[]).length !== 3), "the top-level array's length varies (the examples' lengths differ)");

  // the harness side: agree on equal values (with tolerance) and on both throwing
  const sq = (n: number) => { if (n < 0) throw new Error("neg"); return Math.sqrt(n) * Math.sqrt(n); };
  const ref = (n: number) => { if (n < 0) throw new Error("negative"); return n === 9 ? -1 : n; };
  assert.deepStrictEqual(await runOracle(sq, ref, [[2], [-1], [9], ["$NaN"]]), [
    { name: "#1", ok: true },
    { name: "#2", ok: true },
    { name: "#3", ok: false, actual: { args: [9], got: 9, oracle: -1 } },
    { name: "#4", ok: true },
  ]);

  // the engine side: plan entry with the oracle, the module copied into the stage, the report
  const files = {
    "src/g.ts": 'import * as arc from "open-arc";\ntype F = (n: number) => number;\nexport const fSpec = arc.defineRegion<F>({ id: "g.f", intent: "x", examples: [{ args: [1], expected: 1 }, { args: [4], expected: 4 }] });\n// @openarc:begin g.f\nexport const f: F = (n) => n;\n// @openarc:end g.f\n',
    "legacy/g.js": "export const f = (n) => n;\n",
  };
  const o = fakePorts({ files, proc: [{ code: 0, stdout: "", timedOut: false }, { code: 0, stdout: '{"name":"#1","ok":true}\n{"name":"#2","ok":false,"actual":{"args":[-1],"got":"$-0","oracle":"$NaN"}}\n{"done":2}\n', timedOut: false }] });
  const written = new Map<string, string>();
  const ports = { ...(o.instance as Ports), fs: { ...o.instance.fs, write: async (f: string, t: string) => (written.set(f, t), o.instance.fs.write(f, t)) } };
  const op = await engine.parse(ports, req, []);
  await engine.analyze(ports, req, op, [], { offline: true });
  const rep = await engine.oracleCheck(ports, req, op, "g.f", "legacy/g.js#f", { count: 5 });
  assert.deepStrictEqual([rep.inputs, rep.agreed, rep.error], [5, 1, undefined]);
  assert.equal(engine.showDisagreement(rep.disagreements[0]!), "#2 args [-1]: got -0; oracle NaN");
  const planFile = [...written].find(([f]) => f.endsWith(".openarc/harness-plan.json"))!;
  const entry = JSON.parse(planFile[1])["g.f"];
  assert.deepStrictEqual([entry.oracle.module, entry.oracle.export, entry.oracle.inputs.length], ["legacy/g.js", "f", 5]);
  assert.ok([...written.keys()].some((f) => f.endsWith("/legacy/g.js")), "the oracle module is staged into the sandbox");
  assert.ok(!Object.keys((o.snapshot() as Snap).files).some((f) => f.startsWith(".openarc/sandbox/")), "the stage is removed");
  assert.match((await engine.oracleCheck(ports, req, op, "g.f", "../x.js#f")).error!, /inside the project/);
  assert.match((await engine.oracleCheck(ports, req, op, "g.f", "legacy/g.js")).error!, /<module>#<export>/);
}

// ── 5. smaller items
{
  const codes = (body: string, effects: string[] = []) => engine.staticCheck(body, effects).map((x) => `${x.diag.code} ${x.diag.detail}`);
  assert.deepStrictEqual(codes("const t: Date = new Date(Date.parse(s)); return Date.UTC(2020, 1) + t.getTime();"), [], "pure Date use needs no effect");
  assert.deepStrictEqual(codes("return Date.now();"), ["OARC-E074 Date"]);
  assert.deepStrictEqual(codes("return new Date().getTime();"), ["OARC-E074 Date"]);
  assert.deepStrictEqual(codes("return Date.now();", ["clock"]), []);
  assert.match(engine.staticCheck("const f = require('./x.ts').f;", [])[0]!.message, /put the module in "imports" instead/);

  // scaffold doesn't need a clean tsc: b.ts imports a symbol that only exists once a.ts is scaffolded
  const files = {
    "src/a.ts": 'import * as arc from "open-arc";\ntype Classify = (name: string) => string | null;\nexport const classifySpec = arc.defineRegion<Classify>({ id: "a.classify", intent: "x" });\n',
    "src/b.ts": 'import * as arc from "open-arc";\nimport { classify } from "./a.ts";\ntype All = (names: string[]) => (string | null)[];\nexport const allSpec = arc.defineRegion<All>({ id: "b.all", intent: "x" });\nexport const first = classify("x");\n',
  };
  const s = fakePorts({ files });
  const ds: unknown[] = [];
  const sp = await engine.parse(s.instance, req, []);
  assert.deepStrictEqual(await engine.scaffoldProject(s.instance, sp, ds as never), ["a.classify", "b.all"]);
  assert.deepStrictEqual(ds, []);
  const after = await engine.parse(s.instance, req, []);
  const prog = engine.makeProgram(after, after.files);
  const errors = prog.getSemanticDiagnostics().filter((d) => d.file?.fileName.includes("/src/"));
  assert.deepStrictEqual(errors.map((d) => d.code), [], "after scaffold the project type-checks");

  assert.equal(engine.COMPILER_VERSION, JSON.parse(readFileSync(`${root}/core/package.json`, "utf8")).version);
}
console.log("eval-fixes: context/scope, retry variation, attempts dump, stale/W043, W044, oracle check, Date.parse, scaffold ok");
