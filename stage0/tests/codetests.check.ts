// Code-first tests (SPEC §2.7, §9.3), no model: hand-written replies stand in for it. Run: node tests/codetests.check.ts
// 1. The static plan: test shapes (E010), the regions a test runs for, the summary, fakes by type (none: E010; two:
//    ambiguous), the staged rewrite (assertion indexes, fake names), and the context package (shown source with the
//    consts it reads; hidden tests counted, never shown).
// 2. The runner in-process: every matcher, soft assertions (one failure per assertion, with its index), a law's draws.
// 3. Real compiles through this OS's sandbox against a fake Ollama (tests/fixtures/code-first: a RoundRobin class with
//    two pending methods, a hidden test and a law; a p2p Peer over a faked Transport; a function with JSON examples):
//    json and code output formats, the joint class check, a hidden failure reported by name only, a test registered
//    outside the static plan (E090 test-registry), a member no test reaches (W045), and a second run with no model call.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompileRequest, Diagnostic, Ports } from "../src/types.ts";
import fakePorts from "./fakes/ports.memory.ts";
import * as engine from "../src/engine.ts";
import * as testsPlan from "../src/tests-plan.ts";
import { runTests } from "../core/test-runner.ts";

const root = process.cwd();
const FX = join(root, "tests", "fixtures", "code-first");
const read = (rel: string) => readFileSync(join(FX, rel), "utf8");
const FIXTURE = Object.fromEntries(["src/lb/balancer.ts", "src/p2p/peer.ts", "tests/balancer.test.ts", "tests/p2p.test.ts", "tests/fakes/net.memory.ts"].map((f) => [f, read(f)]));
const req: CompileRequest = { root, ids: [], model: { host: "http://h", model: "m", seed: 1, numCtx: 8192 }, sandbox: { nodeBin: "/n/bin/node", nodePrefix: "/n", heapMb: 256, addressSpaceBytes: 2 ** 32, cpuSeconds: 10 } };
const analyzed = async (files: Record<string, string>, at = root) => {
  const ports = fakePorts({ files }).instance as Ports;
  const p = await engine.parse(ports, { ...req, root: at }, []);
  const ds: Diagnostic[] = [];
  await engine.analyze(ports, { ...req, root: at }, p, ds, { offline: true });
  return { p, ds };
};
const codes = (ds: Diagnostic[]) => ds.map((d) => `${d.code}${d.id ? ` ${d.id}` : ""}${d.detail ? ` ${d.detail}` : ""}`);

// ── 1. the static plan
{
  const { p, ds } = await analyzed(FIXTURE);
  assert.deepStrictEqual(codes(ds), []);
  const tests = p.tests!;
  assert.deepStrictEqual(tests.map((t) => `${t.kind}${t.hidden ? ".hidden" : ""} ${t.name} -> ${t.regions.join(",")}`), [
    "test rotates in list order and wraps -> lb.roundRobin.pick,lb.roundRobin.markDown",
    "test no healthy backend gives null -> lb.roundRobin.pick,lb.roundRobin.markDown",
    "test markDown skips the backend and keeps the position -> lb.roundRobin.pick,lb.roundRobin.markDown",
    "test markDown of an unknown id throws -> lb.roundRobin.pick,lb.roundRobin.markDown",
    "test.hidden fair over 300 picks -> lb.roundRobin.pick,lb.roundRobin.markDown",
    "law never picks an unhealthy backend -> lb.roundRobin.pick,lb.roundRobin.markDown",
    "test known values -> lb.ringHash",
    "test forwards once, with one hop less -> p2p.peer.receive",
    "test a last hop is delivered, not forwarded -> p2p.peer.receive",
  ]);
  assert.deepStrictEqual(tests[7]!.fakes, ["net.memory"], "fakes.of<Transport>() resolves to the fake for that type");
  assert.deepStrictEqual(tests[0]!.assertions.map((a) => [a.line, a.summary]), [[12, 'rr.pick("x") → "a"'], [13, 'rr.pick("x") → "b"'], [14, 'rr.pick("x") → "c"'], [15, 'rr.pick("x") → "a"']]);
  assert.equal(tests[3]!.assertions[0]!.summary, 'new RR(three).markDown("z") throws "unknown backend z"');
  // the harness plan: every statement (the registry must match all of them), the ones that run, the fakes to preload
  const hp = testsPlan.harnessTests(tests, ["p2p.peer.receive"])!;
  assert.deepStrictEqual([hp.all.length, hp.run, hp.fakes], [9, [7, 8], ["net.memory"]]);
  // the staged copy: assertion indexes and fake names, nothing else
  const staged = testsPlan.instrument(FIXTURE["tests/p2p.test.ts"]!, "tests/p2p.test.ts", tests);
  assert.ok(staged.includes('const net = fakes.of<Transport>("net.memory");') && staged.includes("expect(fakes.snapshot(net), 2).toEqual"), staged);
  assert.equal(staged.replace(/, \d+\)/g, ")").replaceAll('"net.memory"', ""), FIXTURE["tests/p2p.test.ts"]);
  // the package: shown source and the consts it reads, the hidden test counted but never shown
  const r = p.regions.find((x) => x.id === "lb.roundRobin.pick")!;
  const ctx = engine.buildContext(p, r, 0, p.config.backends.local!);
  assert.match(ctx, /## Tests your body must pass \(TypeScript, run in a sandbox\)\nconst three: Backend\[\] = \[/);
  assert.match(ctx, /\/\/ plus 1 hidden test\(s\), not shown/);
  assert.ok(!ctx.includes("fair over 300") && !ctx.includes("counts["), "a hidden test's name and source stay out of the package");
  assert.match(ctx, /arc\.law\(RoundRobin, "never picks an unhealthy backend"/);
  // under budget pressure the summary replaces the source before anything else goes
  const tiny = engine.buildContext(p, r, 0, { ...p.config.backends.local!, maxContextTokens: 2100, outputReserveTokens: 1000 });
  assert.match(tiny, /## Tests your body must pass \(summary: the test source did not fit\)\nrr\.pick\("x"\) → "a"/);
  assert.match(tiny, /new RR\(three\)\.markDown\("z"\) throws "unknown backend z"\n\/\/ plus \d+ assertion\(s\) not shown/);
  // shapes the compiler can't read, and fakes it can't resolve
  const bad = await analyzed({ ...FIXTURE, "tests/bad.test.ts": 'import * as arc from "open-arc";\nimport { Peer, type Transport } from "../src/p2p/peer.ts";\nconst n = "x";\narc.test(Peer, n, () => {});\narc.test(Peer, "ok", (P, expect, fakes) => {\n  expect(fakes.of<Transport>()).toBe(null);\n  expect(fakes.of<string>()).toBe("");\n});\n' });
  assert.deepStrictEqual(codes(bad.ds), ["OARC-E010 test:name", "OARC-E010 fake:string"]);
  const two = await analyzed({ ...FIXTURE, "tests/fakes/net.other.ts": FIXTURE["tests/fakes/net.memory.ts"]! });
  assert.deepStrictEqual(codes(two.ds), ["OARC-E010 fake:Transport:ambiguous", "OARC-E010 fake:Transport:ambiguous"], "one per call site");
}

// ── 2. the runner, in-process (the sandbox runs the same code)
const dir = realpathSync(mkdtempSync(join(tmpdir(), "openarc-codetests-")));
try {
  mkdirSync(join(dir, "node_modules"));
  symlinkSync(join(root, "core"), join(dir, "node_modules", "open-arc"), "junction");
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }');
  const files: Record<string, string> = {
    "src/m.ts": "export function twice(n: number): number {\n  return 2 * n;\n}\n",
    "tests/m.test.ts": `import * as arc from "open-arc";
import { twice } from "../src/m.ts";

arc.test(twice, "matchers that pass", async (f, expect) => {
  expect(f(2)).toBe(4);
  expect(-0).toBe(0);
  expect([0.1 + 0.2, NaN]).toEqual([0.3, NaN]);
  expect(1).toEqual(1.001, { tolerance: 0.01 });
  expect("hello").toMatch(/ell/);
  expect("hello").toMatch("lo");
  expect([1, 2]).toHaveLength(2);
  expect([{ a: 1 }]).toContain({ a: 1 });
  expect("abc").toContain("b");
  expect(() => { throw new Error("boom: x"); }).toThrow("boom");
  await expect(Promise.reject(new Error("no way"))).toReject(/no/);
});

arc.test(twice, "soft assertions", async (f, expect) => {
  expect(f(2)).toBe(5);
  expect(f(1)).toBe(2);
  expect(-0).toEqual(0, { exact: true });
  expect(() => 1).toThrow();
  await expect(Promise.resolve(1)).toReject();
  expect([1]).toHaveLength(2);
});

arc.law(twice, "doubles are even", (f, expect, gen) => {
  const n = gen.int(-5, 5);
  expect(f(n) % 2 === 0 && f(n) !== 6).toBe(true);
}, { runs: 40, seed: 3 });

arc.test(twice, "throws", (f) => {
  f(1);
  throw new Error("kaput");
});
`,
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  const { p, ds } = await analyzed(files, dir);
  assert.deepStrictEqual(codes(ds), []);
  // twice isn't a region: run every test of the file
  const plan = { all: p.tests!.map((t) => ({ file: t.file, kind: t.kind, hidden: t.hidden, name: t.name })), run: [0, 1, 2, 3] };
  writeFileSync(join(dir, "tests/m.test.ts"), testsPlan.instrument(files["tests/m.test.ts"]!, "tests/m.test.ts", p.tests!));
  const out = await runTests(dir, plan);
  assert.deepStrictEqual(out[0], { name: 'test "matchers that pass"', ok: true });
  assert.deepStrictEqual(out[1], { name: 'test "soft assertions"', ok: false, actual: { checks: 6, failures: [
    { i: 0, detail: "got 4; expected 5" },
    { i: 2, detail: "got -0; expected 0" },
    { i: 3, detail: "returned instead of throwing" },
    { i: 4, detail: "resolved instead of rejecting" },
    { i: 5, detail: "length 1; expected 2" },
  ] } });
  const law = out[2]!.actual as { failures: { i: number }[]; law: string };
  assert.match(law.law, /^failed at run \d+\/40 \(seed 3\); draws \[3\]$/, "a failing law prints its run, seed and draws");
  assert.deepStrictEqual(out[3], { name: 'test "throws"', ok: false, actual: { checks: 0, failures: [], threw: "kaput" } });
  const t1 = p.tests![1]!;
  assert.equal(testsPlan.failureText(t1, out[1]!.name, out[1]!.actual).split("\n").slice(0, 3).join("\n"), 'OARC-E090 test "soft assertions" failed:\n  line 19: expect(f(2)).toBe(5)\n    got 4; expected 5');
  assert.equal(testsPlan.failureText({ ...t1, hidden: true }, out[1]!.name, { hidden: true }), 'OARC-E090 hidden test failed: "soft assertions"', "a hidden test: by name only");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── 3. real compiles through the sandbox
const BODIES: Record<string, string> = {
  "RoundRobin.pick": "const hs = this.healthy();\nif (hs.length === 0) return null;\nconst b = hs[this.next % hs.length]!;\nthis.next = (this.next + 1) % hs.length;\nreturn b.id;",
  "RoundRobin.markDown": "const b = this.backends.find((x) => x.id === id);\nif (!b) throw new Error(`unknown backend ${id}`);\nb.healthy = false;",
  "hash32": "let h = 2166136261;\nfor (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;\nreturn h;",
  "Peer.receive": "if (this.seen.includes(msg.id)) return false;\nthis.seen.push(msg.id);\nthis.delivered.push(msg.body);\nif (msg.ttl > 0) {\n  const next = [...this.peers].sort().filter((x) => x !== from && x !== msg.origin && x !== this.self).slice(0, 2);\n  for (const to of next) await this.net.send(this.self, to, { ...msg, ttl: msg.ttl - 1 });\n}\nreturn true;",
};
// passes the shown tests and the law, fails the hidden fairness test (after 30 picks it always answers "a")
const UNFAIR = "const hs = this.healthy();\nif (hs.length === 0) return null;\nconst b = hs[this.next % hs.length]!;\nthis.next = this.next + 1;\nreturn this.next > 30 ? hs[0]!.id : b.id;";
let replies: Record<string, string[]> = {};
let format: "json" | "code" = "json";
const prompts: string[] = [];
const server = createServer((rq, rs) => {
  let b = "";
  rq.on("data", (x) => (b += x));
  rq.on("end", () => {
    rs.setHeader("content-type", "application/json");
    if (rq.url === "/api/tags") return rs.end(JSON.stringify({ models: [{ name: "stub:1", digest: "d1" }] }));
    const msg = (JSON.parse(b) as { messages: { content: string }[] }).messages[1]!.content;
    prompts.push(msg);
    const which = /<<<BODY>>> \(([\w.]+)\)/.exec(msg)![1]!;
    const body = replies[which]?.shift() ?? BODIES[which]!;
    // "code": the whole method in a fence, as a small model often answers; the compiler keeps only its body
    const head = which === "hash32" ? "export function hash32(text: string): number" : which === "Peer.receive" ? "async receive(from: string | null, msg: Gossip): Promise<boolean>" : "";
    const content = format === "json" ? JSON.stringify({ body, imports: [] }) : "```ts\n" + (head ? `${head} {\n${body}\n}` : body) + "\n```";
    rs.end(JSON.stringify({ message: { role: "assistant", content }, done: true, prompt_eval_count: 200, eval_count: 20 }));
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const port = (server.address() as { port: number }).port;
const cli = (cwd: string, ...args: string[]) =>
  new Promise<{ code: number; out: string }>((done) =>
    execFile(process.execPath, [join(root, "src", "main.ts"), ...args], { cwd, encoding: "utf8", timeout: 180_000 }, (e, so, se) =>
      done({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: `${so}${se}` })));
const proj = realpathSync(mkdtempSync(join(tmpdir(), "openarc-codetests-")));
try {
  cpSync(join(root, "core"), join(proj, "core"), { recursive: true });
  mkdirSync(join(proj, "node_modules"));
  symlinkSync(process.platform === "win32" ? join(proj, "core") : "../core", join(proj, "node_modules", "open-arc"), "junction");
  symlinkSync(join(root, "node_modules", "typescript"), join(proj, "node_modules", "typescript"), "junction");
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "ct", private: true, type: "module", dependencies: { "open-arc": "file:./core" } }));
  assert.equal((await cli(proj, "init")).code, 0);
  const config = (outputFormat: string) => JSON.stringify({ version: 1, backends: { stub: { provider: "ollama", model: "stub:1", host: `http://127.0.0.1:${port}`, maxContextTokens: 8192, outputFormat } }, compilation: { defaultBackend: "stub", maxAttempts: 2 } });
  const reset = (outputFormat: "json" | "code", over: Record<string, string> = {}) => {
    rmSync(join(proj, "src"), { recursive: true, force: true });
    rmSync(join(proj, "tests"), { recursive: true, force: true });
    rmSync(join(proj, ".openarc", "cache"), { recursive: true, force: true });
    for (const [rel, text] of Object.entries({ ...FIXTURE, ...over })) {
      mkdirSync(join(proj, rel, ".."), { recursive: true });
      writeFileSync(join(proj, rel), text);
    }
    writeFileSync(join(proj, ".openarc", "manifest.json"), '{"schema":1,"regions":{}}');
    writeFileSync(join(proj, "openarc.config.json"), config(outputFormat));
    format = outputFormat;
    replies = {};
    prompts.length = 0;
  };
  const src = (rel: string) => readFileSync(join(proj, rel), "utf8");
  const manifest = () => JSON.parse(src(".openarc/manifest.json")).regions as Record<string, { ownership: string; provenance: { verifiedBy: string[]; outputFormat: string } }>;

  for (const fmt of ["json", "code"] as const) {
    reset(fmt);
    const c = await cli(proj, "compile");
    assert.equal(c.code, 0, c.out);
    assert.match(c.out, /lb\.roundRobin\.pick: ✓ tsc, static, tests:4\/6 \(2 inconclusive: pending regions\), hidden:1/, c.out);
    assert.match(c.out, /done: exit 0 · 4 model call\(s\)/, c.out);
    const m = manifest();
    assert.deepStrictEqual(Object.keys(m), ["lb.roundRobin.pick", "lb.roundRobin.markDown", "lb.ringHash", "p2p.peer.receive"]);
    assert.deepStrictEqual(m["lb.roundRobin.markDown"]!.provenance.verifiedBy, ["tsc", "static", "tests:6/6", "hidden:1"]);
    assert.deepStrictEqual(m["lb.ringHash"]!.provenance.verifiedBy, ["tsc", "static", "examples:1/1", "tests:1/1"], "JSON examples and tests on one region");
    assert.deepStrictEqual(m["p2p.peer.receive"]!.provenance.verifiedBy, ["tsc", "static", "tests:2/2"], "fakes by type, in the sandbox");
    assert.ok(Object.values(m).every((e) => e.ownership === "compiler" && e.provenance.outputFormat === fmt));
    const text = src("src/lb/balancer.ts");
    assert.ok(text.includes("  pick(key: string): string | null {\n    // @openarc:begin lb.roundRobin.pick\n    const hs = this.healthy();"), text);
    assert.ok(!text.includes("__openarcHit") && src("tests/balancer.test.ts") === FIXTURE["tests/balancer.test.ts"], "probes and assertion indexes stay in the stage");
    assert.ok(src("src/p2p/peer.ts").includes("    // @openarc:begin p2p.peer.receive\n    if (this.seen.includes(msg.id)) return false;"));
    const tsc = await new Promise<number>((done) => execFile(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "."], { cwd: proj }, (e) => done(e ? 1 : 0)));
    assert.equal(tsc, 0, "the committed project type-checks");
  }
  // a second run: every fingerprint matches, no model call
  const again = await cli(proj, "compile");
  assert.match(again.out, /done: exit 0 · 0 model call\(s\)/, again.out);

  // a hidden test fails: the repair prompt names it, and nothing else about it
  reset("json");
  replies = { "RoundRobin.pick": [UNFAIR] };
  let c = await cli(proj, "compile", "lb.roundRobin.pick", "lb.roundRobin.markDown");
  assert.equal(c.code, 0, c.out);
  const repair = prompts.find((x) => x.includes("Your previous attempt failed"))!;
  assert.ok(repair, c.out);
  assert.match(repair, /Problems:\nOARC-E090 hidden test failed: "fair over 300 picks"\n/);
  assert.ok(!repair.includes("counts") && !repair.includes("100"), "no values or source of a hidden test reach the model");

  // a test registered outside the static plan (in a loop) is refused before anything runs. (A file with no planned test
  // is never imported, so what it would register never runs.)
  reset("json", { "tests/balancer.test.ts": `${FIXTURE["tests/balancer.test.ts"]}\nfor (const s of ["a"]) arc.test(hash32, s, (h, expect) => expect(h(s)).toBe(0));\n` });
  c = await cli(proj, "compile", "lb.ringHash");
  assert.equal(c.code, 1, c.out);
  assert.match(c.out, /OARC-E090 lb\.ringHash .*\[test-registry:tests\/balancer\.test\.ts: planned \[.*\], registered \[.*test "known values", test "a"\]\]/, c.out);
  assert.match(c.out, /1 model call\(s\)/, "stopped: a registry mismatch is not the body's to fix");

  // a member no passing test reaches: W045 for it, W042 for its sibling, nothing of the class committed
  const shown = FIXTURE["tests/balancer.test.ts"]!;
  const noMarkDown = shown.replace(/arc\.test\(RoundRobin, "markDown[\s\S]*?\n\}\);\n/g, "");
  reset("json", { "tests/balancer.test.ts": noMarkDown });
  c = await cli(proj, "compile", "lb.roundRobin.pick", "lb.roundRobin.markDown");
  assert.match(c.out, /OARC-W045 lb\.roundRobin\.markDown {2}.*unreached:lb\.roundRobin\.markDown/, c.out);
  assert.match(c.out, /OARC-W042 lb\.roundRobin\.pick {2}.*unreached:lb\.roundRobin\.markDown/, c.out);
  assert.equal(src("src/lb/balancer.ts"), FIXTURE["src/lb/balancer.ts"], "the pending bodies are as written");
  console.log("codetests.check: real sandbox compiles ok (json and code, joint class check, hidden by name, registry E090, W045, cache)");
} finally {
  server.close();
  rmSync(proj, { recursive: true, force: true });
}
console.log("codetests: static plan, summary, fakes by type, staged rewrite, package (hidden withheld), matchers, soft assertions, law draws ok");
