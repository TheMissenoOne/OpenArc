// Example harness (spec §9.3, §9.4). Hand-written bootstrap code.
// Used in two places: inside the sandbox through .openarc/harness.mjs, and directly by tools/run-examples.ts.
import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { OpenArcTodoError, type FakeFactory, type FakeInstance, type FakeRef, type Json, type RegionSpec, type AnyFn } from "./index.ts";

export interface Outcome {
  name: string;
  ok: boolean;
  actual?: Json;
}

const isFakeRef = (v: unknown): v is FakeRef =>
  typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as FakeRef).$fake === "string";

const toJson = (v: unknown): Json => {
  if (v === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(v)) as Json;
  } catch {
    return String(v);
  }
};

const importFile = (root: string, rel: string) => import(pathToFileURL(`${root}/${rel}`).href);

/** Run every example of one function region. `pendingIsFailure` is false only for the dev runner. */
export async function runExamples(root: string, fn: AnyFn, spec: RegionSpec<AnyFn>): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const [i, ex] of (spec.examples ?? []).entries()) {
    const name = ex.name ?? `#${i + 1}`;
    const fakes = new Map<string, FakeInstance<unknown>>();
    try {
      const args: unknown[] = [];
      for (const a of ex.args as unknown[]) {
        if (!isFakeRef(a)) {
          args.push(structuredClone(a));
          continue;
        }
        let inst = fakes.get(a.$fake);
        if (!inst) {
          const mod = await importFile(root, `tests/fakes/${a.$fake}.ts`);
          inst = (mod.default as FakeFactory<unknown>)(a.init);
          fakes.set(a.$fake, inst);
        }
        args.push(inst.instance);
      }
      const actual = await fn(...args);
      if ("expected" in ex && !isDeepStrictEqual(actual, ex.expected)) {
        out.push({ name, ok: false, actual: toJson(actual) });
        continue;
      }
      const after: Record<string, Json> = {};
      let fakesOk = true;
      for (const [fake, want] of Object.entries(ex.fakesAfter ?? {})) {
        const got = fakes.get(fake)?.snapshot() ?? null;
        after[fake] = got;
        if (!isDeepStrictEqual(toJson(got), want)) fakesOk = false;
      }
      out.push(fakesOk ? { name, ok: true } : { name, ok: false, actual: { fakesAfter: after } });
    } catch (e) {
      if (e instanceof OpenArcTodoError) out.push({ name, ok: false, actual: { pending: e.id } });
      else out.push({ name, ok: false, actual: { throws: e instanceof Error ? e.message : String(e) } });
    }
  }
  return out;
}

/** Plan written by the compiler into the stage: which module, symbol and spec export to test for a region id. */
export interface HarnessPlanEntry {
  module: string;
  symbol: string;
  specExport: string;
  /** Static examples from the compiler. When present they REPLACE the module's runtime spec.examples. */
  examples?: Json[];
}

/** Sandbox entry: prints one JSON line per example, then {"done": n}. */
export async function main(root: string, regionId: string): Promise<void> {
  const plan = JSON.parse(readFileSync(`${root}/.openarc/harness-plan.json`, "utf8")) as Record<string, HarnessPlanEntry>;
  const entry = plan[regionId];
  if (!entry) throw new Error(`harness: no plan entry for ${regionId}`);
  const mod = await importFile(root, entry.module);
  const spec = entry.examples ? { ...(mod[entry.specExport] as RegionSpec<AnyFn>), examples: entry.examples as unknown as RegionSpec<AnyFn>["examples"] } : mod[entry.specExport];
  const outcomes = await runExamples(root, mod[entry.symbol], spec);
  for (const o of outcomes) process.stdout.write(JSON.stringify(o) + "\n");
  process.stdout.write(JSON.stringify({ done: outcomes.length }) + "\n");
}
