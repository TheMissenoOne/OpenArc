// The palette (src/palette), no model. Run: node tests/palette.check.ts
// 1. The compiler reads it cleanly: concepts, variants, sketches; each hand-written sketch body is contained in its
//    sketch (E099) and keeps the per-hole rules; every package fits the default 9B budget.
// 2. Every region's examples, concept laws included (as the compiler expands them), pass through the harness.
// 3. The laws have teeth: broken bodies fail them. Properties on generated inputs: consistent-hash stability,
//    round-robin fairness, least-connections minimum, framing round trips under random chunking.
//    The UI part (loginPage.spec.tsx) is checked by tests/ui.check.ts.
// 4. The pending copy (tools/palette.ts) compiles end to end through this OS's sandbox against a fake Ollama that
//    answers with the hand-written bodies (fills for sketches): every region verified, every hole reached.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AnyFn, Json, RegionSpec } from "open-arc";
import { runExamples } from "open-arc/harness";
import type { CompileRequest, Ports } from "../src/types.ts";
import fakePorts from "./fakes/ports.memory.ts";
import * as engine from "../src/engine.ts";
import * as sketch from "../src/sketch.ts";
import { PALETTE_FAKES, PALETTE_FILES as ALL_FILES, pendingCopy } from "../tools/palette.ts";
import * as lb from "../src/palette/loadBalancer.ts";
import * as p2p from "../src/palette/p2p.ts";
import * as auth from "../src/palette/auth.ts";

const root = process.cwd();
const req: CompileRequest = { root, ids: [], model: { host: "http://h", model: "m", seed: 1, numCtx: 8192 }, sandbox: { nodeBin: "/n/bin/node", nodePrefix: "/n", heapMb: 256, addressSpaceBytes: 2 ** 32, cpuSeconds: 10 } };
const PALETTE_FILES = ALL_FILES.filter((f) => f.endsWith(".ts")); // the UI palette (loginPage) needs a DOM: tests/ui.check.ts
const files = Object.fromEntries(PALETTE_FILES.map((f) => [`src/palette/${f}`, readFileSync(join(root, "src/palette", f), "utf8")]));

// ── 1. the compiler's view
const ports = fakePorts({ files, http: [JSON.stringify({ models: [{ name: "qwen3.5:9b", digest: "d1" }] })] }).instance as Ports;
const p = await engine.parse(ports, req, []);
const ds: { code: string; id?: string; detail?: string }[] = [];
await engine.analyze(ports, req, p, ds as never);
assert.deepStrictEqual(ds.filter((d) => d.code.startsWith("OARC-E")), [], JSON.stringify(ds));
assert.deepStrictEqual([...p.concepts!.keys()].sort(), ["auth", "framing", "lbStrategy"]);
const variants = [...p.specs.values()].filter((s) => s.literal.concept).map((s) => s.id).sort();
assert.deepStrictEqual(variants, ["auth.apiKey", "auth.magicLink", "auth.password", "lb.consistentHash", "lb.leastConnections", "lb.roundRobin", "lb.weighted", "p2p.decodeLengthPrefixed", "p2p.decodeVarint"]);
const budget = (8192 - 3072) * 3.5;
const sizes: string[] = [];
for (const r of p.regions) {
  const s = r.spec;
  assert.ok(r.state === "developer", `${r.id}: hand-written in stage0`);
  if (s.sketch) {
    const body = engine.unwrapBody(r.bodyLines.join("\n"), "function");
    assert.deepStrictEqual(sketch.checkSketchBody(s.sketch, body, s.calls ?? []).problems, [], `${r.id}: the hand-written body is the sketch, filled`);
  }
  const size = engine.buildContext(p, r, 0, p.config.backends.local!).length;
  assert.ok(size <= budget, `${r.id}: package ${size} chars > ${budget}`);
  sizes.push(`${r.id} ${size}`);
}
assert.equal(p.regions.filter((r) => r.spec.sketch).length, 4);
const ctx = (id: string) => engine.buildContext(p, p.regions.find((r) => r.id === id)!, 0, p.config.backends.local!);
assert.match(ctx("auth.password"), /## Concept\nThis region is the "password" variant of concept auth: /);
assert.match(ctx("lb.consistentHash"), /Waived for this variant: equal backends share requests evenly/);
assert.match(ctx("lb.failover"), /«1» one expression of type string: e's message/);

// ── 2. every region's examples, laws included, through the harness
let examples = 0;
for (const f of PALETTE_FILES) {
  const mod = await import(pathToFileURL(join(root, "src/palette", f)).href);
  for (const s of [...p.specs.values()].filter((x) => x.file === `src/palette/${f}`)) {
    const outcomes = await runExamples(root, mod[s.symbol] as AnyFn, { ...(mod[s.exportName] as RegionSpec<AnyFn>), examples: s.examples as never });
    assert.deepStrictEqual(outcomes.filter((o) => !o.ok), [], s.id);
    assert.ok(outcomes.length >= 3, `${s.id}: ${outcomes.length} examples`);
    examples += outcomes.length;
  }
}

// ── 3. the laws have teeth, and the properties hold beyond the examples
const lawsOf = (id: string) => p.specs.get(id)!;
const failing = async (id: string, fn: AnyFn) => (await runExamples(root, fn, { id, examples: lawsOf(id).examples as never })).filter((o) => !o.ok).map((o) => o.name);
// a password check with a plain === compare passes every behavioural example, but not "constant-time compare used"
const plainCompare: auth.Strategy<auth.PasswordCred> = async (cred, ports) => {
  const user = await ports.users.findByEmail(cred.email.trim().toLowerCase());
  if (user === null || (await ports.hasher.hash(cred.password, user.passwordHash)) !== user.passwordHash) return { ok: false, reason: "invalid" };
  return { ok: true, userId: user.id };
};
const pc = await failing("auth.password", plainCompare);
assert.ok(pc.includes("law: constant-time compare used") && pc.includes("law: an unknown user still costs one compare") && !pc.includes("law: wrong secret is rejected"), pc.join("; "));
const enumerates: auth.Strategy<auth.ApiKeyCred> = async (cred, ports) => {
  const r = await auth.apiKey(cred, ports);
  return !r.ok && (await ports.users.findApiKey(cred.apiKey.split(".")[0]!)) === null ? { ok: false, reason: "expired" } : r;
};
assert.ok((await failing("auth.apiKey", enumerates)).includes("law: unknown user is the same error as a wrong secret"), "a distinct error for unknown keys enumerates users");
const rrWithUnhealthy: lb.Strategy = (backends, keys) => keys.map((_, i) => backends.length ? backends[i % backends.length]!.id : null);
assert.ok((await failing("lb.roundRobin", rrWithUnhealthy)).includes("law: never route to an unhealthy backend"));
const noRest: p2p.Decoder = (chunks) => ({ ...p2p.decodeVarint(chunks), rest: [] });
assert.deepStrictEqual(await failing("p2p.decodeVarint", noRest), ["law: an incomplete frame is kept as rest", "a varint cut in the middle", "a 2-byte length with no payload yet"]);

let seed = 7;
const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
const B = (ids: string[], o: Partial<lb.Backend> = {}) => ids.map((id) => ({ id, healthy: true, weight: 1, connections: 0, ...o }));
{
  const keys = Array.from({ length: 2000 }, (_, i) => `key-${i}-${Math.floor(rand() * 1e6)}`);
  const ids = ["a", "b", "c", "d", "e"];
  const before = lb.consistentHash(B(ids), keys);
  for (const gone of ids) {
    const after = lb.consistentHash(B(ids).map((b) => ({ ...b, healthy: b.id !== gone })), keys);
    keys.forEach((_, i) => {
      if (before[i] !== gone) assert.equal(after[i], before[i], `consistent-hash: removing ${gone} moved a key it didn't own`);
      else assert.notEqual(after[i], gone);
    });
  }
  const share = ids.map((id) => before.filter((x) => x === id).length / keys.length);
  assert.ok(share.every((s) => s > 0.1 && s < 0.32), `consistent-hash spread ${share}`);
  for (let n = 1; n <= ids.length; n++) {
    const picks = lb.roundRobin(B(ids.slice(0, n)), Array.from({ length: n * 7 }, () => "k"));
    for (const id of ids.slice(0, n)) assert.equal(picks.filter((x) => x === id).length, 7, "round-robin is fair over N picks");
  }
  for (let t = 0; t < 200; t++) {
    const bs = ids.map((id) => ({ id, healthy: rand() < 0.8, weight: 1, connections: Math.floor(rand() * 10) }));
    const [pick] = lb.leastConnections(bs, ["k"]);
    const healthy = bs.filter((b) => b.healthy);
    if (!healthy.length) assert.equal(pick, null);
    else assert.equal(bs.find((b) => b.id === pick)!.connections, Math.min(...healthy.map((b) => b.connections)), "least-connections picks the minimum");
  }
  const w = lb.weighted([{ id: "a", healthy: true, weight: 3, connections: 0 }, { id: "b", healthy: true, weight: 2, connections: 0 }], Array.from({ length: 50 }, () => "k"));
  assert.deepStrictEqual([w.filter((x) => x === "a").length, w.filter((x) => x === "b").length], [30, 20], "weights hold over whole cycles");
}
{
  const alphabet = ["a", "Z", " ", "é", "✓", "\u{1F600}", "\n", "0"];
  for (let t = 0; t < 300; t++) {
    const msgs = Array.from({ length: Math.floor(rand() * 4) }, () => Array.from({ length: Math.floor(rand() * (t % 10 === 0 ? 200 : 12)) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join(""));
    for (const [enc, dec] of [[p2p.encodeLengthPrefixed, p2p.decodeLengthPrefixed], [p2p.encodeVarint, p2p.decodeVarint]] as const) {
      const bytes = msgs.flatMap((m) => enc(m));
      const chunks: number[][] = [];
      for (let i = 0; i < bytes.length; ) {
        const n = Math.floor(rand() * 5);
        chunks.push(bytes.slice(i, i + n));
        i += n;
      }
      assert.deepStrictEqual(dec(chunks), { messages: msgs, rest: [] }, "round trip under random chunking");
      if (bytes.length) assert.deepStrictEqual(dec([bytes.slice(0, -1)]).messages, msgs.slice(0, -1), "a cut last frame isn't emitted");
    }
  }
}

// ── 4. the pending copy compiles end to end through the sandbox, the fake model answering with stage0's bodies
const replies = new Map<string, string>();
for (const r of p.regions) {
  const body = engine.unwrapBody(r.bodyLines.join("\n"), "function");
  const fills = r.spec.sketch ? sketch.contains(r.spec.sketch, body) : null;
  replies.set(r.spec.symbol, JSON.stringify(fills?.ok ? { fills: fills.fills, imports: [] } : { body, imports: [] }));
}
const server = createServer((rq, rs) => {
  let b = "";
  rq.on("data", (x) => (b += x));
  rq.on("end", () => {
    rs.setHeader("content-type", "application/json");
    if (rq.url === "/api/tags") return rs.end(JSON.stringify({ models: [{ name: "stub:1", digest: "d1" }] }));
    const prompt = (JSON.parse(b) as { messages: { content: string }[] }).messages[1]!.content;
    const symbol = /export const (\w+)/.exec(prompt)?.[1] ?? "";
    rs.end(JSON.stringify({ message: { role: "assistant", content: replies.get(symbol) ?? "{}" }, done: true }));
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const dir = realpathSync(mkdtempSync(join(tmpdir(), "openarc-palette-")));
try {
  cpSync(join(root, "core"), join(dir, "core"), { recursive: true });
  mkdirSync(join(dir, "node_modules"));
  symlinkSync(process.platform === "win32" ? join(dir, "core") : "../core", join(dir, "node_modules", "open-arc"), "junction");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pal", private: true, type: "module", dependencies: { "open-arc": "file:./core" } }));
  const main = join(root, "src", "main.ts");
  const cli = (...args: string[]) => new Promise<{ code: number; out: string }>((done) =>
    execFile(process.execPath, [main, ...args], { cwd: dir, encoding: "utf8", timeout: 600_000 }, (e, stdout, stderr) => done({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: `${stdout}${stderr}` })));
  assert.equal((await cli("init")).code, 0);
  writeFileSync(join(dir, "openarc.config.json"), JSON.stringify({ version: 1, backends: { stub: { provider: "ollama", model: "stub:1", host: `http://127.0.0.1:${(server.address() as { port: number }).port}`, maxContextTokens: 8192 } }, compilation: { defaultBackend: "stub", maxAttempts: 1 } }));
  mkdirSync(join(dir, "src", "palette"), { recursive: true });
  mkdirSync(join(dir, "tests", "fakes"), { recursive: true });
  for (const f of PALETTE_FILES) writeFileSync(join(dir, "src", "palette", f), pendingCopy(files[`src/palette/${f}`]!));
  for (const f of PALETTE_FAKES) cpSync(join(root, "tests", "fakes", f), join(dir, "tests", "fakes", f));
  const c = await cli("compile");
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, new RegExp(`done: exit 0 · ${p.regions.length} model call\\(s\\)`), c.out);
  assert.ok(!/OARC-W045|OARC-E/.test(c.out), c.out);
  const m = JSON.parse(readFileSync(join(dir, ".openarc", "manifest.json"), "utf8")) as { regions: Record<string, { ownership: string; provenance: { verifiedBy: string[]; waived?: Json } }> };
  for (const r of p.regions) {
    assert.equal(m.regions[r.id]?.ownership, "compiler", r.id);
    assert.ok(m.regions[r.id]!.provenance.verifiedBy.some((v) => /^examples:(\d+)\/\1$/.test(v)), `${r.id}: ${m.regions[r.id]!.provenance.verifiedBy}`);
  }
  assert.deepStrictEqual(m.regions["lb.consistentHash"]!.provenance.waived, { "equal backends share requests evenly": "hashing pins each key to a backend, so the spread is statistical, not even per batch" });
  console.log(`palette.check: the pending copy compiled through the sandbox: ${p.regions.length} regions committed`);
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`palette: ${p.regions.length} regions, ${examples} examples (laws included), properties and mutants ok; packages ${sizes.map((s) => s.split(" ")[1]).sort((a, b) => +b - +a)[0]} chars at most`);
