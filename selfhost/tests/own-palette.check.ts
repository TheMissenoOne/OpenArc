// Your own palette (docs/wiki/Palette.md, "Building your own palette"), no model. Run: node tests/own-palette.check.ts
// The wiki's worked example, tests/fixtures/own-palette/src/cache.ts: a user-defined `cache` concept with two laws (get
// after set, eviction bound) and two variants (LRU, TTL) with their own fixtures and examples.
// 1. It type-checks as written (stage0's compiler options), with the wiki's code-first LruCache (pending bodies, a law).
// 2. The compiler reads it cleanly: one concept, two variants, the laws expanded into each variant's examples.
// 3. Every example of each variant, laws included, passes through the harness against the hand-written bodies.
// 4. The laws have teeth: a variant that never evicts fails "eviction bound" and nothing else.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import type { AnyFn, RegionSpec } from "open-arc";
import { runExamples } from "open-arc/harness";
import type { CompileRequest, Ports } from "../src/types.ts";
import fakePorts from "./fakes/ports.memory.ts";
import * as engine from "../src/engine.ts";

const root = join(process.cwd(), "tests", "fixtures", "own-palette");
const file = join(root, "src", "cache.ts");
const lruCache = join(root, "src", "lruCache.ts"); // the wiki's code-first class and law, pending bodies

// ── 1. tsc
const cfg = ts.readConfigFile(join(process.cwd(), "tsconfig.json"), ts.sys.readFile);
const { options } = ts.parseJsonConfigFileContent(cfg.config, ts.sys, process.cwd());
const program = ts.createProgram([file, lruCache], options);
const tsErrors = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
assert.deepStrictEqual(tsErrors, [], "the wiki's example type-checks");

// ── 2. the compiler's view
const req: CompileRequest = { root, ids: [], model: { host: "http://h", model: "m", seed: 1, numCtx: 8192 }, sandbox: { nodeBin: "/n/bin/node", nodePrefix: "/n", heapMb: 256, addressSpaceBytes: 2 ** 32, cpuSeconds: 10 } };
const ports = fakePorts({ files: { "src/cache.ts": readFileSync(file, "utf8") }, http: [JSON.stringify({ models: [{ name: "qwen3.5:9b", digest: "d1" }] })] }).instance as Ports;
const p = await engine.parse(ports, req, []);
const ds: { code: string; id?: string; detail?: string }[] = [];
await engine.analyze(ports, req, p, ds as never);
assert.deepStrictEqual(ds.filter((d) => d.code.startsWith("OARC-E")), [], JSON.stringify(ds));
assert.deepStrictEqual([...p.concepts!.keys()], ["cache"]);
const variants = [...p.specs.values()].filter((s) => s.literal.concept).map((s) => s.id).sort();
assert.deepStrictEqual(variants, ["cache.lru", "cache.ttl"]);
const LAWS = ["law: get after set returns the value", "law: eviction bound: never more entries than capacity"];
for (const id of variants) assert.deepStrictEqual(p.specs.get(id)!.examples.slice(0, 2).map((e) => (e as { name: string }).name), LAWS, `${id}: laws come first`);

// ── 3. laws and examples through the harness
const mod = await import(pathToFileURL(file).href);
let examples = 0;
for (const id of variants) {
  const s = p.specs.get(id)!;
  const outcomes = await runExamples(root, mod[s.symbol] as AnyFn, { ...(mod[s.exportName] as RegionSpec<AnyFn>), examples: s.examples as never });
  assert.deepStrictEqual(outcomes.filter((o) => !o.ok), [], id);
  assert.equal(outcomes.length, 4, id);
  examples += outcomes.length;
}

// ── 4. a broken variant: an LRU that forgets to evict
const unbounded: AnyFn = (_config: unknown, ops: { op: string; key?: string; value?: string }[]) => {
  const m = new Map<string, string>();
  const out: (string | number | null)[] = [];
  for (const o of ops) {
    if (o.op === "set") m.set(o.key!, o.value!);
    else if (o.op === "get") out.push(m.get(o.key!) ?? null);
    else if (o.op === "size") out.push(m.size);
  }
  return out;
};
const failed = (await runExamples(root, unbounded, { id: "cache.lru", examples: p.specs.get("cache.lru")!.examples as never })).filter((o) => !o.ok).map((o) => o.name);
assert.deepStrictEqual(failed, ["law: eviction bound: never more entries than capacity", "a get makes the entry recent"]);

console.log(`own-palette: concept cache, ${variants.length} variants, ${examples} examples (laws included) pass; a variant that never evicts fails the eviction law`);
