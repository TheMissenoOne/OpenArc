// Per-file batching and cheaper retries of 0.9.2 (issue #19). In-memory ports and a stub model; the regions have no
// examples except in 5, so verification is tsc + static rules (5 fakes the sandbox's output).
// Run: node tests/batch.check.ts
// 1. Batched request shape: a file's two pending function regions share ONE request (shared sections once, one
//    "## Region <id>" each, a reply schema keyed by id); each is verified and committed on its own; provenance says so.
// 2. Partial failure: the region that fails is re-requested alone (single-region prompt); the one that passed is not.
// 3. Write scope: a batched body that escapes its region is rejected for that region only; its sibling still commits.
// 4. "code" format: one "### <id>" section per region; batch "off" (and a different fingerprint) is one request each.
// 5. Resample: a body that failed only its examples is retried without the body (a short note of what failed); a
//    tsc failure keeps the full repair with the body.
import assert from "node:assert/strict";
import type { Json } from "open-arc";
import type { CompileRequest, Ports } from "../src/types.ts";
import fakePorts from "./fakes/ports.memory.ts";
import { run } from "../src/compile.ts";
import { repairText } from "../src/engine.ts";
import { parseConfig } from "../src/config.ts";
import { splitCodeSections } from "../src/output-format.ts";

const root = process.cwd(); // the stage0 checkout, so "open-arc" and "typescript" resolve for the type checker
const req: CompileRequest = { root, ids: [], keepGoing: true, model: { host: "http://h", model: "m", seed: 1, numCtx: 8192 }, sandbox: { nodeBin: "/n/bin/node", nodePrefix: "/n", heapMb: 256, addressSpaceBytes: 2 ** 32, cpuSeconds: 10 } };
const M = ".openarc/manifest.json";
const TAGS = JSON.stringify({ models: [{ name: "qwen3.5:9b", digest: "d1" }] });
const reply = (content: string, usage = {}) => JSON.stringify({ message: { role: "assistant", content }, done: true, ...usage });
const one = (body: string) => reply(JSON.stringify({ body, imports: [] }));
const both = (inc: string, dbl: string, usage = {}) => reply(JSON.stringify({ "bt.inc": { body: inc, imports: [] }, "bt.dbl": { body: dbl, imports: [] } }), usage);
type Chat = { format?: { required?: string[]; properties?: Record<string, Json> }; options: { temperature: number; seed: number }; messages: { content: string }[] };
type Snap = { files: Record<string, string>; requests: { url: string; body: Json }[] };

const SRC = [
  'import * as arc from "open-arc";',
  "type Inc = (n: number) => number;",
  "type Dbl = (n: number) => number;",
  'export const incSpec = arc.defineRegion<Inc>({ id: "bt.inc", intent: "add one" });',
  'export const dblSpec = arc.defineRegion<Dbl>({ id: "bt.dbl", intent: "double it" });',
  "",
].join("\n");
const OTHER = 'import * as arc from "open-arc";\ntype Neg = (n: number) => number;\nexport const negSpec = arc.defineRegion<Neg>({ id: "ot.neg", intent: "negate" });\n';
async function compile(http: string[], opts: { maxAttempts?: number; other?: boolean; backend?: Json; batch?: string; files?: Record<string, string>; proc?: { code: number; stdout: string; timedOut: boolean }[] } = {}) {
  const config = { version: 1, backends: { local: { provider: "ollama", model: "qwen3.5:9b", maxContextTokens: 8192, seed: 1, ...(opts.backend as object) } }, compilation: { defaultBackend: "local", maxAttempts: opts.maxAttempts ?? 1, ...(opts.batch ? { batch: opts.batch } : {}) } };
  const files = { "src/bt.ts": SRC, ...(opts.other ? { "src/other.ts": OTHER } : {}), ...opts.files, [M]: '{"schema":1,"regions":{}}', "openarc.config.json": JSON.stringify(config) };
  const fake = fakePorts({ files, http: [TAGS, ...http], proc: opts.proc ?? [] });
  const res = await run(fake.instance as Ports, req);
  const snap = fake.snapshot() as Snap;
  const chats = snap.requests.filter((q) => q.url.endsWith("/api/chat")).map((q) => q.body as unknown as Chat);
  const manifest = JSON.parse(snap.files[M]!) as { regions: Record<string, { fingerprint: string; provenance: { [k: string]: Json } }> };
  return { res, chats, prompts: chats.map((c) => c.messages[1]!.content), file: snap.files["src/bt.ts"]!, manifest };
}
const count = (s: string, sub: string) => s.split(sub).length - 1;

// ── 1. batched request shape
{
  const { res, chats, prompts, file, manifest } = await compile([both("return n + 1;", "return n * 2;", { prompt_eval_count: 101, eval_count: 41 }), one("return -n;")], { other: true });
  assert.equal(res.exit, 0, JSON.stringify(res.diagnostics));
  assert.equal(chats.length, 2, "one request for src/bt.ts's two regions, one for src/other.ts's");
  assert.equal(res.modelCalls, 2);
  const [batch, single] = prompts as [string, string];
  assert.match(batch, /^Implement 2 OpenArc regions of one file in TypeScript\./);
  for (const s of ["## Region bt.inc\n### Fixed signature", "## Region bt.dbl\n### Fixed signature", "### Intent\nadd one", "### Intent\ndouble it", '{"bt.inc": {"body": "<statements>", "imports": []}, "bt.dbl": {"body": "<statements>", "imports": []}}'])
    assert.ok(batch.includes(s), `batched prompt has: ${s}`);
  for (const s of ["## Types (verbatim)", "## Rules", "type Inc = (n: number) => number;", "type Dbl = (n: number) => number;"]) assert.equal(count(batch, s), 1, `once: ${s}`);
  assert.ok(batch.indexOf("## Types") < batch.indexOf("## Region bt.inc") && batch.indexOf("## Region bt.dbl") < batch.indexOf("## Rules"), "shared sections, then the regions, then the Rules");
  assert.ok(!batch.includes("ot.neg"), "another file's region is not in the batch");
  assert.deepStrictEqual(chats[0]!.format!.required, ["bt.inc", "bt.dbl"]);
  assert.deepStrictEqual(Object.keys(chats[0]!.format!.properties!), ["bt.inc", "bt.dbl"]);
  assert.equal(chats[0]!.options.temperature, 0);
  assert.match(single, /^Implement exactly one OpenArc region/);
  assert.ok(file.includes("  return n + 1;") && file.includes("  return n * 2;"), file);
  const prov = (id: string) => manifest.regions[id]!.provenance;
  assert.deepStrictEqual([prov("bt.inc").batch, prov("bt.dbl").batch, prov("ot.neg").batch], [["bt.inc", "bt.dbl"], ["bt.inc", "bt.dbl"], undefined]);
  assert.deepStrictEqual([prov("bt.inc").tokens, prov("bt.dbl").tokens], [{ prompt: 51, completion: 21 }, { prompt: 50, completion: 20 }], "the shared request's tokens are split, not counted twice");
  assert.deepStrictEqual([prov("bt.inc").attempts, prov("bt.dbl").attempts], [1, 1]);
}

// ── 2. partial failure: only the failed region is re-requested, alone
{
  const { res, prompts, file } = await compile([both("return n + 1;", 'return "x";'), one("return n * 2;")], { maxAttempts: 3 });
  assert.equal(res.exit, 0, JSON.stringify(res.diagnostics));
  assert.equal(prompts.length, 2);
  const retry = prompts[1]!;
  assert.match(retry, /^Implement exactly one OpenArc region/);
  assert.ok(!retry.includes("bt.inc") && !retry.includes("add one"), "the region that passed is not asked again");
  assert.ok(retry.includes('## Your previous attempt failed\nPrevious body:\nreturn "x";') && retry.includes("OARC-E070 TS2322"), "a tsc failure keeps the full repair");
  assert.ok(file.includes("  return n + 1;") && file.includes("  return n * 2;"), file);
}
// a reply missing one region's entry: that region fails alone; an invalid reply fails both, each retried alone
{
  const { res, prompts } = await compile([reply(JSON.stringify({ "bt.inc": { body: "return n + 1;", imports: [] } })), one("return n * 2;")], { maxAttempts: 2 });
  assert.equal(res.exit, 0, JSON.stringify(res.diagnostics));
  assert.ok(prompts[1]!.includes("output was not valid: not-object") && !prompts[1]!.includes("add one"));
  const bad = await compile([reply("not json"), one("return n + 1;"), one("return n * 2;")], { maxAttempts: 2 });
  assert.equal(bad.res.exit, 0, JSON.stringify(bad.res.diagnostics));
  assert.equal(bad.prompts.length, 3);
}

// ── 3. write scope per region
{
  const escape = "return n + 1; }\nexport const extra = 1;\nfunction z() {";
  const { res, file } = await compile([both(escape, "return n * 2;")]);
  assert.equal(res.exit, 1);
  assert.deepStrictEqual(res.diagnostics.filter((d) => d.code === "OARC-E082").map((d) => d.id), ["bt.inc"]);
  assert.ok(file.includes("  return n * 2;"), "the sibling still commits");
  assert.ok(!file.includes("extra") && file.includes('arc.todo("bt.inc")'), file);
}

// ── 4. "code" format, and batch "off"
{
  const sections = "Here you go.\n### bt.inc\n```ts\nreturn n + 1;\n```\n\n### bt.dbl\n```ts\nreturn n * 2;\n```\n";
  const { res, chats, prompts, file } = await compile([reply(sections)], { backend: { outputFormat: "code" } });
  assert.equal(res.exit, 0, JSON.stringify(res.diagnostics));
  assert.equal(chats.length, 1);
  assert.equal(chats[0]!.format, undefined, "code format: no schema");
  assert.ok(prompts[0]!.includes("in this order:\nbt.inc\nbt.dbl\nEach section is a line \"### <region id>\""));
  assert.ok(file.includes("  return n + 1;") && file.includes("  return n * 2;"), file);
  const split = splitCodeSections("**bt.dbl**\n```ts\nreturn 2;\n```\nRegion `bt.inc`:\r\n```ts\nreturn 1;\n```", ["bt.inc", "bt.dbl", "bt.none"]);
  assert.deepStrictEqual([...split], [["bt.inc", "```ts\nreturn 1;\n```"], ["bt.dbl", "```ts\nreturn 2;\n```"], ["bt.none", null]]);

  const off = await compile([one("return n + 1;"), one("return n * 2;")], { batch: "off" });
  assert.equal(off.res.exit, 0, JSON.stringify(off.res.diagnostics));
  assert.equal(off.chats.length, 2);
  assert.ok(off.prompts.every((x) => x.startsWith("Implement exactly one OpenArc region")));
  assert.equal(off.manifest.regions["bt.inc"]!.provenance.batch, undefined);
  const on = await compile([both("return n + 1;", "return n * 2;")]);
  assert.notEqual(off.manifest.regions["bt.inc"]!.fingerprint, on.manifest.regions["bt.inc"]!.fingerprint, "batch is a fingerprint input");
  assert.match(parseConfig(JSON.stringify({ version: 1, backends: { l: { provider: "ollama", model: "m", maxContextTokens: 1 } }, compilation: { batch: "region" } })).error!, /compilation\.batch must be "file" or "off"/);
  assert.equal(parseConfig(JSON.stringify({ version: 1, backends: { l: { provider: "ollama", model: "m", maxContextTokens: 1 } } })).config.compilation.batch, "file");
}

// ── 5. resample on an example failure, full repair on tsc
{
  assert.equal(repairText(null), "");
  const ex = repairText({ body: "return 3;", problems: ['OARC-E090 example "#1" failed: got 3; expected 2'] });
  assert.equal(ex, '## A previous attempt failed\nOARC-E090 example "#1" failed: got 3; expected 2\n\nWrite a new body that passes every example and test above.');
  const tsc = repairText({ body: 'return "x";', problems: ["OARC-E070 TS2322 line 5: Type 'string' is not assignable to type 'number'."] });
  assert.ok(tsc.includes('Previous body:\nreturn "x";') && tsc.includes("Fix these problems."));
  assert.ok(repairText({ body: "x", problems: ['OARC-E090 example "#1" failed: got 1; expected 2', "OARC-E070 TS2322 line 1: no"] }).includes("Previous body"), "mixed: full repair");

  const src = 'import * as arc from "open-arc";\ntype Inc = (n: number) => number;\nexport const incSpec = arc.defineRegion<Inc>({ id: "ex.inc", intent: "add one", examples: [{ args: [1], expected: 2 }] });\n';
  const cp = { code: 0, stdout: "", timedOut: false }; // staging node_modules (no package.json in memory: every run)
  const proc = [cp, { code: 0, stdout: '{"name":"#1","ok":false,"actual":3}\n{"done":1}\n', timedOut: false }, cp, { code: 0, stdout: '{"name":"#1","ok":true}\n{"done":1}\n', timedOut: false }];
  const { res, chats, prompts } = await compile([one("return n + 2;"), one("return n + 1;")], { maxAttempts: 2, files: { "src/bt.ts": src }, proc });
  assert.equal(res.exit, 0, JSON.stringify(res.diagnostics));
  const second = prompts[1]!;
  assert.ok(second.startsWith(prompts[0]!.split("\n\n\n")[0]!), "the base prompt again");
  assert.ok(second.includes('## A previous attempt failed\nOARC-E090 example "#1" failed: got 3; expected 2'), second);
  assert.ok(!second.includes("return n + 2") && !second.includes("Previous body"), "the failed body is not resent");
  assert.deepStrictEqual(chats.map((c) => [c.options.temperature, c.options.seed]), [[0, 1], [0.4, 2]], "and sampled differently");
}

console.log("batch: request shape, partial failure, write scope, code format, off, resample ok");
