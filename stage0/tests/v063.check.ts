// Fixes from the 0.6.x real-model runs (selfhost-compile-3.log, watch logs), on in-memory ports: no model, no sandbox.
// Run: node tests/v063.check.ts
// 1. `calls` allowlist (OARC-E098): the three wrong compile.run block bodies that real runs cached as verified are
//    rejected; the hand-written blocks pass.
// 2. Coverage probe: compile.run's examples reach every block; the original two reached only `lock`. In a compile, a
//    block no passing example reaches is unverified (W045): not cached, held back at STAGE; the probe never reaches disk.
// 3. Requested imports are file bindings (crypto from node:crypto is not the global); `random` is narrowed.
// 4. Comments that mention @openarc: are stripped before splicing; marker-shaped lines are still rejected.
// 5. Fingerprints hash sibling signatures, not bodies: committing one region doesn't re-queue its sibling.
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import type { Json, AnyFn, RegionSpec } from "open-arc";
import { runExamples } from "open-arc/harness";
import type { CompileRequest, Ports } from "../src/types.ts";
import fakePorts from "./fakes/ports.memory.ts";
import { run } from "../src/compile.ts";
import * as engine from "../src/engine.ts";

const root = process.cwd(); // the stage0 checkout, so "open-arc" and "typescript" resolve for the type checker
const req: CompileRequest = { root, ids: [], model: { host: "http://h", model: "m", seed: 1, numCtx: 8192 }, sandbox: { nodeBin: "/n/bin/node", nodePrefix: "/n", heapMb: 256, addressSpaceBytes: 2 ** 32, cpuSeconds: 10 } };
const M = ".openarc/manifest.json";
const TAGS = JSON.stringify({ models: [{ name: "qwen3.5:9b", digest: "d1" }] });
const chat = (content: string) => JSON.stringify({ message: { role: "assistant", content }, done: true });
type Snap = { files: Record<string, string> };
const compileTs = readFileSync(`${root}/src/compile.ts`, "utf8");

// ── 1. calls allowlist on compile.run's blocks
{
  const ports = fakePorts({ files: { "src/compile.ts": compileTs } }).instance as Ports; // other modules come from disk
  const p = await engine.parse(ports, req, []);
  await engine.analyze(ports, req, p, [], { offline: true });
  const check = (id: string, body: string) => {
    const r = p.regions.find((x) => x.id === id)!;
    return engine.staticCheck(body, r.spec.effects, new Set(), engine.callPolicy(p, r)).map((s) => `${s.diag.code} ${s.diag.detail}`);
  };
  // the hand-written bodies (stage 0) pass
  for (const r of p.regions.filter((x) => x.kind === "block")) assert.deepStrictEqual(check(r.id, r.bodyLines.join("\n")), [], r.id);
  // Real bodies from the self-compile, each cached as "✓ examples:1/2 (1 inconclusive)" by 0.6.2:
  // recover ran parse and a commit (selfhost .openarc/cache/ef75bfa6…json, verbatim)
  assert.deepStrictEqual(check("compile.run.recover", "project = await engine.parse(ports, req, diagnostics);\n  const journal = planJournal(txid, targets.map(t => ({ target: t, staged: '' })) as any);\n  await recover(ports.fs);\n  await commit(ports.fs, journal);"),
    ["OARC-E098 engine.parse", "OARC-E098 planJournal", "OARC-E098 commit"]);
  // unlock released the lock, then re-ran the whole pipeline
  assert.deepStrictEqual(check("compile.run.unlock", [
    "await ports.fs.remove('.openarc/lock');",
    "project = await engine.parse(ports, req, diagnostics);",
    "if (project !== null) await engine.analyze(ports, req, project, diagnostics);",
    "if (project !== null) targets = engine.plan(project, req, diagnostics);",
    "for (const id of targets) { const r = await engine.generate(ports, req, project!, id, diagnostics); if (r.candidate) candidates.push(r.candidate); }",
    "if (project !== null) staged = await engine.stage(ports, req, project, candidates, txid, diagnostics);",
    "await commit(ports.fs, planJournal(txid, staged.map((f, i) => ({ target: f.target, staged: `.openarc/txn/${txid}/stage/${i}` }))));",
  ].join("\n")), ["engine.parse", "engine.analyze", "engine.plan", "engine.generate", "engine.stage", "commit", "planJournal"].map((c) => `OARC-E098 ${c}`));
  // analyze called parse twice
  assert.deepStrictEqual(check("compile.run.analyze", "project = await engine.parse(ports, req, diagnostics);\nif (project !== null) await engine.analyze(ports, req, project, diagnostics);\nproject = await engine.parse(ports, req, diagnostics);"),
    ["OARC-E098 engine.parse", "OARC-E098 engine.parse"]);
  // locals, the body's own helpers and wildcards are not restricted; the message lists what is allowed
  assert.deepStrictEqual(check("compile.run.commit", "const go = (x: number) => x;\ngo(1);\nawait commit(ports.fs, planJournal(txid, staged.map((f, i) => ({ target: f.target, staged: String(i) }))));"), []);
  const r = p.regions.find((x) => x.id === "compile.run.plan")!;
  assert.deepStrictEqual(engine.staticCheck("targets = engine.plan(project!, req, diagnostics); engine.manifestChanged(project!);", [], new Set(), { ...engine.callPolicy(p, r)!, calls: ["engine.*"] }), []);
  assert.equal(engine.staticCheck("ports.fs.write('x', '');", [], new Set(), engine.callPolicy(p, r))[0]!.message, "call not allowed by spec: ports.fs.write (allowed: engine.plan)");
  // the prompt names the allowed calls
  assert.match(engine.buildContext(p, r, 1, p.config.backends.local!), /## Calls allowed\nYou may call exactly: engine\.plan\./);
  // compile.run's examples are extracted statically (the harness gets them from the compiler)
  assert.equal(p.specs.get("compile.run")!.examples.length, 3);
}

// ── 2a. coverage: compile.run's examples reach every block (the probe on a copy, run in-process)
{
  const dir = mkdtempSync(`${tmpdir()}/oarc-probe-`);
  try {
    const blocks = [...compileTs.matchAll(/^(\s*)\/\/ @openarc:begin (compile\.run\.\w+)$/gm)].map((m) => m[2]!);
    assert.equal(blocks.length, 9);
    const probedText = compileTs
      .replace(/^(\s*)(\/\/ @openarc:begin (compile\.run\.\w+))$/gm, (_m, ind: string, line: string, id: string) => `${ind}${line}\n${ind}globalThis.__openarcHit?.(${JSON.stringify(id)});`)
      .replace(/from "\.\/([\w.]+)"/g, (_m, f: string) => `from ${JSON.stringify(pathToFileURL(`${root}/src/${f}`).href)}`)
      .replace(/from "open-arc"/g, `from ${JSON.stringify(pathToFileURL(`${root}/core/index.ts`).href)}`);
    writeFileSync(`${dir}/compile.ts`, probedText);
    const mod = await import(pathToFileURL(`${dir}/compile.ts`).href);
    const spec = mod.runSpec as RegionSpec<AnyFn>;
    const reached = (exs: RegionSpec<AnyFn>["examples"]) => runExamples(root, mod.run, { ...spec, examples: exs }).then((os) => {
      assert.ok(os.every((o) => o.ok), JSON.stringify(os));
      return [...new Set(os.flatMap((o) => o.hits ?? []))].sort();
    });
    assert.deepStrictEqual(await reached(spec.examples!.slice(0, 2)), ["analyze", "lock", "parse", "plan", "recover", "unlock"].map((b) => `compile.run.${b}`),
      "0.6.2's two examples never reach generate, stage or commit (and, while siblings are pending, only lock passes conclusively)");
    assert.deepStrictEqual(await reached(spec.examples), [...blocks].sort(), "0.6.3: every block is reached by a passing example");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 2b. in a compile: an unreached block is unverified (W045), not cached, and held back; the probe stays in the sandbox
const blockSrc = [
  'import * as arc from "open-arc";',
  "type Run = (n: number) => number;",
  'export const runSpec = arc.defineRegion<Run>({ id: "fixture.run", intent: "double positives, then add one", examples: [{ args: [-1], expected: -1 }] });',
  'export const aSpec = arc.defineBlock({ id: "fixture.run.a", intent: "x = n * 2" });',
  'export const bSpec = arc.defineBlock({ id: "fixture.run.b", intent: "x = x + 1" });',
  "// @openarc:begin fixture.run",
  "export function run(n: number): number {",
  "  let x = n;",
  "  // @openarc:begin fixture.run.a",
  '  arc.pending("fixture.run.a");',
  "  // @openarc:end fixture.run.a",
  "  if (n < 0) return x;",
  "  // @openarc:begin fixture.run.b",
  '  arc.pending("fixture.run.b");',
  "  // @openarc:end fixture.run.b",
  "  return x;",
  "}",
  "// @openarc:end fixture.run",
  "",
].join("\n");
const out = (lines: object[]) => ({ code: 0, stdout: [...lines, { done: lines.length }].map((l) => JSON.stringify(l)).join("\n") + "\n", timedOut: false });
const staging = (ports: Ports) => {
  const staged: string[] = [];
  return { staged, ports: { ...ports, fs: { ...ports.fs, async write(path: string, data: string) { if (path.startsWith(".openarc/sandbox/") && path.endsWith("/src/fixture.ts")) staged.push(data); return ports.fs.write(path, data); } } } as Ports };
};
{
  const fake = fakePorts({
    files: { "src/fixture.ts": blockSrc, "package.json": "{}", [M]: '{"schema":1,"regions":{}}' }, // package.json: the sandbox stage is set up once
    http: [TAGS, chat('{"body":"x = n * 2;"}'), chat('{"body":"x = x + 1;"}')],
    proc: [
      { code: 0, stdout: "", timedOut: false },
      out([{ name: "#1", ok: true, hits: ["fixture.run.a"] }]), // a: reached and passes (n = -1 returns before b's pending)
      out([{ name: "#1", ok: true, hits: ["fixture.run.a"] }]), // b: every example conclusive, none reaches b -> W045
      out([{ name: "#1", ok: true, hits: ["fixture.run.a"] }]), // joint check: b still unreached -> both held back
    ],
  });
  const s = staging(fake.instance as Ports);
  const res = await run(s.ports, req);
  const files = (fake.snapshot() as Snap).files;
  assert.deepStrictEqual(res.diagnostics.filter((d) => d.code !== "OARC-W040").map((d) => `${d.code} ${d.id} ${d.detail}`), ["OARC-W045 fixture.run.b unreached:fixture.run", "OARC-W042 fixture.run.a unreached:fixture.run.b"]);
  assert.equal(files["src/fixture.ts"], blockSrc, "nothing committed");
  assert.equal(Object.keys(files).filter((f) => f.startsWith(".openarc/cache/")).length, 1, "a is cached, unverified b is not");
  assert.ok(s.staged.length >= 3 && s.staged.every((t) => t.includes('globalThis.__openarcHit?.("fixture.run.')), "the sandbox copies carry the probe");
  assert.match(s.staged.at(-1)!, /begin fixture\.run\.a\n {2}globalThis\.__openarcHit\?\.\("fixture\.run\.a"\);\n {2}x = n \* 2;/);
}
{
  const fake = fakePorts({
    files: { "src/fixture.ts": blockSrc, "package.json": "{}", [M]: '{"schema":1,"regions":{}}' }, // package.json: the sandbox stage is set up once
    http: [TAGS, chat('{"body":"x = n * 2;"}'), chat('{"body":"x = x + 1;"}')],
    proc: [
      { code: 0, stdout: "", timedOut: false },
      out([{ name: "#1", ok: false, actual: { pending: "fixture.run.b" } }]), // a: inconclusive, unreached so far: provisional
      out([{ name: "#1", ok: true, hits: ["fixture.run.a", "fixture.run.b"] }]),
      out([{ name: "#1", ok: true, hits: ["fixture.run.a", "fixture.run.b"] }]), // joint: both reached
    ],
  });
  const res = await run(fake.instance as Ports, req);
  const text = (fake.snapshot() as Snap).files["src/fixture.ts"]!;
  assert.equal(res.exit, 0, JSON.stringify(res.diagnostics));
  assert.ok(text.includes("  x = n * 2;") && text.includes("  x = x + 1;"), "both committed");
  assert.ok(!text.includes("__openarcHit"), "the probe never reaches the committed source");
}
// the harness records hits only for passing examples
{
  const spec = { id: "h", intent: "", examples: [{ args: [1], expected: 1 }, { args: [2], expected: 0 }] } as unknown as RegionSpec<AnyFn>;
  const fn = (n: number) => ((globalThis as { __openarcHit?: (id: string) => void }).__openarcHit?.(`b${n}`), n === 1 ? 1 : 2);
  assert.deepStrictEqual(await runExamples(root, fn, spec), [{ name: "#1", ok: true, hits: ["b1"] }, { name: "#2", ok: false, actual: 2 }]);
}

// ── 3. requested imports are bindings; `random` covers only the random members
{
  const src = [
    'import * as arc from "open-arc";',
    'export const shaSpec = arc.defineRegion<(text: string) => string>({ id: "fx.sha", intent: "sha256 hex", deps: ["node:crypto"] });',
    "",
  ].join("\n");
  // the exact shape hash.sha256Tagged failed three times with in selfhost-compile-3.log (E074 'crypto' requires effect 'random')
  const reply = JSON.stringify({ body: 'return crypto.createHash("sha256").update(text, "utf8").digest("hex");', imports: [{ from: "node:crypto", names: [], default: "crypto" }] });
  const fake = fakePorts({ files: { "src/fx.ts": src, [M]: '{"schema":1,"regions":{}}' }, http: [TAGS, chat(reply)] });
  const res = await run(fake.instance as Ports, req);
  assert.equal(res.exit, 0, JSON.stringify(res.diagnostics));
  assert.match((fake.snapshot() as Snap).files["src/fx.ts"]!, /import crypto from "node:crypto";[\s\S]*return crypto\.createHash/);
  const codes = (body: string, bound: string[] = []) => engine.staticCheck(body, [], new Set(bound)).map((s) => `${s.diag.code} ${s.diag.detail}`);
  assert.deepStrictEqual(codes("return crypto.subtle;"), [], "global crypto outside the random members is not gated");
  assert.deepStrictEqual(codes("return crypto.randomUUID();"), ["OARC-E074 crypto.randomUUID"]);
  assert.deepStrictEqual(codes("return crypto.randomBytes(4);", ["crypto"]), ["OARC-E074 crypto.randomBytes"], "an imported crypto's random members too");
  assert.deepStrictEqual(codes("return Math.random();"), ["OARC-E074 Math.random"]);
  assert.deepStrictEqual(engine.staticCheck("return crypto.getRandomValues(new Uint8Array(2));", ["random"]), []);
}

// ── 4. comments mentioning the marker prefix are stripped, marker-shaped lines are not
{
  const body = "// matches @openarc: markers\nconst re = /@openarc:/; // the @openarc: prefix\n/* scans for\n   @openarc: comments */\nreturn re.test(s) ? \"@openarc:\" : `// @openarc: x`;";
  const s = engine.stripMarkerComments(body);
  assert.equal(s.stripped, 3);
  assert.equal(s.body, "const re = /@openarc:/;\nreturn re.test(s) ? \"@openarc:\" : `// @openarc: x`;", "strings, regexes and templates are untouched");
  assert.equal(engine.guardBody(s.body), null);
  const forged = engine.stripMarkerComments("// @openarc:end a\nreturn 1;");
  assert.equal(forged.stripped, 0);
  assert.match(engine.guardBody(forged.body)!, /marker-shaped line/);
  // in a compile: stripped and logged, then committed
  const src = ['import * as arc from "open-arc";', 'export const nSpec = arc.defineRegion<(s: string) => number>({ id: "fx.n", intent: "count markers" });', ""].join("\n");
  const logs: string[] = [];
  const fake = fakePorts({ files: { "src/fx.ts": src, [M]: '{"schema":1,"regions":{}}' }, http: [TAGS, chat(JSON.stringify({ body: "// count lines that start with @openarc:\nreturn s.split(\"\\n\").length;" }))] });
  const res = await run({ ...(fake.instance as Ports), log: (l) => logs.push(l) }, req);
  assert.equal(res.exit, 0, JSON.stringify(res.diagnostics));
  assert.ok(logs.includes("  fx.n: stripped 1 comment mentioning @openarc: (markers belong to the compiler)"), logs.join("\n"));
  assert.ok(!(fake.snapshot() as Snap).files["src/fx.ts"]!.includes("count lines"));
}

// ── 5. sibling signatures, not bodies, are fingerprinted (watch061: committing titleCase re-queued slugify)
{
  const src = (a: string) => [
    'import * as arc from "open-arc";',
    "type S = (s: string) => string;",
    'export const aSpec = arc.defineRegion<S>({ id: "fx.a", intent: "lower" });',
    'export const bSpec = arc.defineRegion<S>({ id: "fx.b", intent: "upper" });',
    "// @openarc:begin fx.a",
    a,
    "// @openarc:end fx.a",
    "// @openarc:begin fx.b",
    'export const b: S = (s) => arc.todo("fx.b");',
    "// @openarc:end fx.b",
    "",
  ].join("\n");
  const analyzed = async (a: string) => {
    const ports = fakePorts({ files: { "src/fx.ts": src(a) }, http: [TAGS] }).instance as Ports;
    const p = await engine.parse(ports, req, []);
    await engine.analyze(ports, req, p, []);
    return p.regions.find((r) => r.id === "fx.b")!;
  };
  const before = await analyzed('export const a: S = (s) => arc.todo("fx.a");');
  const after = await analyzed("export const a: S = (s) => {\n  return s.toLowerCase() as string;\n};");
  assert.equal(after.fingerprint, before.fingerprint, "a's commit leaves b's fingerprint alone");
  assert.ok(!before.context0.includes("const a: S") && after.context0.includes("const a: S"), "the prompt still shows a once it can be called");
}
console.log("v063: calls allowlist (E098), coverage probe (W045), requested-import bindings, marker-comment strip, sibling-signature fingerprints ok");
