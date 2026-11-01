// Example harness (spec §9.3, §9.4). Hand-written bootstrap code.
// Used in two places: inside the sandbox through .openarc/harness.mjs, and directly by tools/run-examples.ts.
import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { OpenArcTodoError, type FakeFactory, type FakeInstance, type FakeRef, type Json, type RegionSpec, type AnyFn, type UiNode } from "./index.ts";

export interface Outcome {
  name: string;
  ok: boolean;
  actual?: Json;
  /** Coverage probe (spec §8.10): ids of the probed blocks (and sketch holes, "<id>#<n>") this example executed.
   *  Only a passing example's hits count as coverage; a failing one's tell OARC-E100 whether it reached any hole. */
  hits?: string[];
}

/** The compiler stages block bodies with `globalThis.__openarcHit?.("<id>")` as their first statement (never on disk). */
type HitHost = { __openarcHit?: (id: string) => void };
/** The example a hit belongs to: async work keeps the scope it started in, and a closed scope records nothing. */
type HitScope = { hits: Set<string>; open: boolean };

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

/** The built-in `action` fake ({ $fake: "action#<name>" }): a function that records its calls and returns init.returns[i]
 *  for the i-th call. Any other "<file>#<name>" is tests/fakes/<file>.ts, one instance per full name. */
export const action = (init: Json | undefined): FakeInstance<(...a: unknown[]) => Promise<unknown>> => {
  const returns = ((init as { returns?: Json[] } | undefined)?.returns ?? []) as unknown[];
  const calls: unknown[][] = [];
  return { instance: async (...a) => (calls.push(a), structuredClone(returns[calls.length - 1])), snapshot: () => ({ calls: toJson(calls) }) };
};

// join, not `${root}/${rel}`: the root is an OS path (C:\… on Windows), and pathToFileURL handles the drive letter
const importFile = (root: string, rel: string) => import(pathToFileURL(join(root, rel)).href);

/** Run every example of one function region. `pendingIsFailure` is false only for the dev runner. */
export async function runExamples(root: string, fn: AnyFn, spec: RegionSpec<AnyFn>): Promise<Outcome[]> {
  const out: Outcome[] = [];
  // A hit is credited to the example whose call started the work, so a previous example's dangling promise can't mark a
  // block as reached by a later, passing example.
  const attribution = new AsyncLocalStorage<HitScope>();
  (globalThis as HitHost).__openarcHit = (id) => {
    const scope = attribution.getStore();
    if (scope?.open) scope.hits.add(id);
  };
  for (const [i, ex] of (spec.examples ?? []).entries()) {
    const name = ex.name ?? `#${i + 1}`;
    const fakes = new Map<string, FakeInstance<unknown>>();
    const eq: EqualOptions = { tolerance: ex.tolerance ?? spec.tolerance, exact: ex.exact };
    const scope: HitScope = { hits: new Set<string>(), open: true };
    const withHits = (o: Outcome): Outcome => (scope.hits.size ? { ...o, hits: [...scope.hits].sort() } : o);
    const passed = (): Outcome => withHits({ name, ok: true });
    try {
      // fakes anywhere in an argument (a function-valued field may be one: Encoded<T>), each created once per example
      const resolve = async (v: unknown): Promise<unknown> => {
        if (isFakeRef(v)) {
          let inst = fakes.get(v.$fake);
          if (!inst) {
            const file = v.$fake.split("#")[0]!;
            inst = file === "action" ? action(v.init) : ((await importFile(root, `tests/fakes/${file}.ts`)).default as FakeFactory<unknown>)(v.init);
            fakes.set(v.$fake, inst);
          }
          return inst.instance;
        }
        if (Array.isArray(v)) {
          const out: unknown[] = [];
          for (const x of v) out.push(await resolve(x));
          return out;
        }
        if (isPlain(v)) {
          const out: Record<string, unknown> = {};
          for (const [k, x] of Object.entries(v)) out[k] = await resolve(x);
          return out;
        }
        return v;
      };
      const args: unknown[] = [];
      for (const a of decodeTokens(ex.args) as unknown[]) args.push(await resolve(structuredClone(a)));
      if (ex.throws !== undefined) {
        // `throws` example: the call must throw (or reject); a string must appear in the message. Pending still reports pending.
        let message: string | null = null;
        let actual: unknown;
        try {
          actual = await attribution.run(scope, () => fn(...args));
        } catch (e) {
          if (e instanceof OpenArcTodoError) throw e;
          message = e instanceof Error ? e.message : String(e);
        }
        if (message === null) {
          out.push(withHits({ name, ok: false, actual: { returned: toJson(actual) } }));
          continue;
        }
        if (typeof ex.throws === "string" && !message.includes(ex.throws)) {
          out.push(withHits({ name, ok: false, actual: { throws: message } }));
          continue;
        }
      } else {
        const actual = await attribution.run(scope, () => fn(...args));
        if ("expected" in ex && !valuesEqual(actual, decodeTokens(ex.expected), eq)) {
          out.push(withHits({ name, ok: false, actual: toJson(actual) }));
          continue;
        }
      }
      const after: Record<string, Json> = {};
      let fakesOk = true;
      for (const [fake, want] of Object.entries(ex.fakesAfter ?? {})) {
        const got = fakes.get(fake)?.snapshot() ?? null;
        after[fake] = got;
        if (!valuesEqual(JSON.parse(JSON.stringify(got)), decodeTokens(want), eq)) fakesOk = false; // snapshots compare as JSON
      }
      out.push(fakesOk ? passed() : withHits({ name, ok: false, actual: { fakesAfter: after } }));
    } catch (e) {
      if (e instanceof OpenArcTodoError) out.push(withHits({ name, ok: false, actual: { pending: e.id } }));
      else out.push(withHits({ name, ok: false, actual: { throws: e instanceof Error ? e.message : String(e) } }));
    } finally {
      scope.open = false;
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
  /** palette: a UI region (§2.6): the structure tree; `module` is then the component file, run in a DOM by ui-harness.ts. */
  ui?: { param: string | null; root: UiNode };
  /** Code-first tests (§2.7): run after the examples by test-runner.ts. */
  tests?: import("./test-runner.ts").TestPlan;
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
  const plan = JSON.parse(readFileSync(join(root, ".openarc", "harness-plan.json"), "utf8")) as Record<string, HarnessPlanEntry>;
  const entry = plan[regionId];
  if (!entry) throw new Error(`harness: no plan entry for ${regionId}`);
  const print = (os: Outcome[]) => {
    for (const o of os) process.stdout.write(JSON.stringify(o) + "\n");
    process.stdout.write(JSON.stringify({ done: os.length }) + "\n");
  };
  if (entry.ui) return print(await (await import("./ui-harness.ts")).runUi(root, { ...entry, ui: entry.ui })); // palette
  const mod = await importFile(root, entry.module);
  const spec = entry.examples ? { ...(mod[entry.specExport] as RegionSpec<AnyFn>), examples: entry.examples as unknown as RegionSpec<AnyFn>["examples"], tolerance: entry.tolerance } : mod[entry.specExport];
  const outcomes = entry.oracle
    ? await runOracle(mod[entry.symbol], (await importFile(root, entry.oracle.module))[entry.oracle.export], entry.oracle.inputs, { tolerance: entry.tolerance })
    : await runExamples(root, mod[entry.symbol], spec);
  if (entry.tests && !entry.oracle) outcomes.push(...(await (await import("./test-runner.ts")).runTests(root, entry.tests))); // code-first
  for (const o of outcomes) process.stdout.write(JSON.stringify(o) + "\n");
  process.stdout.write(JSON.stringify({ done: outcomes.length }) + "\n");
}
