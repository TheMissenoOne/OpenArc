// Sketches (SPEC §3.7), no model: hand-written replies stand in for it. Run: node tests/sketch.check.ts
// 1. Extraction: holes (kind, type, description), parameters from the sketch, implied calls, E010 for bad sketches,
//    and a mistyped hole is OARC-E070 (detail sketch:TS2345) at ANALYZE, before any model call.
// 2. Containment (E099): per-hole fills and a whole-body reply are accepted with their fills recovered; a whole body
//    that changes non-hole code or drops a statement is rejected. A statement fill with `return` is E035, a fill that
//    calls an off-list port is E098. The spec hash covers the sketch (whitespace-insensitive).
// 3. The context package and the request: Sketch with «n», Holes, calls allowed in fills, the {fills} schema; in
//    outputFormat "code" no schema, a whole filled sketch as a code block, fills recovered by containment, tokens counted.
// 4. A real compile through this OS's sandbox against a fake Ollama: a wrong fill fails an example and is repaired;
//    the committed body is the sketch with the fills; W045 for a hole no example reaches; E100 for an example the
//    sketch decides before any hole.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompileRequest, Ports } from "../src/types.ts";
import fakePorts from "./fakes/ports.memory.ts";
import * as engine from "../src/engine.ts";
import * as sketch from "../src/sketch.ts";

const root = process.cwd();
const req: CompileRequest = { root, ids: [], model: { host: "http://h", model: "m", seed: 1, numCtx: 8192 }, sandbox: { nodeBin: "/n/bin/node", nodePrefix: "/n", heapMb: 256, addressSpaceBytes: 2 ** 32, cpuSeconds: 10 } };
const TAGS = JSON.stringify({ models: [{ name: "qwen3.5:9b", digest: "d1" }] });

const SRC = (sk: string) => `import * as arc from "open-arc";
export interface User { id: string; email: string; passwordHash: string; lockedUntil: number | null }
export interface AuthPorts {
  users: { findByEmail(email: string): Promise<User | null>; recordFailure(userId: string): Promise<void> };
  crypto: { verifyPassword(password: string, hash: string): Promise<boolean>; sha256(s: string): string };
  clock: { now(): number };
}
export type AuthResult = { ok: true; userId: string } | { ok: false; reason: "invalid" | "locked" | "unknown" };
type Password = (cred: { email: string; password: string }, ports: AuthPorts) => Promise<AuthResult>;

export const passwordSpec = arc.defineRegion<Password>({
  id: "fx.password",
  intent: "Emails compare case-insensitively.",
  calls: ["ports.users.recordFailure", "ports.clock.now"],
  sketch: ${sk},
});
`;
const SKETCH = `async (c, ports) => {
    const email = arc.hole<string>("c.email trimmed and lower-cased");
    const user = await ports.users.findByEmail(email);
    if (user === null) return { ok: false, reason: "unknown" };
    if (user.lockedUntil !== null && arc.hole<boolean>("the lock is still active at ports.clock.now()")) return { ok: false, reason: "locked" };
    const valid = await ports.crypto.verifyPassword(c.password, user.passwordHash);
    arc.hole("if not valid, record the failure for user.id");
    return valid ? { ok: true, userId: user.id } : { ok: false, reason: "invalid" };
  }`;
const FILLS = { 1: "c.email.trim().toLowerCase()", 2: "user.lockedUntil > ports.clock.now()", 3: "if (!valid) await ports.users.recordFailure(user.id);" };

const analyzed = async (text: string, opts: { offline?: boolean } = { offline: true }) => {
  const ports = fakePorts({ files: { "src/fx.ts": text }, http: [TAGS] }).instance as Ports;
  const p = await engine.parse(ports, req, []);
  const ds: { code: string; detail?: string; id?: string }[] = [];
  await engine.analyze(ports, req, p, ds as never, opts);
  return { p, ds, r: p.regions.find((x) => x.id === "fx.password") };
};

// ── 1. extraction
const { p, ds, r } = await analyzed(SRC(SKETCH));
assert.deepStrictEqual(ds, [], JSON.stringify(ds));
const sk = r!.spec.sketch!;
assert.deepStrictEqual(sk.holes.map((h) => [h.n, h.kind, h.type, h.description]), [
  [1, "expr", "string", "c.email trimmed and lower-cased"],
  [2, "expr", "boolean", "the lock is still active at ports.clock.now()"],
  [3, "stmt", "statements", "if not valid, record the failure for user.id"],
]);
assert.deepStrictEqual(r!.spec.params, ["c", "ports"], "parameter names come from the sketch");
assert.deepStrictEqual(sk.implied, ["ports.users.findByEmail", "ports.crypto.verifyPassword"]);
assert.ok(sk.holes[2]!.usedAfter.includes("valid") && sk.holes[2]!.isAsync);
assert.match(p.files.get("src/fx.ts")!, /export const password: Password = \(c, ports\) => arc\.todo\("fx\.password"\);/, "scaffolded with the sketch's names");
{
  const bad = await analyzed(SRC(SKETCH.replace('arc.hole<string>("c.email', 'arc.hole<number>("c.email')));
  assert.deepStrictEqual(bad.ds.map((d) => `${d.code} ${d.id} ${d.detail}`), ["OARC-E070 fx.password sketch:TS2345"], "a mistyped hole is a tsc error in the spec, before any model call");
  const adj = await analyzed(SRC(SKETCH.replace('arc.hole("if not valid', 'arc.hole("first");\n    arc.hole("if not valid')));
  assert.deepStrictEqual(adj.ds.map((d) => d.detail), ["sketch:adjacent-statement-holes"]);
  const lit = await analyzed(SRC(SKETCH.replace('arc.hole<boolean>("the lock is still active at ports.clock.now()")', "arc.hole<boolean>(c.email)")));
  assert.deepStrictEqual(lit.ds.map((d) => d.detail), ["sketch:hole-2-description-must-be-a-string-literal"]);
}

// ── 2. containment, per-hole rules, spec hash
const good = sketch.spliceFills(sk, FILLS);
assert.ok(good.includes("const email = (c.email.trim().toLowerCase());") && good.includes("\nif (!valid) await ports.users.recordFailure(user.id);\n"), good);
assert.deepStrictEqual(sketch.checkSketchBody(sk, good, r!.spec.calls!), { problems: [], fills: FILLS });
const whole = [
  "const email = c.email.trim().toLowerCase();",
  "const user = await ports.users.findByEmail(email);",
  "if (user === null) return { ok: false, reason: 'unknown' };", // single quotes: string literals compare by value
  "if (user.lockedUntil !== null && user.lockedUntil > ports.clock.now()) return { ok: false, reason: \"locked\" };",
  "// a comment the sketch doesn't have",
  "const valid = await ports.crypto.verifyPassword(c.password, user.passwordHash);",
  "if (!valid) {\n  await ports.users.recordFailure(user.id);\n}",
  "await ports.clock.now();",
  "return valid ? { ok: true, userId: user.id } : { ok: false, reason: \"invalid\" };",
].join("\n");
assert.deepStrictEqual(sketch.checkSketchBody(sk, whole, r!.spec.calls!).fills, { ...FILLS, 3: "if (!valid) {\n  await ports.users.recordFailure(user.id);\n}\nawait ports.clock.now();" }, "a whole-body reply: fills recovered, a statement hole takes 2 statements");
const hidden = whole.replace("reason: 'unknown'", "reason: 'invalid'"); // a 'helpful' edit that hides user enumeration
assert.deepStrictEqual(sketch.checkSketchBody(sk, hidden, []).problems, ["OARC-E099 sketch not preserved: body line 3 has `'invalid'` where the sketch has `\"unknown\"`"]);
const dropped = whole.split("\n").filter((l) => !l.includes("lockedUntil")).join("\n");
assert.match(sketch.checkSketchBody(sk, dropped, []).problems[0]!, /^OARC-E099 sketch not preserved: body line 5 has `const valid = await/);
assert.match(sketch.checkSketchBody(sk, "}; export const x = 1; function q() {", []).problems[0]!, /^OARC-E099 .*does not parse/);
assert.deepStrictEqual(sketch.checkSketchBody(sk, sketch.spliceFills(sk, { ...FILLS, 3: "if (!valid) { await ports.users.recordFailure(user.id); return { ok: false, reason: \"invalid\" }; }" }), r!.spec.calls!).problems,
  ["OARC-E035 hole «3»: not allowed in a statement hole: return"]);
assert.deepStrictEqual(sketch.checkSketchBody(sk, sketch.spliceFills(sk, { ...FILLS, 3: "if (!valid) await ports.users.recordFailure(ports.crypto.sha256(user.id));" }), r!.spec.calls!).problems,
  ["OARC-E098 hole «3»: call not allowed by spec: ports.crypto.sha256 (allowed: ports.users.findByEmail, ports.crypto.verifyPassword, ports.users.recordFailure, ports.clock.now)"]);
assert.deepStrictEqual(sketch.checkSketchBody(sk, sketch.spliceFills(sk, { ...FILLS, 3: "const valid = 1;" }), r!.spec.calls!).problems, ["OARC-E035 hole «3»: not allowed in a statement hole: binding:valid"]);
assert.deepStrictEqual(sketch.checkSketchBody(sk, sketch.spliceFills(sk, { ...FILLS, 1: "a); (b" }), []).problems.length, 1, "a fill can't change how the sketch parses");
{
  const spaced = await analyzed(SRC(SKETCH.replaceAll("    ", "      ")));
  assert.equal(spaced.r!.specHash, r!.specHash, "re-indenting the sketch doesn't change the spec hash");
  const changed = await analyzed(SRC(SKETCH.replace('reason: "unknown"', 'reason: "invalid"')));
  assert.notEqual(changed.r!.specHash, r!.specHash, "the spec hash covers the sketch");
}

// ── 3. the package and the reply protocol
{
  const ctx = engine.buildContext(p, r!, 0, p.config.backends.local!);
  assert.match(ctx, /## Task\nFill the numbered holes «n» in the sketch of export const password\./);
  assert.match(ctx, /## Sketch \(fixed; Password = \(cred: \{ email: string; password: string; \}, ports: AuthPorts\): Promise<AuthResult>\)\nasync \(c, ports\) => \{\n {2}const email = «1»;\n/);
  assert.match(ctx, /if \(user\.lockedUntil !== null && «2»\)/);
  assert.match(ctx, /## Holes\n«1» one expression of type string: c\.email trimmed and lower-cased\n«2» one expression of type boolean: .*\n«3» statements \(no return/);
  assert.match(ctx, /## Calls allowed in fills\nYou may call: ports\.users\.findByEmail, ports\.crypto\.verifyPassword, ports\.users\.recordFailure, ports\.clock\.now /);
  assert.ok(!ctx.includes("Fixed signature") && ctx.includes("export interface AuthPorts"), "types still come from the closure");
  const parsed = sketch.parseFills(JSON.stringify({ fills: FILLS, imports: [] }), sk);
  assert.ok(parsed.ok && parsed.body === good);
  assert.deepStrictEqual(sketch.parseFills(JSON.stringify({ fills: { 1: "x", 2: "y" } }), sk), { ok: false, diagnostic: { code: "OARC-E081", detail: "fill-missing:3" } });
  assert.deepStrictEqual(sketch.parseFills(JSON.stringify({ fills: { ...FILLS, 4: "z" } }), sk), { ok: false, diagnostic: { code: "OARC-E081", detail: "unexpected-fill:4" } });
  const wb = sketch.parseFills(JSON.stringify({ body: whole }), sk);
  assert.ok(wb.ok && wb.body === whole, "a whole-body reply is kept for containment to recover");
  // the request: the {fills} protocol and a schema with exactly one string per hole
  const fake = fakePorts({ files: { "src/fx.ts": SRC(SKETCH), ".openarc/manifest.json": '{"schema":1,"regions":{}}' }, http: [TAGS, JSON.stringify({ message: { role: "assistant", content: "not json" }, done: true }), JSON.stringify({ message: { role: "assistant", content: "not json" }, done: true }), JSON.stringify({ message: { role: "assistant", content: "not json" }, done: true })] });
  const { run } = await import("../src/compile.ts");
  await run(fake.instance as Ports, req);
  const chat = (fake.snapshot() as { requests: { url: string; body: { format: { properties: { fills: { required: string[] } } }; messages: { content: string }[] } }[] }).requests[1]!;
  assert.deepStrictEqual(chat.body.format.properties.fills.required, ["1", "2", "3"]);
  assert.match(chat.body.messages[0]!.content, /\{"fills"/);
  assert.match(chat.body.messages[1]!.content, /Reply with JSON only: \{"fills": \{"1": "<code>"/);
}
// outputFormat "code": no schema; the model writes the whole filled sketch as one code block and containment recovers
// the fills. Tokens are counted for sketch requests like any other.
{
  const config = JSON.stringify({ version: 1, backends: { local: { provider: "ollama", model: "qwen3.5:9b", maxContextTokens: 8192, outputFormat: "code" } }, compilation: { defaultBackend: "local", maxAttempts: 2 } });
  const reply = (code: string) => JSON.stringify({ message: { role: "assistant", content: "```ts\n" + code + "\n```" }, done: true, prompt_eval_count: 300, eval_count: 30 });
  const fake = fakePorts({ files: { "src/fx.ts": SRC(SKETCH), ".openarc/manifest.json": '{"schema":1,"regions":{}}', "openarc.config.json": config }, http: [TAGS, reply(hidden), reply(whole)] });
  const { run } = await import("../src/compile.ts");
  const res = await run(fake.instance as Ports, req);
  assert.equal(res.exit, 0, JSON.stringify(res.diagnostics));
  const snap = fake.snapshot() as { files: Record<string, string>; requests: { url: string; body: { format?: unknown; messages: { content: string }[] } }[] };
  const sent = snap.requests.filter((q) => q.url.endsWith("/api/chat")).map((q) => q.body);
  assert.equal(sent.length, 2, "attempt 1 changed non-hole code (E099) and was repaired");
  assert.ok(sent.every((b) => !("format" in b)), "no fills schema in code mode");
  assert.equal(sent[0]!.messages[0]!.content, sketch.SKETCH_CODE_SYSTEM);
  assert.match(sent[0]!.messages[1]!.content, /Reply with ONE fenced code block[\s\S]*with each «n» replaced by its fill/);
  assert.match(sent[1]!.messages[1]!.content, /OARC-E099 sketch not preserved/);
  const text = snap.files["src/fx.ts"]!;
  assert.ok(text.includes("export const password: Password = async (c, ports) => {\n  const email = c.email.trim().toLowerCase();") && text.includes("await ports.clock.now();"), text);
  const prov = JSON.parse(snap.files[".openarc/manifest.json"]!).regions["fx.password"].provenance;
  assert.deepStrictEqual([prov.outputFormat, prov.attempts, prov.tokens], ["code", 2, { prompt: 600, completion: 60 }]);
}

// ── 4. a real compile through the sandbox, fake Ollama
let replies: string[] = [];
let chats = 0;
const server = createServer((rq, rs) => {
  let b = "";
  rq.on("data", (x) => (b += x));
  rq.on("end", () => {
    rs.setHeader("content-type", "application/json");
    if (rq.url === "/api/tags") return rs.end(JSON.stringify({ models: [{ name: "stub:1", digest: "d1" }] }));
    if (rq.url === "/api/chat") return rs.end(JSON.stringify({ message: { role: "assistant", content: replies[chats++] ?? "{}" }, done: true, prompt_eval_count: 200, eval_count: 20 }));
    rs.statusCode = 404;
    rs.end("{}");
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const port = (server.address() as { port: number }).port;
const main = join(root, "src", "main.ts");
const cli = (cwd: string, ...args: string[]) =>
  new Promise<{ code: number; out: string }>((done) =>
    execFile(process.execPath, [main, ...args], { cwd, encoding: "utf8", timeout: 180_000 }, (e, stdout, stderr) =>
      done({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: `${stdout}${stderr}` })));
const FAKE = `import { defineFake } from "open-arc";
import type { AuthPorts, User } from "../../src/fx.ts";
export default defineFake<AuthPorts>((init) => {
  const i = init as unknown as { users: User[]; now: number };
  const failures: string[] = [];
  const instance: AuthPorts = {
    users: { findByEmail: async (e) => i.users.find((u) => u.email === e) ?? null, recordFailure: async (id) => { failures.push(id); } },
    crypto: { verifyPassword: async (pw, h) => h === "h:" + pw, sha256: (s) => "s:" + s },
    clock: { now: () => i.now },
  };
  return { instance, snapshot: () => ({ failures }) };
});
`;
const ana = (lockedUntil: number | null) => ({ id: "u1", email: "ana@x.io", passwordHash: "h:secret", lockedUntil });
const ex = (name: string, cred: object, users: object[], expected: object, failures?: string[]) =>
  `{ name: ${JSON.stringify(name)}, args: [${JSON.stringify(cred)}, { $fake: "auth.memory", init: { users: ${JSON.stringify(users)}, now: 1000 } }], expected: ${JSON.stringify(expected)}${failures ? `, fakesAfter: { "auth.memory": { failures: ${JSON.stringify(failures)} } }` : ""} }`;
const ALL = [
  ex("valid, mixed-case email", { email: " Ana@X.io ", password: "secret" }, [ana(null)], { ok: true, userId: "u1" }),
  ex("unknown user", { email: "bob@x.io", password: "secret" }, [ana(null)], { ok: false, reason: "unknown" }),
  ex("locked", { email: "ana@x.io", password: "secret" }, [ana(5000)], { ok: false, reason: "locked" }),
  ex("expired lock; failure recorded", { email: "ana@x.io", password: "bad" }, [ana(500)], { ok: false, reason: "invalid" }, ["u1"]),
];
const withExamples = (exs: string[], sk = SKETCH) => SRC(sk).replace("  sketch:", `  examples: [\n    ${exs.join(",\n    ")},\n  ],\n  sketch:`);
const dir = realpathSync(mkdtempSync(join(tmpdir(), "openarc-sketch-")));
try {
  cpSync(join(root, "core"), join(dir, "core"), { recursive: true });
  mkdirSync(join(dir, "node_modules"));
  symlinkSync(process.platform === "win32" ? join(dir, "core") : "../core", join(dir, "node_modules", "open-arc"), "junction");
  symlinkSync(join(root, "node_modules", "typescript"), join(dir, "node_modules", "typescript"), "junction");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "sk", private: true, type: "module", dependencies: { "open-arc": "file:./core" } }));
  assert.equal((await cli(dir, "init")).code, 0);
  writeFileSync(join(dir, "openarc.config.json"), JSON.stringify({ version: 1, backends: { stub: { provider: "ollama", model: "stub:1", host: `http://127.0.0.1:${port}`, maxContextTokens: 8192 } }, compilation: { defaultBackend: "stub", maxAttempts: 3 } }));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "tests", "fakes"), { recursive: true });
  writeFileSync(join(dir, "tests", "fakes", "auth.memory.ts"), FAKE);
  const reply = (fills: object) => JSON.stringify({ fills, imports: [] });
  const compile = async (src: string, rs: string[]) => {
    writeFileSync(join(dir, "src", "fx.ts"), src);
    rmSync(join(dir, ".openarc", "cache"), { recursive: true, force: true });
    writeFileSync(join(dir, ".openarc", "manifest.json"), '{"schema":1,"regions":{}}');
    replies = rs;
    chats = 0;
    return cli(dir, "compile");
  };

  // W045: no example reaches hole 2 (the lock check): verified otherwise, but not committed
  let c = await compile(withExamples(ALL.filter((e) => !e.includes("lockedUntil\":5000") && !e.includes("expired"))), [reply(FILLS)]);
  assert.equal(c.code, 1, c.out);
  assert.match(c.out, /OARC-W045 .*hole:fx\.password#2/, c.out);
  assert.ok(!readFileSync(join(dir, "src", "fx.ts"), "utf8").includes("@openarc:begin"), "an unverified hole: nothing committed, the region stays pending");

  // repair: attempt 1 forgets to lower-case (an example fails, reaching hole 1), attempt 2 is right
  c = await compile(withExamples(ALL), [reply({ ...FILLS, 1: "c.email.trim()" }), reply(FILLS)]);
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /done: exit 0 · 2 model call\(s\)/, c.out);
  const text = readFileSync(join(dir, "src", "fx.ts"), "utf8");
  assert.ok(text.includes("export const password: Password = async (c, ports) => {\n  const email = (c.email.trim().toLowerCase());"), text);
  assert.ok(!text.includes("__openarcHit"), "the probes never reach the committed source");
  const m = JSON.parse(readFileSync(join(dir, ".openarc", "manifest.json"), "utf8"));
  assert.deepStrictEqual(m.regions["fx.password"].provenance.verifiedBy, ["tsc", "static", "examples:4/4"]);
  assert.deepStrictEqual(m.regions["fx.password"].provenance.tokens, { prompt: 400, completion: 40 }, "both fills requests are counted");

  // E100: the sketch returns before any hole for an empty email, and the example disagrees: one model call, then stop
  const early = SKETCH.replace("const email =", 'if (c.email === "") return { ok: false, reason: "invalid" };\n    const email =');
  c = await compile(withExamples([...ALL, ex("empty email is unknown", { email: "", password: "x" }, [ana(null)], { ok: false, reason: "unknown" })], early), [reply(FILLS), reply(FILLS), reply(FILLS)]);
  assert.equal(c.code, 1, c.out);
  assert.match(c.out, /OARC-E100 .*empty email is unknown/, c.out);
  assert.match(c.out, /1 model call\(s\)/, c.out);
  console.log("sketch.check: real sandbox compile ok (repair, W045 per hole, E100)");
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log("sketch: extraction, E070 before the model, containment E099 + recovery, E035/E098 per hole, spec hash, package, {fills} protocol ok");
