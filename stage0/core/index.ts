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
/** Each positional argument may be a FakeRef instead of its value. */
export type FakeArgs<P extends readonly unknown[]> = { [K in keyof P]: P[K] | FakeRef };
/** void-returning functions are checked by side effects (fakesAfter), so they take no `expected`. */
type Expect<F extends AnyFn> = [Awaited<ReturnType<F>>] extends [void]
  ? { expected?: never }
  : { expected: Awaited<ReturnType<F>> };

export type Example<F extends AnyFn> = {
  name?: string;
  args: FakeArgs<Parameters<F>>;
  /** fake name -> expected snapshot() after the call */
  fakesAfter?: { [fake: string]: Json };
} & Expect<F>;

export interface RegionSpec<F extends AnyFn> {
  id: string;
  symbol?: string;
  intent: string | string[]; // array form is joined with single spaces (static, no .join call)
  effects?: Effect[];
  deps?: string[];
  examples?: Example<F>[];
  refine?: "concrete" | "next";
}

export interface BlockSpec {
  id: string;
  intent: string | string[]; // array form is joined with single spaces (static, no .join call)
  effects?: Effect[];
  deps?: string[];
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
