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
      ? T | FakeRef // a function-valued field can be a fake (UI props: { $fake: "action#onLogin" })
      : T extends object
        ? { [K in keyof T]: Encoded<T[K], [...D, 0]> }
        : T;
/** Each positional argument may be a FakeRef instead of its value. */
export type FakeArgs<P extends readonly unknown[]> = { [K in keyof P]: Encoded<P[K]> | FakeRef };
/** void-returning functions are checked by side effects (fakesAfter), so they take no `expected`; nor do functions that
 *  return `unknown` (UI components, checked in the DOM). `throws` replaces `expected`: the call must throw (or reject);
 *  a string must appear in the error's message. */
type Expect<F extends AnyFn> =
  | ([Awaited<ReturnType<F>>] extends [void]
    ? { expected?: never; throws?: never }
    : unknown extends Awaited<ReturnType<F>>
      ? { expected?: Json; throws?: never }
      : { expected: Encoded<Awaited<ReturnType<F>>>; throws?: never })
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
  /** UI regions: steps run in a DOM after the component renders, elements found by accessible name */
  script?: UiStep[];
  /** UI regions: what the DOM shows after the script */
  dom?: { text?: string[]; notText?: string[]; enabled?: UiTarget[]; disabled?: UiTarget[] };
} & Expect<F>;

/** An element by role and accessible name ("button", "Sign in"). */
export type UiTarget = { role: string; name: string };
export type UiStep = { fill: { label: string; value: string } } | { click: UiTarget };
/** A UI structure tree, as the compiler reads it from `ui:` (and as the vocabulary builds it for the type checker). */
export interface UiNode {
  tag: string;
  props: { [k: string]: unknown };
  children: (UiNode | string)[];
}

export interface RegionSpec<F extends AnyFn> {
  id: string;
  symbol?: string;
  /** Required unless `sketch`, `ui` or `concept` is present (else OARC-E010). Array form is joined with single spaces (static, no .join call). */
  intent?: string | string[];
  effects?: Effect[];
  deps?: string[];
  examples?: Example<F>[];
  /** default numeric tolerance for every example (see Example.tolerance) */
  tolerance?: number;
  refine?: "concrete" | "next";
  /** Allowlist of imported or port functions the body may call ("engine.parse", "ports.fs.remove", "engine.*"). Absent: unrestricted. */
  calls?: string[];
  /** The body as typed TypeScript with `arc.hole<T>("…")` gaps. Read as syntax, never run; the model fills only the holes. */
  sketch?: F;
  /** This region is a variant of the concept with that id: the concept's laws become authoritative examples. */
  concept?: string;
  /** Values substituted for "$fixture:<name>" in the concept's laws. */
  fixtures?: { [name: string]: Json };
  /** law name -> why that law does not apply to this variant (printed and recorded in the manifest). */
  waive?: { [law: string]: string };
  /** UI regions (in a `*.spec.tsx` file): the component's rough structure in the open-arc/ui vocabulary. Read as syntax. */
  ui?: (...args: Parameters<F>) => UiNode;
}

/** A concept law: an example template. Any "$fixture:<name>" string in it is replaced by the variant's fixtures[name]. */
export interface Law {
  name: string;
  args: Json[];
  expected?: Json;
  fakesAfter?: { [fake: string]: Json };
  tolerance?: number;
  exact?: boolean;
}

/** A family of regions (variants) that share an intent and laws. Compiled once per variant, used by import. */
export interface ConceptSpec {
  id: string;
  intent: string | string[];
  laws: Law[];
  /** Optional: the name of a type (in the concept's file) that every variant's F must instantiate. */
  interface?: string;
}

export function defineConcept(spec: ConceptSpec): ConceptSpec {
  return spec;
}

/** A typed gap in a sketch. As an expression it stands for one value of type T; as a statement, for 0..n statements.
 *  Sketches are read as syntax and never run, so this only throws if called by mistake. */
export function hole<T = void>(description: string): T {
  throw new Error(`openarc: arc.hole is a sketch placeholder, not runnable code: ${description}`);
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
    super(id ? `openarc: region "${id}" is not implemented yet` : "openarc: region not implemented yet");
    this.id = id;
  }
}

/** A pending body. Classic regions pass their id; a code-first region (`{ return arc.todo(); }`) needs none: its id
 *  comes from the declaration, or from a string argument here (the same as `@arc id`). */
export function todo(id?: string): never {
  throw new OpenArcTodoError(id ?? "");
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

// Code-first assertions and the customization layer (core/test.ts).
export { test, law, configure } from "./test.ts";
export type { Ctor, Expect, Matchers, Gen, Fakes, RegionConfig, TestBody, LawBody } from "./test.ts";
