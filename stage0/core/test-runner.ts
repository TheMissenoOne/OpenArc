// The sandbox side of code-first tests (SPEC §9.3). Hand-written bootstrap code, loaded by harness.ts only when the
// harness plan has tests. It imports the planned test files, refuses a registry that differs from the compiler's static
// plan (per file: kinds, hidden flags, names, in order), then runs the selected tests with soft assertions and the
// coverage probe's hit attribution. Hidden tests report pass/fail only: their details never leave this process.
import { AsyncLocalStorage } from "node:async_hooks";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OpenArcTodoError, type FakeFactory, type FakeInstance, type Json } from "./index.ts";
import { registered, type Gen, type Registered } from "./test.ts";
import { showValue, toJson, valuesEqual, type Outcome } from "./harness.ts";

/** One arc.test/arc.test.hidden/arc.law statement as the compiler read it. */
export interface PlanTest {
  file: string;
  kind: "test" | "law";
  hidden: boolean;
  name: string;
}
/** `all`: every test statement of every project file that has one, in source order. `run`: indexes into `all`.
 *  `fakes`: the tests/fakes/ names the compiler resolved `fakes.of<T>()` to (it rewrote the staged copies to name them). */
export interface TestPlan {
  all: PlanTest[];
  run: number[];
  fakes?: string[];
}

const key = (t: { kind: string; hidden: boolean; name: string }) => `${t.kind}${t.hidden ? ".hidden" : ""} ${JSON.stringify(t.name)}`;
/** The outcome-line name of a test; the compiler maps it back to the static plan. */
export const outcomeName = (t: { kind: string; name: string }) => `${t.kind} ${JSON.stringify(t.name)}`;

/** mulberry32, as engine.oracleInputs uses. */
function prng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = Math.imul(x ^ (x >>> 15), x | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGen(seed: number, draws: Json[]): Gen {
  const r = prng(seed);
  const rec = <T>(v: T): T => (draws.push(toJson(v)), v);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const g: Gen = {
    int: (lo, hi) => rec(int(lo, hi)),
    bool: () => rec(r() < 0.5),
    pick: (xs) => rec(xs[Math.floor(r() * xs.length)]!),
    string: (o = {}) => {
      const al = o.alphabet ?? "abcxyz ";
      return rec(Array.from({ length: int(0, o.max ?? 8) }, () => al[Math.floor(r() * al.length)]).join(""));
    },
    array: (item, o = {}) => Array.from({ length: rec(int(o.min ?? 0, o.max ?? 8)) }, () => item(g)),
  };
  return g;
}

const matches = (msg: string, m: unknown) => m === undefined || (m instanceof RegExp ? m.test(msg) : msg.includes(String(m)));
const show = (v: unknown) => showValue(toJson(v));
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

type HitHost = { __openarcHit?: (id: string) => void };

export async function runTests(root: string, plan: TestPlan): Promise<Outcome[]> {
  const relOf = (url: string) => (url.startsWith("file:") ? relative(root, fileURLToPath(url)).split(sep).join("/") : url);
  const files = [...new Set(plan.run.map((i) => plan.all[i]!.file))];
  for (const f of files) await import(pathToFileURL(join(root, f)).href);
  // The registry check: every file that registered tests (also through an import) registered exactly its planned ones.
  const byFile = new Map<string, Registered[]>();
  for (const r of registered()) byFile.set(relOf(r.file), [...(byFile.get(relOf(r.file)) ?? []), r]);
  for (const f of new Set([...files, ...byFile.keys()])) {
    const want = plan.all.filter((t) => t.file === f).map(key);
    const got = (byFile.get(f) ?? []).map(key);
    if (JSON.stringify(want) !== JSON.stringify(got))
      return [{ name: "test-registry", ok: false, actual: { registry: `${f}: planned [${want.join(", ")}], registered [${got.join(", ")}]` } }];
  }

  const attribution = new AsyncLocalStorage<{ hits: Set<string>; open: boolean }>();
  (globalThis as HitHost).__openarcHit = (id) => {
    const scope = attribution.getStore();
    if (scope?.open) scope.hits.add(id);
  };
  const factories = new Map<string, FakeFactory<unknown>>(); // preloaded, so fakes.of stays synchronous
  for (const name of plan.fakes ?? []) factories.set(name, (await import(pathToFileURL(join(root, "tests", "fakes", `${name}.ts`)).href)).default as FakeFactory<unknown>);
  const out: Outcome[] = [];
  for (const i of plan.run) {
    const t = plan.all[i]!;
    const r = byFile.get(t.file)![plan.all.slice(0, i).filter((x) => x.file === t.file).length]!;
    const failures: { i: number; detail: string }[] = [];
    let checks = 0;
    const expect = (actual: unknown, idx = -1) => {
      const rec = (ok: boolean, detail: () => string) => {
        checks++;
        if (!ok) failures.push({ i: idx, detail: detail() });
      };
      return {
        toBe: (e: unknown) => rec(Object.is(actual, e) || (actual === 0 && e === 0), () => `got ${show(actual)}; expected ${show(e)}`),
        toEqual: (e: unknown, o: { tolerance?: number; exact?: boolean } = {}) => rec(valuesEqual(actual, e, o), () => `got ${show(actual)}; expected ${show(e)}`),
        toMatch: (p: RegExp | string) => rec(typeof actual === "string" && matches(actual, p), () => `got ${show(actual)}; expected to match ${String(p)}`),
        toHaveLength: (n: number) => rec((actual as { length?: unknown } | null)?.length === n, () => `length ${show((actual as { length?: unknown } | null)?.length)}; expected ${n}`),
        toContain: (x: unknown) => rec(Array.isArray(actual) ? actual.some((a) => valuesEqual(a, x)) : typeof actual === "string" && actual.includes(String(x)), () => `${show(actual)} does not contain ${show(x)}`),
        toThrow: (m?: string | RegExp) => {
          try {
            (actual as () => unknown)();
          } catch (e) {
            if (e instanceof OpenArcTodoError) throw e;
            return rec(matches(messageOf(e), m), () => `threw ${JSON.stringify(messageOf(e))}; expected ${m === undefined ? "a throw" : String(m)}`);
          }
          rec(false, () => "returned instead of throwing");
        },
        toReject: async (m?: string | RegExp) => {
          try {
            await actual;
          } catch (e) {
            if (e instanceof OpenArcTodoError) throw e;
            return rec(matches(messageOf(e), m), () => `rejected with ${JSON.stringify(messageOf(e))}; expected ${m === undefined ? "a rejection" : String(m)}`);
          }
          rec(false, () => "resolved instead of rejecting");
        },
      };
    };
    const live = new Map<object, FakeInstance<unknown>>();
    const fakes = {
      of(name: unknown, init?: Json) {
        if (typeof name !== "string" || !factories.has(name)) throw new Error("fakes.of<T>() was not resolved to a fake by the compiler");
        const inst = factories.get(name)!(init);
        live.set(inst.instance as object, inst);
        return inst.instance;
      },
      named(name: string, init?: Json) {
        return fakes.of(name, init);
      },
      snapshot: (instance: object) => JSON.parse(JSON.stringify(live.get(instance)?.snapshot() ?? null)) as Json,
    };
    const scope = { hits: new Set<string>(), open: true };
    let pending: string | null = null, error: string | null = null, law: string | null = null;
    let cur: { run: number; runs: number; seed: number; draws: Json[] } | null = null; // a law's current run: a throw reports it too
    const where = (c: NonNullable<typeof cur>) => `at run ${c.run + 1}/${c.runs} (seed ${c.seed}); draws ${showValue(c.draws)}`;
    try {
      if (t.kind === "law") {
        const runs = r.runs ?? 50, seed = r.seed ?? 1;
        for (let run = 0; run < runs; run++) {
          const draws: Json[] = [];
          const before = failures.length;
          cur = { run, runs, seed, draws };
          await attribution.run(scope, () => r.body(r.target as never, expect, makeGen(seed * 1000 + run, draws) as never));
          if (failures.length > before) {
            law = `failed ${where(cur)}`;
            break;
          }
        }
      } else await attribution.run(scope, () => r.body(r.target as never, expect, fakes as never));
    } catch (e) {
      if (e instanceof OpenArcTodoError) pending = e.id;
      else {
        error = messageOf(e);
        if (cur) law = `threw ${where(cur)}`;
      }
    } finally {
      scope.open = false;
    }
    const ok = pending === null && error === null && failures.length === 0;
    const hits = scope.hits.size ? { hits: [...scope.hits].sort() } : {};
    const name = outcomeName(t);
    if (ok) out.push({ name, ok, ...hits });
    else if (pending !== null) out.push({ name, ok, actual: { pending }, ...hits });
    else if (t.hidden) out.push({ name, ok, actual: { hidden: true }, ...hits }); // by name only (SPEC §8.5)
    else out.push({ name, ok, actual: { checks, failures: failures.slice(0, 8), ...(error !== null ? { threw: error } : {}), ...(law ? { law } : {}) }, ...hits });
  }
  return out;
}
