// compile.run end to end on in-memory ports (no model, no sandbox). Run: node tests/compile-run.check.ts
// 1. A hand edit with nothing to compile still records the W060 transition (manifest-only transaction), so the
//    warning doesn't repeat and a later spec change is reported as E061.
// 2. --keep-going stops calling a dead backend after 3 consecutive E080s.
// 3. Context packages show the project's canonical import form for package deps.
// 4. --keep-going never commits a block whose sibling failed: it can't pass the joint check (F14), so it's held back.
import assert from "node:assert";
import type { Json } from "openarc";
import type { CompileRequest, Ports } from "../src/types.ts";
import fakePorts from "./fakes/ports.memory.ts";
import { run } from "../src/compile.ts";
import * as engine from "../src/engine.ts";

const root = process.cwd(); // the stage0 checkout, so "openarc" and "typescript" resolve for the type checker
const req: CompileRequest = { root, ids: [], model: { host: "http://h", model: "m", seed: 1, numCtx: 8192 }, sandbox: { nodeBin: "/n/bin/node", nodePrefix: "/n", heapMb: 256, addressSpaceBytes: 2 ** 32, cpuSeconds: 10 } };
const M = ".openarc/manifest.json";
type Snap = { files: Record<string, string>; requests: { url: string; body: Json }[] };

// ── 1. W060 persisted when there are no targets
{
  const src = (intent: string) => [
    'import * as arc from "openarc";',
    "type Inc = (n: number) => number;",
    `export const incSpec = arc.defineRegion<Inc>({ id: "fixture.inc", intent: "${intent}", examples: [{ args: [1], expected: 2 }] });`,
    "// @openarc:begin fixture.inc",
    "export const inc: Inc = (n) => n + 2; // hand edit",
    "// @openarc:end fixture.inc",
    "",
  ].join("\n");
  // the real hash/specHash of the region, from an offline analyze
  const probe = fakePorts({ files: { "src/fixture.ts": src("n + 1") } }).instance;
  const pp = await engine.parse(probe, req, []);
  await engine.analyze(probe, req, pp, [], { offline: true });
  const r = pp.regions[0]!;
  const entry = { kind: "function", parent: null, file: "src/fixture.ts", symbol: "inc", ownership: "compiler", hash: "sha256:before-the-hand-edit", specHash: r.specHash, fingerprint: "sha256:f", provenance: { source: "generated" } };
  const fake = fakePorts({ files: { "src/fixture.ts": src("n + 1"), [M]: JSON.stringify({ schema: 1, regions: { "fixture.inc": entry } }) } });
  const ports = fake.instance;

  const r1 = await run(ports, req);
  assert.deepStrictEqual(r1, { exit: 0, diagnostics: [{ code: "OARC-W060", id: "fixture.inc", file: "src/fixture.ts" }], modelCalls: 0 });
  const m1 = JSON.parse((fake.snapshot() as Snap).files[M]!);
  assert.deepStrictEqual(m1.regions["fixture.inc"], { ...entry, ownership: "developer", hash: r.hash }, "manifest records developer + the new hash, keeps the old specHash");
  assert.deepStrictEqual(Object.keys((fake.snapshot() as Snap).files).sort(), [M, "src/fixture.ts"], "lock and txn are gone");

  const r2 = await run(ports, req);
  assert.deepStrictEqual(r2, { exit: 0, diagnostics: [], modelCalls: 0 }, "the warning does not repeat");
  assert.equal((fake.snapshot() as Snap).files[M], JSON.stringify(m1, null, 2) + "\n", "nothing rewritten when nothing changed");

  await ports.fs.write("src/fixture.ts", src("n plus one"));
  const r3 = await run(ports, req);
  assert.deepStrictEqual(r3.diagnostics.map((d) => d.code), ["OARC-E061"], "spec change on the developer region is a conflict");
  assert.equal(r3.exit, 1);
}

// ── 2 + 3. dead backend under --keep-going; canonical import hint in the prompt
{
  const spec = (n: number) => [
    `type F${n} = (s: string) => number;`,
    `export const f${n}Spec = arc.defineRegion<F${n}>({ id: "fixture.f${n}", intent: "length", deps: ["typescript"], examples: [{ args: ["ab"], expected: 2 }] });`,
  ].join("\n");
  const files = {
    "src/fixture.ts": ['import * as arc from "openarc";', ...[1, 2, 3, 4, 5].map(spec), ""].join("\n"),
    "src/other.ts": 'import ts from "typescript";\nexport const k = ts.SyntaxKind.Identifier;\n',
    "src/third.ts": 'import ts from "typescript";\nimport type { Node } from "typescript";\nexport const n = (x: Node) => ts.isIdentifier(x);\n',
    [M]: '{"schema":1,"regions":{}}',
  };
  const tags = JSON.stringify({ models: [{ name: "qwen3.5:9b", digest: "d1" }] });
  const fake = fakePorts({ files, http: [tags] }); // every /api/chat call then fails: the backend is gone
  const res = await run(fake.instance as Ports, { ...req, keepGoing: true });
  const e080 = res.diagnostics.filter((d) => d.code === "OARC-E080");
  assert.deepStrictEqual(e080.map((d) => d.id ?? d.detail), ["fixture.f1", "fixture.f2", "fixture.f3", "stopped:3-consecutive"]);
  assert.equal(res.exit, 1);
  const chats = (fake.snapshot() as Snap).requests.filter((q) => q.url.endsWith("/api/chat"));
  assert.equal(chats.length, 3, "regions 4 and 5 never hit the dead backend");
  const prompt = JSON.stringify(chats[0]!.body);
  assert.match(prompt, /Allowed new imports\\ntypescript\\nUse exactly these import forms:\\nimport ts from \\"typescript\\";/);
}
// ── 4. a generated block whose sibling failed is held back, not committed
{
  const src = [
    'import * as arc from "openarc";',
    "type Run = (n: number) => number;",
    'export const runSpec = arc.defineRegion<Run>({ id: "fixture.run", intent: "double, then add one", examples: [{ args: [1], expected: 3 }] });',
    'export const aSpec = arc.defineBlock({ id: "fixture.run.a", intent: "x = n * 2" });',
    'export const bSpec = arc.defineBlock({ id: "fixture.run.b", intent: "x = x + 1" });',
    "// @openarc:begin fixture.run",
    "export function run(n: number): number {",
    "  let x = 0;",
    "  // @openarc:begin fixture.run.a",
    '  arc.pending("fixture.run.a");',
    "  // @openarc:end fixture.run.a",
    "  // @openarc:begin fixture.run.b",
    '  arc.pending("fixture.run.b");',
    "  // @openarc:end fixture.run.b",
    "  return x;",
    "}",
    "// @openarc:end fixture.run",
    "",
  ].join("\n");
  const chat = (content: string) => JSON.stringify({ message: { role: "assistant", content }, done: true });
  const fake = fakePorts({
    files: { "src/fixture.ts": src, [M]: '{"schema":1,"regions":{}}' },
    // tags; block a: a correct body; block b: three invalid outputs (attempts exhausted)
    http: [JSON.stringify({ models: [{ name: "qwen3.5:9b", digest: "d1" }] }), chat('{"body":"x = n * 2;"}'), chat("nope"), chat("nope"), chat("nope")],
    // a's sandbox run: cp -al node_modules, then the harness. The example fails only because b is still pending: inconclusive.
    proc: [{ code: 0, stdout: "", timedOut: false }, { code: 0, stdout: '{"name":"#1","ok":false,"actual":{"pending":"fixture.run.b"}}\n{"done":1}\n', timedOut: false }],
  });
  const res = await run(fake.instance as Ports, { ...req, keepGoing: true });
  const files = (fake.snapshot() as Snap).files;
  assert.deepStrictEqual(res.diagnostics.filter((d) => d.code !== "OARC-W040").map((d) => `${d.code} ${d.id}`), ["OARC-E082 fixture.run.b", "OARC-W042 fixture.run.a"]);
  assert.equal(files["src/fixture.ts"], src, "block a is NOT committed: its function was never verified with every block present");
  assert.deepStrictEqual(Object.keys(JSON.parse(files[M]!).regions), ["fixture.run"], "a stays pending: no manifest entry (only the hand-written parent is recorded)");
  assert.equal(Object.keys(files).filter((f) => f.startsWith(".openarc/cache/")).length, 1, "a's verified body stays in the cache for the next run");
  assert.equal(res.exit, 1);
}
console.log("compile-run: manifest-only transition, E080 stop, canonical imports, held-back blocks ok");
