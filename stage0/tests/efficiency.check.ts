// Efficiency changes of 0.9.1 (issue #19): fewer wasted calls and prompt tokens, same verification.
// In-memory ports and a stub model; no sandbox (the regions have no examples, so verification is tsc + static rules).
// Run: node tests/efficiency.check.ts
// 1. Diverse retries: attempt 1 samples as configured; attempt 2 at temperature 0.4, then 0.7; seed + attempt - 1.
// 2. Repeat-stop: a reply equal (whitespace aside) to an earlier one is not verified again and stops the region (E082),
//    unless a fallback backend is still to come.
// 3. Whole-function unwrap: helpers + the region's own declaration (function, export, async, const arrow with block or
//    expression body, a class method, each inside a fence) become the body; anything else is left alone.
// 4. Prompt trim: a closed function region (no effects, deps or imports beyond open-arc) gets the short Rules and no
//    "none" sections; the Examples heading keeps only the conventions its examples use; a function region whose file
//    imports only open-arc doesn't see that import (a 7B called arc.flatten); open regions are unchanged.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Json } from "open-arc";
import type { CompileRequest, Ports } from "../src/types.ts";
import fakePorts from "./fakes/ports.memory.ts";
import { run } from "../src/compile.ts";
import * as engine from "../src/engine.ts";
import { PROMPT_TEMPLATE, renderTemplate } from "../src/model.ts";

const root = process.cwd(); // the stage0 checkout, so "open-arc" and "typescript" resolve for the type checker
const req: CompileRequest = { root, ids: [], model: { host: "http://h", model: "m", seed: 1, numCtx: 8192 }, sandbox: { nodeBin: "/n/bin/node", nodePrefix: "/n", heapMb: 256, addressSpaceBytes: 2 ** 32, cpuSeconds: 10 } };
const M = ".openarc/manifest.json";
const TAGS = JSON.stringify({ models: [{ name: "qwen3.5:9b", digest: "d1" }] });
const chat = (body: string) => JSON.stringify({ message: { role: "assistant", content: JSON.stringify({ body, imports: [] }) }, done: true });
type Snap = { files: Record<string, string>; requests: { url: string; body: Json }[] };
type ChatBody = { options: { temperature: number; seed: number }; messages: { content: string }[] };
const chats = (s: Snap) => s.requests.filter((q) => q.url.endsWith("/api/chat")).map((q) => q.body as unknown as ChatBody);

const SRC = [
  'import * as arc from "open-arc";',
  "type Inc = (n: number) => number;",
  'export const incSpec = arc.defineRegion<Inc>({ id: "ef.inc", intent: "add one" });',
  "",
].join("\n");
const project = (maxAttempts: number) => ({
  "src/ef.ts": SRC,
  [M]: '{"schema":1,"regions":{}}',
  "openarc.config.json": JSON.stringify({ version: 1, backends: { local: { provider: "ollama", model: "qwen3.5:9b", maxContextTokens: 8192, seed: 1 } }, compilation: { defaultBackend: "local", maxAttempts } }),
});
async function compile(maxAttempts: number, bodies: string[]) {
  const logs: string[] = [];
  const fake = fakePorts({ files: project(maxAttempts), http: [TAGS, ...bodies.map(chat)] });
  const res = await run({ ...(fake.instance as Ports), log: (l: string) => logs.push(l) }, { ...req, keepGoing: true });
  const snap = fake.snapshot() as Snap;
  const attempt = (n: number) => JSON.parse(snap.files[`.openarc/attempts/ef.inc/${n}.json`] ?? "null") as { problems: string[]; sampling: Json } | null;
  return { res, snap, logs, attempt, sent: chats(snap).map((b) => [b.options.temperature, b.options.seed]) };
}

// ── 1. diverse retries
{
  const b = { provider: "ollama", model: "m", maxContextTokens: 8192, seed: 5 } as const;
  assert.deepStrictEqual([1, 2, 3, 4].map((n) => engine.retrySampling(b, n)), [null, { temperature: 0.4, seed: 6 }, { temperature: 0.7, seed: 7 }, { temperature: 0.7, seed: 8 }]);
  // three different failing bodies: every one is verified, every retry is varied
  const { res, sent, attempt } = await compile(3, ['return "a" as never as string;', "return `b`;", "return [] as never as string;"]);
  assert.equal(res.exit, 1);
  assert.deepStrictEqual(sent, [[0, 1], [0.4, 2], [0.7, 3]]);
  for (const n of [1, 2, 3]) assert.match(attempt(n)!.problems[0]!, /^OARC-E070 TS2322/, `attempt ${n} was verified`);
}

// ── 2. repeat-stop
{
  // the same body twice (surrounding whitespace aside): one verification, then stop at the repeat with 3 of 5 calls left
  const { res, sent, attempt, logs } = await compile(5, ['return "x";', '  return "x";\n']);
  assert.equal(res.exit, 1);
  assert.equal(sent.length, 2, "the first repeat stops the region before the budget of 5 is spent");
  assert.match(attempt(1)!.problems[0]!, /^OARC-E070 TS2322/);
  assert.deepStrictEqual(attempt(2)!.problems, ["repeat of an earlier attempt (not verified again)"]);
  assert.equal(attempt(3), null);
  const e082 = res.diagnostics.find((d) => d.code === "OARC-E082")!;
  assert.match(e082.detail!, /^repeat: OARC-E070 TS2322/, "reported with the last real verdict");
  assert.ok(logs.some((l) => /repeats an earlier attempt; stopping/.test(l)));
  // exact text: spacing inside a literal is a different reply (CodeRabbit #20)
  assert.notEqual(engine.repeatKey('return "a  b";'), engine.repeatKey('return "a b";'));
  // a different body after a failure is verified as usual and can pass
  const ok = await compile(3, ['return "x";', 'return "y";', "return n + 1;"]);
  assert.equal(ok.res.exit, 0, JSON.stringify(ok.res.diagnostics));
  const prov = JSON.parse(ok.snap.files[M]!).regions["ef.inc"].provenance;
  assert.deepStrictEqual([prov.attempts, prov.sampling], [3, { temperature: 0.7, seed: 3 }]);
  assert.ok(ok.snap.files["src/ef.ts"]!.includes("  return n + 1;"));
  // with a fallback backend, a repeat hands over to it instead of stopping
  const fb = fakePorts({ files: { ...project(3), "openarc.config.json": JSON.stringify({ version: 1, backends: { local: { provider: "ollama", model: "qwen3.5:9b", maxContextTokens: 8192, seed: 1 }, big: { provider: "ollama", model: "qwen3.5:9b", maxContextTokens: 8192, seed: 9 } }, compilation: { defaultBackend: "local", fallbackBackend: "big", maxAttempts: 3 } }) }, http: [TAGS, ...['return "x";', 'return "x";', "return n + 1;"].map(chat)] });
  const fres = await run(fb.instance as Ports, { ...req, keepGoing: true });
  assert.equal(fres.exit, 0, JSON.stringify(fres.diagnostics));
  assert.deepStrictEqual(chats(fb.snapshot() as Snap).map((b) => b.options.seed), [1, 2, 11], "attempt 3 on the fallback (seed 9 + 2)");
  // invalid output on the penultimate attempt (no repeat) still leaves the last attempt to the fallback (CodeRabbit #22)
  const bad = JSON.stringify({ message: { role: "assistant", content: "not json" }, done: true });
  const fb2 = fakePorts({ files: { ...project(3), "openarc.config.json": JSON.stringify({ version: 1, backends: { local: { provider: "ollama", model: "qwen3.5:9b", maxContextTokens: 8192, seed: 1 }, big: { provider: "ollama", model: "qwen3.5:9b", maxContextTokens: 8192, seed: 9 } }, compilation: { defaultBackend: "local", fallbackBackend: "big", maxAttempts: 3 } }) }, http: [TAGS, chat('return "x";'), bad, chat("return n + 1;")] });
  const fres2 = await run(fb2.instance as Ports, { ...req, keepGoing: true });
  assert.equal(fres2.exit, 0, JSON.stringify(fres2.diagnostics));
  assert.deepStrictEqual(chats(fb2.snapshot() as Snap).map((b) => b.options.seed), [1, 2, 11], "attempt 3 on the fallback after an invalid reply");
}

// ── 3. whole-function unwrap
{
  const self = { name: "verse", params: ["n"] };
  const fence = (s: string) => "```ts\n" + s + "\n```";
  const helper = 'const animals = ["fly", "spider"];';
  const cases: [string, string][] = [
    [`${helper}\nconst verse: VerseFn = (n) => {\n  return animals[n - 1]!;\n};`, `${helper}\nreturn animals[n - 1]!;`], // the 7B's habit (ablations)
    [`${helper}\nexport function verse(n: number): string {\n  return animals[n]!;\n}`, `${helper}\nreturn animals[n]!;`],
    [`export ${helper}\nasync function verse(n: number) {\n  return animals[n]!;\n}\nexport default verse;`, `${helper}\nreturn animals[n]!;`],
    [`${helper}\nexport const verse = (n: number): string => animals[n]!;`, `${helper}\nreturn animals[n]!;`],
    [`${helper}\nconst verse = function (n: number) { return animals[n]!; };\nexport { verse };`, `${helper}\nreturn animals[n]!;`],
  ];
  for (const [reply, want] of cases) {
    assert.equal(engine.unwrapBody(reply, "function", false, self), want, reply);
    assert.equal(engine.unwrapBody(fence(reply), "function", false, self), want, `fenced: ${reply}`);
  }
  // the single-declaration forms (no helpers) keep working, with or without a fence
  for (const one of ["function verse(n: number) { return 1; }", "export async function verse(n: number) { return 1; }", "const verse = (n: number) => 1;", "verse(n: number): number { return 1; }"])
    for (const r of [one, fence(one)]) assert.equal(engine.unwrapBody(r, "function", false, self), "return 1;", r);
  // left alone: another name, other parameters, a body that already returns, two declarations, a block region
  for (const r of [`${helper}\nconst other = (n: number) => 1;`, `${helper}\nconst verse = (k: number) => 1;`, `${helper}\nconst verse = (n: number, m: number) => 1;`,
    `const verse = (n: number) => 1;\nreturn verse(n);`, `const verse = (n: number) => 1;\nif (n > 0) return verse(n);`, `${helper}\nfunction verse(n: number) { return 1; }\nfunction verse(n: number) { return 2; }`])
    assert.equal(engine.unwrapBody(r, "function", false, self), r, r);
  assert.equal(engine.unwrapBody(`${helper}\nconst verse = (n: number) => 1;`, "block", false, self), `${helper}\nconst verse = (n: number) => 1;`);
  // a returned (or bare) function with the region's own parameters: Seed-Coder's habit (dev bench 2026-11-03, TS2322)
  const returned: [string, string][] = [
    [`${helper}\nreturn (n: number) => {\n  return animals[n]!;\n};`, `${helper}\nreturn animals[n]!;`],
    [`${helper}\nreturn (n) => animals[n]!;`, `${helper}\nreturn animals[n]!;`],
    [`return function (n: number) { return 1; };`, "return 1;"],
    [`(n: number) => {\n  return 1;\n}`, "return 1;"],
    [`return ((n: number) => 1);`, "return 1;"],
    [`export ${helper}\nreturn (n: number) => animals[n]!;`, `${helper}\nreturn animals[n]!;`], // export dropped, as in unwrapOwn
  ];
  for (const [reply, want] of returned) for (const r of [reply, fence(reply)]) assert.equal(engine.unwrapBody(r, "function", false, self), want, r);
  // left alone: other parameters, an earlier return, not the last statement, a block region
  for (const r of [`return (k: number) => 1;`, `return (n: number, m: number) => 1;`, `if (n < 0) return () => 0;\nreturn (n: number) => 1;`, `return (n: number) => 1;\nconst x = 1;`])
    assert.equal(engine.unwrapBody(r, "function", false, self), r, r);
  assert.equal(engine.unwrapBody(`return (n: number) => 1;`, "block", false, self), `return (n: number) => 1;`);
  // a region whose own result is a function: the returned arrow IS the answer
  assert.equal(engine.unwrapBody(`return (n: number) => n + 1;`, "function", false, { ...self, returnsFn: true }), `return (n: number) => n + 1;`);
  // a parameter redeclared at the top of the body becomes an assignment; typed or nested declarations are left alone
  assert.equal(engine.assignRedeclaredParams("const question = question.trim();\nlet limit = limit || 1000;\nreturn question + limit;", ["question", "limit"]),
    "question = question.trim();\nlimit = limit || 1000;\nreturn question + limit;");
  for (const r of ["const q: string[] = question.split(\" \");\nreturn q;", "const question2 = question;\nreturn question2;", "const question: string = question.trim();\nreturn question;", "if (x) { const question = 1; }\nreturn 0;"])
    assert.equal(engine.assignRedeclaredParams(r, ["question"]), r, r);
  // end to end: helpers + the whole function compiles on attempt 1 (was TS2322 "(n: number) => void")
  const { res, sent, snap } = await compile(3, ["const ONE = 1;\nexport const inc: Inc = (n) => {\n  return n + ONE;\n};"]);
  assert.equal(res.exit, 0, JSON.stringify(res.diagnostics));
  assert.equal(sent.length, 1);
  assert.ok(snap.files["src/ef.ts"]!.includes("  const ONE = 1;\n  return n + ONE;"), snap.files["src/ef.ts"]);
}

// ── 4. prompt trim
{
  assert.equal(engine.examplesHeading('{"args":["a b"],"expected":"AB"}'), "Examples (deep equality)");
  assert.equal(engine.examplesHeading('{"args":[1.5],"expected":3}'), 'Examples (deep equality; numbers match within 1e-9 relative and -0 equals 0 unless "exact")');
  assert.equal(engine.examplesHeading('{"args":[-0],"expected":0}'), 'Examples (deep equality; numbers match within 1e-9 relative and -0 equals 0 unless "exact")');
  assert.equal(engine.examplesHeading('{"args":[[1,[2]]],"expected":[1,2]}'), "Examples (deep equality)", "integers need no tolerance note");
  assert.equal(engine.examplesHeading('{"args":["$NaN",{"$fake":"x"}],"expected":"$undefined","throws":"bad"}'),
    'Examples (deep equality; the strings "$NaN", "$undefined" stand for those values; {"$fake": name} is a test double for that parameter; {"throws": true} means the call must throw, and a "throws" string must appear in the error message)');

  const acronym = [
    'import * as arc from "open-arc";',
    "export type ParseFn = (phrase: string) => string;",
    'export const parseSpec = arc.defineRegion<ParseFn>({ id: "acronym.parse", intent: "Convert a phrase to its acronym; hyphens separate words.",',
    '  examples: [{ name: "png", args: ["Portable Network Graphics"], expected: "PNG" }, { name: "html", args: ["HyperText Markup Language"], expected: "HTML" }] });',
    "",
  ].join("\n");
  const open = 'import * as arc from "open-arc";\ntype Now = () => number;\nexport const nowSpec = arc.defineRegion<Now>({ id: "ef.now", intent: "the time", effects: ["clock"] });\n';
  const fake = fakePorts({ files: { "src/acronym.ts": acronym, "src/now.ts": open, [M]: '{"schema":1,"regions":{}}' } }).instance;
  const p = await engine.parse(fake, req, []);
  await engine.analyze(fake, req, p, [], { offline: true });
  const ctx = (id: string) => engine.buildContext(p, p.regions.find((r) => r.id === id)!, 0, p.config.backends.local!);
  const closed = ctx("acronym.parse");
  for (const kept of ["## Fixed signature", "export type ParseFn = (phrase: string) => string;", "## Intent\nConvert a phrase to its acronym", '"expected":"HTML"', "## Rules\nNo new imports.\nNo effects: never use Date.now()"])
    assert.ok(closed.includes(kept), `kept: ${kept}`);
  for (const cut of ["## Effects allowed", "## Allowed new imports", '"$fake"', "need effect 'clock'", "## Imports already in the file", "// ParseFn =", "never re-import"]) assert.ok(!closed.includes(cut), `cut: ${cut}`); // 0.9.3: no second signature, no in-scope sentence with nothing in scope
  assert.match(closed, /## Examples \(deep equality\)\n/);
  const prompt = renderTemplate(PROMPT_TEMPLATE, { context: closed, repair: "" });
  assert.ok(prompt.ok && prompt.text.length < 1300, `the closed acronym prompt is ${prompt.ok && prompt.text.length} chars (0.9.0: 1905)`);
  // an open region (an effect) keeps the full sections and Rules
  const full = ctx("ef.now");
  for (const kept of ["## Effects allowed\nclock", "## Allowed new imports\nnone", "need effect 'clock'", "\"imports\" may name:"]) assert.ok(full.includes(kept), `open region keeps: ${kept}`);
}

console.log("efficiency: ok");

// ── latency: --timings logs each attempt's stage times, and the commit's
{
  const logs: string[] = [];
  const fake = fakePorts({ files: project(1), http: [TAGS, chat("return n + 1;")] });
  const res = await run({ ...(fake.instance as Ports), log: (l: string) => logs.push(l) }, { ...req, timings: true });
  assert.equal(res.exit, 0, JSON.stringify(res.diagnostics));
  assert.ok(logs.some((l) => /^  ef\.inc: timings context \d+ · model \d+ · static \d+ · tsc \d+$/.test(l)), logs.join("\n"));
  assert.ok(logs.some((l) => /^timings commit \d+$/.test(l)), logs.join("\n"));
  const quiet: string[] = [];
  await run({ ...(fakePorts({ files: project(1), http: [TAGS, chat("return n + 1;")] }).instance as Ports), log: (l: string) => quiet.push(l) }, req);
  assert.ok(!quiet.some((l) => l.includes("timings")), "no timings without the flag");
  console.log("efficiency: timings ok");
}

// ── failed-region memory: a region that exhausted its attempts is skipped by later compiles until its fingerprint
//    changes; naming it or --retry-failed retries it (multi-file evolution benchmark)
{
  const go = async (files: Record<string, string>, bodies: string[], extra: Partial<CompileRequest> = {}) => {
    const logs: string[] = [];
    const fake = fakePorts({ files, http: [TAGS, ...bodies.map(chat)] });
    const res = await run({ ...(fake.instance as Ports), log: (l: string) => logs.push(l) }, { ...req, keepGoing: true, ...extra });
    const snap = fake.snapshot() as Snap;
    return { res, logs, files: snap.files, calls: chats(snap).length };
  };
  const first = await go(project(2), ['return "a";', 'return "b";']);
  assert.equal(first.calls, 2);
  assert.match(JSON.parse(first.files[".openarc/failed.json"]!)["ef.inc"].detail, /^OARC-E070 TS2322/);
  const again = await go(first.files, []);
  assert.equal(again.calls, 0, "same fingerprint: no model call");
  assert.equal(again.res.exit, 1);
  assert.match(again.res.diagnostics.find((d) => d.code === "OARC-E082")!.detail!, /^failed before: OARC-E070 TS2322/);
  assert.ok(again.logs.some((l) => /ef\.inc: failed before with this spec and context; skipped/.test(l)));
  const named = await go(first.files, ["return n + 1;"], { ids: ["ef.inc"] });
  assert.equal(named.calls, 1, "naming the region retries it");
  assert.equal(named.res.exit, 0, JSON.stringify(named.res.diagnostics));
  assert.deepStrictEqual(JSON.parse(named.files[".openarc/failed.json"]!), {}, "a pass forgets the failure");
  assert.equal((await go(first.files, ["return n + 1;"], { retryFailed: true })).calls, 1, "--retry-failed retries it");
  const edited = { ...first.files, "src/ef.ts": first.files["src/ef.ts"]!.replace('"add one"', '"add one to n"') };
  assert.equal((await go(edited, ["return n + 1;"])).calls, 1, "a spec change retries it");
  for (const bad of ["null", "[]", "{"]) assert.equal((await go({ ...project(1), ".openarc/failed.json": bad }, ["return n + 1;"])).res.exit, 0, `failed.json ${bad} is ignored`);
  console.log("efficiency: failed-region memory ok");
}

// ── a spec that fails tsc on its own (issue #15): OARC-E070 spec:TS<code> before any model call (was 3 calls, each E070)
{
  const cases: [string, string, string[]][] = [
    ["a bad type in the signature", SRC.replace("(n: number)", "(n: Nmber)"), ["spec:TS2552"]],
    ["a mistyped example", SRC.replace('intent: "add one"', 'intent: "add one", examples: [{ args: ["1"], expected: 2 }]'), ["spec:TS2322"]],
    ["an import that doesn't resolve (only it is reported)", `import { two } from "./nope.ts";\n${SRC.replace("(n: number)", "(n: typeof two)")}`, ["spec:TS2307"]],
  ];
  for (const [what, src, details] of cases) {
    const logs: string[] = [];
    const fake = fakePorts({ files: { ...project(3), "src/ef.ts": src }, http: [TAGS, ...["return n + 1;", "return n + 2;", "return n + 3;"].map(chat)] });
    const res = await run({ ...(fake.instance as Ports), log: (l: string) => logs.push(l) }, { ...req, keepGoing: true });
    assert.equal(res.exit, 1, what);
    assert.equal(res.modelCalls, 0, `${what}: no model call`);
    assert.equal(chats(fake.snapshot() as Snap).length, 0, `${what}: no chat request`);
    const e070 = res.diagnostics.filter((d) => d.code === "OARC-E070");
    assert.deepStrictEqual(e070.map((d) => [d.id, d.file, d.detail]), details.map((d) => ["ef.inc", "src/ef.ts", d]), `${what}: ${JSON.stringify(res.diagnostics)}`);
    assert.ok(!res.diagnostics.some((d) => d.code === "OARC-E082"), `${what}: not charged to the model as exhausted attempts`);
    assert.ok(logs.some((l) => /ef\.inc: tsc errors outside the regions .*no model call/.test(l)), logs.join("\n"));
  }
  console.log("efficiency: spec type errors before the model ok");
}

// ── a package nothing imports yet whose declarations use `export = X` is shown as a default import (TS2595 otherwise)
{
  const root = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
  assert.equal(engine.exportEqualsImport({ root }, "typescript"), 'import ts from "typescript";');
  assert.equal(engine.exportEqualsImport({ root }, "no-such-package-xyz"), null, "unresolved: no form");
  assert.equal(engine.exportEqualsImport({ root }, "node:path"), null, "no export = : no form");
  const n = (names: string[], d?: string) => engine.normalizeImports({ root }, [{ from: "typescript", names, ...(d ? { default: d } : {}) }])[0];
  assert.deepEqual(n(["ts"], "ts"), { from: "typescript", names: [], default: "ts" }, "import ts, { ts }");
  assert.deepEqual(n(["ts"]), { from: "typescript", names: [], default: "ts" }, "import { ts } from an export = package");
  assert.deepEqual(n(["default"], "ts"), { from: "typescript", names: [], default: "ts" }, "import ts, { default }");
  assert.deepEqual(n(["SyntaxKind"]), { from: "typescript", names: ["SyntaxKind"] }, "other named imports stay");
  assert.deepEqual(engine.normalizeImports({ root }, [{ from: "node:path", names: ["join"] }])[0], { from: "node:path", names: ["join"] });
  console.log("efficiency: export = default import form ok");
}

// ── a package nothing imports yet with ordinary exports shows them (semver-compare, csv-parse in bench/deps)
{
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "openarc-forms-")));
  try {
    const pkg = (name: string, dts: string) => {
      mkdirSync(join(dir, "node_modules", name), { recursive: true });
      writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, types: "index.d.ts" }));
      writeFileSync(join(dir, "node_modules", name, "index.d.ts"), dts);
    };
    pkg("named-lib", 'export declare function compare(a: string, b: string): number;\nexport interface Options { x: number }\nexport type Kind = "a";\nexport * from "./more";\nimport { hidden } from "./more";\nexport { hidden as parse };\n');
    writeFileSync(join(dir, "node_modules", "named-lib", "more.d.ts"), "export declare const extra: number;\nexport declare const hidden: number;\nexport declare class Thing {}\n");
    pkg("default-lib", "export default function run(): void;\n");
    pkg("both-lib", "export default function run(): void;\nexport declare const helper: number;\n");
    pkg("types-only", "export interface Only { x: number }\n");
    pkg("huge", Array.from({ length: 52 }, (_, i) => `export declare const n${i}: number;`).join("\n"));
    assert.equal(engine.exportsImport({ root: dir }, "named-lib"), 'import { compare, parse, extra, hidden, Thing } from "named-lib"; // import only the names you call');
    assert.equal(engine.exportsImport({ root: dir }, "default-lib"), 'import defaultLib from "default-lib";');
    assert.equal(engine.exportsImport({ root: dir }, "both-lib"), 'import bothLib, { helper } from "both-lib"; // import only the names you call');
    assert.equal(engine.exportsImport({ root: dir }, "types-only"), null, "nothing to call");
    assert.equal(engine.exportsImport({ root: dir }, "no-such-package-xyz"), null, "unresolved");
    assert.match(engine.exportsImport({ root: dir }, "huge")!, /n49 \} from "huge"; \/\/ import only the names you call; 2 more not listed$/);
    assert.equal(engine.exportEqualsImport({ root: dir }, "named-lib"), null, "normalizeImports still sees no export =");

    // in the prompt: the form, not the bare specifier; a form the project already uses still wins
    symlinkSync(join(root, "core"), join(dir, "node_modules", "open-arc"), "junction");
    const prompt = async (extra: Record<string, string>) => {
      const src = 'import * as arc from "open-arc";\ntype F = (a: string) => number;\nexport const fSpec = arc.defineRegion<F>({ id: "x.f", intent: "x", deps: ["named-lib"], examples: [{ args: ["a"], expected: 1 }] });\n// @openarc:begin x.f\nexport const f: F = (a) => arc.todo("x.f");\n// @openarc:end x.f\n';
      const fake = fakePorts({ files: { "src/x.ts": src, ...extra } });
      const r = { ...req, root: dir };
      const p = await engine.parse(fake.instance as Ports, r, []);
      await engine.analyze(fake.instance as Ports, r, p, [], { offline: true });
      return engine.buildContext(p, p.regions.find((x) => x.id === "x.f")!, 0, p.config.backends.local!);
    };
    assert.match(await prompt({}), /Use exactly these import forms:\nimport \{ compare, parse, extra, hidden, Thing \} from "named-lib"; \/\/ import only the names you call\nThe spec declares named-lib for this body/);
    assert.match(await prompt({ "src/y.ts": 'import { compare } from "named-lib";\nexport const k = compare("a", "b");\n' }), /Use exactly these import forms:\nimport \{ compare \} from "named-lib";\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("efficiency: declared package import form ok");
}
