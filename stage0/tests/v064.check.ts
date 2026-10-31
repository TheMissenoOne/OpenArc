// Fixes from the CodeRabbit review of 0.6.3 (PR #3), plus the `openarc init` module-type hint. In-memory ports, no model.
// Run: node tests/v064.check.ts   (watcher fixes: tests/watch.check.ts; backend/config fixes: tests/backends.check.ts)
// 1. A non-array `calls` (or one with non-strings) is OARC-E010, not a silently unrestricted spec.
// 2. The E098 local-name exemption holds only where the local is in scope (a nested function's parameter named like an
//    import doesn't exempt calls on the import outside that function).
// 3. An unannotated helper's inferred return type keeps its aliases in the type closure (and so in the fingerprint).
// 4. Coverage hits go to the example whose async work produced them.
// 5. `openarc init` says when package.json is not "type": "module".
// 6. Provider presets (openrouter, local, key-env defaults), in the fingerprint; `init --backend`; `openarc backends [test]`.
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import type { AnyFn, RegionSpec } from "open-arc";
import { runExamples } from "open-arc/harness";
import type { CompileRequest, Diagnostic, Ports } from "../src/types.ts";
import fakePorts from "./fakes/ports.memory.ts";
import * as engine from "../src/engine.ts";
import { applyPreset, parseConfig, presetConfig, type BackendConfig } from "../src/config.ts";
import { describeBackend, testBackend } from "../src/backends.ts";

const root = process.cwd(); // the stage0 checkout, so "open-arc" and "typescript" resolve for the type checker
const req: CompileRequest = { root, ids: [], model: { host: "http://h", model: "m", seed: 1, numCtx: 8192 }, sandbox: { nodeBin: "/n/bin/node", nodePrefix: "/n", heapMb: 256, addressSpaceBytes: 2 ** 32, cpuSeconds: 10 } };
const TAGS = JSON.stringify({ models: [{ name: "qwen3.5:9b", digest: "d1" }] });

// ── 1. calls must be an array of strings
for (const calls of ['"engine.parse"', '["engine.parse", 1]', "null"]) {
  const src = ['import * as arc from "open-arc";', `export const xSpec = arc.defineRegion<(n: number) => number>({ id: "fx.x", intent: "x", calls: ${calls} });`, ""].join("\n");
  const ports = fakePorts({ files: { "src/fx.ts": src } }).instance as Ports;
  const diags: Diagnostic[] = [];
  const p = (await engine.parse(ports, req, diags))!;
  await engine.analyze(ports, req, p, diags, { offline: true });
  assert.deepStrictEqual(diags.filter((d) => d.code === "OARC-E010").map((d) => `${d.id} ${d.detail}`), ["fx.x calls must be an array of strings"], calls);
  assert.ok(!p.specs.has("fx.x"), calls);
}

// ── 2. the local-name exemption is scoped to the call site
{
  const policy = { calls: ["engine.plan"], restricted: new Set(["commit", "engine"]) };
  const codes = (body: string) => engine.staticCheck(body, [], new Set(["commit", "engine"]), policy).map((s) => `${s.diag.code} ${s.diag.detail}`);
  assert.deepStrictEqual(codes("function helper(commit: (x: number) => void) { commit(1); }\nawait commit(ports.fs, journal);"), ["OARC-E098 commit"], "a nested parameter doesn't exempt the import");
  assert.deepStrictEqual(codes("{ const engine = { parse: () => 1 }; engine.parse(); }\nengine.parse();"), ["OARC-E098 engine.parse"], "a block-scoped local doesn't leak");
  assert.deepStrictEqual(codes("const commit = (x: number) => x;\ncommit(1);\nconst f = () => commit(2);"), [], "a body-level local is visible everywhere below it");
  assert.deepStrictEqual(codes("for (const commit of [() => 1]) commit();\nfunction g() { var engine = { x: () => 1 }; if (engine) { engine.x(); } }"), [], "loop variables and var");
  assert.deepStrictEqual(codes("try { } catch (commit) { commit(); }\nconst { engine: e2, ...rest } = { engine: 1 };\nengine.plan(1);"), []);
}

// ── 3. the type closure of an unannotated helper's inferred return type
{
  const src = (pair: string) => [
    'import * as arc from "open-arc";',
    pair,
    "const mk = (n: number) => ({ a: n }) as Pair;",
    "function mkAll(ns: number[]) { return ns.map(mk); }",
    'export const bSpec = arc.defineRegion<(n: number) => number>({ id: "fx.b", intent: "x" });',
    "",
  ].join("\n");
  const analyzed = async (pair: string) => {
    const ports = fakePorts({ files: { "src/fx.ts": src(pair) }, http: [TAGS] }).instance as Ports;
    const p = await engine.parse(ports, req, []);
    await engine.analyze(ports, req, p!, []);
    return p!.regions.find((r) => r.id === "fx.b")!;
  };
  const before = await analyzed("type Pair = { a: number };");
  assert.ok(before.context0.includes("const mk: (n: number) => Pair") && before.context0.includes("type Pair = { a: number };"), before.context0);
  const after = await analyzed("type Pair = { a: number; b?: string };");
  assert.notEqual(after.fingerprint, before.fingerprint, "changing the alias re-fingerprints the region");
}

// ── 4. coverage hits are attributed to the example that started the work
{
  const hit = (id: string) => (globalThis as { __openarcHit?: (id: string) => void }).__openarcHit?.(id);
  const spec = { id: "h", intent: "", examples: [{ args: [1], expected: 1 }, { args: [2], expected: 2 }] } as unknown as RegionSpec<AnyFn>;
  const fn = async (n: number) => {
    if (n === 1) setTimeout(() => hit("late-from-1"), 5); // dangling: fires while example 2 runs
    else await new Promise((r) => setTimeout(r, 30));
    hit(`b${n}`);
    return n;
  };
  assert.deepStrictEqual(await runExamples(root, fn, spec), [{ name: "#1", ok: true, hits: ["b1"] }, { name: "#2", ok: true, hits: ["b2"] }]);
}

// ── 5. `openarc init` and package.json "type"
{
  const dir = mkdtempSync(`${tmpdir()}/oarc-init-`);
  try {
    const init = (pkg: object) => {
      writeFileSync(`${dir}/package.json`, JSON.stringify(pkg));
      const r = spawnSync(process.execPath, [`${root}/src/main.ts`, "init"], { cwd: dir, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    };
    assert.match(init({ name: "x", type: "commonjs" }), /^note: package\.json has "type": "commonjs"; OpenArc projects are ES modules \(tsc fails with TS1295 otherwise\): run `npm pkg set type=module`$/m);
    assert.match(init({ name: "x" }), /^note: package\.json has no "type"; .*npm pkg set type=module/m);
    assert.doesNotMatch(init({ name: "x", type: "module" }), /note:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// ── 6a. presets normalise to the three providers; explicit fields win
{
  const cfg = (b: object) => parseConfig(JSON.stringify({ version: 1, backends: { x: b } }));
  const one = (b: object) => cfg(b).config.backends.x!;
  assert.deepStrictEqual(one({ provider: "openrouter", model: "qwen/qwen3-coder", maxContextTokens: 32768 }), {
    provider: "openai", preset: "openrouter", model: "qwen/qwen3-coder", maxContextTokens: 32768,
    baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", structuredOutput: "json_object", headers: { "X-Title": "OpenArc" },
  });
  const over = one({ provider: "openrouter", model: "m", maxContextTokens: 1, structuredOutput: "json_schema", apiKeyEnv: "OR_KEY", headers: { "X-Title": "Mine", "HTTP-Referer": "https://x.dev" } });
  assert.deepStrictEqual([over.structuredOutput, over.apiKeyEnv, over.headers], ["json_schema", "OR_KEY", { "X-Title": "Mine", "HTTP-Referer": "https://x.dev" }]);
  assert.deepStrictEqual(one({ provider: "local", model: "m", maxContextTokens: 8192, baseUrl: "http://127.0.0.1:8080/v1" }), { provider: "openai", preset: "local", model: "m", maxContextTokens: 8192, baseUrl: "http://127.0.0.1:8080/v1", ollamaCompat: false });
  assert.equal(one({ provider: "local", model: "m", maxContextTokens: 1, baseUrl: "http://127.0.0.1:11434/v1" }).ollamaCompat, true);
  assert.equal(one({ provider: "local", model: "m", maxContextTokens: 1, baseUrl: "http://127.0.0.1:11434/v1", ollamaCompat: false }).ollamaCompat, false);
  assert.match(cfg({ provider: "local", model: "m", maxContextTokens: 1 }).error!, /"baseUrl" is required for provider "local"/);
  assert.equal(one({ provider: "openai", model: "m", maxContextTokens: 1 }).apiKeyEnv, "OPENAI_API_KEY");
  assert.equal(one({ provider: "openai", model: "m", maxContextTokens: 1, baseUrl: "http://gpu:8000/v1" }).apiKeyEnv, undefined, "a custom URL gets no default key");
  assert.equal(one({ provider: "anthropic", model: "m", maxContextTokens: 1 }).apiKeyEnv, "ANTHROPIC_API_KEY");
  assert.deepStrictEqual(one({ provider: "ollama", model: "m", maxContextTokens: 1 }), { provider: "ollama", preset: "ollama", model: "m", maxContextTokens: 1 });
  const n = one({ provider: "openrouter", model: "m", maxContextTokens: 1 });
  assert.deepStrictEqual(applyPreset(n), n, "normalising twice changes nothing");
  assert.match(cfg({ provider: "gemini", model: "m", maxContextTokens: 1 }).error!, /unknown provider "gemini" \(one of ollama, openai, anthropic, openrouter, local\)/);
}
// ── 6b. the normalised endpoint is in the fingerprint
{
  const src = ['import * as arc from "open-arc";', 'export const fSpec = arc.defineRegion<(n: number) => number>({ id: "fx.f", intent: "x" });', ""].join("\n");
  const fp = async (backend: object) => {
    const config = JSON.stringify({ version: 1, backends: { r: backend } });
    const ports = fakePorts({ files: { "src/fx.ts": src, "openarc.config.json": config } }).instance as Ports;
    const p = (await engine.parse(ports, req, []))!;
    await engine.analyze(ports, req, p, []);
    return p.regions.find((r) => r.id === "fx.f")!.fingerprint;
  };
  const base = { provider: "openrouter", model: "m", maxContextTokens: 32768 };
  const a = await fp(base);
  assert.ok(a);
  assert.equal(await fp(base), a, "deterministic");
  assert.notEqual(await fp({ ...base, structuredOutput: "json_schema" }), a, "a different structured-output mode re-fingerprints");
  assert.notEqual(await fp({ provider: "openai", model: "m", maxContextTokens: 32768, baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", structuredOutput: "json_object" }), a, "the preset name is part of it");
}
// ── 6c. init --backend writes only what was chosen
{
  assert.deepStrictEqual(presetConfig("openrouter", "qwen/qwen3-coder"), {
    version: 1, backends: { openrouter: { provider: "openrouter" as never, model: "qwen/qwen3-coder", maxContextTokens: 32768 } },
    compilation: { defaultBackend: "openrouter", maxAttempts: 3, context: { initialLevel: 0, expandOnFailure: true } },
  });
  const local = presetConfig("local", "qwen3.5:9b", "http://127.0.0.1:11434/v1");
  assert.ok(typeof local !== "string" && parseConfig(JSON.stringify(local)).config.backends.local!.ollamaCompat === true);
  assert.equal(presetConfig("local", "m"), "--backend local needs --base-url <url>, e.g. http://127.0.0.1:8080/v1 (llama-server), :1234/v1 (LM Studio), :8000/v1 (vLLM)");
  assert.equal(presetConfig("openai"), "--backend openai needs --model <id>");
  assert.match(presetConfig("gemini") as string, /unknown backend preset/);
  const ollama = presetConfig("ollama");
  assert.ok(typeof ollama !== "string" && ollama.backends.ollama!.model === "qwen3.5:9b");
}
// ── 6d. `openarc backends`: never the key, only whether its env var is set
{
  const b = parseConfig(JSON.stringify({ version: 1, backends: { or: { provider: "openrouter", model: "m", maxContextTokens: 1 } } })).config.backends.or!;
  assert.equal(describeBackend("or", b, true, { OPENROUTER_API_KEY: "sk-or-secret" }), "* or  openai (openrouter)  m  https://openrouter.ai/api/v1  key OPENROUTER_API_KEY set");
  assert.equal(describeBackend("or", b, false, {}), "  or  openai (openrouter)  m  https://openrouter.ai/api/v1  key OPENROUTER_API_KEY NOT set");
}
// ── 6e. `openarc backends test`: one request through complete(), with a reason on failure
{
  const ok = '{"body":"return 1;","imports":[]}';
  const port = (post: (url: string, body: unknown, headers?: Record<string, string>) => string, get: () => string = () => { throw new Error("no get"); }) => {
    const seen: { url: string; body: unknown; headers?: Record<string, string> }[] = [];
    const ports = { log: () => {}, http: { async postJson(url: string, body: unknown, headers?: Record<string, string>) { seen.push({ url, body, headers }); return post(url, body, headers); }, async get() { return get(); } } } as unknown as Ports;
    return { ports, seen };
  };
  const openai = (content: string) => () => JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] });
  const fail = (e: Error) => () => { throw e; };
  const env = { OPENROUTER_API_KEY: "sk-or-secret" };
  const or = parseConfig(JSON.stringify({ version: 1, backends: { or: { provider: "openrouter", model: "m", maxContextTokens: 32768 } } })).config.backends.or!;
  const t = async (b: BackendConfig, post: Parameters<typeof port>[0], get?: () => string, e: Record<string, string> = env) => {
    const f = port(post, get);
    const r = await testBackend(f.ports, b, e);
    assert.ok(!r.detail.includes("sk-or-secret"));
    return { ...r, seen: f.seen };
  };
  const good = await t(or, openai(ok));
  assert.deepStrictEqual([good.ok, good.detail], [true, 'replied "return 1;"']);
  assert.equal(good.seen.length, 1, "exactly one request");
  assert.deepStrictEqual([good.seen[0]!.url, (good.seen[0]!.body as { response_format: unknown }).response_format, (good.seen[0]!.body as { max_tokens: number }).max_tokens, good.seen[0]!.headers!["X-Title"]], ["https://openrouter.ai/api/v1/chat/completions", { type: "json_object" }, 256, "OpenArc"]);
  assert.equal((await t(or, openai(ok), undefined, {})).detail, "missing key: env OPENROUTER_API_KEY is not set");
  assert.match((await t(or, fail(new Error("HTTP 401: bad key")))).detail, /^auth rejected \(HTTP 401\): check the key in env OPENROUTER_API_KEY$/);
  const strict = { ...or, structuredOutput: "json_schema" as const };
  assert.match((await t(strict, fail(new Error('HTTP 400: {"error":"response_format json_schema is not supported for this model"}')))).detail, /^json_schema unsupported .*set "structuredOutput": "json_object" on this backend$/);
  assert.match((await t(or, fail(new Error('HTTP 404: {"error":"model m not found"}')))).detail, /^model not found: check "model" \(m\) and "baseUrl"/);
  const refused = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  assert.equal((await t(or, fail(refused()))).detail, "unreachable: https://openrouter.ai/api/v1");
  const junk = await t(or, openai("Sure! Here is the code"));
  assert.deepStrictEqual([junk.ok, junk.detail], [false, 'invalid JSON in the reply (the model or endpoint may ignore structured output): "Sure! Here is the code"']);
  // ollama: the model must be pulled before any chat request
  const ol: BackendConfig = { provider: "ollama", model: "qwen3.5:9b", maxContextTokens: 8192 };
  const tags = () => JSON.stringify({ models: [{ name: "qwen3.5:9b", digest: "d" }] });
  const chatOk = () => JSON.stringify({ message: { role: "assistant", content: ok }, done: true, done_reason: "stop" });
  assert.deepStrictEqual((await t(ol, chatOk, tags)).ok, true);
  const missing = await t({ ...ol, model: "llama9" }, chatOk, tags);
  assert.deepStrictEqual([missing.ok, missing.detail, missing.seen.length], [false, "model not pulled: run `ollama pull llama9`", 0]);
  assert.equal((await t(ol, chatOk, () => { throw refused(); })).detail, "unreachable: http://127.0.0.1:11434/api/tags");
}
// ── 6f. the CLI: init --backend, backends, backends test (a missing key fails before any network)
{
  const dir = mkdtempSync(`${tmpdir()}/oarc-backends-`);
  try {
    writeFileSync(`${dir}/package.json`, '{"type":"module"}');
    const cli = (...args: string[]) => spawnSync(process.execPath, [`${root}/src/main.ts`, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, OPENROUTER_API_KEY: "" } });
    assert.equal(cli("init", "--backend", "local").status, 2, "local needs --model and --base-url");
    const init = cli("init", "--backend", "openrouter", "--model", "qwen/qwen3-coder");
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /backend: openrouter; check it with `npx openarc backends test`/);
    const list = cli("backends");
    assert.equal(list.stdout, "* openrouter  openai (openrouter)  qwen/qwen3-coder  https://openrouter.ai/api/v1  key OPENROUTER_API_KEY NOT set\n");
    const test = cli("backends", "test");
    assert.equal(test.status, 1);
    assert.match(test.stdout, /^openrouter: FAIL \d+\.\ds · missing key: env OPENROUTER_API_KEY is not set$/m);
    assert.equal(cli("backends", "test", "nope").status, 2);
    assert.match(cli("init", "--backend", "openai", "--model", "gpt-5").stdout, /already exists and was not changed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log("v064: calls validation (E010), scoped E098 exemption, inferred-type closure, per-example coverage, init type hint, provider presets, backends test ok");
