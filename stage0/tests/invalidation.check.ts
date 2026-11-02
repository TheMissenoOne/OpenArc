// Incremental invalidation matrix (issue #14). In-memory ports, a stub model, a stub sandbox.
// Run: node tests/invalidation.check.ts
// A baseline project is compiled for real, then each edit below is analysed against its manifest and the compiler's
// stale set is compared with an expected set computed here from a hand-written dependency map (DEPS), not by engine
// helpers. Soundness: nothing the edit can affect is missing. Precision: nothing else is stale.
//   1. unrelated file           5. model name / digest           9. callee body regenerated, contract unchanged
//   2. dependency contract      6. developer-owned body
//   3. generated sibling body   7. failed generation
//   4. region's examples        8. identical rerun
// Two GAPs are asserted as today's behaviour (search "GAP (#14)"): a cross-file caller is not re-fingerprinted by its
// callee's contract (case 2), and a callee regenerated under an unchanged contract doesn't re-run its callers (case 9).
import assert from "node:assert/strict";
import type { Json } from "open-arc";
import type { CompileRequest, Diagnostic, Ports } from "../src/types.ts";
import fakePorts from "./fakes/ports.memory.ts";
import { run } from "../src/compile.ts";
import * as engine from "../src/engine.ts";

const t0 = performance.now();
const root = process.cwd(); // the stage0 checkout, so "open-arc" and "typescript" resolve for the type checker
const req: CompileRequest = { root, ids: [], model: { host: "http://h", model: "m", seed: 1, numCtx: 8192 }, sandbox: { nodeBin: "/n/bin/node", nodePrefix: "/n", heapMb: 256, addressSpaceBytes: 2 ** 32, cpuSeconds: 10 } };
const M = ".openarc/manifest.json";
const tags = (digest = "d1") => JSON.stringify({ models: [{ name: "qwen3.5:9b", digest }, { name: "qwen3.5:27b", digest: "d27" }] });
const chat = (body: string) => JSON.stringify({ message: { role: "assistant", content: JSON.stringify({ body, imports: [] }) }, done: true });
const BAD = JSON.stringify({ message: { role: "assistant", content: "not json" }, done: true });
const CP = { code: 0, stdout: "", timedOut: false }; // the sandbox's cp -al node_modules
const harness = (...ok: boolean[]) => ({ code: 0, stdout: ok.map((o, i) => JSON.stringify({ name: `#${i + 1}`, ok: o, ...(o ? {} : { actual: 0 }) })).join("\n") + `\n{"done":${ok.length}}\n`, timedOut: false });
const config = (model = "qwen3.5:9b") => JSON.stringify({ version: 1, backends: { local: { provider: "ollama", model, maxContextTokens: 8192, seed: 1 } }, compilation: { defaultBackend: "local", maxAttempts: 3, batch: "off" } });
type Snap = { files: Record<string, string>; requests: { url: string; body: Json }[]; runs: string[][] };

// ── the project: geo.norm2 calls geo.sq (same file), use.quad calls geo.sq (another file); other.neg and src/notes.ts
//    are unrelated to all of them. Every region starts pending; the baseline compile writes the bodies.
const region = (id: string, sym: string, type: string, param: string) => [`// @openarc:begin ${id}`, `export const ${sym}: ${type} = (${param}) => arc.todo("${id}");`, `// @openarc:end ${id}`];
const pending = {
  "src/types.ts": "export type Point = { x: number; y: number };\n",
  "src/geo.ts": [
    'import * as arc from "open-arc";',
    'import type { Point } from "./types.ts";',
    "type Sq = (n: number) => number;",
    "type Norm2 = (p: Point) => number;",
    'export const sqSpec = arc.defineRegion<Sq>({ id: "geo.sq", intent: "n squared", examples: [{ args: [3], expected: 9 }] });',
    'export const norm2Spec = arc.defineRegion<Norm2>({ id: "geo.norm2", intent: "x squared plus y squared, using sq", examples: [{ args: [{ x: 3, y: 4 }], expected: 25 }] });',
    ...region("geo.sq", "sq", "Sq", "n"),
    ...region("geo.norm2", "norm2", "Norm2", "p"),
    "",
  ].join("\n"),
  "src/use.ts": [
    'import * as arc from "open-arc";',
    'import { sq } from "./geo.ts";',
    "type Quad = (n: number) => number;",
    'export const quadSpec = arc.defineRegion<Quad>({ id: "use.quad", intent: "n to the fourth, as sq of sq" });',
    ...region("use.quad", "quad", "Quad", "n"),
    "",
  ].join("\n"),
  "src/other.ts": [
    'import * as arc from "open-arc";',
    "type Neg = (n: number) => number;",
    'export const negSpec = arc.defineRegion<Neg>({ id: "other.neg", intent: "minus n" });',
    ...region("other.neg", "neg", "Neg", "n"),
    "",
  ].join("\n"),
  "src/notes.ts": 'export const NOTE = "a";\n',
  "openarc.config.json": config(),
  [M]: '{"schema":1,"regions":{}}',
};

// The independent dependency map: what each region's verified result can depend on. A function region is written
// against its own spec, the contracts (signature + intent) of what it can call (same-file siblings, imported regions)
// and every type those reach; never another region's body (case 3). Examples are part of the region's own spec only.
const DEPS: Record<string, string[]> = {
  "geo.sq": ["spec:geo.sq", "contract:geo.norm2", "type:Point", "model"],
  "geo.norm2": ["spec:geo.norm2", "contract:geo.sq", "type:Point", "model"],
  "use.quad": ["spec:use.quad", "contract:geo.sq", "model"],
  "other.neg": ["spec:other.neg", "model"],
};
// GAP (#14): at the default context level 0 a function region's fingerprint holds its same-file siblings' contracts but
// not those of the regions it imports from another file ("Helpers you may call" is level 1+), so a change to geo.sq's
// signature or intent leaves use.quad's fingerprint alone: it is not re-verified (soundness). The matrix asserts today's
// stale set: the closure without these edges. Drop an edge here when it is fingerprinted.
const CROSS_FILE_GAP: Record<string, string[]> = { "use.quad": ["contract:geo.sq"] };
const expected = (touched: string[], gaps: Record<string, string[]> = {}) =>
  Object.keys(DEPS).filter((id) => DEPS[id]!.some((d) => touched.includes(d) && !gaps[id]?.includes(d))).sort();

async function compile(files: Record<string, string>, http: string[], proc: { code: number; stdout: string; timedOut: boolean }[] = []) {
  const fake = fakePorts({ files, http, proc });
  const res = await run(fake.instance as Ports, req);
  const s = fake.snapshot() as Snap;
  return { res, files: s.files, calls: s.requests.filter((q) => q.url.endsWith("/api/chat")).length, runs: s.runs.length };
}
async function analyzed(files: Record<string, string>, digest = "d1") {
  const ports = fakePorts({ files, http: [tags(digest)] }).instance as Ports;
  const d: Diagnostic[] = [];
  const p = (await engine.parse(ports, req, d))!;
  await engine.analyze(ports, req, p, d);
  assert.deepStrictEqual(d.filter((x) => x.code.startsWith("OARC-E")), [], "analyze reached the fingerprints");
  const stale = p.regions.filter((r) => r.stale).map((r) => r.id).sort();
  return { p, d, stale, kept: Object.fromEntries(p.regions.filter((r) => r.stale).map((r) => [r.id, r.kept ?? null])) };
}

// ── baseline: compile everything. sq's body is subtly wrong (negative n) but passes its one example.
const SQ_OLD = "return Math.abs(n) * n;";
const base = await compile(pending, [tags(), chat(SQ_OLD), chat("return sq(p.x) + sq(p.y);"), chat("return -n;"), chat("return sq(sq(n));")], [CP, harness(true), CP, harness(true)]);
assert.equal(base.res.exit, 0, JSON.stringify(base.res.diagnostics));
assert.equal(base.calls, 4);
const B = base.files;
assert.deepStrictEqual(Object.keys(JSON.parse(B[M]!).regions).sort(), Object.keys(DEPS).sort());
assert.deepStrictEqual((await analyzed(B)).stale, [], "the baseline is clean");
const edit = (f: string, from: string, to: string) => {
  assert.ok(B[f]!.includes(from), `${f} has ${from}`);
  return { ...B, [f]: B[f]!.replace(from, to) };
};

// ── the matrix: each edit, what it touches in DEPS terms, the stale set compared with the closure
const cases: [string, Record<string, string>, string[], string?][] = [
  ["1. unrelated file", edit("src/notes.ts", '"a"', '"b"'), []],
  ["2a. a project type the signatures reach", edit("src/types.ts", "y: number }", "y: number; z?: number }"), ["type:Point"]],
  ["2b. the callee's signature", edit("src/geo.ts", "type Sq = (n: number) => number;", "type Sq = (n: number, m?: number) => number;"), ["spec:geo.sq", "contract:geo.sq"]],
  ["2c. the callee's intent", edit("src/geo.ts", '"n squared"', '"the square of n"'), ["spec:geo.sq", "contract:geo.sq"]],
  ["4. a region's examples", edit("src/geo.ts", "{ args: [3], expected: 9 }", "{ args: [3], expected: 9 }, { args: [-2], expected: 4 }"), ["spec:geo.sq"]],
  ["5a. the backend's model", { ...B, "openarc.config.json": config("qwen3.5:27b") }, ["model"]],
  ["5b. the model digest", B, ["model"], "d2"],
];
for (const [name, files, touched, digest] of cases) {
  const { stale, kept } = await analyzed(files, digest);
  if (touched.includes("contract:geo.sq")) assert.ok(expected(touched).includes("use.quad"), "the closure reaches the cross-file caller");
  assert.deepStrictEqual(stale, expected(touched, CROSS_FILE_GAP), `${name}: stale set (soundness and precision)`);
  if (name.startsWith("5")) assert.deepStrictEqual(Object.values(kept), [null, null, null, null], `${name}: regenerated, not kept`);
  // spec changed: regenerate; spec unchanged, only the context moved (same backend): re-verify the current body first
  if (name.startsWith("4") || name.startsWith("2b") || name.startsWith("2c")) assert.equal(kept["geo.sq"], null, `${name}: sq's spec moved, regenerated`);
  if (name.startsWith("2")) assert.deepStrictEqual(kept["geo.norm2"], "return sq(p.x) + sq(p.y);", `${name}: norm2's spec is unchanged, its body is re-verified first`);
}

// ── 3. a generated sibling's body changes (its spec doesn't): the caller is not stale. Same project, sq committed with
//    another body (as a regeneration would leave it): only sq's own manifest entry moves.
{
  const files = edit("src/geo.ts", SQ_OLD, "return n * n;");
  const m = JSON.parse(B[M]!);
  m.regions["geo.sq"].hash = (await analyzed(files)).p.regions.find((r) => r.id === "geo.sq")!.hash;
  const { stale, d } = await analyzed({ ...files, [M]: JSON.stringify(m) });
  assert.deepStrictEqual(stale, expected([]), "3. generated sibling body: nothing stale");
  assert.deepStrictEqual(d.filter((x) => x.code === "OARC-W060"), [], "3. still compiler-owned");
}

// ── 1 (full compile). an unrelated file: 0 model calls, 0 sandbox runs, every other file byte-identical
{
  const files = edit("src/notes.ts", '"a"', '"b"');
  const r = await compile(files, [tags()]);
  assert.deepStrictEqual([r.res.exit, r.calls, r.runs], [0, 0, 0]);
  assert.deepStrictEqual(r.files, files, "1. byte-identical");
}

// ── 8. identical rerun: 0 model calls, 0 sandbox runs, byte-identical
{
  const r = await compile(B, [tags()]);
  assert.deepStrictEqual([r.res.exit, r.calls, r.runs], [0, 0, 0]);
  assert.deepStrictEqual(r.files, B, "8. byte-identical");
}

// ── 6. a developer-owned body is never overwritten, even when the model changes under it (everything else regenerates)
{
  const hand = edit("src/geo.ts", "return sq(p.x) + sq(p.y);", "return p.x * p.x + p.y * p.y; // by hand");
  const a = await analyzed(hand, "d2");
  assert.deepStrictEqual(a.d.filter((x) => x.code === "OARC-W060").map((x) => x.id), ["geo.norm2"]);
  assert.deepStrictEqual(a.stale, expected(["model"]).filter((id) => id !== "geo.norm2"), "6. the developer region is never stale");
  const r = await compile(hand, [tags("d2"), chat("return n * n;"), chat("return 0 - n;"), chat("return sq(n) * sq(n);")], [CP, harness(true)]);
  assert.equal(r.res.exit, 0, JSON.stringify(r.res.diagnostics));
  assert.equal(r.calls, 3, "6. sq, neg and quad regenerate, norm2 does not");
  assert.ok(r.files["src/geo.ts"]!.includes("return p.x * p.x + p.y * p.y; // by hand"), "6. the hand edit survives");
  assert.ok(r.files["src/geo.ts"]!.includes("return n * n;"));
  assert.equal(JSON.parse(r.files[M]!).regions["geo.norm2"].ownership, "developer");
}

// ── 7. a failed generation writes nothing: sources and manifest byte-identical; only .openarc bookkeeping is new
{
  const files = edit("src/other.ts", '"minus n"', '"the negation of n"');
  assert.deepStrictEqual((await analyzed(files)).stale, expected(["spec:other.neg"]));
  const r = await compile(files, [tags(), BAD, BAD, BAD]);
  assert.equal(r.res.exit, 1);
  assert.deepStrictEqual(r.res.diagnostics.filter((x) => x.code.startsWith("OARC-E")).map((x) => `${x.code} ${x.id}`), ["OARC-E082 other.neg"]);
  for (const [f, text] of Object.entries(files)) assert.equal(r.files[f], text, `7. ${f} unchanged`);
  const extra = Object.keys(r.files).filter((f) => !(f in files)).sort();
  assert.ok(extra.length && extra.every((f) => f.startsWith(".openarc/") && f !== M), `7. only bookkeeping is new: ${extra}`);
  assert.ok(extra.includes(".openarc/failed.json"));
}

// ── 4 + 9 (full compile). sq gains an example its old body would fail: a spec change, so sq is regenerated (not kept).
//    Its contract (signature + intent) is unchanged, so norm2's fingerprint doesn't move and norm2's examples are not
//    re-run against the new callee.
{
  const files = edit("src/geo.ts", "{ args: [3], expected: 9 }", "{ args: [3], expected: 9 }, { args: [-2], expected: 4 }");
  const r = await compile(files, [tags(), chat("return n * n;")], [CP, harness(true, true)]);
  assert.equal(r.res.exit, 0, JSON.stringify(r.res.diagnostics));
  assert.equal(r.calls, 1, "4. regenerated");
  assert.ok(r.files["src/geo.ts"]!.includes("return n * n;") && !r.files["src/geo.ts"]!.includes(SQ_OLD), "4. the new body is committed");
  assert.equal(r.runs, 2, "9. sandbox runs: sq's examples (cp + harness); none for norm2");
  // GAP (#14): a callee body regenerated under an unchanged contract does not re-run its callers' examples. norm2 is not
  // stale after the commit, so nothing re-verifies it: a green callee is not proven to keep a green suite. When this is
  // closed, norm2 should be in this run's verification (r.runs 4) and this assertion flips.
  assert.deepStrictEqual((await analyzed(r.files)).stale, [], "9. after the commit nothing is stale: norm2 never re-ran");
  // and a rerun of the result is clean: 0 calls, byte-identical
  const again = await compile(r.files, [tags()]);
  assert.deepStrictEqual([again.res.exit, again.calls, again.runs], [0, 0, 0]);
  assert.deepStrictEqual(again.files, r.files);
}

console.log(`invalidation: matrix (unrelated, contract, sibling body, examples, model, developer, failed, rerun, callee regen; 2 GAPs) ok in ${Math.round(performance.now() - t0)} ms`);
