// Code-first regions (SPEC §3.8), no model and no sandbox: in-memory ports, hand-written replies and harness lines.
// Run: node tests/implicit.check.ts
// 1. Discovery without running code: functions, methods, getters, arrow consts and arrow properties whose whole body is
//    arc.todo(); generics; derived ids (module, class, member), `@arc module`, `@arc id`, arc.todo("<id>"); E022, E011.
// 2. Markers inside the body: in memory at analysis (the file on disk keeps its pending bodies), written at commit,
//    and the identity afterwards (a renamed class keeps its id; `@arc id` that disagrees with the markers is E064).
// 3. Classes: members are planned in source order and verified jointly (W042/W045 semantics, per class).
// 4. The customization layer: @arc tags, arc.configure and defineRegion by id; E013 for a field set twice; E020;
//    openarc.config.json regions[id] wins; the spec hash covers the head, JSDoc, configuration and tests.
import assert from "node:assert/strict";
import type { CompileRequest, Diagnostic, Ports } from "../src/types.ts";
import fakePorts from "./fakes/ports.memory.ts";
import * as engine from "../src/engine.ts";
import { run } from "../src/compile.ts";

const root = process.cwd();
const req: CompileRequest = { root, ids: [], model: { host: "http://h", model: "m", seed: 1, numCtx: 8192 }, sandbox: { nodeBin: "/n/bin/node", nodePrefix: "/n", heapMb: 256, addressSpaceBytes: 2 ** 32, cpuSeconds: 10 } };
const TAGS = JSON.stringify({ models: [{ name: "qwen3.5:9b", digest: "d1" }] });
const reply = (body: string) => JSON.stringify({ message: { role: "assistant", content: JSON.stringify({ body, imports: [] }) }, done: true });

const analyzed = async (files: Record<string, string>, opts: { offline?: boolean } = { offline: true }) => {
  const ports = fakePorts({ files, http: [TAGS] }).instance as Ports;
  const p = await engine.parse(ports, req, []);
  const ds: Diagnostic[] = [];
  await engine.analyze(ports, req, p, ds, opts);
  return { p, ds, ids: p.regions.map((r) => r.id), spec: (id: string) => p.specs.get(id)! };
};
const codes = (ds: Diagnostic[]) => ds.map((d) => `${d.code}${d.id ? ` ${d.id}` : ""}${d.detail ? ` ${d.detail}` : ""}`);

// ── 1. discovery
const SHAPES = `/** @arc module shapes */
import * as arc from "open-arc";

/** A shape with an area. */
export interface Shape {
  /** Area in square units, never negative. */
  area(): number;
}

export class Circle implements Shape {
  readonly r: number;
  constructor(r: number) {
    this.r = r;
  }
  area(): number {
    return arc.todo();
  }
  /** Twice the radius. */
  get diameter(): number {
    return arc.todo();
  }
  /** The circumference. */
  perimeter = (): number => arc.todo();
}

/** The first element, or undefined for an empty list. */
export function first<T>(xs: T[]): T | undefined {
  return arc.todo();
}

/** Half of n. */
export const half = (n: number): number => arc.todo();

/** @arc id shapes.unit */
export function unitArea(): number {
  arc.todo();
}

export function named(): string {
  return arc.todo("shapes.custom");
}

export function concrete(): number {
  return 1;
}
`;
{
  const { ds, ids, spec, p } = await analyzed({ "src/geo/shapes.ts": SHAPES });
  assert.deepStrictEqual(codes(ds), []);
  assert.deepStrictEqual(ids, ["shapes.circle.area", "shapes.circle.diameter", "shapes.circle.perimeter", "shapes.first", "shapes.half", "shapes.unit", "shapes.custom"], "derived ids, @arc module, @arc id, arc.todo(id); concrete code is not a region");
  assert.ok(p.regions.every((r) => r.state === "pending" && r.pending));
  assert.equal(spec("shapes.first").signature, "<T>(xs: T[]): T | undefined", "generics are allowed");
  assert.equal(spec("shapes.circle.area").codeFirst!.doc, "/** Area in square units, never negative. */", "an undocumented member inherits its interface member's JSDoc");
  assert.equal(spec("shapes.circle.area").intent, "Area in square units, never negative.");
  assert.deepStrictEqual([spec("shapes.circle.diameter").codeFirst!.kind, spec("shapes.circle.perimeter").codeFirst!.kind, spec("shapes.half").codeFirst!.kind], ["getter", "arrow", "arrow"]);
  assert.equal(spec("shapes.circle.area").codeFirst!.declaration, "Circle.area");
  // markers inside the body, in memory only: p.files has them, the disk text doesn't
  assert.match(p.files.get("src/geo/shapes.ts")!, /area\(\): number \{\n {4}\/\/ @openarc:begin shapes\.circle\.area\n {4}return arc\.todo\(\);\n {4}\/\/ @openarc:end shapes\.circle\.area\n {2}\}/);
  assert.match(p.files.get("src/geo/shapes.ts")!, /export const half = \(n: number\): number => \{\n {2}\/\/ @openarc:begin shapes\.half\n {2}return arc\.todo\(\);\n/, "an expression body becomes a block");
  assert.equal(p.disk.get("src/geo/shapes.ts"), SHAPES);
  // derived ids without @arc module: the path under src/; a class named like its file, a function named like its file
  const plain = await analyzed({
    "src/lb/RoundRobin.ts": 'import * as arc from "open-arc";\nexport class RoundRobin {\n  pick(key: string): string {\n    return arc.todo();\n  }\n}\n',
    "src/ui/molecules/field.ts": 'import * as arc from "open-arc";\nexport function field(label: string): string {\n  return arc.todo();\n}\n',
    "src/net/index.ts": 'import * as arc from "open-arc";\nexport function send(to: string): boolean {\n  return arc.todo();\n}\n',
  });
  assert.deepStrictEqual(plain.ids, ["lb.roundRobin.pick", "net.send", "ui.molecules.field"]);
  // E022: no explicit return type (arc.todo() would infer never); E011: two declarations with one id
  const e022 = await analyzed({ "src/a.ts": 'import * as arc from "open-arc";\nexport class A {\n  f(x: number) {\n    return arc.todo();\n  }\n}\n' });
  assert.deepStrictEqual(e022.ds.map((d) => [d.code, d.id, d.line]), [["OARC-E022", "a.f", 3]]);
  assert.deepStrictEqual(e022.ids, []);
  const e011 = await analyzed({ "src/a.ts": 'import * as arc from "open-arc";\n/** @arc id a.same */\nexport function f(): number {\n  return arc.todo();\n}\n/** @arc id a.same */\nexport function g(): number {\n  return arc.todo();\n}\n' });
  assert.deepStrictEqual(codes(e011.ds), ["OARC-E011 a.same"]);
  // `openarc scaffold` writes no code-first markers: a pending body is valid TypeScript already
  const fake = fakePorts({ files: { "src/geo/shapes.ts": SHAPES } });
  const sp = await engine.parse(fake.instance as Ports, req, []);
  assert.deepStrictEqual(await engine.scaffoldProject(fake.instance as Ports, sp, []), []);
  assert.equal((fake.snapshot() as { files: Record<string, string> }).files["src/geo/shapes.ts"], SHAPES);
}

// ── 2 + 3. a class compiled through the pipeline (harness lines stand in for the sandbox)
const LB = `/** @arc module lb */
import * as arc from "open-arc";

export interface Backend {
  id: string;
  healthy: boolean;
}

export class RoundRobin {
  readonly backends: Backend[];
  next = 0;
  constructor(backends: Backend[]) {
    this.backends = backends.map((b) => ({ ...b }));
  }
  healthy(): Backend[] {
    return this.backends.filter((b) => b.healthy);
  }
  /** The next healthy backend id in list order, wrapping around; null when none is healthy. */
  pick(key: string): string | null {
    return arc.todo();
  }
  /** Mark one backend unhealthy; throws "unknown backend <id>" for an unknown id. */
  markDown(id: string): void {
    return arc.todo();
  }
}
`;
const TESTS = `import * as arc from "open-arc";
import { RoundRobin } from "../src/lb.ts";

arc.test(RoundRobin, "rotates", (RR, expect) => {
  const rr = new RR([{ id: "a", healthy: true }, { id: "b", healthy: true }]);
  expect(rr.pick("x")).toBe("a");
  expect(rr.pick("x")).toBe("b");
});

arc.test(RoundRobin, "markDown skips", (RR, expect) => {
  const rr = new RR([{ id: "a", healthy: true }, { id: "b", healthy: true }]);
  rr.markDown("a");
  expect(rr.pick("x")).toBe("b");
});
`;
const PICK = "const hs = this.healthy();\nif (hs.length === 0) return null;\nconst b = hs[this.next % hs.length]!;\nthis.next = (this.next + 1) % hs.length;\nreturn b.id;";
const MARK = "const b = this.backends.find((x) => x.id === id);\nif (!b) throw new Error(`unknown backend ${id}`);\nb.healthy = false;";
const line = (name: string, ok: boolean, hits: string[], actual?: object) => JSON.stringify({ name: `test ${JSON.stringify(name)}`, ok, ...(actual ? { actual } : {}), ...(hits.length ? { hits } : {}) });
const harness = (...ls: string[]) => ({ code: 0, stdout: `${ls.join("\n")}\n${JSON.stringify({ done: ls.length })}\n`, timedOut: false });
const P = "lb.roundRobin.pick", M = "lb.roundRobin.markDown";
const compileLb = async (joint: { code: number; stdout: string; timedOut: boolean }) => {
  const fake = fakePorts({
    files: { "package.json": "{}", "src/lb.ts": LB, "tests/lb.test.ts": TESTS, ".openarc/manifest.json": '{"schema":1,"regions":{}}' },
    http: [TAGS, reply(PICK), reply(MARK)],
    proc: [
      { code: 0, stdout: "", timedOut: false }, // cp -al node_modules into the stage
      harness(line("rotates", true, [P]), line("markDown skips", false, [M], { pending: "" })), // pick: markDown still pending
      harness(line("rotates", true, [P]), line("markDown skips", true, [M, P])), // markDown, with pick accepted
      joint, // the joint check of class RoundRobin
    ],
  });
  const res = await run(fake.instance as Ports, req);
  const snap = fake.snapshot() as { files: Record<string, string>; requests: { url: string; body: { messages: { content: string }[] } }[] };
  return { res, files: snap.files, prompts: snap.requests.filter((q) => q.url.endsWith("/api/chat")).map((q) => q.body.messages[1]!.content) };
};
{
  const { res, files, prompts } = await compileLb(harness(line("rotates", true, [P]), line("markDown skips", true, [M, P])));
  assert.deepStrictEqual(codes(res.diagnostics), [], "2 tests, no examples: not thin (tests count)");
  assert.equal(res.modelCalls, 2);
  assert.match(prompts[0]!, /<<<BODY>>> \(RoundRobin\.pick\)/, "members compile in source order");
  assert.match(prompts[0]!, /markDown\(id: string\): void;  \/\/ pending: compiled jointly with this member; tests may call it/);
  assert.match(prompts[1]!, /healthy\(\): Backend\[\];  \/\/ implemented/);
  const text = files["src/lb.ts"]!;
  assert.ok(text.includes("  pick(key: string): string | null {\n    // @openarc:begin lb.roundRobin.pick\n    const hs = this.healthy();"), text);
  assert.ok(text.includes("    b.healthy = false;\n    // @openarc:end lb.roundRobin.markDown\n  }"), text);
  const m = JSON.parse(files[".openarc/manifest.json"]!).regions;
  assert.deepStrictEqual([m[P].declaration, m[P].ownership, m[P].provenance.verifiedBy], ["RoundRobin.pick", "compiler", ["tsc", "static", "tests:1/2 (1 inconclusive: pending regions)"]]);
  assert.deepStrictEqual(m[M].provenance.verifiedBy, ["tsc", "static", "tests:2/2"]);
  assert.equal(files["tests/lb.test.ts"], TESTS, "test files are never written");

  // the joint check: a member no passing test reaches holds the class back (W045 for it, W042 for the others)
  const held = await compileLb(harness(line("rotates", true, [P]), line("markDown skips", true, [P])));
  assert.deepStrictEqual(codes(held.res.diagnostics), [`OARC-W042 ${P} unreached:${M}`, `OARC-W045 ${M} unreached:${M}`]);
  assert.equal(held.files["src/lb.ts"], LB, "nothing committed, and the pending bodies are written back as they were");
  const failed = await compileLb(harness(line("rotates", false, [P], { checks: 2, failures: [{ i: 1, detail: 'got "a"; expected "b"' }] }), line("markDown skips", true, [M, P])));
  assert.deepStrictEqual(codes(failed.res.diagnostics), [`OARC-E090 ${P} joint:test "rotates"`]);
  assert.equal(failed.files["src/lb.ts"], LB);

  // identity after commit: the markers are the id. A renamed class keeps it; `@arc id` that disagrees is E064.
  const renamed = text.replaceAll("RoundRobin", "Rotation");
  const after = await analyzed({ "src/lb.ts": renamed, ".openarc/manifest.json": files[".openarc/manifest.json"]! });
  assert.deepStrictEqual(after.ids, [P, M]);
  assert.deepStrictEqual(after.p.regions.map((r) => r.state), ["compiler", "compiler"]);
  const tagged = await analyzed({ "src/lb.ts": text.replace("  /** The next healthy", "  /** @arc id lb.other\n   * The next healthy") });
  assert.deepStrictEqual(codes(tagged.ds), [`OARC-E064 ${P} @arc id lb.other`]);
  // a hand edit between the markers is the developer's (W060), as for any region
  const edited = await analyzed({ "src/lb.ts": text.replace("return b.id;", "return b.id; // mine"), ".openarc/manifest.json": files[".openarc/manifest.json"]! });
  assert.deepStrictEqual(codes(edited.ds), [`OARC-W060 ${P}`]);
}

// ── 4. the customization layer
{
  const SRC = (extra: string, tags = "@arc calls Math.max") => `import * as arc from "open-arc";
/**
 * The larger of a and b.
 * ${tags}
 */
export function larger(a: number, b: number): number {
  return arc.todo();
}
${extra}`;
  const ok = await analyzed({ "src/m.ts": SRC('arc.configure(larger, { effects: [], examples: [{ args: [1, 2], expected: 2 }, { args: [0, -1], expected: 0 }, { args: [3, 3], expected: 3 }] });\nexport const largerSpec = arc.defineRegion<(a: number, b: number) => number>({ id: "m.larger", intent: "Ties return a.", deps: [], examples: [{ args: [-2, -3], expected: -2 }] });\n') });
  assert.deepStrictEqual(codes(ok.ds), []);
  const s = ok.spec("m.larger");
  assert.deepStrictEqual([s.calls, s.effects, s.deps, s.examples.length], [["Math.max"], [], [], 4], "tags, configure and defineRegion merge; examples add up");
  assert.equal(s.intent, "The larger of a and b.\nTies return a.", "the defineRegion intent is appended to the JSDoc");
  assert.deepStrictEqual(ok.ids, ["m.larger"], "the defineRegion attaches: no second region, no scaffolded export const");
  const twice = await analyzed({ "src/m.ts": SRC("arc.configure(larger, { calls: [] });\n") });
  assert.deepStrictEqual(codes(twice.ds), ["OARC-E013 m.larger calls:jsdoc,configure"]);
  const thrice = await analyzed({ "src/m.ts": SRC('arc.configure(larger, { deps: [] });\nexport const largerSpec = arc.defineRegion<(a: number, b: number) => number>({ id: "m.larger", deps: [] });\n', "") });
  assert.deepStrictEqual(codes(thrice.ds), ["OARC-E013 m.larger deps:configure,defineRegion"]);
  const e020 = await analyzed({ "src/m.ts": SRC('export const largerSpec = arc.defineRegion<(a: string) => string>({ id: "m.larger" });\n') });
  assert.deepStrictEqual(codes(e020.ds), ["OARC-E020 m.larger defineRegion-type"]);
  const methodEx = await analyzed({ "src/c.ts": 'import * as arc from "open-arc";\nexport class C {\n  f(x: number): number {\n    return arc.todo();\n  }\n}\narc.configure(C.prototype.f, { examples: [{ args: [1], expected: 1 }] });\n' });
  assert.deepStrictEqual(codes(methodEx.ds), ["OARC-E010 c.f examples:method"], "methods are verified by tests (construct, then call)");
  const notRegion = await analyzed({ "src/m.ts": SRC("export function other(): number {\n  return 1;\n}\narc.configure(other, { calls: [] });\n") });
  assert.deepStrictEqual(codes(notRegion.ds), ["OARC-E010 configure:not-a-region:other"]);

  // backend: `@arc backend` is a default; openarc.config.json regions[id] wins
  const cfg = (regions: object) => JSON.stringify({ version: 1, backends: { local: { provider: "ollama", model: "qwen3.5:9b", maxContextTokens: 8192 }, big: { provider: "ollama", model: "qwen3.5:27b", maxContextTokens: 8192 } }, compilation: { defaultBackend: "local" }, regions });
  const tagged = await analyzed({ "src/m.ts": SRC("", "@arc backend big\n * @arc outputFormat code"), "openarc.config.json": cfg({}) });
  assert.deepStrictEqual([tagged.spec("m.larger").backend, tagged.spec("m.larger").outputFormat], ["big", "code"]);
  assert.deepStrictEqual(codes((await analyzed({ "src/m.ts": SRC("", "@arc backend huge"), "openarc.config.json": cfg({}) })).ds), ["OARC-E010 m.larger backend:huge"]);

  // the spec hash: the head, the JSDoc, the configuration and the tests; not a sibling's body
  const TEST = 'import * as arc from "open-arc";\nimport { larger } from "../src/m.ts";\narc.test(larger, "picks b", (f, expect) => {\n  expect(f(1, 2)).toBe(2);\n});\n';
  const h = async (src: string, test = TEST) => (await analyzed({ "src/m.ts": src, "tests/m.test.ts": test })).p.regions[0]!.specHash;
  const base = await h(SRC(""));
  assert.notEqual(await h(SRC("").replace("The larger", "The bigger")), base, "JSDoc");
  assert.equal(await h(SRC("").replace("(a: number, b: number)", "(a: number,  b: number)")), base, "whitespace in the head is normalised");
  assert.notEqual(await h(SRC("").replace("b: number): number", "b: number): 0 | number")), base, "the signature");
  assert.notEqual(await h(SRC("arc.configure(larger, { effects: [] });\n")), base, "configure");
  assert.notEqual(await h(SRC(""), TEST.replace("toBe(2)", "toBe(2.0)")), base, "test source");
  assert.equal(await h(SRC("export function sibling(): number {\n  return 1;\n}\n")), base, "an unrelated declaration");
}
console.log("implicit: discovery (functions, methods, getters, arrows, generics), ids, E022/E011, markers inside the body, joint class verification (W042/W045), identity after a rename, E064, layers (E013/E020/backend), spec hash ok");
