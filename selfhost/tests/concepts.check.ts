// Concepts (SPEC §2.5), on in-memory ports: no model, no sandbox. Run: node tests/concepts.check.ts
// 1. Laws x fixtures become a variant's first examples ("law: <name>"), statically; waived laws are skipped and listed.
//    A missing fixture, an unknown concept, a waiver of an unknown law are E010; a variant whose F isn't an instance of
//    the concept's interface is E020.
// 2. Fingerprints: changing a law changes every variant's spec hash; changing the concept's intent changes its users'
//    fingerprints (they see its one-line summary) and leaves unrelated regions alone.
// 3. Packages: a variant gets a Concept section; a sketch that calls a variant sees its signature plus the concept's
//    summary, never its body; a prose region sees the variants its file imports.
// 4. PLAN compiles a sketch's callee before it; a compile logs waivers and records them in the manifest provenance.
import assert from "node:assert/strict";
import type { CompileRequest, Ports } from "../src/types.ts";
import fakePorts from "./fakes/ports.memory.ts";
import * as engine from "../src/engine.ts";
import { expandLaws } from "../src/concepts.ts";
import { run } from "../src/compile.ts";

const root = process.cwd();
const req: CompileRequest = { root, ids: [], model: { host: "http://h", model: "m", seed: 1, numCtx: 8192 }, sandbox: { nodeBin: "/n/bin/node", nodePrefix: "/n", heapMb: 256, addressSpaceBytes: 2 ** 32, cpuSeconds: 10 } };
const TAGS = JSON.stringify({ models: [{ name: "qwen3.5:9b", digest: "d1" }] });

const PORTS = { $fake: "auth.memory", init: { users: [{ id: "u1", email: "ana@x.io", hash: "h:secret", key: "k1" }] } };
const AUTH = (o: { intent?: string; law2?: string; apiKeyType?: string; apiKeyExtra?: string } = {}) => `import * as arc from "open-arc";
export interface User { id: string; email: string; hash: string; key: string }
export interface AuthPorts { users: User[] }
export type AuthResult = { ok: true; userId: string } | { ok: false; reason: "invalid" };
export type Strategy<C> = (cred: C, ports: AuthPorts) => Promise<AuthResult>;
export type PasswordCred = { email: string; password: string };

export const authConcept = arc.defineConcept({
  id: "auth",
  interface: "Strategy",
  intent: ${JSON.stringify(o.intent ?? "Authenticate one credential. Never throws for bad input.")},
  laws: [
    { name: "valid credential authenticates", args: ["$fixture:valid", "$fixture:ports"], expected: { ok: true, userId: "u1" } },
    { name: ${JSON.stringify(o.law2 ?? "wrong secret is rejected")}, args: ["$fixture:invalid", "$fixture:ports"], expected: { ok: false, reason: "invalid" } },
    { name: "unknown user is the same error", args: ["$fixture:unknown", "$fixture:ports"], expected: { ok: false, reason: "invalid" } },
  ],
});

export const passwordSpec = arc.defineRegion<Strategy<PasswordCred>>({
  id: "auth.password",
  concept: "auth",
  fixtures: { ports: ${JSON.stringify(PORTS)}, valid: { email: "ana@x.io", password: "secret" }, invalid: { email: "ana@x.io", password: "nope" }, unknown: { email: "bob@x.io", password: "secret" } },
  examples: [{ name: "email is trimmed", args: [{ email: " ana@x.io", password: "secret" }, ${JSON.stringify(PORTS)}], expected: { ok: true, userId: "u1" } }],
  sketch: async (cred, ports) => {
    const u = ports.users.find((x) => x.email === arc.hole<string>("cred.email, trimmed"));
    return u && u.hash === "h:" + cred.password ? { ok: true, userId: u.id } : { ok: false, reason: "invalid" };
  },
});

export const apiKeySpec = arc.defineRegion<${o.apiKeyType ?? "Strategy<{ apiKey: string }>"}>({
  id: "auth.apiKey",
  concept: "auth",
  intent: "Find the user whose key equals cred.apiKey.",
  fixtures: { ports: ${JSON.stringify(PORTS)}, valid: { apiKey: "k1" }, invalid: { apiKey: "k2" } },
  waive: { "unknown user is the same error": "a key names no user"${o.apiKeyExtra ?? ""} },
});
`;
const APP = `import * as arc from "open-arc";
import * as auth from "./auth.ts";
type Login = (cred: auth.PasswordCred, ports: auth.AuthPorts) => Promise<{ ok: boolean; message: string }>;
export const loginSpec = arc.defineRegion<Login>({
  id: "app.login",
  sketch: async (cred, ports) => {
    const r = await auth.password(cred, ports);
    return { ok: r.ok, message: arc.hole<string>("'Welcome' when r.ok, else 'Wrong email or password.'") };
  },
});
type Greet = (cred: auth.PasswordCred, ports: auth.AuthPorts) => Promise<string>;
export const greetSpec = arc.defineRegion<Greet>({ id: "app.greet", intent: "Authenticate with auth.password; 'hi <email>' or 'no'." });
`;
const OTHER = `import * as arc from "open-arc";
export const incSpec = arc.defineRegion<(n: number) => number>({ id: "other.inc", intent: "add one" });
`;
type D = { code: string; id?: string; detail?: string };
const analyzed = async (files: Record<string, string>, offline = true) => {
  const ports = fakePorts({ files, http: [TAGS] }).instance as Ports;
  const p = await engine.parse(ports, req, []);
  const ds: D[] = [];
  await engine.analyze(ports, req, p, ds as never, { offline });
  return { p, ds, r: (id: string) => p.regions.find((x) => x.id === id)! };
};

// ── 1. law expansion
{
  const { p, ds } = await analyzed({ "src/auth.ts": AUTH() });
  assert.deepStrictEqual(ds, []);
  const names = (id: string) => (p.specs.get(id)!.examples as { name: string }[]).map((e) => e.name);
  assert.deepStrictEqual(names("auth.password"), ["law: valid credential authenticates", "law: wrong secret is rejected", "law: unknown user is the same error", "email is trimmed"]);
  assert.deepStrictEqual(names("auth.apiKey"), ["law: valid credential authenticates", "law: wrong secret is rejected"]);
  assert.deepStrictEqual(p.specs.get("auth.apiKey")!.examples[1], { name: "law: wrong secret is rejected", args: [{ apiKey: "k2" }, PORTS], expected: { ok: false, reason: "invalid" } });
  assert.deepStrictEqual(expandLaws({ laws: [{ name: "a", args: ["$fixture:x"] }] }, { fixtures: {} }).error, "fixture-missing:x");
  const errs = async (src: string) => (await analyzed({ "src/auth.ts": src })).ds.map((d) => `${d.code} ${d.id} ${d.detail}`);
  assert.deepStrictEqual(await errs(AUTH().replace(', invalid: { apiKey: "k2" }', "")), ["OARC-E010 auth.apiKey fixture-missing:invalid"]);
  assert.deepStrictEqual(await errs(AUTH({ apiKeyExtra: ', "no such law": "x"' })), ["OARC-E010 auth.apiKey waive-unknown-law:no such law"]);
  assert.deepStrictEqual(await errs(AUTH().replace('concept: "auth",\n  intent: "Find', 'concept: "authz",\n  intent: "Find')), ["OARC-E010 auth.apiKey concept-unknown:authz"]);
  assert.deepStrictEqual(await errs(AUTH({ apiKeyType: "(cred: { apiKey: string }, ports: AuthPorts) => Promise<AuthResult>" })), ["OARC-E020 auth.apiKey concept-interface:Strategy"]);
}

// ── 2. fingerprints
{
  const base = await analyzed({ "src/auth.ts": AUTH(), "src/app.ts": APP, "src/other.ts": OTHER }, false);
  assert.deepStrictEqual(base.ds, []);
  const lawEdit = await analyzed({ "src/auth.ts": AUTH({ law2: "a wrong secret is rejected" }), "src/app.ts": APP, "src/other.ts": OTHER }, false);
  for (const id of ["auth.password", "auth.apiKey"]) assert.notEqual(lawEdit.r(id).specHash, base.r(id).specHash, `${id}: a law changed`);
  const intentEdit = await analyzed({ "src/auth.ts": AUTH({ intent: "Authenticate one credential; never throw." }), "src/app.ts": APP, "src/other.ts": OTHER }, false);
  assert.notEqual(intentEdit.r("app.login").fingerprint, base.r("app.login").fingerprint, "a user sees the concept's summary");
  assert.notEqual(intentEdit.r("app.greet").fingerprint, base.r("app.greet").fingerprint, "a prose user too");
  assert.equal(intentEdit.r("other.inc").fingerprint, base.r("other.inc").fingerprint, "unrelated regions are untouched");

  // ── 3. packages
  const { p, r } = base;
  const ctx = (id: string) => engine.buildContext(p, r(id), 0, p.config.backends.local!);
  assert.match(ctx("auth.password"), /## Concept\nThis region is the "password" variant of concept auth: Authenticate one credential\. Never throws for bad input\.\nIts examples below include the concept's laws/);
  assert.match(ctx("auth.password"), /"name":"law: valid credential authenticates"/);
  assert.match(ctx("auth.apiKey"), /Waived for this variant: unknown user is the same error \(a key names no user\)\./);
  const login = ctx("app.login");
  assert.match(login, /## Functions the sketch calls\nauth\.password: Strategy<PasswordCred> {2}\/\/ variant of concept auth: Authenticate one credential\. Never throws for bad input\. Laws: valid credential authenticates; wrong secret is rejected; unknown user is the same error\./);
  assert.match(login, /## Calls allowed in fills\nYou may call: auth\.password /);
  assert.ok(!login.includes("cred.email, trimmed") && !login.includes("email is trimmed"), "never the variant's sketch or examples");
  assert.match(ctx("app.greet"), /## Concept variants you can call\nauth\.password: Strategy<PasswordCred> {2}\/\/ variant of concept auth: .*\nauth\.apiKey: Strategy<\{ apiKey: string \}> {2}\/\/ variant/);

  // ── 4a. PLAN: callees first (the sketch calls auth.password; app.ts imports auth.ts, so app.greet waits too)
  assert.deepStrictEqual(engine.plan(p, req, []).filter((id) => id !== "other.inc"), ["auth.password", "auth.apiKey", "app.login", "app.greet"]);
}

// ── 4b. a compile logs the waiver and records it in the manifest
{
  const logs: string[] = [];
  const ok = (n: number) => ({ code: 0, stdout: [...Array.from({ length: n }, (_, i) => ({ name: `#${i}`, ok: true })), { done: n }].map((l) => JSON.stringify(l)).join("\n") + "\n", timedOut: false });
  const fake = fakePorts({
    files: { "src/auth.ts": AUTH(), "package.json": "{}", ".openarc/manifest.json": '{"schema":1,"regions":{}}' },
    http: [TAGS, JSON.stringify({ message: { role: "assistant", content: JSON.stringify({ body: 'const u = ports.users.find((x) => x.key === cred.apiKey);\nreturn u ? { ok: true, userId: u.id } : { ok: false, reason: "invalid" };' }) }, done: true })],
    proc: [{ code: 0, stdout: "", timedOut: false }, ok(2)],
  });
  const res = await run({ ...(fake.instance as Ports), log: (l) => logs.push(l) }, { ...req, ids: ["auth.apiKey"] });
  assert.equal(res.exit, 0, JSON.stringify(res.diagnostics));
  assert.ok(logs.includes('  auth.apiKey: law "unknown user is the same error" waived: a key names no user'), logs.join("\n"));
  const m = JSON.parse((fake.snapshot() as { files: Record<string, string> }).files[".openarc/manifest.json"]!);
  assert.deepStrictEqual(m.regions["auth.apiKey"].provenance.waived, { "unknown user is the same error": "a key names no user" });
  const plan = JSON.parse(Object.entries((fake.snapshot() as { files: Record<string, string> }).files).find(([f]) => f.endsWith(".openarc/harness-plan.json"))?.[1] ?? "null");
  assert.equal(plan, null, "the sandbox stage is removed after the run");
}
console.log("concepts: laws x fixtures, waivers, E010/E020, spec hashes and fingerprints, packages, PLAN order, provenance ok");
