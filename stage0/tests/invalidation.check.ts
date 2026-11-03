// Incremental invalidation matrix (issue #14). In-memory ports, a stub model, a stub sandbox.
// Run: node tests/invalidation.check.ts
// A baseline project is compiled for real, then each edit below is analysed against its manifest and the compiler's
// stale set is compared with an expected set computed here from a hand-written dependency map (DEPS), not by engine
// helpers. Soundness: nothing the edit can affect is missing. Precision: nothing else is stale.
//   1. unrelated file           5. model name / digest           9. callee body regenerated, contract unchanged
//   2. dependency contract      6. developer-owned body
//   3. generated sibling body   7. failed generation
//   4. region's examples        8. identical rerun
// Both former GAPs (#14) are closed: a cross-file caller is re-fingerprinted by its callee's contract (case 2), and a
// callee regenerated under an unchanged contract re-runs its callers with their current bodies (case 9).
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
// (#14) the stable view holds the contracts of the regions a file imports from other files at every context level, so
// use.quad's fingerprint follows geo.sq's signature and intent like a same-file sibling's.
const expected = (touched: string[]) => Object.keys(DEPS).filter((id) => DEPS[id]!.some((d) => touched.includes(d))).sort();

async function compile(files: Record<string, string>, http: string[], proc: { code: number; stdout: string; timedOut: boolean }[] = [], keepGoing = false) {
  const fake = fakePorts({ files, http, proc });
  const res = await run(fake.instance as Ports, { ...req, keepGoing });
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
  assert.deepStrictEqual(stale, expected(touched), `${name}: stale set (soundness and precision)`);
  if (name.startsWith("5")) assert.deepStrictEqual(Object.values(kept), [null, null, null, null], `${name}: regenerated, not kept`);
  // spec changed: regenerate; spec unchanged, only the context moved (same backend): re-verify the current body first
  if (name.startsWith("4") || name.startsWith("2b") || name.startsWith("2c")) assert.equal(kept["geo.sq"], null, `${name}: sq's spec moved, regenerated`);
  if (name.startsWith("2")) assert.deepStrictEqual(kept["geo.norm2"], "return sq(p.x) + sq(p.y);", `${name}: norm2's spec is unchanged, its body is re-verified first`);
  if (name.startsWith("2b") || name.startsWith("2c")) assert.deepStrictEqual(kept["use.quad"], "return sq(sq(n));", `${name}: quad (another file) is kept and re-verified`);
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
//    Its contract (signature + intent) is unchanged, so its callers' fingerprints don't move, but its body did: the
//    callers are re-verified with their current bodies in the same run (#14), no model call. norm2 re-runs its examples;
//    quad has none (type check only).
const ex4 = edit("src/geo.ts", "{ args: [3], expected: 9 }", "{ args: [3], expected: 9 }, { args: [-2], expected: 4 }");
{
  const r = await compile(ex4, [tags(), chat("return n * n;")], [CP, harness(true, true), CP, harness(true)]);
  assert.equal(r.res.exit, 0, JSON.stringify(r.res.diagnostics));
  assert.equal(r.calls, 1, "4. regenerated; 9. callers re-verified without a model call");
  assert.ok(r.files["src/geo.ts"]!.includes("return n * n;") && !r.files["src/geo.ts"]!.includes(SQ_OLD), "4. the new body is committed");
  assert.equal(r.runs, 4, "9. sandbox runs: sq's examples, then norm2's against the new sq (cp + harness each)");
  assert.ok(r.files["src/geo.ts"]!.includes("return sq(p.x) + sq(p.y);") && r.files["src/use.ts"] === B["src/use.ts"], "9. the callers' bodies are kept");
  assert.deepStrictEqual((await analyzed(r.files)).stale, [], "9. after the commit nothing is stale");
  // and a rerun of the result is clean: 0 calls, byte-identical
  const again = await compile(r.files, [tags()]);
  assert.deepStrictEqual([again.res.exit, again.calls, again.runs], [0, 0, 0]);
  assert.deepStrictEqual(again.files, r.files);
}

// ── 9b. a caller fails its re-verification against the regenerated callee: like any failed target, it goes on to the
//    model (repair) and the repaired body is committed with the callee's, in one transaction
{
  const r = await compile(ex4, [tags(), chat("return n * n;"), chat("return sq(p.x) + sq(p.y) + 0;")], [CP, harness(true, true), CP, harness(false), CP, harness(true)]);
  assert.equal(r.res.exit, 0, JSON.stringify(r.res.diagnostics));
  assert.deepStrictEqual([r.calls, r.runs], [2, 6], "9b. sq generated; norm2 re-verified, failed, repaired");
  assert.ok(r.files["src/geo.ts"]!.includes("return n * n;") && r.files["src/geo.ts"]!.includes("return sq(p.x) + sq(p.y) + 0;"));
  // without a repair the run fails and writes nothing (the callee's new body included)
  const f = await compile(ex4, [tags(), chat("return n * n;"), BAD, BAD], [CP, harness(true, true), CP, harness(false)]);
  assert.equal(f.res.exit, 1);
  assert.deepStrictEqual(f.res.diagnostics.filter((x) => x.code.startsWith("OARC-E")).map((x) => `${x.code} ${x.id}`), ["OARC-E082 geo.norm2"]);
  assert.equal(f.files["src/geo.ts"], ex4["src/geo.ts"], "9b. nothing written");
}

// ── 9c. a caller verified BEFORE its callee changed (norm2 now precedes sq in the file, so it is the earlier target):
//    the final check at STAGE re-runs it against sq's new body. A failure aborts; under --keep-going both are held back.
{
  const g = ex4["src/geo.ts"]!;
  const n2 = /\/\/ @openarc:begin geo\.norm2\n[^]*?\/\/ @openarc:end geo\.norm2\n/.exec(g)![0];
  const swapped = { ...ex4, "src/geo.ts": g.replace(n2, "").replace("// @openarc:begin geo.sq", `${n2}// @openarc:begin geo.sq`).replace("using sq", "via sq") };
  const runs = [CP, harness(true), CP, harness(true, true), CP, harness(false)]; // norm2 generated, sq generated, norm2 at STAGE
  const http = [tags(), chat("return sq(p.x) + sq(p.y);"), chat("return n * n;")];
  const r = await compile(swapped, http, runs);
  assert.deepStrictEqual([r.res.exit, r.runs], [1, 6], JSON.stringify(r.res.diagnostics));
  assert.deepStrictEqual(r.res.diagnostics.filter((x) => x.code.startsWith("OARC-E")).map((x) => `${x.code} ${x.id} ${x.detail}`), ["OARC-E090 geo.norm2 callee:geo.sq:#1"]);
  assert.equal(r.files["src/geo.ts"], swapped["src/geo.ts"], "9c. nothing written");
  const k = await compile(swapped, http, runs, true);
  assert.ok(!k.files["src/geo.ts"]!.includes("return n * n;"), "9c. --keep-going: sq's new body is held back");
}

// ── 9d. a default import through a nodenext ".js" specifier is still a cross-file caller: quad follows sq's contract
{
  const v = await compile({ ...B, "src/geo.ts": `${B["src/geo.ts"]}export default sq;\n`, "src/use.ts": B["src/use.ts"]!.replace('import { sq } from "./geo.ts";', 'import sq from "./geo.js";') }, [tags()]);
  assert.equal(v.res.exit, 0, JSON.stringify(v.res.diagnostics));
  assert.deepStrictEqual((await analyzed(v.files)).stale, [], "9d. the variant is clean");
  const c = { ...v.files, "src/geo.ts": v.files["src/geo.ts"]!.replace('"n squared"', '"the square of n"') };
  assert.ok((await analyzed(c)).stale.includes("use.quad"), "9d. sq's intent moved: its default-import caller is stale");
}

console.log(`invalidation: matrix (unrelated, contract, sibling body, examples, model, developer, failed, rerun, callee regen, caller repair, caller order, default import) ok in ${Math.round(performance.now() - t0)} ms`);
