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

// ── value tokens and equality (spec §9.3) ──
const TOKENS: Record<string, unknown> = { $NaN: NaN, $Infinity: Infinity, "$-Infinity": -Infinity, $undefined: undefined };

/** Decode the "$NaN" | "$Infinity" | "$-Infinity" | "$undefined" tokens of a JSON example value (fake refs stay as they are). */
export function decodeTokens(v: unknown): unknown {
  if (typeof v === "string") return Object.hasOwn(TOKENS, v) ? TOKENS[v] : v;
  if (Array.isArray(v)) return v.map(decodeTokens);
  if (typeof v === "object" && v !== null && !isFakeRef(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decodeTokens(x)]));
  return v;
}

/** A JSON view of a result that keeps -0, NaN, ±Infinity and undefined visible (as "$-0", "$NaN", … tokens). */
export function toJson(v: unknown): Json {
  if (v === undefined) return "$undefined";
  if (typeof v === "number") return Number.isNaN(v) ? "$NaN" : v === Infinity ? "$Infinity" : v === -Infinity ? "$-Infinity" : Object.is(v, -0) ? "$-0" : v;
  if (Array.isArray(v)) return v.map(toJson);
  if (typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJson(x)]));
  try {
    return JSON.parse(JSON.stringify(v)) as Json;
  } catch {
    return String(v);
  }
}

/** Print a toJson value or an example literal with the tokens unquoted: [-0,1,NaN], not [0,1,null]. */
export const showValue = (v: Json | undefined): string =>
  v === undefined ? "undefined" : JSON.stringify(v).replace(/"\$(-0|NaN|-?Infinity|undefined)"/g, "$1");

export interface EqualOptions {
  tolerance?: number; // default 1e-9, relative to max(1, |a|, |b|), so also absolute near zero
  exact?: boolean; // Object.is on numbers (-0 !== 0, no tolerance); NaN still equals NaN
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && [Object.prototype, null].includes(Object.getPrototypeOf(v));

/** Example equality: deep strict equality, except that numbers match within the tolerance, -0 equals 0 and NaN equals NaN. */
export function valuesEqual(a: unknown, b: unknown, o: EqualOptions = {}): boolean {
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
    if (o.exact) return Object.is(a, b);
    if (a === b) return true; // also -0 === 0 and Infinity === Infinity
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return Math.abs(a - b) <= (o.tolerance ?? 1e-9) * Math.max(1, Math.abs(a), Math.abs(b));
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => valuesEqual(x, b[i], o));
  if (isPlain(a) && isPlain(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && valuesEqual(a[k], b[k], o));
  }
  return isDeepStrictEqual(a, b);
}

const importFile = (root: string, rel: string) => import(pathToFileURL(`${root}/${rel}`).href);

/** Run every example of one function region. `pendingIsFailure` is false only for the dev runner. */
export async function runExamples(root: string, fn: AnyFn, spec: RegionSpec<AnyFn>): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const [i, ex] of (spec.examples ?? []).entries()) {
    const name = ex.name ?? `#${i + 1}`;
    const fakes = new Map<string, FakeInstance<unknown>>();
    const eq: EqualOptions = { tolerance: ex.tolerance ?? spec.tolerance, exact: ex.exact };
    try {
      const args: unknown[] = [];
      for (const a of decodeTokens(ex.args) as unknown[]) {
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
      if ("expected" in ex && !valuesEqual(actual, decodeTokens(ex.expected), eq)) {
        out.push({ name, ok: false, actual: toJson(actual) });
        continue;
      }
      const after: Record<string, Json> = {};
      let fakesOk = true;
      for (const [fake, want] of Object.entries(ex.fakesAfter ?? {})) {
        const got = fakes.get(fake)?.snapshot() ?? null;
        after[fake] = got;
        if (!valuesEqual(JSON.parse(JSON.stringify(got)), decodeTokens(want), eq)) fakesOk = false; // snapshots compare as JSON
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
  /** Static spec-level tolerance from the compiler (replaces the runtime spec.tolerance with the examples). */
  tolerance?: number;
  /** `openarc check --oracle`: run the region and a reference implementation on these argument lists instead of the examples. */
  oracle?: { module: string; export: string; inputs: Json[][] };
}

const settle = async (fn: AnyFn, args: unknown[]): Promise<{ value?: unknown; throws?: string }> => {
  try {
    return { value: await fn(...structuredClone(args)) };
  } catch (e) {
    return { throws: e instanceof Error ? e.message : String(e) };
  }
};

/** Differential check: one outcome per input. They agree when both return equal values (valuesEqual) or both throw. */
export async function runOracle(fn: AnyFn, oracle: AnyFn, inputs: Json[][], o: EqualOptions = {}): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const [i, raw] of inputs.entries()) {
    const args = decodeTokens(raw) as unknown[];
    const [got, want] = [await settle(fn, args), await settle(oracle, args)];
    const ok = got.throws !== undefined || want.throws !== undefined ? got.throws !== undefined && want.throws !== undefined : valuesEqual(got.value, want.value, o);
    const view = (r: typeof got): Json => (r.throws !== undefined ? { throws: r.throws } : toJson(r.value));
    out.push(ok ? { name: `#${i + 1}`, ok } : { name: `#${i + 1}`, ok, actual: { args: raw, got: view(got), oracle: view(want) } });
  }
  return out;
}

/** Sandbox entry: prints one JSON line per example, then {"done": n}. */
export async function main(root: string, regionId: string): Promise<void> {
  const plan = JSON.parse(readFileSync(`${root}/.openarc/harness-plan.json`, "utf8")) as Record<string, HarnessPlanEntry>;
  const entry = plan[regionId];
  if (!entry) throw new Error(`harness: no plan entry for ${regionId}`);
  const mod = await importFile(root, entry.module);
  const spec = entry.examples ? { ...(mod[entry.specExport] as RegionSpec<AnyFn>), examples: entry.examples as unknown as RegionSpec<AnyFn>["examples"], tolerance: entry.tolerance } : mod[entry.specExport];
  const outcomes = entry.oracle
    ? await runOracle(mod[entry.symbol], (await importFile(root, entry.oracle.module))[entry.oracle.export], entry.oracle.inputs, { tolerance: entry.tolerance })
    : await runExamples(root, mod[entry.symbol], spec);
  for (const o of outcomes) process.stdout.write(JSON.stringify(o) + "\n");
  process.stdout.write(JSON.stringify({ done: outcomes.length }) + "\n");
}
