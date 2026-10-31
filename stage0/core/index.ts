// openarc: the runtime half of the DSL (spec §2.1).
// Hand-written bootstrap code. It is not a region, because OpenArc cannot generate itself before it exists.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type Effect = "clock" | "random" | "log";

// biome-ignore lint: `any` is required for a generic function-type constraint.
export type AnyFn = (...args: any[]) => any;

/** A developer-authored fake, resolved from tests/fakes/<$fake>.ts (spec §9.4, F6). */
export interface FakeRef {
  $fake: string;
  init?: Json;
}
/** JSON has no NaN, Infinity or undefined: in `args` and `expected` these string tokens stand for them (the harness decodes them). */
export type NumberToken = "$NaN" | "$Infinity" | "$-Infinity";
/** T, where a number may also be written as a NumberToken and undefined as "$undefined". */
export type Encoded<T, D extends 0[] = []> = D["length"] extends 8 ? T : [Json] extends [T] ? T : EncodedEach<T, D>; // Json already admits the string tokens (and recursing into it never ends)
// D counts the nesting depth. A recursive alias (`type Nested = Array<number | Nested>`) would otherwise recurse forever
// (TS2589 on the spec's own `args`). ponytail: from depth 8 on a value is checked as plain T, without the tokens.
type EncodedEach<T, D extends 0[]> = T extends number
  ? T | NumberToken
  : T extends undefined
    ? T | "$undefined"
    : T extends AnyFn
      ? T
      : T extends object
        ? { [K in keyof T]: Encoded<T[K], [...D, 0]> }
        : T;
/** Each positional argument may be a FakeRef instead of its value. */
export type FakeArgs<P extends readonly unknown[]> = { [K in keyof P]: Encoded<P[K]> | FakeRef };
/** void-returning functions are checked by side effects (fakesAfter), so they take no `expected`. `throws` replaces
 *  `expected`: the call must throw (or reject); a string must appear in the error's message. */
type Expect<F extends AnyFn> =
  | ([Awaited<ReturnType<F>>] extends [void] ? { expected?: never; throws?: never } : { expected: Encoded<Awaited<ReturnType<F>>>; throws?: never })
  | { throws: true | string; expected?: never };

export type Example<F extends AnyFn> = {
  name?: string;
  args: FakeArgs<Parameters<F>>;
  /** fake name -> expected snapshot() after the call */
  fakesAfter?: { [fake: string]: Json };
  /** numbers match when |a - b| <= tolerance * max(1, |a|, |b|); default: the spec's tolerance, else 1e-9 */
  tolerance?: number;
  /** compare numbers bit-exactly (Object.is: -0 differs from 0, no tolerance); NaN still equals NaN */
  exact?: boolean;
} & Expect<F>;

export interface RegionSpec<F extends AnyFn> {
  id: string;
  symbol?: string;
  intent: string | string[]; // array form is joined with single spaces (static, no .join call)
  effects?: Effect[];
  deps?: string[];
  examples?: Example<F>[];
  /** default numeric tolerance for every example (see Example.tolerance) */
  tolerance?: number;
  refine?: "concrete" | "next";
  /** Allowlist of imported or port functions the body may call ("engine.parse", "ports.fs.remove", "engine.*"). Absent: unrestricted. */
  calls?: string[];
}

export interface BlockSpec {
  id: string;
  intent: string | string[]; // array form is joined with single spaces (static, no .join call)
  effects?: Effect[];
  deps?: string[];
  /** Allowlist of imported or port functions the body may call ("engine.parse", "ports.fs.remove", "engine.*"). Absent: unrestricted. */
  calls?: string[];
}

export function defineRegion<F extends AnyFn>(spec: RegionSpec<F>): RegionSpec<F> {
  return spec;
}

export function defineBlock(spec: BlockSpec): BlockSpec {
  return spec;
}

export class OpenArcTodoError extends Error {
  id: string;
  constructor(id: string) {
    super(`openarc: region "${id}" is not implemented yet`);
    this.id = id;
  }
}

export function todo(id: string): never {
  throw new OpenArcTodoError(id);
}

/**
 * Placeholder for a pending BLOCK region (spec §3.6). Typed `void`, not `never`, on purpose:
 * a `never` placeholder makes the rest of the parent unreachable to TypeScript's control-flow
 * analysis, which breaks narrowing after the block and fails VALIDATE on a freshly scaffolded parent.
 * It still throws at runtime.
 */
export function pending(id: string): void {
  throw new OpenArcTodoError(id);
}

/** What a fake factory returns: the port instance plus a JSON view of its state for `fakesAfter`. */
export interface FakeInstance<T> {
  instance: T;
  snapshot(): Json;
}
export type FakeFactory<T> = (init: Json | undefined) => FakeInstance<T>;

/** `export default defineFake<FsPort>((init) => ...)` in tests/fakes/<name>.ts. The name is the file's basename. */
export function defineFake<T>(factory: FakeFactory<T>): FakeFactory<T> {
  return factory;
}
