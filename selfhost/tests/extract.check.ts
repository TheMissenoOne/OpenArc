// `openarc extract` (spec §10) on in-memory ports. Run: node tests/extract.check.ts
import assert from "node:assert";
import type { CompileRequest, Ports } from "../src/types.ts";
import fakePorts from "./fakes/ports.memory.ts";
import * as engine from "../src/engine.ts";

const root = process.cwd(); // stage0, so "openarc" resolves for the type checker
const req: CompileRequest = { root, ids: [], model: { host: "http://h", model: "m", seed: 1, numCtx: 8192 }, sandbox: { nodeBin: "/n/bin/node", nodePrefix: "/n", heapMb: 256, addressSpaceBytes: 2 ** 32, cpuSeconds: 10 } };
const M = ".openarc/manifest.json";

/** One `openarc extract` against `ports`; applies the staged files like the CLI's commit does. */
async function extract(ports: Ports, rel: string, opts: { fn?: string; id?: string } = {}) {
  const p = await engine.parse(ports, req, []);
  const res = await engine.extract(ports, req, p, rel, opts);
  for (const f of res.files) await ports.fs.write(f.target, f.text);
  return res;
}
async function tsErrors(ports: Ports): Promise<string[]> {
  const p = await engine.parse(ports, req, []);
  const prog = engine.makeProgram(p, p.files);
  return [...p.files.keys()].flatMap((rel) => {
    const sf = prog.getSourceFile(`${root}/${rel}`)!;
    return [...prog.getSyntacticDiagnostics(sf), ...prog.getSemanticDiagnostics(sf)].map((d) => `${rel}: TS${d.code}`);
  });
}

const addBody = "export function add(a: number, b: number): number {\n  return a + b; // keep me\n}";
const slugBody = 'export const slug = async (title: string, opts?: { sep?: string }) => {\n  return title.trim().toLowerCase().split(/\\s+/).join(opts?.sep ?? "-");\n};';
const fixture = [
  'import type { Json } from "openarc";',
  "",
  "/**",
  " * Adds two numbers.",
  " * Second line is ignored.",
  " */",
  addBody,
  "",
  slugBody,
  "",
  "function helper(): Json { return null; }",
  "export const VERSION = 1;",
  "",
].join("\n");

// ── two exported functions, one with JSDoc
{
  const fake = fakePorts({ files: { "src/text-utils.ts": fixture } });
  const ports = fake.instance;
  const res = await extract(ports, "src/text-utils.ts");
  assert.deepStrictEqual({ extracted: res.extracted, skipped: res.skipped, refused: res.refused }, { extracted: ["textUtils.add", "textUtils.slug"], skipped: [], refused: [] });
  const out = (await ports.fs.read("src/text-utils.ts"))!;
  assert.ok(out.startsWith('import * as arc from "openarc";\n'), "arc import added");
  assert.ok(out.includes(`// @openarc:begin textUtils.add\n${addBody}\n// @openarc:end textUtils.add`), "add body byte-identical inside its markers");
  assert.ok(out.includes(`// @openarc:begin textUtils.slug\n${slugBody}\n// @openarc:end textUtils.slug`), "slug body byte-identical inside its markers");
  assert.ok(out.includes("type AddFn = (a: number, b: number) => number;"), out);
  assert.ok(out.includes("type SlugFn = (title: string, opts?: { sep?: string; }) => Promise<string>;"), out);
  assert.ok(out.includes('  intent: ["[inferred] Adds two numbers."],'), "first JSDoc line");
  assert.ok(out.includes('  intent: ["[inferred] TODO describe"],'), "no JSDoc");
  assert.ok(/\/\*\*\n \* Adds two numbers\.\n \* Second line is ignored\.\n \*\/\n\/\/ @openarc:begin textUtils\.add/.test(out), "JSDoc stays attached, outside the markers");
  assert.ok(!out.includes("helperSpec"), "non-exported functions are left alone");
  assert.deepStrictEqual(await tsErrors(ports), [], "the result type-checks");

  const m = JSON.parse((await ports.fs.read(M))!);
  for (const id of ["textUtils.add", "textUtils.slug"]) {
    const e = m.regions[id];
    assert.equal(e.ownership, "developer");
    assert.equal(e.provenance.source, "extracted");
    assert.equal(e.fingerprint, null);
  }
  // the analyzer agrees: developer-owned, nothing to (re)generate, no W060/E061
  const p = await engine.parse(ports, req, []);
  const ds: never[] = [];
  await engine.analyze(ports, req, p, ds, { offline: true });
  assert.deepStrictEqual(ds, []);
  assert.deepStrictEqual(p.regions.map((r) => [r.id, r.state]), [["textUtils.add", "developer"], ["textUtils.slug", "developer"]]);

  // idempotent: a second run changes nothing
  const before = JSON.stringify(fake.snapshot());
  const again = await extract(ports, "src/text-utils.ts");
  assert.deepStrictEqual(again, { files: [], extracted: [], skipped: ["add", "slug"], refused: [] });
  assert.equal(JSON.stringify(fake.snapshot()), before);
}

// ── --function and --id
{
  const ports = fakePorts({ files: { "src/text-utils.ts": fixture } }).instance;
  const res = await extract(ports, "src/text-utils.ts", { fn: "slug", id: "text.makeSlug" });
  assert.deepStrictEqual(res.extracted, ["text.makeSlug"]);
  const out = (await ports.fs.read("src/text-utils.ts"))!;
  assert.ok(out.includes('  symbol: "slug",'), "symbol recorded when the id's last segment differs");
  assert.ok(!out.includes("@openarc:begin textUtils.add"));
  assert.deepStrictEqual(await tsErrors(ports), []);
}

// ── refusals
{
  const refusals = [
    "export function over(a: string): string;",
    "export function over(a: number): number;",
    "export function over(a: unknown) { return a; }",
    "export function first<T>(xs: T[]): T | undefined { return xs[0]; }",
    "export default function () { return 1; }",
    "export class Box {",
    "  get(): number { return 1; }",
    "}",
    "",
  ].join("\n");
  const fake = fakePorts({ files: { "src/bad.ts": refusals } });
  const ports = fake.instance;
  const before = JSON.stringify(fake.snapshot());
  const res = await extract(ports, "src/bad.ts");
  assert.deepStrictEqual(res.extracted, []);
  assert.deepStrictEqual(res.refused.map((r) => [r.name, r.reason.split(":")[0]]), [
    ["default", "default-exported anonymous function"],
    ["over", "overloaded function"],
    ["first", "generic function"],
  ]);
  const method = await extract(ports, "src/bad.ts", { fn: "get" });
  assert.match(method.refused[0]!.reason, /^class method/);
  assert.match((await extract(ports, "src/bad.ts", { fn: "Box.get" })).refused[0]!.reason, /^class method/);
  assert.match((await extract(ports, "src/bad.ts", { fn: "missing" })).refused[0]!.reason, /^no top-level function/);
  assert.match((await extract(ports, "tests/x.ts")).refused[0]!.reason, /under src\//);
  assert.equal(JSON.stringify(fake.snapshot()), before, "refusals write nothing");
}

// ── ids (the CLI side is cli.parseArgv's examples)
assert.equal(engine.extractId("src/text-utils.ts", "_Parse$Thing"), "textUtils.parseThing");
assert.equal(engine.extractId("src/a.test.ts", "f"), "a.test.f");
console.log("extract: markers, specs, manifest, idempotence and refusals ok");
