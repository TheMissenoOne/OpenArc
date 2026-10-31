// Fixes from the 2026-10-31 benchmark (openarc-wt-bench bench/results/2026-10-31-untuned-ollama-*/summary.md).
// No model: in-memory ports, stub HTTP and a fake Ollama server. Run: node tests/benchfix.check.ts
// 1. outputFormat "code": the reply parser, request shapes (no schema), and compiles through the same guards.
// 2. A recursive type alias in F type-checks (was TS2589 on the spec's `args`).
// 3. Token accounting: per attempt, per region (provenance), in `inspect`.
// 4. `throws` examples: the type, the harness, equality and fakes.
// 5. The real sandbox (bwrap on Linux) with a symlinked node_modules, in code mode, with a throws example.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import type { Json, AnyFn, RegionSpec } from "open-arc";
import { runExamples } from "open-arc/harness";
import type { CompileRequest, Ports } from "../src/types.ts";
import type { BackendConfig } from "../src/config.ts";
import { parseConfig } from "../src/config.ts";
import fakePorts from "./fakes/ports.memory.ts";
import { run } from "../src/compile.ts";
import * as engine from "../src/engine.ts";
import { completeWithUsage } from "../src/backends.ts";
import { CODE_SYSTEM, parseCodeOutput } from "../src/output-format.ts";

const root = process.cwd(); // the stage0 checkout, so "open-arc" and "typescript" resolve for the type checker
const req: CompileRequest = { root, ids: [], model: { host: "http://h", model: "m", seed: 1, numCtx: 8192 }, sandbox: { nodeBin: "/n/bin/node", nodePrefix: "/n", heapMb: 256, addressSpaceBytes: 2 ** 32, cpuSeconds: 10 } };
const M = ".openarc/manifest.json";
const TAGS = JSON.stringify({ models: [{ name: "qwen3.5:9b", digest: "d1" }] });
const chat = (content: string, prompt = 100, completion = 10, extra: object = {}) =>
  JSON.stringify({ message: { role: "assistant", content }, done: true, prompt_eval_count: prompt, eval_count: completion, ...extra });
type Snap = { files: Record<string, string>; requests: { url: string; body: Json }[] };
const fence = (code: string, tag = "ts") => "```" + tag + "\n" + code + "\n```";

// ── 1a. the reply parser
{
  const ok = (raw: string) => {
    const r = parseCodeOutput(raw);
    assert.ok(r.ok, JSON.stringify(r));
    return { body: r.body, imports: r.imports };
  };
  const fail = (raw: string) => {
    const r = parseCodeOutput(raw);
    assert.ok(!r.ok, JSON.stringify(r));
    return r.diagnostic.detail;
  };
  assert.deepStrictEqual(ok(fence("return n + 1;")), { body: "return n + 1;", imports: [] });
  assert.deepStrictEqual(ok("<think>maybe ```ts\nreturn 0;\n``` no</think>\nSure:\n" + fence("return 1;", "typescript") + "\ntrailing prose"), { body: "return 1;", imports: [] }, "think blocks are dropped");
  assert.deepStrictEqual(ok(fence('{"a":1}', "json") + "\n" + fence("return 2;", "")), { body: "return 2;", imports: [] }, "the first ts/typescript/untagged fence, not a json one");
  assert.deepStrictEqual(ok("return 3;"), { body: "return 3;", imports: [] }, "no fence at all: the whole reply");
  assert.deepStrictEqual(ok("\r\n" + fence('import half, { twice } from "./lib.ts";\nimport * as lib from "./lib.ts";\nimport type { T } from "./t.ts";\n\nreturn lib.twice(half(n));').replaceAll("\n", "\r\n")), {
    body: "return lib.twice(half(n));",
    imports: [{ from: "./lib.ts", names: ["twice"], default: "half" }, { from: "./lib.ts", names: [], namespace: "lib" }, { from: "./t.ts", names: ["T"] }],
  }, "leading imports: named, default, namespace, type-only");
  assert.equal(ok(fence('return 1;\nimport { x } from "./x.ts";')).body, 'return 1;\nimport { x } from "./x.ts";', "only LEADING import lines are imports; a later one stays in the body (tsc rejects it)");
  assert.equal(fail("```ts\nreturn n +"), "unclosed-fence");
  assert.equal(fail(fence("{}", "json")), "no-ts-fence");
  assert.equal(fail(fence('import { a as b } from "./x.ts";\nreturn b;')), 'bad-import:import { a as b } from "./x.ts";');
  assert.equal(fail(fence('import "./side-effect.ts";\nreturn 1;')), 'bad-import:import "./side-effect.ts";');
  assert.equal(fail("<think>only thinking"), "empty");
  assert.equal(fail(fence('import { a } from "./a.ts";')), "empty");
}

// ── 1b. request shapes: no schema in code mode; tokens from every provider
{
  const fake = (response: string) => {
    const seen: Json[] = [];
    const ports = { log: () => {}, http: { async postJson(_u: string, body: Json) { seen.push(body); return response; }, async get() { throw new Error("no get"); } } } as unknown as Ports;
    return { ports, seen };
  };
  const env = { K: "k" };
  const cases: [BackendConfig, string, { prompt: number; completion: number }, string[]][] = [
    [{ provider: "ollama", model: "m", maxContextTokens: 8192 }, chat("x", 7, 3), { prompt: 7, completion: 3 }, ["format"]],
    [{ provider: "openai", model: "m", apiKeyEnv: "K", maxContextTokens: 8192 }, JSON.stringify({ choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 11, completion_tokens: 4 } }), { prompt: 11, completion: 4 }, ["response_format"]],
    [{ provider: "anthropic", model: "m", apiKeyEnv: "K", maxContextTokens: 8192 }, JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "x" }], usage: { input_tokens: 13, output_tokens: 5 } }), { prompt: 13, completion: 5 }, ["output_config"]],
  ];
  for (const [b, reply, tokens, schemaKeys] of cases) {
    for (const outputFormat of ["json", "code"] as const) {
      const { ports, seen } = fake(reply);
      assert.deepStrictEqual(await completeWithUsage(ports, { ...b, outputFormat }, "S", "U", env), { text: "x", tokens }, `${b.provider} tokens`);
      for (const k of schemaKeys) assert.equal(k in (seen[0] as object), outputFormat === "json", `${b.provider} ${outputFormat}: ${k}`);
    }
  }
  // a truncated reply's retry counts too; a provider that reports nothing gives null
  const replies = [chat("```ts\nreturn n +", 50, 20, { done_reason: "length" }), chat(fence("return 1;"), 60, 30)];
  const ports = { log: () => {}, http: { async postJson() { return replies.shift()!; } } } as unknown as Ports;
  assert.deepStrictEqual(await completeWithUsage(ports, { provider: "ollama", model: "m", maxContextTokens: 8192, outputReserveTokens: 1000, outputFormat: "code" }, "S", "U", env), { text: fence("return 1;"), tokens: { prompt: 110, completion: 50 } });
  const silent = fake(JSON.stringify({ message: { content: "x" }, done: true }));
  assert.equal((await completeWithUsage(silent.ports, { provider: "ollama", model: "m", maxContextTokens: 8192 }, "S", "U", env)).tokens, null);
  // config: per backend and per region; anything else is an error
  assert.equal(parseConfig(JSON.stringify({ version: 1, backends: { a: { provider: "ollama", model: "m", maxContextTokens: 1, outputFormat: "xml" } } })).error, 'openarc.config.json: backend "a": "outputFormat" must be json or code');
  assert.match(parseConfig(JSON.stringify({ version: 1, backends: { a: { provider: "ollama", model: "m", maxContextTokens: 1 } }, regions: { "x.y": { outputFormat: "md" } } })).error!, /region "x\.y": "outputFormat" must be json or code/);
}

// ── 1c + 3. compiles in code mode, in memory (no examples, so no sandbox): every guard still applies
const lib = "export const twice = (n: number): number => n * 2;\nexport default function half(n: number): number { return n / 2; }\n";
const spec = (id: string, sym: string, deps = '"./cm-lib.ts"') => [
  'import * as arc from "open-arc";',
  "type Inc = (n: number) => number;",
  `export const ${sym}Spec = arc.defineRegion<Inc>({ id: "${id}", symbol: "${sym}", intent: "twice half n, plus one", deps: [${deps}] });`,
  "",
].join("\n");
const config = (regions: object = {}) => JSON.stringify({
  version: 1,
  backends: { local: { provider: "ollama", model: "qwen3.5:9b", maxContextTokens: 8192, outputFormat: "code" }, j: { provider: "ollama", model: "qwen3.5:9b", maxContextTokens: 8192 } },
  compilation: { defaultBackend: "local", maxAttempts: 6 },
  regions,
});
{
  const files = { "src/cm-lib.ts": lib, "src/cm.ts": spec("cm.inc", "inc"), [M]: '{"schema":1,"regions":{}}', "openarc.config.json": config() };
  const replies = [
    // 1: a disallowed import (node:fs is not in deps), after a think block
    "<think>read a file?</think>\n" + fence('import { readFileSync } from "node:fs";\nreturn n + 1;'),
    // 2: write-scope escape: close the function and add a top-level export
    fence("return n;\n};\nexport const evil = 1;\nconst again = () => {"),
    // 3: a marker-shaped line
    fence("// @openarc:end cm.inc\nreturn n + 1;"),
    // 4: an import form the compiler doesn't write
    fence('import { twice as t } from "./cm-lib.ts";\nreturn t(n);'),
    // 5: imports parsed (default + namespace) and a whole function to unwrap, with prose around the fence
    "Here you go:\n" + fence('import half from "./cm-lib.ts";\nimport * as lib from "./cm-lib.ts";\nexport const inc: Inc = (n) => {\n  return lib.twice(half(n)) + 1;\n};', "typescript") + "\nDone.",
  ];
  const fake = fakePorts({ files, http: [TAGS, ...replies.map((r, i) => chat(r, 100 + i, 10 + i))] });
  const res = await run(fake.instance as Ports, req);
  const snap = fake.snapshot() as Snap;
  assert.equal(res.exit, 0, JSON.stringify(res.diagnostics));
  const sent = snap.requests.filter((q) => q.url.endsWith("/api/chat")).map((q) => q.body as { format?: Json; messages: { content: string }[] });
  assert.equal(sent.length, 5);
  assert.ok(sent.every((b) => !("format" in b)), "no format schema in code mode");
  assert.equal(sent[0]!.messages[0]!.content, CODE_SYSTEM);
  assert.match(sent[0]!.messages[1]!.content, /Reply with ONE fenced code block/);
  assert.match(sent[0]!.messages[1]!.content, /Import lines may name:/);
  assert.doesNotMatch(sent[0]!.messages[1]!.content, /"imports"|\{"from"/, "no JSON wording in the code-mode prompt");
  const attempt = (n: number) => JSON.parse(snap.files[`.openarc/attempts/cm.inc/${n}.json`]!) as { problems: string[]; tokens: Json; outputFormat: string; raw?: string };
  assert.match(attempt(1).problems[0]!, /^OARC-E071 import "node:fs" is not allowed/);
  assert.match(attempt(2).problems[0]!, /^OARC-E097 body escapes its region/);
  assert.match(attempt(3).problems[0]!, /^OARC-E097 body contains a marker-shaped line/);
  assert.deepStrictEqual(attempt(4).problems, ['output was not valid: bad-import:import { twice as t } from "./cm-lib.ts";']);
  assert.equal(attempt(4).raw, replies[3], "an unparseable reply is kept raw");
  assert.deepStrictEqual([1, 2, 3, 4].map((n) => [attempt(n).outputFormat, attempt(n).tokens]), [1, 2, 3, 4].map((n) => ["code", { prompt: 99 + n, completion: 9 + n }]));
  const text = snap.files["src/cm.ts"]!;
  assert.ok(text.includes('import half from "./cm-lib.ts";\nimport * as lib from "./cm-lib.ts";'), text);
  assert.ok(text.includes("export const inc: Inc = (n) => {\n  return lib.twice(half(n)) + 1;\n};"), "the whole function was unwrapped to its body");
  assert.ok(!text.includes("evil"));
  const prov = JSON.parse(snap.files[M]!).regions["cm.inc"].provenance;
  assert.deepStrictEqual([prov.outputFormat, prov.attempts, prov.tokens], ["code", 5, { prompt: 510, completion: 60 }], "token totals cover every call for the region");
  const cache = Object.entries(snap.files).find(([f]) => f.startsWith(".openarc/cache/"))![1];
  assert.deepStrictEqual(JSON.parse(cache).tokens, { prompt: 510, completion: 60 });

  // a cache hit (the region was put back to pending) makes no model call and carries the cached tokens
  const again = fakePorts({ files: { ...snap.files, "src/cm.ts": files["src/cm.ts"], [M]: '{"schema":1,"regions":{}}' }, http: [TAGS] });
  const r2 = await run(again.instance as Ports, req);
  assert.equal(r2.exit, 0, JSON.stringify(r2.diagnostics));
  assert.deepStrictEqual(JSON.parse((again.snapshot() as Snap).files[M]!).regions["cm.inc"].provenance.tokens, { prompt: 510, completion: 60 });
}
// a reply without a fence, and the per-region override; json mode (region override back to json) still sends the schema
{
  for (const [regions, wantFormat] of [[{}, "code"], [{ "cm.dec": { backend: "j" } }, "json"], [{ "cm.dec": { backend: "j", outputFormat: "code" } }, "code"]] as const) {
    const reply = wantFormat === "code" ? "return n - 1;" : JSON.stringify({ body: "return n - 1;" });
    const fake = fakePorts({ files: { "src/cm-lib.ts": lib, "src/cm.ts": spec("cm.dec", "dec"), [M]: '{"schema":1,"regions":{}}', "openarc.config.json": config(regions) }, http: [TAGS, chat(reply, 40, 4)] });
    const res = await run(fake.instance as Ports, req);
    const snap = fake.snapshot() as Snap;
    assert.equal(res.exit, 0, JSON.stringify(res.diagnostics));
    assert.ok(snap.files["src/cm.ts"]!.includes("  return n - 1;"));
    const body = snap.requests.find((q) => q.url.endsWith("/api/chat"))!.body as object;
    assert.equal("format" in body, wantFormat === "json");
    const prov = JSON.parse(snap.files[M]!).regions["cm.dec"].provenance;
    assert.deepStrictEqual([prov.outputFormat, prov.tokens], [wantFormat, { prompt: 40, completion: 4 }]);
  }
  // the output format is in the fingerprint
  const fp = async (regions: object) => {
    const ports = fakePorts({ files: { "src/cm-lib.ts": lib, "src/cm.ts": spec("cm.dec", "dec"), "openarc.config.json": config(regions) }, http: [TAGS] }).instance as Ports;
    const p = await engine.parse(ports, req, []);
    await engine.analyze(ports, req, p, []);
    return p.regions[0]!.fingerprint;
  };
  assert.notEqual(await fp({}), await fp({ "cm.dec": { outputFormat: "json" } }));
}

// ── 2 + 4a. types: a recursive alias in F, and throws examples
{
  const src = [
    'import * as arc from "open-arc";',
    "export type Nested = Array<number | null | undefined | Nested>;",
    "type Flatten = (input: Nested) => number[];",
    'export const flattenSpec = arc.defineRegion<Flatten>({ id: "f.flatten", intent: "x", examples: [',
    '  { args: [[1, [2, [3, ["$NaN", ["$undefined", null]]]]]], expected: [1, 2, 3, "$NaN"] },',
    '  { args: [[]], throws: true },',
    "] });",
    "type Tree = { v: number; kids: Tree[] | null };",
    'export const treeSpec = arc.defineRegion<(t: Tree) => number>({ id: "f.tree", intent: "x", examples: [{ args: [{ v: "$Infinity", kids: [{ v: 1, kids: null }] }], expected: 1 }] });',
    "type Find = (xs: number[], x: number) => number;",
    'export const findSpec = arc.defineRegion<Find>({ id: "f.find", intent: "x", examples: [{ args: [[1], 2], throws: "not found" }, { args: [[1], 1], expected: 0 }] });',
    "type Log = (msg: string) => void;",
    'export const logSpec = arc.defineRegion<Log>({ id: "f.log", intent: "x", examples: [{ args: [""], throws: "empty" }, { args: ["a"] }] });',
    "// @ts-expect-error a string deep inside is not a number",
    'export const bad1 = arc.defineRegion<Flatten>({ id: "f.b1", intent: "x", examples: [{ args: [[1, [2, ["x"]]]], expected: [1] }] });',
    "// @ts-expect-error expected and throws together",
    'export const bad2 = arc.defineRegion<Find>({ id: "f.b2", intent: "x", examples: [{ args: [[1], 2], expected: 0, throws: true }] });',
    "// @ts-expect-error throws is true or a string",
    'export const bad3 = arc.defineRegion<Find>({ id: "f.b3", intent: "x", examples: [{ args: [[1], 2], throws: false }] });',
    "",
  ].join("\n");
  const prog = engine.makeProgram({ root } as engine.Project, new Map([["src/__benchfix_types.ts", src]]));
  const sf = prog.getSourceFile(`${root}/src/__benchfix_types.ts`)!;
  const errors = [...prog.getSyntacticDiagnostics(sf), ...prog.getSemanticDiagnostics(sf)].map((d) => `TS${d.code} line ${sf.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
  assert.deepStrictEqual(errors, [], "the recursive alias type-checks (no TS2589), and throws examples are typed");
}

// ── 4b. the harness: throws, substrings, async rejections, pending, and fakes after a throw
{
  const find = (xs: number[], x: number) => {
    const i = xs.indexOf(x);
    if (i < 0) throw new RangeError(`${x} not found`);
    return i;
  };
  const spec4 = {
    id: "t.find", intent: "",
    examples: [
      { name: "throws", args: [[1], 2], throws: true },
      { name: "substring", args: [[1], 2], throws: "not found" },
      { name: "wrong message", args: [[1], 2], throws: "missing" },
      { name: "returned", args: [[1], 1], throws: true },
      { name: "value", args: [[1, 2], 2], expected: 1 },
    ],
  } as unknown as RegionSpec<AnyFn>;
  const out = await runExamples(root, find, spec4);
  assert.deepStrictEqual(out, [
    { name: "throws", ok: true },
    { name: "substring", ok: true },
    { name: "wrong message", ok: false, actual: { throws: "2 not found" } },
    { name: "returned", ok: false, actual: { returned: 0 } },
    { name: "value", ok: true },
  ]);
  // async rejection, a pending body, and fakesAfter checked after the throw
  const save = async (fs: { write(p: string, d: string): Promise<void> }, data: string) => {
    await fs.write("a.txt", data);
    if (!data) throw new Error("empty data");
  };
  const spec5 = {
    id: "t.save", intent: "",
    examples: [
      { name: "rejects", args: [{ $fake: "fs.memory" }, ""], throws: "empty", fakesAfter: { "fs.memory": { files: { "a.txt": "" } } } },
      { name: "fakes differ", args: [{ $fake: "fs.memory" }, ""], throws: true, fakesAfter: { "fs.memory": { files: {} } } },
      { name: "void ok", args: [{ $fake: "fs.memory" }, "x"], fakesAfter: { "fs.memory": { files: { "a.txt": "x" } } } },
    ],
  } as unknown as RegionSpec<AnyFn>;
  const out5 = await runExamples(root, save, spec5);
  assert.deepStrictEqual(out5.map((o) => [o.name, o.ok]), [["rejects", true], ["fakes differ", false], ["void ok", true]]);
  const { OpenArcTodoError } = await import("open-arc");
  const pend = await runExamples(root, () => { throw new OpenArcTodoError("t.p"); }, { id: "t.p", intent: "", examples: [{ args: [], throws: true }] } as unknown as RegionSpec<AnyFn>);
  assert.deepStrictEqual(pend, [{ name: "#1", ok: false, actual: { pending: "t.p" } }], "a pending body is pending, not a pass for throws: true");
}

// ── 5. the real sandbox with a symlinked node_modules (a shared install), code mode, a throws example
{
  const main = join(root, "src", "main.ts");
  const cli = (cwd: string, ...args: string[]) =>
    new Promise<{ code: number; out: string }>((done) =>
      execFile(process.execPath, [main, ...args], { cwd, encoding: "utf8", timeout: 180_000 }, (e, stdout, stderr) =>
        done({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: `${stdout}${stderr}` })));
  const bodies = [
    fence("return n + 1;"), // fails the throws example in the sandbox
    "<think>negative input must throw</think>\n" + fence('if (n < 0) throw new RangeError("negative input");\nreturn n + 1;'),
  ];
  const seen: object[] = [];
  const server = createServer((rq, rs) => {
    let body = "";
    rq.on("data", (b) => (body += b));
    rq.on("end", () => {
      rs.setHeader("content-type", "application/json");
      if (rq.url === "/api/tags") return rs.end(JSON.stringify({ models: [{ name: "stub:1", digest: "d1" }] }));
      if (rq.url === "/api/chat") {
        seen.push(JSON.parse(body));
        return rs.end(chat(bodies[seen.length - 1] ?? fence("return 0;"), 200, 20));
      }
      rs.statusCode = 404;
      rs.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  // auto: bwrap on Linux (the tier the benchmark hit), sandbox-exec on macOS, node on Windows; then node everywhere
  try {
  for (const isolation of ["auto", "node"]) {
  seen.length = 0;
  const base = realpathSync(mkdtempSync(join(tmpdir(), "openarc-benchfix-")));
  try {
    // shared/node_modules holds open-arc (a link to a copy of core/, as in a file: dep); the project links to it
    const shared = join(base, "shared");
    cpSync(join(root, "core"), join(shared, "core"), { recursive: true });
    mkdirSync(join(shared, "node_modules"), { recursive: true });
    const win = process.platform === "win32";
    symlinkSync(win ? join(shared, "core") : "../core", join(shared, "node_modules", "open-arc"), "junction");
    const dir = join(base, "p");
    mkdirSync(join(dir, "src"), { recursive: true });
    symlinkSync(win ? join(shared, "node_modules") : "../shared/node_modules", join(dir, "node_modules"), "junction");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "bf", private: true, type: "module", dependencies: { "open-arc": "file:../shared/core" } }));
    assert.equal((await cli(dir, "init")).code, 0);
    writeFileSync(join(dir, "openarc.config.json"), JSON.stringify({
      version: 1,
      backends: { stub: { provider: "ollama", model: "stub:1", host: `http://127.0.0.1:${port}`, maxContextTokens: 8192, outputFormat: "code" } },
      compilation: { defaultBackend: "stub", maxAttempts: 3 },
      sandbox: { isolation },
    }));
    writeFileSync(join(dir, "src", "inc.ts"), [
      'import * as arc from "open-arc";',
      "type Inc = (n: number) => number;",
      'export const incSpec = arc.defineRegion<Inc>({ id: "demo.inc", intent: "add one; a negative n throws", examples: [{ args: [1], expected: 2 }, { args: [0], expected: 1 }, { args: [-1], throws: "negative" }] });',
      "",
    ].join("\n"));
    assert.equal((await cli(dir, "scaffold")).code, 0);
    const c = await cli(dir, "compile");
    assert.equal(c.code, 0, c.out);
    assert.match(c.out, /done: exit 0 · 2 model call\(s\)/, c.out);
    assert.ok(seen.every((b) => !("format" in b)), "code mode sends no schema");
    assert.ok(readFileSync(join(dir, "src", "inc.ts"), "utf8").includes('if (n < 0) throw new RangeError("negative input");'));
    const failed = readdirSync(join(dir, ".openarc", "attempts", "demo.inc")).map((f) => JSON.parse(readFileSync(join(dir, ".openarc", "attempts", "demo.inc", f), "utf8")));
    assert.equal(failed.length, 1);
    assert.deepStrictEqual(failed[0].problems, ['OARC-E090 example "#3" failed: got {"returned":0}; expected {"throws":"negative"}'], "the sandbox ran (no module-not-found) and checked the throws example");
    assert.deepStrictEqual(failed[0].tokens, { prompt: 200, completion: 20 });
    const m = JSON.parse(readFileSync(join(dir, ".openarc", "manifest.json"), "utf8"));
    assert.deepStrictEqual(m.regions["demo.inc"].provenance.verifiedBy, ["tsc", "static", "examples:3/3"]);
    assert.deepStrictEqual(m.regions["demo.inc"].provenance.tokens, { prompt: 400, completion: 40 });
    const ins = await cli(dir, "inspect", "demo.inc");
    assert.equal(ins.code, 0, ins.out);
    assert.deepStrictEqual(JSON.parse(ins.out.slice(ins.out.indexOf("{"))).tokens, { prompt: 400, completion: 40 });
    console.log(`benchfix: sandbox ${isolation}: symlinked node_modules, code mode, throws example ok`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  }
  } finally {
    server.close();
  }
}

console.log("benchfix: outputFormat code, recursive alias types, token accounting, throws examples, symlinked node_modules in the sandbox ok");
