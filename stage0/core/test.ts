// Code-first assertions (SPEC §2.7): arc.test, arc.test.hidden, arc.law and arc.configure. Hand-written bootstrap code.
// The compiler reads these calls as syntax (src/tests-plan.ts) and never runs them. Bodies run only in the sandbox,
// where core/test-runner.ts imports the test files and compares what registered here with the compiler's static plan.
// Nothing here imports node: modules, so "open-arc" stays importable from any runtime.
import type { AnyFn, Effect, Json } from "./index.ts";

// biome-ignore lint: `any` is required for a generic constructor constraint.
export type Ctor = abstract new (...args: any[]) => any;

export interface Matchers<T> {
  /** Object.is, except that -0 equals 0. */
  toBe(expected: T): void;
  /** Example equality (SPEC §9.3): deep, numbers within the tolerance (default 1e-9 relative), -0 equals 0, NaN equals NaN. */
  toEqual(expected: T, o?: { tolerance?: number; exact?: boolean }): void;
  toMatch(pattern: RegExp | string): void;
  toHaveLength(n: number): void;
  toContain(item: T extends readonly (infer E)[] ? E : T extends string ? string : never): void;
  /** `actual` is a function; it must throw (a string must appear in the message, a RegExp must match it). */
  toThrow(message?: string | RegExp): void;
  /** `actual` is a promise; it must reject. */
  toReject(message?: string | RegExp): Promise<void>;
}
export type Expect = <T>(actual: T) => Matchers<T>;

/** Seeded generator (mulberry32, as `openarc check --oracle`). Every draw is recorded so a failing law prints its inputs. */
export interface Gen {
  int(lo: number, hi: number): number;
  bool(): boolean;
  pick<T>(xs: readonly T[]): T;
  string(o?: { max?: number; alphabet?: string }): string;
  array<T>(item: (g: Gen) => T, o?: { min?: number; max?: number }): T[];
}

/** Fakes injected by type: the compiler resolves `fakes.of<T>()` to the one `defineFake<T>` in tests/fakes/ (statically). */
export interface Fakes {
  of<T>(init?: Json): T;
  /** The fake by its file name in tests/fakes/, typed by the caller. */
  named<T>(name: string, init?: Json): T;
  /** The fake's snapshot() (what `fakesAfter` compares in JSON examples). */
  snapshot(instance: object): Json;
}

export type TestBody<T> = (subject: T, expect: Expect, fakes: Fakes) => void | Promise<void>;
export type LawBody<T> = (subject: T, expect: Expect, gen: Gen) => void | Promise<void>;

/** One registered test, as the sandbox runner sees it. `file` is the module URL that called arc.test. */
export interface Registered {
  kind: "test" | "law";
  hidden: boolean;
  name: string;
  target: unknown;
  body: (subject: never, expect: Expect, extra: never) => void | Promise<void>;
  file: string;
  runs?: number;
  seed?: number;
}

const registry: Registered[] = [];
/** The runner's view. Not exported by "open-arc" itself, so a region body can't reach it. */
export const registered = (): readonly Registered[] => registry;

const self = import.meta.url;
/** The module that called arc.test: the first stack frame outside this file. */
function callerFile(): string {
  for (const line of (new Error().stack ?? "").split("\n").slice(1)) {
    const m = /(file:\/\/\/?[^\s()]+?):\d+:\d+/.exec(line);
    if (m && m[1] !== self) return m[1]!;
  }
  return "";
}

const add = (e: Omit<Registered, "file">) => void registry.push({ ...e, file: callerFile() });

/** A test of a region: `target` is the function or the class (the test gets it back as `subject`). Runs only in the sandbox. */
export function test<T extends AnyFn | Ctor>(target: T, name: string, body: TestBody<T>): void {
  add({ kind: "test", hidden: false, target, name, body: body as Registered["body"] });
}
/** Held out: it runs in every sandbox run and counts for verification, but the model never sees it; a failure is
 *  reported to the model by name only. */
test.hidden = function hidden<T extends AnyFn | Ctor>(target: T, name: string, body: TestBody<T>): void {
  add({ kind: "test", hidden: true, target, name, body: body as Registered["body"] });
};
/** A property: the body runs `runs` times (default 50) with a generator seeded from `seed` (default 1). */
export function law<T extends AnyFn | Ctor>(target: T, name: string, body: LawBody<T>, o: { runs?: number; seed?: number } = {}): void {
  add({ kind: "law", hidden: false, target, name, body: body as Registered["body"], runs: o.runs ?? 50, seed: o.seed ?? 1 });
}

/** The optional customization layer for a code-first region (SPEC §2.7). Read statically; a no-op at runtime. */
export interface RegionConfig {
  calls?: string[];
  effects?: Effect[];
  deps?: string[];
  tolerance?: number;
  backend?: string;
  outputFormat?: "json" | "code";
  /** JSON examples (SPEC §9.3), for top-level functions; they run next to the tests. */
  examples?: Json[];
  intent?: string | string[];
}
export function configure(_target: AnyFn | Ctor, _config: RegionConfig): void {}
