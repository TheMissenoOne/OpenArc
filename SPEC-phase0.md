# OpenArc — Phase 0 Technical Specification

**Version:** 0.5.0-draft (0.8.0 adds §2.5 concepts, §2.6 UI structure specs, §3.7 sketches, §9.6 the UI harness; 0.9.0 adds §2.7 code-first tests, §3.8 code-first regions and `openarc migrate`). Revised after self-hosting (`selfhost/WALKTHROUGH.md`) and after the stage 0 implementation (`stage0/`). · **Date:** 2026-10-31 · **Status:** for review, not implemented

The keywords MUST, MUST NOT, SHOULD, and MAY are normative. Diagnostics use the code `OARC-Exxx` (error) or `OARC-Wxxx` (warning). Section 11 lists every code.

---

## 1. Scope

| Component | v0 |
|---|---|
| Source | TypeScript ≥ 5.8, with `erasableSyntaxOnly: true`, `strict: true` |
| Spec DSL | Since 0.9.0 the main form is **code-first** (§2.7, §3.8): a function, method, getter or arrow whose whole body is `arc.todo()` is a region, tests are `arc.test`/`arc.test.hidden`/`arc.law`, and `arc.configure` and JSDoc `@arc` tags customise. Also `defineRegion<F>` (function regions), `defineBlock` (block regions); since 0.8.0 also sketches (`sketch` with `arc.hole<T>()`, §3.7), concepts (`defineConcept`, §2.5) and UI structure specs (`ui` in a `*.spec.tsx` file, §2.6) |
| Region identification | Line-comment markers + a manifest; a pending code-first region is identified by a derived id until its first commit writes markers inside its body (§3.8) |
| Ownership | Non-overlapping, nested, hash-based |
| Model backend | One Ollama instance, structured output |
| Verification | tsc, static effect/import check, developer examples in a sandbox (tiered by OS, §9.2) |
| Platforms | Linux, macOS, Windows (since 0.7.0); Node ≥ 23.6 |
| Reverse | Provenance (manifest), and `openarc extract` of whole functions (§10). Extraction of arbitrary selections is Phase 5 |
| Editor | Out of scope for this document. It consumes the manifest (§5) |

**Non-goals for v0:** operator algebra, CUE/TypeSpec, projection or virtual documents, same-region three-way merge, non-TS targets, LLM-written authoritative tests, extraction of arbitrary selections.

---

## 2. The DSL (`open-arc`)

### 2.1 Types

```ts
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type Effect =
  | "clock"   // Date, performance.now
  | "random"  // Math.random, crypto.getRandomValues / randomUUID / randomBytes
  | "log";    // console.*

export type NumberToken = "$NaN" | "$Infinity" | "$-Infinity";
// T where a number may also be a NumberToken and undefined may be "$undefined" (JSON can't write them; §9.3).
// Depth-limited (8 levels; deeper values are checked as plain T), so a recursive alias in F
// (type Nested = Array<number | Nested>) type-checks instead of failing the spec with TS2589.
export type Encoded<T> = …;

export interface Example<F extends (...a: any[]) => any> {
  name?: string;
  args: { [K in keyof Parameters<F>]: Encoded<Parameters<F>[K]> | FakeRef };
  expected: Encoded<Awaited<ReturnType<F>>>;   // compared with example equality (§9.3)
  // OR, instead of expected: the call must throw or reject; a string must appear in the error message (§9.3)
  throws: true | string;
  tolerance?: number;   // numeric tolerance for this example (§9.3)
  exact?: boolean;      // bit-exact numbers: Object.is, no tolerance (NaN still equals NaN)
}

export interface RegionSpec<F extends (...a: any[]) => any> {
  id: string;                 // §2.3
  symbol?: string;            // default: last id segment
  intent: string | string[];  // non-verifiable guidance; array form joined with single spaces [F1]
  effects?: Effect[];         // default []
  deps?: string[];            // allowed import specifiers, default []
  examples?: Example<F>[];    // authoritative tests, default []
  tolerance?: number;         // default numeric tolerance of every example, default 1e-9 (§9.3)
  refine?: "concrete" | "next"; // default "concrete"; "next" is reserved, v0 rejects it (OARC-E041)
  calls?: string[];           // allowlist of imported or port functions the body may call (§7 rule 6); default: unrestricted
  sketch?: F;                 // the body as typed code with arc.hole<T>() gaps (§3.7); read as syntax, never run
  concept?: string;           // this region is a variant of that concept (§2.5)
  fixtures?: { [name: string]: Json };  // values for the concept's "$fixture:<name>" placeholders
  waive?: { [law: string]: string };    // laws that don't apply to this variant, with the reason
  ui?: (...a: Parameters<F>) => UiNode; // a *.spec.tsx structure in the open-arc/ui vocabulary (§2.6); read as syntax
}
// intent is optional when sketch, ui or concept is present (a sketch beats an intent; hole descriptions are local
// intents; a variant has its concept's intent). Without any of them, a missing intent is E010.
// Example also has script?: UiStep[] and dom?: {text?, notText?, enabled?, disabled?} for UI regions (§9.6), and
// expected is optional when F returns unknown (a component is checked in the DOM).

export interface ConceptSpec {
  id: string;
  intent: string | string[];
  laws: { name: string; args: Json[]; expected?: Json; fakesAfter?: {[fake: string]: Json}; tolerance?: number; exact?: boolean }[];
  interface?: string;         // a type in the concept's file that every variant's F must instantiate (§2.4)
}

export interface BlockSpec {
  id: string;
  intent: string | string[];
  effects?: Effect[];
  deps?: string[];
  calls?: string[];           // as in RegionSpec
}

export function defineRegion<F extends (...a: any[]) => any>(spec: RegionSpec<F>): RegionSpec<F>;
export function defineBlock(spec: BlockSpec): BlockSpec;
export function defineConcept(spec: ConceptSpec): ConceptSpec;
export function hole<T = void>(description: string): T;  // a sketch gap (§3.7); throws if ever run
export function todo(id: string): never;    // pending FUNCTION body; throws OpenArcTodoError(id)
export function pending(id: string): void;  // pending BLOCK body; throws too, but typed void [F4]
```

Convention: import as `import * as arc from "open-arc"`. The rest of this document writes `arc.todo` and so on.

`calls` lists callee paths such as `"engine.parse"`, `"ports.fs.remove"` or `"recover"`; an entry ending in `.*` allows every path under that prefix (`"engine.*"`). It is the structural half of an intent: a block whose intent is "release the lock" can be held to `["ports.fs.remove"]`, so a body that also re-runs the pipeline is rejected before any example runs (§7 rule 6). It matters most for blocks, whose examples run through their function and often never reach them (§8.10).

At runtime, `defineRegion` and `defineBlock` return their argument unchanged. Removing them from production builds is a later build transform (not v0). Implementations MUST NOT rely on tree shaking.

### 2.2 Static evaluability

The compiler reads specs **without executing them**. A spec call MUST satisfy all of the following:

- It is the initializer of a module-scope `const` (exported or not).
- Its argument is an object literal whose values are JSON literals (strings, numbers, booleans, `null`, arrays, object literals). It has no identifiers, spreads, template expressions with substitutions, or computed keys.
- `F` is a type reference or function type literal that resolves to exactly one call signature.

Violation: `OARC-E010`. Async functions are allowed. `expected` is compared against the awaited result.

Two property values are read as **syntax** and never evaluated: `sketch` (an arrow or function expression with a block body, §3.7) and `ui` (the JSX subset of §2.6). Everything else in the object stays JSON. `defineConcept` is read by the same rules. A string `"$fixture:<name>"` anywhere in a concept law is a placeholder (§2.5). E010 details for these forms: `sketch:must-be-a-function-with-a-block-body`, `sketch:hole-<n>-description-must-be-a-string-literal`, `sketch:adjacent-statement-holes`, `ui:*` (§2.6), `concept:*`, `concept-unknown:<id>`, `fixture-missing:<name>`, `waive-unknown-law:<name>`.

### 2.3 Identifiers

```
id      = segment { "." segment }
segment = lower { lower | upper | digit }
lower   = "a".."z" ; upper = "A".."Z" ; digit = "0".."9"
```

- IDs are unique per project (`OARC-E011` on a duplicate); so are concept ids (`OARC-E011`, detail `duplicate concept id <id>`).
- An ID's **parent** is determined by marker nesting (§3), not by its dotted prefix. The prefix is convention only.
- An ID is permanent. Renaming means delete + create (§6.4).

### 2.4 Contract binding (fixes "spec doesn't constrain implementation")

For a function region with spec `defineRegion<F>` and symbol `S`, the compiler MUST check that `typeof S` is assignable to `F`. The reference mechanism type-checks an in-memory synthetic file:

```ts
import { S } from "<file>";          // or a same-file reference
type __Check = typeof S extends F ? true : never;
const __c: __Check = true;
```

Failure: `OARC-E020`. Implementations MAY use `checker.isTypeAssignableTo` instead, as long as it gives the same result. The declared type `F` is authoritative: generated code never chooses its own signature (§8.4).

A concept variant's `F` MUST be an instance of the concept's `interface` when the concept names one: `F` is a reference to that type (`Strategy<PasswordCred>` for `interface: "Strategy"`), or, for a non-generic interface, assignable to it. Failure: `OARC-E020`, detail `concept-interface:<name>`.

### 2.5 Concepts (since 0.8.0)

A **concept** is a family of function regions that share an intent and laws: `arc.defineConcept({ id, intent, laws, interface? })`. Its **variants** are ordinary regions with `concept: "<id>"`, compiled once each and used by import; a concept is never expanded into its users.

- **Laws** are example templates. Every law that a variant does not waive becomes one of its examples, named `law: <name>`, placed before the variant's own examples, with each `"$fixture:<name>"` string (anywhere in `args`, `expected` or `fakesAfter`) replaced by the variant's `fixtures[name]`: pure JSON substitution, done statically by the compiler (and by the dev runner). Laws are authoritative (tier 1, §9.1).
- **Waivers:** `waive: { "<law>": "<reason>" }` skips a law that can't apply. The reason is printed by `compile` (`<id>: law "<law>" waived: <reason>`) and stored in the manifest provenance as `waived`. A waiver of an unknown law is E010 `waive-unknown-law:<name>`; a missing fixture is E010 `fixture-missing:<name>`; an unknown concept is E010 `concept-unknown:<id>`.
- **Hashes:** a variant's spec hash includes its concept's hash (`canonicalJson` of the concept literal), so changing a law re-fingerprints every variant. A user's fingerprint includes the concept's one-line summary through its context package (§8.8), and nothing else of the concept.
- **What a model sees:** a variant's package has a `Concept` section (the concept's intent, the waived laws) and the laws as concrete examples. A region that calls a variant sees its signature plus `// variant of concept <id>: <intent> Laws: <names>.` (laws the variant waives are not listed there but as ` Waived: <names>.`), never its body or examples.

### 2.6 UI structure specs (since 0.8.0)

> **Deprecation (0.9.0).** The built-in vocabulary of `open-arc/ui` (the four words in the table below) is deprecated and frozen: it keeps working unchanged. The mechanism of this section (the `*.spec.tsx` file, the static reader and its accepted subset, the spec hash, `OARC-E092`) remains normative. Project-defined vocabularies are specified with code-first phase 5. The bundled palette (`open-arc/palette/*`, 0.8.0) is likewise deprecated and frozen; it is not part of this specification, and the mechanisms it is built from (§2.5 concepts, §3.7 sketches, this section and §9.6) remain normative.

A UI region's spec lives in a `*.spec.tsx` file under `src/` with `/** @jsxImportSource open-arc/ui */`, and has `ui: (props) => <Form …>…</Form>`. tsc checks the structure against the vocabulary in `open-arc/ui`; the compiler reads it statically into a JSON tree. The region itself is a React function component in the sibling file (`LoginPage.spec.tsx` → `LoginPage.tsx`), scaffolded there with `import type { <F> } from "./<name>.spec.tsx"`, so `F` MUST be an exported type name (E010 `ui:F-must-be-an-exported-type-name`). `react` is an allowed import of every UI region.

Accepted subset: the `ui` value is an arrow with zero or one parameter whose body is (optionally parenthesised) JSX; the root is `Form`. Children are vocabulary elements, fragments, text, `{"string"}` and `{/* comments */}`. Attributes are bare (`required` = true), string literals, `{<JSON literal>}`, or `{<ref>}` where a ref is a dotted path rooted at the parameter or an import (`{"$ref": "props.onLogin"}`). Rejected with E010: spreads (`ui:spread`), any other child expression such as `.map` or a conditional (`ui:child-expression:<text>`), computed attributes (`ui:expression:<text>`), and tags outside the vocabulary (`ui:tag:<name>`; lowercase tags are also TS errors).

| Word | Meaning (shown to the model) | Derived check (§9.6) |
|---|---|---|
| `Form title onSubmit onSuccess?` | `<form>` with a heading `title`; on submit calls onSubmit with `{ <Field name>: value }`; `ok: false` shows `error` in ErrorText; `ok: true` calls onSuccess(result) | a `<form>`; a heading (h1–h3 or legend) with the title; the wiring example |
| `Field name label type? secret? required? autoComplete?` | a labelled input (`secret` = type password) | an input whose accessible name is `label`, with that name, type, required and autocomplete |
| `ErrorText` | `role="alert"` with the last failure message | an element with `role="alert"` |
| `Submit busyText?` (text child) | `<button type="submit">` named by its text, disabled with busyText while pending | a submit button with that accessible name |

The tree (with the vocabulary version) joins the spec hash. UI regions need a DOM from the project: `"ui": { "dom": "jsdom" }` in `openarc.config.json` and `jsdom`, `react` and `react-dom` installed. Otherwise every UI region is `OARC-E092` (detail `dom:not-configured`, `dom:jsdom-missing`, `dom:react-missing`, `dom:react-dom-missing`) before any model call; there is no unverified fallback.

---

### 2.7 Code-first regions and tests (since 0.9.0)

`open-arc` adds (in `core/test.ts`, re-exported by the package root):

```ts
export function todo(id?: string): never;   // the id is optional for a code-first region (§3.8)
export function test<T extends AnyFn | Ctor>(target: T, name: string, body: (subject: T, expect: Expect, fakes: Fakes) => void | Promise<void>): void;
test.hidden = …same signature…;               // held out from the model (§8.5, §8.8)
export function law<T extends AnyFn | Ctor>(target: T, name: string, body: (subject: T, expect: Expect, gen: Gen) => void | Promise<void>,
                                          o?: { runs?: number; seed?: number }): void;   // default 50 runs, seed 1
export function configure(target: AnyFn | Ctor, config: RegionConfig): void;             // a no-op at runtime
interface RegionConfig { calls?; effects?; deps?; tolerance?; backend?; outputFormat?; examples?: Json[]; intent? }
interface Matchers<T> { toBe; toEqual(expected, { tolerance?, exact? }?); toMatch; toHaveLength; toContain; toThrow(message?); toReject(message?): Promise<void> }
interface Gen { int(lo, hi); bool(); pick(xs); string({ max?, alphabet? }?); array(item, { min?, max? }?) }
interface Fakes { of<T>(init?): T; named<T>(name, init?): T; snapshot(instance): Json }
```

**Static reading (§2.2 applies).** A test is a top-level expression statement `arc.test(…)`, `arc.test.hidden(…)` or `arc.law(…)` in any `.ts`/`.tsx` file under `src/` or `tests/` (not `tests/fakes/` or `tests/fixtures/`). The target MUST be an identifier or a property access (`C.prototype.m` narrows the test to that member), the name a string literal, the body an inline arrow or function expression, and a law's options a static JSON object; anything else is E010 (detail `test:<target|name|body|options>`). An `arc.test`/`arc.test.hidden`/`arc.law` call anywhere else (inside a block, a loop or a function) is E010 `test:not-top-level` at its line. A test that runs for a region MUST type-check: a tsc error inside its statement is E070 (detail `test:TS<code>`), reported at ANALYZE before any model call, because the sandbox strips types. Local modules a test file imports from `tests/` (helpers without tests of their own) are staged into the sandbox with it, transitively. A generated body that calls `arc.todo` (or constructs `OpenArcTodoError`) is refused (E033): its own pending outcome would otherwise read as inconclusive. `arc.configure(target, <static JSON>)` likewise (`configure:not-static`); its target MUST resolve, through the checker, to a code-first region (`configure:not-a-region:<text>`). Test bodies are never run outside the sandbox (§9.3).

**`expect`** is deterministic: `toBe` is `Object.is` except that `-0` equals `0`; `toEqual` is the example equality of §9.3 with its options; `toThrow` takes a function and `toReject` a promise, and a string must be a substring of the message (a RegExp must match it); an `OpenArcTodoError` is never an assertion failure but marks the test pending. Assertions are soft: a failed `expect` is recorded with its index and the test continues; any other exception ends the test (`threw`).

**`gen`** is mulberry32 (§9.5) seeded with `seed × 1000 + run`; every draw, including an array's length, is recorded, and a failing law reports `failed at run r/N (seed s); draws [...]`. There is no shrinking.

**Fakes by type.** `fakes.of<T>(init?)` is resolved when the test is read: the one `export default defineFake<T>(…)` in `tests/fakes/` whose `T` is the same type (by checker identity). None is E010 `fake:<T>`, two or more `fake:<T>:ambiguous` (one diagnostic per call site). `fakes.named(<file name>, init?)` is the explicit form (the name a string literal naming a file in `tests/fakes/`, else E010 `fake:named-not-static` or `fake:named:<name>`; it is preloaded like the others); `fakes.snapshot(instance)` is that instance's `snapshot()` as JSON.

**Which tests run for a region:** those whose target is the region's declaration, its class, or a class its class extends (transitively); `C.prototype.m` targets only member `m`.


### 3.1 Markers

```
begin = ws* "// @openarc:begin " id ws* EOL
end   = ws* "// @openarc:end "   id ws* EOL
```

- Markers are recognised on **single-line comment tokens only** (TypeScript scanner). Text inside strings, templates and code is never inspected, because specs' own examples routinely contain marker text. [F2]
- Each marker comment is the only non-whitespace content of its line. Any other comment containing `@openarc:` (a block comment, or a comment on a line with code) gives `OARC-W001`.
- Every `begin` MUST have a matching `end` with the same id, in the same file, and properly nested (`OARC-E030` unmatched, `OARC-E031` crossed nesting).

### 3.2 Legal positions

The lines between a `begin`/`end` pair (the **body**) MUST be exactly one of the following.

**(F) Function region.** A single top-level declaration, one of:
- `[export] [async] function S(...) {...}`
- `[export] const S = [async] (...) => ...` / `= [async] function (...) {...}`

The compiler finds its spec with `defineRegion` whose `id` equals the marker id, in any `src/` file (the same file, a file imported by it, or a `*.spec.tsx` file that nothing imports, §2.6). `S` must equal `spec.symbol` (`OARC-E021`). `src/` files are `.ts` and, since 0.8.0, `.tsx`.

**(B) Block region.** One or more complete statements, contiguous, all in the *same* block of an enclosing function body (or of a nested block). Its spec is `defineBlock` with the matching id. Block regions MUST be nested (directly or transitively) inside an (F) region (`OARC-E032`).

**(M) Code-first region** (since 0.9.0). The begin marker is the first line of a function, method, getter or arrow body block and the end marker its last line; between them is the whole statement list (§3.8).

Anything else (a partial statement, a class member outside (M), top-level non-function statements, statements from two different blocks): `OARC-E033`.

A marker id with no spec: `OARC-E012`. A spec with no markers is **pending** (§8.1 scaffolds it).

### 3.3 Nesting

- (F) regions do not nest inside other regions in v0 (`OARC-E034`).
- (B) regions nest inside (F) or (B). Siblings do not overlap (this follows from §3.1).
- The **owned text** of a region is its body minus the full text of its direct child regions, markers included.

### 3.4 Block-region restrictions (v0)

The body of a (B) region MUST NOT contain, outside any nested non-arrow function, method or class (**arrow functions are transparent** for `this`/`arguments`/`super`/`new.target`, because arrows capture them lexically [F7]):
- `return`, `yield`, `await` (unless the enclosing function is `async`, in which case `await` is allowed)
- `break`/`continue` whose target is outside the region, or labeled statements
- `this`, `arguments`, `super`, `new.target`

It MUST also NOT declare a binding (`const`/`let`/`var`/`function`/`class`) that is referenced after its `end` marker in the enclosing scope. Outputs flow only through assignments to `let` variables declared before the region.

Violation: `OARC-E035`, naming the construct.

### 3.5 Derived block contract

For each (B) region the compiler computes and records in the manifest:
- `reads`: outer bindings read inside the body, sorted, each with its printed declared type.
- `writes`: outer `let` bindings assigned inside the body, sorted, with types.

Block regions have no examples in v0. They are verified only through the examples of their enclosing (F) region (§9). The compiler MUST report this fact (`OARC-W040`: "block region verified indirectly") on every compile that touches a (B) region. If the enclosing (F) region has **zero** examples (common for effectful parents, see F6), the compiler MUST report `OARC-W041` instead: "block region has no behavioral verification".

### 3.6 Pending bodies

- A (B) region not yet implemented has the body `arc.pending("<id>");`. It MUST NOT be `arc.todo`: a `never` statement makes the rest of the parent unreachable to TypeScript's control-flow analysis, and narrowing after it fails, so a freshly scaffolded parent would fail VALIDATE (`OARC-E070`). This was found by type-checking the self-hosted compiler. [F4]
- A pending (F) region is scaffolded by the compiler as:

```ts
// @openarc:begin <id>
export const <symbol>: F = (<params from F>) => arc.todo("<id>");
// @openarc:end <id>
```

Both forms type-check. Scaffolding is deterministic and is available on its own as `openarc scaffold`. `openarc compile` scaffolds in memory **before** VALIDATE, because code that references a not-yet-scaffolded symbol cannot type-check. [F10]

A region whose body is exactly its placeholder (`arc.todo("<id>")` for (F), `arc.pending("<id>");` for (B)) is **pending**, whether or not it has a manifest entry (§6.2). [F5]

### 3.7 Sketches (since 0.8.0)

A function region's spec may carry its body as a **sketch**: `sketch: async (a, b) => { … }`, contextually typed by `F`, with `arc.hole<T>("<description>")` where the model fills in. The sketch is read as syntax and never run.

- An **expression hole** stands for exactly one expression of type `T` (written, or inferred from context). A **statement hole** (`arc.hole("…");` as a statement) stands for 0..n statements, under the §3.4 restrictions relative to the function the hole is in: no `return`, `break` or `continue` out of it, no `this`, and no declaration of a name the sketch uses after it. Two adjacent statement holes are E010 (`sketch:adjacent-statement-holes`). Holes are numbered in source order; descriptions MUST be string literals. Call it as `arc.hole`.
- The region's parameter names are the sketch's. Its body is the sketch's statements (dedented) with every hole filled; `intent` is optional.
- **VALIDATE:** tsc errors inside the sketch are reported at ANALYZE, before any model call, as `OARC-E070` with detail `sketch:TS<code>`.
- **Output (§8.4):** the model replies `{"fills": {"<n>": "<code>"}, "imports": [...]}`, constrained by a per-region schema with exactly one string per hole. The compiler splices each fill into the sketch; an expression fill is parenthesised so it can't change how the code around it parses. A reply with `body` instead of `fills` is kept as a whole body, and containment (§7 rule 7) recovers its fills or rejects it.
- **Calls:** the sketch's own calls on restricted roots (§7 rule 6: imports, and parameters whose type name ends in `Ports`) are the **implied allowlist**. Fills may call `implied ∪ spec.calls` (E098); the sketch's own code is never checked against `calls`.
- **PLAN** orders a sketch's callees (project regions it calls) before it, so its examples run against compiled callees.
- **Coverage (§8.10):** the sandbox copy carries a probe in every hole (`id#n`). A hole that no passing example reaches is unverified: `OARC-W045` (detail `hole:<id>#<n>`), the candidate is neither cached nor committed, and the region stays pending.
- **Sketch versus example (`OARC-E100`):** when an example fails and its run reached no hole, its result is decided by the developer's code (the sketch and its callees), so no fill can fix it. The compiler reports E100 (detail = the example name) and stops that region's attempts. A failure that ends in a pending callee is inconclusive, not E100.
- **Hashing:** the spec hash covers the sketch through the §4.1 normalisation (whitespace-insensitive, comments count) plus the fills-protocol version.
- A sketch never escalates to L2 (whole file); a context failure escalates to L1 at most.

Block regions stay: a block is a statement hole in developer-owned text, held by markers. A sketch puts the structure in the spec, gives expression holes and one model call per region.

### 3.8 Code-first regions (since 0.9.0)

**Discovery.** In a `src/` file that is not `*.test.ts(x)`, a declaration is a **code-first region** when it is a top-level `function` with a body, a top-level `const` bound to an arrow or function expression, or a method, get accessor or arrow-valued property of a top-level named class, and either (a) its whole body is `{ return arc.todo(…); }`, `{ arc.todo(…); }` or the arrow expression `arc.todo(…)` (it is **pending**), or (b) its body's first and last lines are the begin and end markers of one id (position **M**). A declaration that lies inside a marker pair is never code-first (a classic placeholder `export const f: F = (x) => arc.todo("id")` has the same shape). Constructors, setters, nested functions and object-literal methods are not regions.

**Contract.** The declaration's own signature, including type parameters and, for a member, `this`. A pending region MUST have an explicit return type (or, for an arrow, a typed `const`/property): otherwise `arc.todo()` infers `never` (`OARC-E022`, and the declaration is not a region).

**Intent.** The JSDoc: description, `@param`, `@returns`, `@throws`. A member without JSDoc inherits that of the same-named member of the interfaces and base classes in its heritage clause. JSDoc `@arc <key> <value>` tags configure the region (§2.7 layers below); `@arc id`, `@arc module`, `@arc backend` and `@arc outputFormat` take one word, `@arc calls|effects|deps` a list (`none` is empty). A region with no intent at all gets `OARC-W023` at PLAN.

**Ids.** `<module>[.<class>].<member>`: `<module>` is the path under `src/` without the extension or a trailing `index`, split at `/` and `.`, each segment normalised as §2.3 (or `/** @arc module <id> */` at the top of the file); `<class>` is left out when it equals the file's base name (case-insensitive), and a top-level function named like its file is not repeated. `@arc id <id>` or `arc.todo("<id>")` overrides the whole id. Two declarations with one id: E011.

**Markers inside the body.** At ANALYZE the compiler inserts, in memory only, the markers around a pending body's single statement (an expression body becomes `{ return <expr>; }`), so every later step sees an (M) region. At STAGE, a pending region that is not committed in the run gets its original text back, so a pending body is never rewritten on disk. A committed body is written between its markers as statements, indented one level inside the declaration. From then on the markers are the identity: a renamed method, class or file keeps the id; `@arc id` that disagrees with the markers is `OARC-E064` (rename explicitly by editing both).

**Layers.** A code-first region's settings come from up to three places: JSDoc `@arc` tags, `arc.configure(target, …)`, and a `defineRegion` whose `id` is the region's (it **attaches**: no second region is created, no placeholder is scaffolded, its `intent` is optional and is appended to the JSDoc, and its `F` must be mutually assignable with the declaration's type, else E020 detail `defineRegion-type`). `calls`, `effects`, `deps`, `tolerance`, `outputFormat` and `backend` MAY be set in one layer only (`OARC-E013`, detail `<field>:<layers in the order jsdoc, configure, defineRegion>`); `examples` and intents add up. `openarc.config.json` `regions[id]` still wins for `backend`, `outputFormat` and `contextLevel`. JSON examples are for top-level functions only (E010 `examples:method`) that are exported (`examples:not-exported`). A `backend` that is not configured is E010 `backend:<name>`.

**Classes.** The class shell (heritage, fields with initializers, the constructor, every member's head and JSDoc) is developer-owned; only the statements between a member's markers are the region. The code-first members of one class form a **group** that PLAN compiles in source order and §8.10 verifies jointly.

**Migration.** `openarc migrate <id>` turns one classic function region into this form (§10).

---

## 4. Hashing

### 4.1 Normalized owned text

`norm(region)` is computed as follows:
1. Take the region's body lines, each without one trailing `\r`, so a CRLF file (a Windows checkout) hashes exactly like the same file with LF on every OS. Replace each direct child region (its begin marker through its end marker) with the single line `/*«openarc-child:<id>»*/`.
2. Parse the result with `ts.createSourceFile(…, setParentNodes = true)`. Walk `node.getChildren()` depth-first, skipping JSDoc nodes. For each leaf, emit its leading comment ranges, then `leaf.getText()` if it is non-empty, then its **trailing** comment ranges. Each comment is emitted once, trimmed. `getLeadingCommentRanges` alone misses a comment on the same line as code, so editing `x = 1; // why` would not change the hash. The examples caught this in stage 0.
3. Join with U+0020.

The **raw scanner MUST NOT be used**. It doesn't rescan template continuations or regex literals, so whitespace inside `` `a ${b}   c` `` or `/a  b/` would be dropped. A semantic edit could then keep the old hash and be silently overwritten. This was verified while self-hosting. [F3] Comments count as edits; whitespace outside literals does not.

`hash(region) = "sha256:" + hex(sha256(utf8(norm(region))))`

A formatter run therefore never changes ownership. Editing a child never changes the parent's hash.

Line endings (since 0.7.0): a file whose every line ends in CRLF is held as LF in memory (markers, hashes, splicing, tsc and the sandbox all see LF) and written back with CRLF. A file with mixed endings is left byte for byte as it is.

### 4.2 Spec hash

`specHash = sha256(canonicalJson(specLiteral) + "\n" + printType(F))`. Here `canonicalJson` means sorted keys and no whitespace, and `printType` uses `checker.typeToString` with `NoTruncation`. For (B), the `printType` part is the canonical JSON of `{reads, writes}`.

For a code-first region (§3.8) the spec literal is `{id, $head, $doc, $intent, …merged layers (not backend or outputFormat), examples, $tests}`: the declaration's head with whitespace collapsed, its JSDoc as written (or inherited), an attached intent, and the source of every test that targets it (hidden ones included) preceded by the test-file constants it reads. Its `printType` part is the checker-printed signature.

Since 0.8.0 the spec literal also holds, for a sketch region, `$sketch` (the normalised sketch and the fills-protocol version, §3.7); for a UI region, `$ui` (the structure tree and the vocabulary version, §2.6); and for a concept variant, `$concept` (the concept's hash, §2.5).

### 4.3 Fingerprint (cache key)

```
fingerprint = sha256(canonicalJson({
  specHash,
  parentSpecHash,            // null for (F)
  depContracts: sorted list of printed export types of every module in spec.deps that is project-local,
  model: { name, digest },   // digest from Ollama GET /api/tags
  options: { temperature, seed, num_ctx },
  promptTemplate: "<version>",   // PROMPT_TEMPLATE_VERSION, or CODE_PROMPT_TEMPLATE_VERSION for outputFormat "code"
  outputFormat: "json" | "code", // §8.4.1
  compiler: "<openarc version>",  // COMPILER_VERSION = the version in core/package.json (the published package's version)
  typescript: "<version>"
}))
```

The implementation also hashes `context`: the hash of the stable view of the initial context package (§8.8), which shows sibling regions by signature and never by body, so committing one region does not change its siblings' fingerprints. For a code-first member the stable view includes the class shell (other members by head and JSDoc, without `implemented`/`pending` notes), a project base class's shell, and the interfaces through the type closure.

---

## 5. Manifest

Path: `.openarc/manifest.json`. It is committed to version control. It is written only in the COMMIT state (§8).

```jsonc
{
  "schema": 1,
  "regions": {
    "tasks.normalizeTitle": {
      "kind": "function",               // "function" | "block"
      "parent": null,                   // id | null
      "file": "src/tasks/create.ts",    // POSIX, relative to project root
      "symbol": "normalizeTitle",       // function regions only
      "declaration": "RoundRobin.pick", // code-first regions only (§3.8); display
      "ownership": "compiler",          // §6
      "hash": "sha256:…",               // hash at last commit
      "specHash": "sha256:…",           // spec hash at last commit
      "fingerprint": "sha256:…",        // fingerprint that produced the body; null if never generated
      "contract": null,                 // block regions: { reads:[…], writes:[…] }
      "provenance": {
        "source": "generated",          // "generated" | "extracted" | "scaffold"
        "model": "qwen2.5-coder:14b@sha256:…",
        "outputFormat": "json",          // §8.4.1
        "attempts": 2,
        "verifiedBy": ["tsc", "static", "examples:3/3"], // code-first: also "tests:<passed>/<run>[ (n inconclusive: pending regions)]", "hidden:<n>"
        "tokens": { "prompt": 4307, "completion": 982 }, // every model call that produced this body, failed attempts included (§8.4.2); absent when the backend reports none
        "at": "2026-10-31T12:00:00Z"
      }
    }
  }
}
```

The manifest contains **no** line numbers. Locations are always re-derived from markers. A tool that sees an unknown `schema` MUST refuse to write (`OARC-E050`).

Generation artifacts are cached in `.openarc/cache/<fingerprint>.json` (§8.6). The cache is not authoritative and may be deleted.

---

## 6. Ownership

### 6.1 States

| State | Meaning |
|---|---|
| `compiler` | The body is exactly what OpenArc last committed. OpenArc may regenerate it. |
| `developer` | The body was edited, or explicitly frozen. OpenArc never writes to it. |
| `conflicted` | The spec changed while the region is `developer`, or the markers are damaged. OpenArc never writes to it. |

### 6.2 Detection (run at ANALYZE on every command)

Let `h` be the current hash and `m` the manifest entry.

| Condition | Result |
|---|---|
| markers missing (with an entry) | → `conflicted` (`OARC-E062`) — checked first |
| markers under a different parent than `m.parent` | → `conflicted` (`OARC-E063`) |
| no entry, body is the placeholder | `pending` [F5] |
| no entry, any other body | `developer`, `source: "extracted"` |
| `m.ownership = compiler` and `h = m.hash` | stays `compiler` |
| `m.ownership = compiler` and `h ≠ m.hash` | → `developer` (`OARC-W060` "manual edit detected") |
| `m.ownership = developer` and current specHash ≠ `m.specHash` | → `conflicted` (`OARC-E061`) |
| `m.ownership = conflicted` | stays `conflicted` until `openarc resolve` |

Rules are evaluated top to bottom; the first match wins. The executable form of this table is `selfhost/src/ownership.ts` (`ownership.detect` examples).

### 6.3 Explicit transitions (CLI)

| Command | Effect |
|---|---|
| `openarc freeze <id>` | `compiler` → `developer` |
| `openarc release <id>` | `developer` → `compiler`. The next compile regenerates the body if the fingerprint changed. The current body is backed up to `.openarc/backup/<id>.<hash>.ts` first. |
| `openarc resolve <id> --keep` | `conflicted` → `developer`. Accepts the current body and spec, and records the new specHash. |
| `openarc resolve <id> --regen` | `conflicted` → `compiler`. Backs up the body (as `release` does), then regenerates. |
| `openarc resolve <id> --unlink` | Removes the manifest entry. Requires the markers to be gone. |

There is no implicit path from `developer` or `conflicted` to a write. This is the "never silently overwrite" guarantee.

### 6.3.1 Display state `stale`

A `compiler` region whose current specHash differs from `m.specHash`, or whose fingerprint (when computed) differs from `m.fingerprint`, is **displayed** as `stale` by `openarc graph`, `openarc inspect` (which also prints `ownership: "compiler"`) and watch status lines (§15). Its body was verified against an older spec and may fail the current examples. When its compile fails, the old body stays in the file, so GENERATE emits `OARC-W043` for it and `openarc compile` exits 1 even under `--keep-going`. `stale` is derived on every command and never stored: ownership and the transitions above are unchanged.

### 6.4 Rename

A changed id is treated as removal of the old id (`OARC-E062` until resolved with `--unlink`) plus a new region. v0 does not track renames.

Code-first regions (§3.8): while pending, the id is derived from the declaration, so renaming the method, class or file just changes it (nothing generated is lost). Once committed, the markers inside the body are the id, so renaming the declaration, the class or the file keeps it; deleting the markers is E062 as above, and an `@arc id` that differs from the markers is E064.

---

## 7. Static verification rules

Static rules are applied to the owned text of each **candidate** body, and to the whole staged program for tsc. They are best-effort. The sandbox (§9.2) is the security boundary.

1. `tsc --noEmit` on the staged program, with the project tsconfig, MUST produce zero errors (`OARC-E070`).
2. Imports: every requested import `{from, names, default?}` MUST name a specifier in `spec.deps`, `openarc`, or a module the file already imports; or be a type-only import of closure types the context package marked "not in scope", from the file that declares them (§8.8) (`OARC-E071`). Dynamic `import()` and `require` are always rejected (`OARC-E072`, `OARC-E073`); the `require` message tells the model to use `imports` instead.
3. Forbidden free identifiers, unless allowed by `effects`: `process`, `globalThis`, `global`, `window`, `self`, `eval`, `Function`, `fetch`, `XMLHttpRequest`, `WebSocket`, `Deno`, `Bun`, `setTimeout`, `setInterval`, `queueMicrotask` (`OARC-E073`).
4. Effect-gated identifiers: `Date`, `performance` need `clock`; `Math.random` and `crypto.getRandomValues`, `crypto.randomUUID`, `crypto.randomBytes` need `random`; `console` needs `log` (`OARC-E074`). Any other use of `crypto` is pure: `createHash` on `crypto` imported from `node:crypto` needs no effect. A name the file binds (its imports and top-level declarations, **plus the candidate's requested imports**) is not the global of the same name. Before 0.6.3 the requested imports were not counted, so `import crypto from "node:crypto"` requested by the model still read as the global and `hash.sha256Tagged` failed three times with `'crypto' requires effect 'random'`. The pure uses of `Date` are exempt: `Date.parse(…)`, `Date.UTC(…)`, `new Date(<at least one argument>)`, and `Date` as a type. `Date.now()` and `new Date()` with no argument read the clock and stay gated.
5. Any other capability (DB, network, filesystem, env) MUST arrive as a parameter of `F` (ports or injected dependencies). There is no effect token for it. This is what lets examples run against fakes.
6. Call allowlist, only when the spec has `calls` (§2.1). For every call expression in the body, the compiler computes the callee path from identifiers and property accesses (`engine.parse`, `ports.fs.remove`, `recover`; an element access prints as `x[]`). If the path's root identifier is **restricted**, the path MUST equal an entry of `calls` or fall under one of its `prefix.*` entries (`OARC-E098`, detail = the path; message `call not allowed by spec: <path> (allowed: …)`). Restricted roots are the file's import bindings (named, default and namespace, plus the candidate's requested imports) and the parameters of the enclosing function whose type is `Ports`; for a code-first member (§3.8), also `this.<field>` for every field whose declared type is a project interface (a port held by the instance: `@arc calls this.net.send`). Calls on locals (`diagnostics.push`, `staged.map`), on functions the body declares, and on globals (governed by rules 3 and 4) are not restricted. Only calls are checked: an alias (`const f = engine.parse; f()`) is not traced. The rule stops a model that wanders into the wrong step; the sandbox remains the security boundary. For a sketch region, the rule applies to each fill, with the implied allowlist (§3.7).
7. Containment, for sketch regions (§3.7): the candidate body MUST be the sketch with every hole replaced by some code and nothing else changed (`OARC-E099 sketch not preserved: body line <n> has … where the sketch has …`). The check walks both ASTs in parallel: an expression hole matches one expression, a statement hole 0..n statements (backtracking); every other node has the same kind and children and every token the same text, except that string literals compare by value; comments and whitespace are ignored. It yields the fills that rules 6 and §3.4 then check.

---

## 8. Compilation state machine

One `openarc compile [id…]` run is a single **transaction**. The disk stays unchanged until COMMIT.

```
PARSE → ANALYZE → VALIDATE → PLAN → ┬→ GENERATE → STATIC → SANDBOX ┬→ STAGE → COMMIT → DONE
                                    └───────── (per node, ≤ 3 attempts) ┘
any state ──error──> ABORT (no writes; diagnostics printed; exit code 1)
```

### 8.1 States

| State | Does | Fails with |
|---|---|---|
| PARSE | Load the tsconfig program, with the test files under `tests/` (§2.7). Find spec calls (§2.2) and markers (§3.1) | E010, E030, E031, W001 |
| ANALYZE (code-first) | Insert markers inside pending code-first bodies in memory, derive ids, read declarations, JSDoc, tests and `arc.configure`, merge the layers, build the static test plan (§2.7, §3.8) | E010, E011, E013, E020, E022, E064 |
| ANALYZE | Pair specs with markers. Build the region tree. Compute hashes and ownership (§6.2), block contracts (§3.5) and fingerprints | E011, E012, E021, E032–E035, E061–E063 |
| VALIDATE | Contract binding (§2.4) on the **current** code. Example typing (tsc). `refine` | E020, E041, E070 |
| PLAN | Select targets: pending regions, plus `compiler` regions whose fingerprint ≠ `m.fingerprint`, restricted to the requested ids and their descendants. Skip `developer`/`conflicted` regions with W060/E061. Order: children before parents (post-order), and a sketch's callees before it (§3.7); the members of a class in source order (§3.8). A code-first target with neither tests nor examples gets `OARC-W044` (detail `tests:0`), and one with no intent `OARC-W023`. Parents are generated with children as opaque `«openarc-child»` slots. | — |
| GENERATE | A UI region whose project has no DOM is E092 here, before any model call (§2.6). Cache lookup by fingerprint. On a miss, call the model (§8.4). An output that is not valid JSON is logged with its reason (`✗ output was not valid: <detail>`). Every failed attempt is saved (§8.11). A `compiler` region that ends without a candidate gets `OARC-W043` (§6.3.1). A connection error (`ECONNREFUSED`, `fetch failed`) is retried once after 10 s. After 3 consecutive E080s in one run, the remaining targets are skipped without calling the backend (E080, detail `stopped:3-consecutive`) | E080 (backend unreachable), E081 (schema invalid) |
| STATIC | Splice the candidate into an in-memory copy. Apply §7 | E070–E074 |
| SANDBOX | Run the examples of the enclosing (F) region(s) (§9), and for a code-first region its examples and planned tests (§9.3); for a UI region, the DOM checks of §9.6 | E090 (example failed), E091 (timeout/limit), E092 (sandbox unavailable), E100 (§3.7), W045 |
| repair | If STATIC or SANDBOX fails and attempts < 3, go back to GENERATE with a repair prompt (§8.5). Otherwise ABORT for this run. E100, E092 and a test-registry mismatch (§9.3) stop the region's attempts at once | E082 (attempts exhausted) |
| STAGE | Write every changed file to `.openarc/txn/<txid>/`, plus the new manifest. When PLAN found no targets but ownership changed (a W060 transition to `developer`, a new hand-written region), STAGE and COMMIT still run with the manifest alone, so the transition is recorded once and a later spec change is detected as E061. Write `.openarc/txn/<txid>/journal.json` listing `{target, backupOf}`. Before writing, every changed target is re-read: if it differs from the text PARSE read (the developer saved during the run), nothing is staged or committed | E093 (I/O), E096 |
| COMMIT | For each file: copy the original to the journal backup, then `rename(staged, target)`. Then rename the manifest. Delete the journal last. | — |

### 8.2 Crash recovery

At startup, every `openarc` command checks `.openarc/txn/*/journal.json`. If one exists, it restores every `backupOf` file over its target, deletes the txn directory, and emits `OARC-W094`. This makes multi-file commits all-or-nothing.

### 8.3 Concurrency

`.openarc/lock` is taken with an exclusive create (`O_EXCL`) for the whole run and holds the creator's PID. If it's held: `OARC-E095`. Before taking it, `compile`, `extract` and `watch` remove a **stale** lock, one whose PID is not a running process (`kill(pid, 0)` fails with ESRCH), with a warning. A lock without a PID is stale only once it is 10 s old.

### 8.4 Model request

Function regions: the compiler prints the signature from `F` (the parameter names and types come from the call signature). The model returns **only the statements of the body**. Block regions: the model returns the statements between the markers. Sketch regions (§3.7): the model returns `{"fills": {"<n>": "<code>"}, "imports": [...]}` under a per-region schema whose `fills` object requires exactly the hole numbers, each a string; the prompt template and system message say so, and their version is part of the sketch's spec hash.

Request: `POST {OLLAMA_HOST}/api/chat`, `stream: false`, `options: {temperature: <cfg, default 0>, seed: <cfg>, num_ctx: <cfg>, num_predict: <outputReserveTokens>}`, `format:` the JSON schema below, `keep_alive` from config. `num_predict` caps the output: without it a confused model generated for about three minutes and still returned truncated JSON. Hosted providers send the same schema in their own structured-output field (§13).

**Truncation.** A reply cut at the cap (Ollama `done_reason: "length"`, OpenAI-compatible `finish_reason: "length"`, Anthropic `stop_reason: "max_tokens"`) is retried with double the cap, up to the backend's `maxContextTokens` minus the prompt (estimated at 3.5 characters per token), and each retry is logged. A reply still cut at that ceiling goes on to `model.parseOutput` as it is. In selfhost-compile-3, `block.checkRestrictions` lost all three attempts to invalid JSON cut at 2048 tokens; the default cap is now 3072.

```json
{
  "type": "object",
  "required": ["body"],
  "additionalProperties": false,
  "properties": {
    "body":    { "type": "string" },
    "imports": { "type": "array", "items": {
      "type": "object", "required": ["from", "names"], "additionalProperties": false,
      "properties": { "from": { "type": "string" }, "names": { "type": "array", "items": { "type": "string" } },
                      "default": { "type": "string" } } } }
  }
}
```

`default` (optional) is the local name of a default import: `{from: "typescript", names: [], default: "ts"}` merges as `import ts from "typescript";`. `model.parseOutput` (a region) predates it, so the engine takes `default` out of each item before parsing and puts it back after. OpenAI strict mode lists `default` in `required` with type `["string", "null"]`; `null` means absent.

The prompt is the versioned template `PROMPT_TEMPLATE` (`src/model.ts`) filled with a **context package** (§8.8) and, on retries, a repair section (§8.5).

The compiler, not the model, merges `imports` into the file's import list after checking them against rule §7.2. Child slots in a parent body MUST appear verbatim as the line `/*«openarc-child:<id>»*/`. The compiler replaces each one with the child's current full region text. A missing or duplicated slot is `OARC-E083`.

### 8.4.1 Output format

`outputFormat` (§13; per backend, overridden per region) selects how the model returns the body. `"json"` (the default) is everything above. `"code"` asks, with the versioned template `CODE_PROMPT_TEMPLATE` (`src/output-format.ts`), for **one fenced code block**: optional `import` lines at the top, then the body statements (function regions) or the block's statements. No schema is sent (no Ollama `format`, OpenAI `response_format` or Anthropic `output_config`); the output is plain text. The context package's rules describe import lines instead of the JSON `imports` field.

The compiler parses a `"code"` reply as follows (`parseCodeOutput`):
1. `<think>…</think>` blocks are removed (an unclosed one runs to the end of the reply).
2. The first fence tagged `ts`, `typescript` or nothing is the code; fences with other tags are skipped. A fence with no closing line is `OARC-E081` `unclosed-fence` (a reply cut at the cap); fences but none of those tags is `no-ts-fence`. A reply with no fence at all is taken whole.
3. Leading import declarations become `imports`: named, default (`default`), namespace (`namespace`, merged as `import * as x from "m";`) and `import type`. A side-effect import, a rename inside braces or import attributes is `OARC-E081` `bad-import:<text>`. An import after the first statement stays in the body (and fails tsc).
4. Nothing left is `OARC-E081` `empty`.

The result is the same `{body, imports}` as a `"json"` reply and goes through exactly the same steps: unwrapping (§8.9), import rules (§7.2), write scope (§8.7), static rules and `calls` (§7), tsc, the sandbox and the coverage probe (§8.10). Truncation (§8.4) and failed attempts (§8.11) work the same way. The output format is in the fingerprint (§4.3) and `provenance.outputFormat`. It exists to measure whether code as an escaped JSON string under constrained decoding costs small models accuracy (benchmark 2026-10-31, finding 6); the default stays `"json"` until that is measured.

### 8.4.2 Token accounting

Each model call records the tokens the provider reports: Ollama `prompt_eval_count`/`eval_count`, OpenAI-compatible `usage.prompt_tokens`/`completion_tokens`, Anthropic `usage.input_tokens`/`output_tokens`, as `{prompt, completion}` (`null` when the provider reports neither). A truncated reply's retries (§8.4) are added to the same attempt. Each failed attempt records its tokens (§8.11); a generated region's `provenance.tokens` is the sum over every call this run made for it, failed attempts included, and its cache entry keeps that sum, so a cache hit reports the tokens that produced the body. `openarc inspect <id>` prints it as `tokens`.

### 8.5 Repair prompt

For a parse, type (`OARC-E070`) or static failure this is the original request plus the previous `body` plus the diagnostics (code, message, and for E090 the example name with expected and actual values, printed faithfully as in §9.3). For a failed test (§2.7): `OARC-E090 test "<name>" failed[ (<law run, seed and draws>)]:` then, per failing assertion, `line <n>: <expect(…) source>` and `got …; expected …`, and `threw: …` if it threw. A failed **hidden** test is `OARC-E090 hidden test failed: "<name>"` and nothing else: the harness never sends a hidden test's values out of the sandbox. Attempts are capped at 3 total per node per run.

At temperature 0 a small model mostly returns the same body whatever the repair prompt says (issue #19: 14 of 24 retries of a 7B were byte-identical to the previous body). So since 0.9.1 every retry varies sampling: attempt 2 is sent with temperature 0.4, later attempts with 0.7, and seed `seed + attempt − 1`; attempt 1 uses the configured sampling. An attempt that passes with varied sampling records `provenance.sampling: {temperature, seed}` and keeps it in its cache entry. Anthropic's API rejects sampling fields, so the variation doesn't reach that provider.

**Resample on behaviour (0.9.2).** When every problem of the previous attempt is an example or test failure (`OARC-E090`, `OARC-E091`), the retry is the original request plus a short note instead: `## A previous attempt failed`, the first three problems (each cut at 300 characters), and `Write a new body that passes every example and test above.` The failed body is not sent again: on a 7B, repairing with the body did no better than resampling (issue #19, ablation E), and the body's tokens were paid twice. Sampling varies as above.

**Repeat-stop (0.9.1, stricter in 0.9.2).** A reply whose body (with its imports), or whose invalid output, equals an earlier one of the same region in this run, ignoring leading and trailing whitespace (inner whitespace counts: it can sit inside a string literal), is not verified again: the attempt is recorded with the problem `repeat of an earlier attempt (not verified again)` and the region's attempts end with `OARC-E082` (detail `repeat: <the last verdict>`), even when attempts remain. On a 7B no retry after a repeat ever passed. With a `fallbackBackend` the repeat hands over to it instead (its attempts follow).

**Per-file batching (0.9.2).** With `compilation.batch: "file"` (the default), the first attempt of a function region and of its pending siblings that come later in the plan, in the same file, on the same backend and output format, with no cache hit, is ONE request. Not batched: blocks, sketches, UI regions, class members, regions with nested blocks, and a region whose `calls` names another member. The context is the sections every member has verbatim, once (their type closures merged into one `Types` section), then a `## Region <id>` section per member with the rest of its package (`###` headings), then the shared Rules. The reply is a JSON object keyed by region id, each value the §8.4 `{body, imports}` (the schema requires every id), or in `"code"` format one `### <id>` line plus one fenced block per region. Each region's part then goes through the usual normalisation, repeat check, STATIC, write-scope guards, TSC and SANDBOX, in plan order, and is committed or fails on its own; a missing entry fails only its region. Only failed regions retry, one request each (§8.5). The request counts as one model call (the first region's); its tokens are split evenly between the members' `provenance.tokens`, and each member's provenance and failed attempts record `batch: [ids]`. A package too big for the context budget, or `batch: "off"`, falls back to one request per region. `batch` is a fingerprint input. A failed batched request is the first region's `OARC-E080`.

### 8.6 Cache

`.openarc/cache/<fingerprint>.json = {body, imports, sampling?, tokens?}` is written only after SANDBOX passes. A cache hit still goes through STATIC and SANDBOX, because neighbouring code may have changed. If nothing changed, a run makes **zero** model calls.

---

### 8.7 Write scope (structural)

The model never writes files. It returns `{body, imports}` as data, and the compiler is the only writer. The following are enforced **in code, independent of any prompt**:

1. **Containment.** `body` must parse, with no syntax errors, as exactly one statement when wrapped as `async function __region() {\n<body>\n}`. A body that closes its braces to escape (`}; export const xSpec = …; function q() {`) is rejected. Markers belong to the compiler: a marker-shaped line (`// @openarc:begin …` or `// @openarc:end …`, even inside a template literal) and any comment still mentioning `@openarc:` are rejected. Before these checks the compiler **strips** every comment whose text contains `@openarc:` but is not marker-shaped (`// matches @openarc: markers`), a non-semantic normalisation it logs (`stripped n comment(s) mentioning @openarc:`); the prefix inside strings, regexes and templates is inert and kept. In selfhost-compile-3, `markers.scanMarkers` lost all three attempts to such comments. → `OARC-E097`
2. **Splice.** After splicing, every line outside the region's markers is byte-identical to before. The only exception is added import lines (`import { … } from "…"`, `import type { … } from "…"`, `import x from "…"`, `import x, { … } from "…"`), which the compiler writes for imports that passed §7.2. → `OARC-E097`
3. **Spec integrity.** At STAGE, only files under `src/` may change, never tests, fakes or core. In every changed file, the text of every `defineRegion`/`defineBlock`/`defineConcept` statement, and since 0.9.0 of every top-level `arc.test`/`arc.test.hidden`/`arc.law`/`arc.configure` statement, is byte-identical to the file on disk; test files under `tests/` are never written. → `OARC-E097` (detail `spec-integrity`), and nothing is written. A sketch and a `ui` structure are part of their spec statement, and `*.spec.tsx` files are never written by the compiler. Fills are spliced by the compiler; containment (§7 rule 7) is an extra structural check inside the region. A UI component's static checks parse the body as TSX.
4. **Examples are static.** The harness receives the examples from the compiler's static extraction (§2.2) through `harness-plan.json`, not from the module's runtime `spec.examples`. A body that mutates its spec object at runtime cannot weaken its own tests. The sandbox mounts the stage read-only.

The executable form is `selfhost/tests/write-scope.check.ts`.

### 8.8 Context packages and adaptive budgets

A region is compiled the way a unit test isolates code. The model receives a deterministic **context package** built from the type graph, never whole files by default:

| Level | Adds |
|---|---|
| L0 contract | the fixed signature; the file's import lines; the signatures of the file's other implemented top-level values (helpers, and regions that are not pending); the **type closure** of all of these (every project-local type alias or interface reachable from them, verbatim); intent, effects, allowed imports, examples, rules |
| L1 dependencies | exported value signatures of local modules the file imports or the spec lists in `deps`, plus their type closure |
| L2 source | the region's whole file |

Block regions always start at L1, plus the variables in scope (`let`/`const`/params with checker-printed types) and the enclosing function with `<<<HERE>>>`.

**Scope of closure types.** A closure type that the region's file neither declares nor imports is marked in the package (`// Side: not in scope; the compiler adds import type { Side } from "./types.ts" if you use it`). If the body names it, the compiler adds that type-only import at verify time, with the specifier relative to the file. A closure type its file doesn't export is marked `don't name it`. The rules section and §7.2 agree: names the file imports are in scope, and imports may come from `deps`, modules the file imports, or the marked types' files.

The **budget** is `(maxContextTokens − outputReserveTokens) × 3.5` characters for the selected backend (§13). Optional sections are dropped (full file first, then helpers from other modules, then same-file values, then imports) until the package fits.

Under "Allowed new imports", each package (non-relative) dep is followed by the exact import declaration the project already uses for it, most frequent value import first (e.g. `import ts from "typescript";`, which needs a default import), or by the bare specifier if the project never imports it.

**Escalation by failure type.** If attempt *n* fails with a missing name, property or export (TS2304/2305/2339/2551/2552/2724), or with the wrong import form for a module (TS2595/TS2614/TS1259/TS2497), that's a context problem, so attempt *n+1* expands one level. Any other failure is repaired at the same level, with the diagnostics. The last attempt uses `fallbackBackend` if one is configured.

If the spec has `calls`, the package has a section `Calls allowed`: "You may call exactly: …" (§7 rule 6).

Since 0.8.0:
- **Sketch regions** (§3.7): `Task` (fill the numbered holes; the rest is fixed and checked), `Sketch` (the sketch with `«n»` in place of each hole, under its printed signature) and `Holes` (one line per hole: its type or "statements", and its description) replace the fixed signature; `Calls allowed in fills` lists the implied allowlist plus `calls`; `Functions the sketch calls` lists each project function the sketch calls with its type, and for a concept variant the concept's one-line summary.
- **Concept variants** (§2.5): a `Concept` section; the laws are among the examples. **Prose regions** that import variants get `Concept variants you can call` with the same one-line summaries.
- **UI regions** (§2.6): `Structure (required; checked in the rendered DOM)` (the tree printed as TSX), `What the structure words mean` (one line per word used), and `UI rules`. Examples include their `script` and `dom`.

Since 0.9.0, **code-first regions** (§3.8): a `Task` section and a `Contract (fixed)` section replace the fixed signature: the declaration with its JSDoc in place and `<<<BODY>>>`; for a member, the whole class shell (heritage, fields, the constructor, every other member's JSDoc, own or inherited, and head, noted `implemented` or `pending: compiled jointly with this member; tests may call it`), preceded by the shell of each project base class. The type roots are the signatures and the class shell, never bodies. `Intent` is shown only for an attached or configured intent (`More intent`). After the examples, `Tests your body must pass (TypeScript, run in a sandbox)`: the module-level `const` statements of the tests' files that the shown tests read, the shown tests' source, and `// plus <n> hidden test(s), not shown`. When the package is over budget, that section is first replaced by a summary of the literal assertions (`<call> → <literal>`, `<call> throws <message>`, plus a count of the rest), before any optional section is dropped.

The hash of the initial context package's **stable view** is part of the fingerprint (§4.3). A change in any type the region depends on therefore invalidates the cache. The stable view lists every other region of the file by signature, pending or not, takes type closures from signatures only (parameter and return types, never bodies), and leaves out the level-2 full file. The prompt itself still omits pending siblings (there is nothing to call yet). Before 0.6.3 the fingerprint hashed the prompt, so committing one region added its signature to its siblings' packages and changed their fingerprints: in watch mode, compiling `text.titleCase` re-queued the just-compiled `text.slugify`.

### 8.9 Model output normalisation [F13]

Small models often return a whole function when asked for a body. If a function region's `body` parses as a single function declaration or a `const` bound to an arrow or function expression, the compiler unwraps it to the inner statements (or `return <expr>;`). Since 0.9.1 the same holds when helper statements come first (`const animals = […];` then `const verse: VerseFn = (n) => {…}`): if exactly one statement declares the region's own name with the region's parameter names and no other statement is a `return`, the result is the helpers (an `export` dropped, `export default f;` and `export { f };` removed) followed by the inner statements. Markdown fences are stripped. A reply that is a single class member (`pick(key: string): T { … }`, as a code-first region's whole method) is unwrapped to its statements too. This normalisation runs **before** the write-scope checks. A sketch region that gets a `body` instead of `fills` keeps it as a whole body; containment (§7 rule 7) recovers its fills or rejects it.

### 8.10 Joint verification of sibling blocks [F14]

Block regions are verified through their function's examples, but sibling blocks can only pass those examples together. While generating a block, an example outcome that fails only because another block is still `arc.pending` is **inconclusive**, not a failure. At STAGE, every function whose blocks were generated in this run must pass **all** its examples with every candidate applied. Otherwise the run aborts with `OARC-E090` (detail `joint:…`) and nothing is written.

A generated block is committed **only** if its function passed that joint check (or has no examples, W041) **and** a passing example reached it.

**Coverage probe.** Passing examples prove nothing about a block they return before. In selfhost-compile-3, `compile.run.unlock`, `.recover` and `.analyze` were cached as verified with bodies that re-ran the pipeline, ran a commit, and parsed twice: the only conclusive example (`lock held by another run`) returns before any of them. So whenever the sandbox runs examples for a block (its own verification and the joint check), the compiler inserts `globalThis.__openarcHit?.("<block id>")` as the first statement of each block being verified, in the **staged sandbox copy only**, never in committed text. The harness records, per passing example, the ids it hit (a `hits` field on the outcome line). Then:
- At verification, a block that no passing example reached while every example was conclusive is **unverified** (`OARC-W045`, detail `unreached:<function id>`): it is not cached and not reported as verified. If some examples were inconclusive (sibling blocks pending), the block is *provisional*: cached, logged as provisional, and decided by the joint check.
- Sketch regions get one probe per hole, `globalThis.__openarcHit?.("<id>#<n>")`, as the first part of the fill (a comma expression for an expression hole, a statement for a statement hole). A hole no passing example reaches is `OARC-W045` with detail `hole:<id>#<n>` (§3.7). The harness reports `hits` on failing outcomes too; only passing ones count as coverage, and a failing one without hits is E100.
- At the joint check, every generated block of the function must be reached by at least one passing example. Otherwise all of that function's generated blocks are held back as with W042: the unreached ones with `OARC-W045`, the others with `OARC-W042` (detail `unreached:<ids>`).

**Code-first groups** (since 0.9.0). The same rules apply to the code-first members of one class (a top-level function is a group of one): each member's verification probes every member of its group, a test that fails only on a still-pending region is inconclusive, and a member reached by no passing test or example while every outcome was conclusive is `OARC-W045` (detail `unreached:<id>`). At STAGE every group with a generated member is re-run once with all candidates in place (its tests are the union of its generated members'): a real failure is `OARC-E090` (detail `joint:<outcomes>`) and aborts the run, or under `--keep-going` holds the group back; inconclusive outcomes on regions that stay pending are tolerated; a generated member that no passing outcome reaches holds the group back (W045 for it, W042 for the others).

The fix is in the examples: `compile.run` gained one that compiles a one-region project end to end, so every block is reached. If a sibling block is still pending (it failed under `--keep-going`, or it was outside the requested ids), the joint check cannot run: the generated blocks of that function are **held back** (`OARC-W042`, detail `waiting:<function id>`) and stay pending on disk and in the manifest. Their verified bodies stay in the cache, so a later run that completes the siblings commits them without a model call. Under `--keep-going`, a failed joint check holds back that function's blocks (`OARC-E090`) instead of aborting the run.

### 8.11 Failed attempts

Every failed attempt (invalid output, STATIC, or SANDBOX failure, including a cache hit that no longer verifies) is written to `.openarc/attempts/<id>/<n>.json`: `{n, at, attempt, source?, backend, model, outputFormat, contextLevel, promptHash, sampling, tokens, body | raw, imports?, problems}` (`tokens`: §8.4.2). `n` counts up across runs; only the 20 highest are kept per region. `.openarc/.gitignore` lists `attempts/` (`openarc init` adds missing lines to an existing file). Nothing reads these files: they are for the developer.

## 9. Verification

### 9.1 Tiers

| Tier | Source | Can fail a compile |
|---|---|---|
| Authoritative | `examples` written by the developer in specs, and concept laws expanded with a variant's fixtures (§2.5); `arc.test`, `arc.test.hidden` and `arc.law` (§2.7), hidden ones included; project tests under `tests/` that are not in `tests/advisory/` | yes |
| Derived | Generated mechanically from authoritative data: the contract-binding check (§2.4); since 0.8.0 the UI structure, accessibility and wiring checks derived from a `ui` tree (§9.6) | yes |
| Advisory | Model-written tests, under `tests/advisory/` | no; reported only (`OARC-W096`) |

The compiler output MUST list exactly what was checked, for example `examples 3/3, tsc, static` (stored in `provenance.verifiedBy`). Passing means "these checks passed", not "the region is correct".

### 9.2 Sandbox

Each example run executes the staged program in a fresh process, isolated by one of these **tiers**. `sandbox.isolation` in the configuration (§13) selects it; the selection is hand-written (`src/isolation.ts`).

| Tier | Platform | Isolation | Selected by `"auto"` |
|---|---|---|---|
| `bwrap` | Linux | the argv below: namespaces, `prlimit`, Node's permission model, heap cap | when `bwrap` and `prlimit` are on `PATH` and an unprivileged user namespace actually works (probed once per process) |
| `sandbox-exec` | macOS | `sandbox-exec -p <profile>` + the Node flags below without bwrap and prlimit | on macOS |
| `node` | any | Node's permission model only | otherwise (Windows; Linux without a usable bwrap), with `OARC-W046` once per command |
| `container` | any with podman or docker | `run --rm --network=none`, stage mounted read-only at `/work` | never |
| `unsafe-none` | any | none | never; with `OARC-W047` at error level on every command |

- An explicitly configured tier that is unavailable is `OARC-E092` (detail `bwrap-unavailable`, `sandbox-exec-unavailable`, `no-podman-or-docker`) and no example runs. `"none"` is invalid configuration (`OARC-E051`); turning the sandbox off MUST be spelled `"unsafe-none"`.
- Every tier but `unsafe-none` runs `node --permission` with no grant other than `--allow-fs-read`: no `--allow-net`, `--allow-child-process`, `--allow-worker`, `--allow-addons`, `--allow-wasi` or `--allow-fs-write`, and `--max-old-space-size=<heapMb>`. Node's permission model denies network access only from v25.0.0 (when `--allow-net` was added); on Node 23.6–24 the `node` tier does not block the network, and W046 carries the detail `node-<version>:network-not-blocked`.
- `node` and `sandbox-exec`: `--allow-fs-read` is granted for the real paths of the stage, the project's `node_modules` and the targets of symlinked packages in it (`file:` deps), and for `<root>/node_modules` as spelled, because Node checks a package's `package.json` under the unresolved path when `node_modules` is itself a symlink (0.7.1). `node_modules` is not copied: module resolution walks up from the stage, which lives inside the project. The harness gets the stage path as `argv[3]`; bwrap and container mount the stage at `/work` and pass none (`.openarc/harness.mjs`: `main(process.argv[3] ?? "/work", process.argv[2])`, written into every stage by the compiler).
- `sandbox-exec` profile: `(allow default)`, then `(deny network*)`, `(deny file-write*)` except `/dev` and the temp directory, and `(deny file-read-data)` under the home directory except the stage, `node_modules`, linked packages and the Node prefix.
- `container`: `<podman|docker> run --rm --network=none --security-opt label=disable -v <stage>:/work:ro -v <root>/node_modules:/work/node_modules:ro -w /work <image> timeout -s KILL <cpuSeconds+5> node --permission --allow-fs-read=/work --max-old-space-size=<heapMb> /work/.openarc/harness.mjs <id>`. Image: `sandbox.containerImage`, default `docker.io/library/node:<host Node version>-slim`.
- Tiers without `prlimit` rely on the heap cap and the wall-clock timeout, which kills the process (`OARC-E091`); the permission model prevents child processes, so there is no tree to leave behind.
- `openarc doctor` reports the selected tier and runs one example in it that must also be refused a file write, a child process and a network request.

The `bwrap` tier:

```
bwrap --unshare-all --die-with-parent --new-session \
      --ro-bind <stage> /work --ro-bind /usr /usr --ro-bind <node-prefix> <node-prefix> \
      --symlink usr/lib64 /lib64 --symlink usr/lib /lib --symlink usr/bin /bin \
      --tmpfs /tmp --proc /proc --dev /dev \
      [--ro-bind <extra> <extra>]... --chdir /work \
  prlimit --as=<bytes ≥ 4294967296> --cpu=<sec> \
  <node-bin> --permission --allow-fs-read=/work [--allow-fs-read=<extra>]... \
       --max-old-space-size=<heapMb> /work/.openarc/harness.mjs <id>
```

`<extra>` (`SandboxConfig.extraReadPaths`, from `isolation.bwrapReadPaths`) is every real path outside the project that the project's `node_modules` leads to: `node_modules` itself when it is a symlink (a shared install), and the targets of symlinked packages (pnpm's store, `file:` deps, `npm link`). The stage's `node_modules` is a `cp -al` copy, so links in it that leave the project are rewritten as absolute links to those paths; links inside the project resolve within the stage as before. The extra binds come after `--tmpfs /tmp`, so a path under `/tmp` is not hidden by it. Before 0.7.1 such links dangled in the sandbox and every stderr line of `ERR_MODULE_NOT_FOUND` became an example failure (benchmark 2026-10-31, finding 1).

The executable form is `selfhost/src/sandbox.ts` (`sandbox.buildArgv`). The following were verified on the target machine (Fedora 43, Node v25.9.0, bwrap) [F8]:
- `<node-bin>` MUST be the **resolved** binary. A version-manager shim (asdf/nvm/volta) on `PATH` silently resolved to `/usr/bin/node` v22 inside the sandbox. `<node-prefix>` is its install prefix, bound read-only.
- `/usr` plus the `/lib64`, `/lib` and `/bin` symlinks are needed for the dynamic loader on merged-`/usr` distros.
- `prlimit --as` below 4 GiB crashes V8 at startup (it can't reserve the pointer-compression cage). Loading any `.ts` file needs **≥ 16 GiB**, because Node's type stripper (amaro) is WebAssembly and each WASM memory reserves about 10 GiB of virtual address space. The default is 32 GiB. That limit is virtual address space, not RAM: the heap is capped by `--max-old-space-size`, and `--as` is only a backstop.
- Observed results: network → `ENETUNREACH` (bwrap netns); fs write → `ERR_ACCESS_DENIED` (permission model); `process.exit(7)` in generated code → exit 7 and a truncated harness output (see §9.3).

- No `--allow-net`, `--allow-child-process`, `--allow-worker`, `--allow-addons`, `--allow-wasi`, or `--allow-fs-write`.
- Wall-clock timeout: 10 s per region (configurable).
- Node ≥ 23.6 runs `.ts` directly via type stripping. That's why `erasableSyntaxOnly` is required (§1).
- With `"isolation": "bwrap"`, a missing or unusable `bwrap` is `OARC-E092`; with `"auto"` the run falls back to the `node` tier (W046), never to unsandboxed execution. (Verified on the target machine: Node v25.9.0 with `--allow-net`, and `/usr/bin/bwrap` present.)

### 9.3 Harness

For each example, the harness decodes the value tokens `"$NaN"`, `"$Infinity"`, `"$-Infinity"` and `"$undefined"` in `args` and `expected` (fake refs are left alone), calls `S(...args)`, awaits the result, and compares it to `expected` with **example equality**: deep equality that is strict about structure (arrays, plain objects with the same own keys; anything else through `isDeepStrictEqual`), except for numbers. Two numbers match when both are NaN, or `a === b` (so `-0` equals `0`), or both are finite and `|a − b| ≤ tolerance × max(1, |a|, |b|)`, where `tolerance` is the example's, else the spec's, else `1e-9`. With `exact: true` numbers match only under `Object.is` (NaN still equals NaN). `fakesAfter` snapshots compare as JSON under the same rules. A failing outcome records `actual` with `-0`, NaN, ±Infinity and `undefined` as the tokens `"$-0"`, `"$NaN"`, `"$Infinity"`, `"$-Infinity"`, `"$undefined"`, and messages print them unquoted (`got [-0,1,NaN]`). Output on stdout is JSON lines `{name, ok, actual?}`, followed by a final `{done: n}`. A thrown error counts as a failure, with the actual result recorded as `{throws: message}`, except in a `throws` example: there the call must throw or reject (`OpenArcTodoError` still counts as pending), and a string `throws` must be a substring of the error's message. A `throws` example that returns fails with `actual: {returned: <value>}`; one whose message doesn't match fails with `{throws: message}`. `fakesAfter` is checked after the throw as usual. A run is **complete** only if the `done` line is present and `n` equals the number of outcome lines. Generated code can call `process.exit()`, so a missing `done` line counts as a failure (`OARC-E090`, detail `incomplete`) even if every printed outcome passed. [F8]

**Tests (since 0.9.0).** The harness plan entry of a code-first region carries `tests: {all, run, fakes?}`: `all` lists every test statement of every project file that has one (`{file, kind, hidden, name}`, files sorted, statements in source order), `run` the indexes of the tests selected for the regions being verified, and `fakes` the fake names to preload. The staged copy of every file with tests is rewritten, in the stage only: each `expect(x)` becomes `expect(x, <index>)` and each `fakes.of<T>(…)` gets its fake's name as the first argument. After the examples, `core/test-runner.ts` imports the files of the selected tests and compares what registered, attributed to its calling module by stack frame, with `all`: for every file that registered a test or was imported, the sequence of `{kind, hidden, name}` MUST be equal, else the single outcome `test-registry` fails (`OARC-E090` detail `test-registry:<file>: planned […], registered […]`) and the region stops. Then each selected test runs once (a law `runs` times) with the hit attribution of the coverage probe; outcome lines are named `test "<name>"` / `law "<name>"`; a failing one carries `{checks, failures: [{i, detail}] (at most 8), threw?, law?}`, a pending one `{pending: <id>}`, and a hidden one only `{hidden: true}`.

### 9.4 Fakes [F6]

An example argument may be `{"$fake": "<name>", "init"?: <Json>}`. The harness replaces it with the instance from `tests/fakes/<name>.ts`, whose default export is `defineFake<T>((init) => ({ instance, snapshot }))`. Within one example, a name denotes one instance.

`fakesAfter: { "<name>": <Json> }` compares `snapshot()` after the call. For functions returning `void`, `expected` is omitted (enforced by the type), and `fakesAfter` is the assertion.

In a code-first test, `fakes.of<T>()` resolves the fake by type and `fakes.snapshot(instance)` replaces `fakesAfter` (§2.7).

Fakes are developer-authored and authoritative (§9.1). They run inside the sandbox under the same static rules as regions. The compiler checks that `T` is assignable to the parameter type at that position.

---

### 9.5 Thin examples and differential checks

At PLAN, a function target whose examples are fewer than 3 (`OARC-W044`, detail `examples:<n>`), or of which none has an edge-case argument anywhere in its `args` (`""`, `[]`, `{}`, `0`, a negative number, `null`, or a NaN/Infinity/undefined token; detail `no-edge-case`), gets a warning. It is a syntactic heuristic and never fails a compile. A code-first target with at least one test is not checked for thin examples; one with neither tests nor examples gets detail `tests:0`.

`openarc check <id> --oracle <module>#<export>` runs a compiled function region against a reference implementation. `<module>` is a project-relative path; that one file is copied into the sandbox stage. Inputs are the argument lists of the region's examples whose values are only numbers, strings, booleans, and arrays or objects of those, followed by seeded variations (mulberry32, seed 1, 60 inputs in total, deduplicated): numbers become 0, their negation, a neighbour or a random value of similar magnitude; strings get a character inserted or deleted, become empty, upper-cased or doubled, or are swapped for another example's string at the same position; booleans flip; array elements and object values are varied in place; a top-level array changes length only when the examples' lengths differ at that position. The harness plan entry carries `oracle: {module, export, inputs}`, and the harness calls both functions on a fresh clone of each input. They agree when both return values that are equal under §9.3 (with the spec's tolerance) or when both throw. Each disagreement prints the args and both results; the command exits 1 if there is any.

### 9.6 UI harness (since 0.8.0)

> **Deprecation (0.9.0).** The derived checks of the built-in vocabulary (§2.6) are frozen with it. The harness (the module hook, the project's jsdom, one outcome per check, scripts, `dom` assertions, `action#<name>` fakes) remains normative.

For a UI region (§2.6) the harness plan entry carries the structure tree and names the component file as the module. Inside the same sandbox, `core/ui-harness.ts`:

1. registers an in-thread module load hook (`module.registerHooks`, Node ≥ 23.5; no worker) that transpiles `.tsx` with the project's TypeScript (`jsx: react-jsx`);
2. creates a jsdom document from the project's `node_modules`, installs its globals, and imports `react`, `react-dom/client` and the component;
3. reports one outcome per check: `ui: structure and accessibility` (the derived checks of the §2.6 table; elements are found by accessible name: `label[for]`, a wrapping label, `aria-label`, or a button's text), `ui: wiring` (every Field filled with a generated value, Submit clicked, the prop that `Form onSubmit` references (`props.onLogin`, or a nested path such as `props.actions.login`; the spy goes at that path) called exactly once with `{ <name>: value }`, and while that call is pending the submit button is disabled and named by `busyText` when given), then each example: render with `args[0]` as props, run `script` (`fill {label, value}`, `click {role, name}`), then check `dom.text` / `notText` (body text), `dom.enabled` / `disabled` (by role and name) and `fakesAfter`.

Fakes may sit anywhere inside the props (a function-valued prop can be `{"$fake": …}`). `"action#<name>"` is a built-in fake, named per instance: a function that records its calls and returns `init.returns[i]` on the i-th call; `snapshot()` is `{calls}`. Other names load `tests/fakes/<name before #>.ts` as usual. `verifiedBy` counts the derived checks with the examples (`examples:5/5` for two derived checks and three examples).

## 10. Reverse (Phase 0 subset)

`openarc inspect <id>` and `openarc graph` read the manifest and markers only. A region whose `provenance.source` is `"extracted"` has a spec the developer wrote, but its implementation was not generated.

**"Extract as Abstraction"** (the editor/CLI `openarc extract-region <file> <startLine> <endLine> <id>`):
1. The selection is widened to whole statements. If it does not satisfy §3.2 (B) and §3.4, the command fails with the specific diagnostic code.
2. The command inserts markers and a `defineBlock({id, intent: "TODO"})` at module scope, and records `{kind: "block", ownership: "developer", source: "extracted"}`. The body is unchanged, so no regeneration happens until `openarc release`.
3. It MAY ask the model to propose an `intent`. The proposal is written as `intent` prefixed with `"[inferred] "`, which is left for the developer to remove.

**`openarc extract <file> [--function <name>] [--id <id>] [--style code|region]`** adopts existing functions as regions. It is deterministic and never calls a model. Since 0.9.0 the CLI's default is `--style code`: for each candidate (top-level functions and arrow consts as in 1. below; generics allowed), the markers go on their own lines just inside the body block (position M, §3.8; a body whose braces don't end and start their own lines is refused), `@arc id <id>` is added to the JSDoc (a one-line JSDoc is expanded, none becomes `/** @arc id <id> */`), the id defaults to the derived id of §3.8, a function without an explicit return type (on it or on its `const`) is refused, no spec statement or import is added, and the manifest entry carries `declaration`. `--style region` is the form below.
1. Candidates are the top-level `function` declarations and `const S = (...) => ...` / `= function (...) {...}` statements of a file under `src/`: every exported one, or only `--function <name>` (exported or not). `--id` requires `--function`.
2. For each, the command writes, above the declaration (and above its JSDoc, which stays attached and outside the markers), `type <Name>Fn = <signature>;`, where the signature is printed by the type checker as a non-generic arrow type, and then `export const <name>Spec = arc.defineRegion<<Name>Fn>({ id, intent: ["[inferred] <first JSDoc line | TODO describe>"], examples: [] })`. `symbol` is added when the id's last segment differs from the function name. Markers go around the declaration lines. `import * as arc from "open-arc"` is added if missing.
3. The id defaults to `<file-stem>.<functionName>`, each segment normalised to §2.3 (separators camel-cased, leading non-letters dropped, first letter lowercased).
4. Each region is recorded as `{kind: "function", ownership: "developer", fingerprint: null, provenance: {source: "extracted"}}` with the hashes ANALYZE computes. The declaration's text is unchanged byte for byte, so nothing is regenerated until `openarc release <id>`. Editing the spec of a developer region is E061 as usual (`resolve --keep` accepts it).
5. It refuses, with a message and exit code 1: overloaded functions, generic functions (type parameters can't be expressed in a non-generic `F`), default-exported anonymous functions, class methods, declarations that share a line with other code, invalid or already-used ids, and any result that type-checks worse than the original file or fails ANALYZE.
6. It is idempotent: a declaration already inside a region is skipped. File and manifest are written in one transaction (§8.1 STAGE/COMMIT) under the lock (§8.3).

**`openarc migrate <id>`** (since 0.9.0) converts one classic function region to code-first form, in one transaction under the lock: `export const S: F = (a, b) => …` between markers becomes `[export] [async] function S(a: A, b: B): R { …markers inside… }`, with parameter and return types printed from `F` (default initializers and rest parameters kept as written; body lines re-indented, except lines inside a multiline template literal, which are kept byte for byte); the intent becomes the JSDoc with `@arc id <id>`; `calls`, `effects`, `deps`, `tolerance` and non-empty `examples` move to `arc.configure(S, {…})` after the function, through the file's `open-arc` namespace import (whatever its name; `import * as arc from "open-arc"` is added when there is none, and the migration is refused when `arc` is bound to something else); the `defineRegion` statement is removed (a type alias stays). The manifest entry keeps its id, ownership, fingerprint and provenance (plus `provenance.migrated`), with the new owned-text `hash` and `specHash` recorded, so the move is neither a hand edit (W060) nor a spec change (E061). The fingerprint hashes the model digest, which this offline command does not read, so it is not recomputed: the next online compile may find the region stale and regenerate it, verified as usual. It refuses: a region with block children, a sketch, a `ui` structure or a concept; a conflicted region; a spec export used from another file; a spec statement after its markers; and a result that type-checks worse or no longer analyzes as a code-first region.

---

## 11. Diagnostics

A diagnostic is `{code, id?, file?, line?, detail?}`. It has **no message field**; messages come from this table. `detail` is a structured token (`return`, `binding:y`, `invalid-json`, …), never prose, and absent fields are omitted rather than set to `undefined`. That keeps examples that assert diagnostics stable under deep strict equality. [F9]

| Code | Meaning |
|---|---|
| W001 | `@openarc:` text that is not a valid marker |
| E010 | spec not statically evaluable |
| E011 | duplicate region id (or concept id) |
| E012 | marker id with no spec |
| E013 | code-first region configured twice: a field set in more than one layer (§3.8; detail `<field>:<layers>`) |
| E020 | implementation not assignable to spec type F |
| E021 | declared symbol ≠ spec.symbol |
| E022 | a pending code-first region has no explicit return type (§3.8) |
| W023 | a code-first region has no intent: no JSDoc, own or inherited, and none attached (§3.8; at PLAN) |
| E030 | unmatched marker |
| E031 | crossed marker nesting |
| E032 | block region outside a function region |
| E033 | illegal region body |
| E034 | nested function region |
| E035 | unsupported construct in a block region |
| W040 | block region verified indirectly |
| W041 | block region has no behavioral verification (parent has no examples) |
| W042 | block held back: its function can't be verified until all its blocks exist (§8.10) |
| W043 | region keeps a body that does not satisfy its current spec (its compile failed; displayed `stale`, §6.3.1) |
| W044 | thin examples: fewer than 3, or none with an edge case (§9.5); `tests:0` for a code-first region with neither tests nor examples |
| W045 | block, code-first region or sketch hole unverified: no passing example or test reaches it (§8.10; detail `unreached:<function id>`, `unreached:<id>` or `hole:<id>#<n>`) |
| E041 | `refine: "next"` unsupported in v0 |
| E050 | unknown manifest schema |
| W060 | manual edit detected; region is now developer-managed |
| E061 | spec changed on a developer-managed region |
| E062 | region markers removed |
| E063 | region moved to a different parent |
| E064 | `@arc id` disagrees with the markers inside a code-first body (§3.8, §6.4) |
| E070 | type error |
| E071 | import not in `deps` |
| E072 | dynamic import / require |
| E073 | forbidden global |
| E074 | effect-gated identifier without that effect |
| E080 | model backend unreachable |
| E081 | model output does not match schema |
| E082 | repair attempts exhausted |
| E083 | child slot missing or duplicated |
| E090 | example or test failed; details `joint:<outcomes>` (§8.10), `test-registry:<…>` (§9.3) |
| E091 | sandbox timeout or resource limit |
| E092 | sandbox unavailable (the configured tier, §9.2); for UI regions, no DOM (detail `dom:not-configured`, `dom:jsdom-missing`, `dom:react-missing`, `dom:react-dom-missing`, §2.6) |
| W046 | weaker isolation: Node permission model only (no OS sandbox) |
| W047 | no sandbox: `sandbox.isolation` is `"unsafe-none"` (printed at error level on every run) |
| E093 | staging I/O error |
| W094 | recovered interrupted transaction |
| E095 | another openarc process holds the lock |
| E096 | a target file changed on disk during the run; nothing was written (§8.1 STAGE) |
| E097 | write-scope violation: generated code changed something outside its own region (§8.7) |
| E098 | call not allowed by the spec's `calls` list (§7 rule 6), or, in a sketch's fill, by the implied allowlist (§3.7) |
| E099 | sketch not preserved: the body is not the sketch with only its holes filled (§7 rule 7) |
| E100 | an example fails without reaching any hole of the sketch: the sketch decides it, so no fill can fix it (§3.7; detail = the example name) |
| W013 | block spec without markers (place them by hand) |
| E051 | invalid `openarc.config.json` |
| W096 | advisory test failed |

---

## 12. Conformance suite

Layout: `conformance/<NNN-name>/`

```
input/            project files (tsconfig.json, src/…, .openarc/manifest.json optional)
command.json      { "argv": ["compile"], "model": "stub" }
model.json        stub responses, keyed by region id, as an array per attempt
expected.json     { "exit": 1, "diagnostics": [{"code":"E035","file":"…","id":"…"}],
                    "manifest": { …expected regions, provenance.at omitted… },
                    "files": { "src/x.ts": "<sha256 of expected bytes>" } }
```

Conformant implementations MUST use the stub backend (`model.json`) for the suite. That way the results are deterministic and comparable.

Required cases (minimum):

| # | Case | Expect |
|---|---|---|
| 001 | pending (F) spec | scaffold + generate, manifest `compiler` |
| 002 | second run, nothing changed | zero model calls, files byte-identical |
| 003 | Prettier reformat of a `compiler` region | still `compiler` (§4.1) |
| 004 | comment edited in a region | → `developer`, W060 |
| 005 | child edited | child → `developer`, parent hash unchanged |
| 006 | parent spec changed, child is `developer` | parent regenerated, child bytes identical |
| 007 | spec changed on a `developer` region | E061, no writes |
| 008 | markers deleted | E062 |
| 009 | crossed markers | E031 |
| 010 | block with `return` | E035 |
| 011 | block declaring a binding used later | E035 |
| 012 | impl not assignable to F | E020 |
| 013 | generated body imports `node:fs` | E071, repaired by stub attempt 2 |
| 014 | generated body uses `process.exit` | E073 |
| 015 | example fails 3 times | E082, files byte-identical to input |
| 016 | example with infinite loop | E091 |
| 017 | journal present at start | W094, originals restored |
| 018 | spec uses an identifier in examples | E010 |
| 019 | duplicate ids across files | E011 |
| 020 | `refine: "next"` | E041 |
| 021 | a sketch filled correctly (fills reply) | committed; body = sketch with fills; every hole reached |
| 022 | a whole-body reply that keeps the sketch | fills recovered, committed |
| 023 | a whole-body reply that alters non-hole code | E099 |
| 024 | a statement hole filled with `return` | E035 (hole) |
| 025 | a fill calling an off-list port | E098 (hole) |
| 026 | a hole no example reaches | W045 `hole:<id>#<n>`, nothing committed |
| 027 | an example the sketch decides before any hole, contradicting it | E100 after one model call |
| 028 | a mistyped hole (`arc.hole<number>` where a string is needed) | E070 `sketch:TS2345`, no model call |
| 029 | a concept variant | its examples begin with the laws; a waived law is logged and in the provenance |
| 030 | a variant missing a fixture | E010 `fixture-missing:<name>` |
| 031 | a TSX spec with `.map` | E010 `ui:child-expression:…` |
| 032 | a UI region without `ui.dom` | E092 `dom:not-configured`, no model call |
| 033 | a class with two pending methods and tests that call both | compiled in source order, markers inside each body, verified jointly; the pending bodies of members not compiled are written back as written |
| 034 | a committed code-first class renamed | same ids, `compiler` state |
| 035 | a pending method without a return type | E022 |
| 036 | `@arc id` different from the markers | E064 |
| 037 | `calls` in a JSDoc tag and in `arc.configure` | E013 `calls:jsdoc,configure` |
| 038 | a test failing one of three assertions | E090 with that assertion's line and source in the repair prompt; the other two reported ok |
| 039 | a hidden test failing | the repair prompt names it, with no values or source |
| 040 | a failing law | its run, seed and draws in the repair prompt |
| 041 | `fakes.of<T>()` with no fake for `T`, and with two | E010 `fake:<T>`, `fake:<T>:ambiguous` |
| 042 | a class member no passing test reaches | W045 `unreached:<id>`, W042 for its siblings, nothing committed |
| 043 | a test registered at runtime outside the static plan | E090 `test-registry:…`, the region stops |
| 044 | `openarc migrate` of a compiler-owned region | code-first form; same id, ownership and provenance; no W060 or E061 |

---

## 13. Configuration: `openarc.config.json`

The configuration sits at the project root, like `package.json`, and selects the agent that compiles each region:

```json
{
  "version": 1,
  "backends": {
    "local": { "provider": "ollama", "model": "qwen3.5:9b", "maxContextTokens": 8192, "think": false },
    "big":   { "provider": "ollama", "model": "qwen2.5-coder:14b", "maxContextTokens": 32768 }
  },
  "compilation": {
    "defaultBackend": "local",
    "fallbackBackend": "big",
    "maxAttempts": 3,
    "context": { "initialLevel": 0, "expandOnFailure": true }
  },
  "regions": { "payments.process": { "backend": "big", "contextLevel": 2 } },
  "sandbox": { "heapMb": 512, "cpuSeconds": 20, "isolation": "auto" }
}
```

- `compilation.batch`: `"file"` (default) or `"off"`: whether a file's independent pending function regions share their first request (§8.5). Any other value is `OARC-E051`.
- `outputFormat`: `"json"` (default) or `"code"`, on a backend or in `regions.<id>` (which wins); §8.4.1. Any other value is `OARC-E051`.
- `sandbox.isolation`: `"auto"` (default), `"bwrap"`, `"sandbox-exec"`, `"node"`, `"container"` or `"unsafe-none"` (§9.2). `sandbox.containerImage` sets the container tier's image.
- Code-first (since 0.9.0) needs no configuration: module ids are derived from paths under `src/`, and test files are the `.ts`/`.tsx` files under `src/` and `tests/` (not `tests/fakes/` or `tests/fixtures/`) that call `arc.test`, `arc.law` or `arc.configure`. `regions.<id>` applies to code-first ids as to any other.
- `ui.dom`: `"jsdom"` (since 0.8.0) opts into UI regions (§2.6): their checks render components in the project's own `jsdom` (with `react` and `react-dom`), installed as devDependencies. Any other value is E051.

- `provider` is one of:
  - `"ollama"`: `POST {host}/api/chat` as in §8.4. `host` defaults to `http://127.0.0.1:11434`; `keepAlive` (default `"2m"`) is sent as `keep_alive`, so an idle model leaves RAM.
  - `"openai"`: any OpenAI-compatible Chat Completions endpoint (OpenAI, OpenRouter, Groq, LM Studio, vLLM, llama.cpp server). `POST {baseUrl}/chat/completions` (default `https://api.openai.com/v1`) with `temperature: 0`, `seed`, `max_tokens` and `response_format: {type: "json_schema", json_schema: {name: "openarc_region", strict: true, schema}}`, where `schema` is the §8.4 schema with `imports` also required (strict mode needs every property in `required`). `structuredOutput: "json_object"` is for providers without `json_schema`. Optional `headers` (e.g. OpenRouter's `HTTP-Referer`, `X-Title`).
  - `"anthropic"`: the Messages API, `POST {baseUrl}/messages` (default `https://api.anthropic.com/v1`) with headers `x-api-key` and `anthropic-version`, `max_tokens`, and `output_config: {format: {type: "json_schema", schema}}`. The text block of the reply is the `{body, imports}` JSON.
  - Presets (0.6.4), normalised to the providers above when the config is read; explicit fields always win: `"openrouter"` is `"openai"` with `baseUrl` `https://openrouter.ai/api/v1`, `apiKeyEnv` `OPENROUTER_API_KEY`, header `X-Title: OpenArc` and `structuredOutput` `json_object`. `"local"` is `"openai"` with a required `baseUrl`, no key, and `ollamaCompat` true when the URL contains `:11434`. `"openai"` defaults `apiKeyEnv` to `OPENAI_API_KEY` at OpenAI's own URL, and `"anthropic"` defaults it to `ANTHROPIC_API_KEY`. The fingerprint's backend part includes the preset, `structuredOutput` and `ollamaCompat`, so a changed preset recompiles. `openarc backends test [name]` sends one small structured request through this path and reports OK or FAIL with a reason.
  
  Every provider returns the raw `{body, imports}` text, which goes through `model.parseOutput` unchanged. With `outputFormat: "code"` no provider gets a schema field, and the raw text goes through `parseCodeOutput` (§8.4.1).
- **Keys only via env var names.** A hosted backend names its key with `apiKeyEnv` (the *name* of an environment variable). A literal `apiKey` field is invalid config (`OARC-E051`). An unset variable is `OARC-E080` with detail `missing-key:<ENV_NAME>`. The key is never printed, logged, snapshotted or put in a diagnostic.
- `maxContextTokens` sets the context budget (§8.8) for every provider; Ollama also gets it as `num_ctx`. `outputReserveTokens` (default 3072) is the output cap: Ollama gets it as `num_predict`, hosted APIs as `max_tokens`. A truncated reply is retried with double the cap (§8.4).
- `ollamaCompat` (openai provider): the endpoint is Ollama's OpenAI-compatible `/v1`. Default: true when `baseUrl` ends in `:11434/v1`. The request then also carries `keep_alive` (from `keepAlive`, default `"2m"`) and `reasoning_effort: "none"`, because that endpoint otherwise loads the model with the default keep-alive and lets a reasoning model think. Ollama ignores fields it doesn't know.
- `temperature` (default 0) and `seed` (default 1) go to Ollama and OpenAI-compatible APIs; retries vary them as in §8.5.
- `think: false` disables reasoning on Ollama reasoning models, because structured output is enough.
- The model **digest** from `/api/tags` is part of the fingerprint. If a model is re-pulled, everything it compiled goes stale. Hosted providers have no digest and the fingerprint uses `"<provider>:<baseUrl>:<model>"` without any network call. A hosted model can change silently behind its id; that is acceptable because cached bodies are re-verified on every use (§8.6).
- A backend is a bounded compilation interface: request in, `{body, imports}` out. A future adapter for a tool-using agent (Codex, Claude) MUST go through the same interface, so the compiler stays the only writer (§8.7).
- Invalid config: `OARC-E051`.

## 14. Bootstrap [F12]

1. **Stage 0** is `selfhost/` with every region body written by hand, outside OpenArc. Those regions are `developer`-owned. Its acceptance test is the self-hosted examples (`node tools/run-examples.ts --strict`: 43/43, the 24 compiler regions and the 19 palette regions). It is built into the npm package `open-arc` (`node tools/build.ts`).
2. **Stage 1:** stage 0, installed as the devDependency `openarc-stage0`, compiles a pristine `selfhost/` scaffold (`selfhost-scaffold.tgz`). Its output is `compiler`-owned regions.
3. **Stage 2:** the package built from stage 1 compiles the scaffold again, with stage 1's cache. That run must make **zero** model calls and produce a byte-identical tree and manifest (excluding `provenance.at`). Fingerprints use `COMPILER_VERSION`, not a build hash, so stages share cache keys. `COMPILER_VERSION` is read at import time from `core/package.json` (source tree) or the package's own `package.json` (published build), so every release gets new cache keys.

Stage 0 stays installed as the known-good compiler. A broken stage N is never needed to repair itself.

## 15. Watch mode

`openarc watch [--debounce <ms>]` (default 300) keeps regions compiled while the developer edits. The queue logic is the regions `watch.classifyPath`, `watch.enqueue` and `watch.takeNext`; the loop is hand-written (`src/watcher.ts`).

1. **Events.** `src/` and `tests/fakes/` are watched recursively and the project root non-recursively. Every changed path is classified by `watch.classifyPath`; an `ignore` path MUST have no effect (no analysis). A `source`, `fakes` or `config` path sets a dirty flag and (re)starts the debounce timer.
2. **Single worker.** At most one `compile.run` is in flight. Analysis MUST NOT run while a compile is in flight; it runs when the worker is idle and the flag is dirty, and once after every run (with `running` still set, so a region edited during its own run lands in `rerun`).
3. **Analysis.** PARSE + ANALYZE + PLAN as in §8.1, with fingerprints when the backend answers its digest call (§8.4, no model is loaded). If it doesn't, a `compiler` region whose `specHash` differs from the manifest is treated as stale. Every block target is replaced by its enclosing function region (blocks are only verified jointly, §8.10). Targets are queued with `watch.enqueue`, in plan order.
4. **Dispatch.** Before each `watch.takeNext`, the default backend is checked: Ollama's `/api/tags` must list the model; a hosted backend needs its `apiKeyEnv` set. On failure the worker prints one line and pauses for 5 s, 10 s, 30 s, then 60 s per retry, resetting after a success. The queue MUST NOT be dropped. A relevant change during a pause retries immediately. Each region is `compile.run(ports, {…req, ids: [id], keepGoing: true})`.
5. **Failed regions.** A run with exit 1 records the region's key: the `specHash`es of the function and its blocks, and their fingerprints (empty when unknown). The region MUST NOT be queued again while its key is unchanged (fingerprints are compared only when both are known). A `config` or `fakes` change clears all keys. A run that fails with `OARC-E080` or `OARC-E095` is not a failure: the region goes back to the front of the queue and the worker pauses as in 4. A run with `OARC-E096` (a file it would commit to was saved during the compile, typically an edit to another region of the same file) is not a failure either: the region goes back to the front of the queue **without** a pause, its key is not recorded, and the status line ends with `re-queued (file changed during compile)`. Before 0.6.3 it was recorded as failed, so a region that had passed was stranded until its own spec changed. This holds only when `OARC-E096` is the run's only error and it reported no `OARC-W045` (otherwise the run is an ordinary failure), and only while the region is still a target after the re-analysis. The third consecutive such run of a region is recorded as failed, with the status `gave up: a file it commits to changed during 3 compiles in a row (E096)`. A run that exits 0 but held back a block with `OARC-W045` is recorded as failed (status `held back: an example must reach every block (W045)`), since re-queuing it can't help until the examples change. The status line of any other failed run ends with `still pending`, or, when the run reported `OARC-W043` for the region, with `stale: keeps a body that fails the current spec` (§6.3.1).
6. **History.** Each dispatch appends `{at, id, state, ms, detail}` to `.openarc/watch-history.jsonl`, `state` ∈ `running | done | failed | requeued | interrupted` (`requeued`: E096); the file keeps its last 1000 lines. At start, a region whose last entry is `running` is reported and recorded `interrupted`. The history never decides what to compile.
7. **Signals.** The first SIGINT stops dispatch and exits after the running region (printing `finishing <id>, Ctrl+C again to abort`). The second exits immediately after removing `.openarc/lock` if this process holds it; the open transaction is recovered at the next start (§8.2). Stale locks: §8.3.

---

## Appendix A — v0 acceptance walk-through against this spec

| Step | Covered by |
|---|---|
| 1. Write a typed spec | §2.1, §2.2, §2.4 |
| 2. Compile with Ollama | §3.6 scaffold, §8, §8.4 |
| 3. Navigate spec ↔ impl | manifest §5 + markers §3 (the editor reads both; no line numbers stored) |
| 4. Edit the implementation | §6.2 → `developer`, W060 |
| 5. Extract a subregion | §10 extract-region, §3.4 restrictions |
| 6. Modify and recompile only that region | `openarc release <child>` (§6.3) → PLAN targets the child only (§8.1); parent hash is unaffected (§4.1) |
| 7. Unrelated manual edits stay byte-identical | the parent is `developer` and never written (§6.3); conformance 005/006 |
| 8. Invalid implementation rejected, source unchanged | §8 ABORT before STAGE; conformance 015 |

**Gap made explicit:** step 6 requires `openarc release` on the extracted region first. Extracted regions start as `developer` (§10.2), and per §6 OpenArc never writes a `developer` region implicitly. That's intended, not an oversight.

## Appendix B — Open questions (decide before Phase 1)

1. Spec placement for (B) regions: is module scope (current) acceptable, or should block specs live in a sidecar `*.openarc.ts`?
2. Should `tests/` (non-advisory) run in SANDBOX on every compile, or only on `openarc verify`? (Current text: authoritative, so every compile. That may be slow.)
3. Effect vocabulary: are `clock`/`random`/`log` enough, or should `env` exist as a gated token instead of being parameter-only?
4. Model choice for the Phase 1 benchmark (Ollama is not installed on this machine yet).
5. ~~[F6] Effectful regions can't have examples.~~ **Resolved:** fakes (§9.4).
6. ~~[F12] Bootstrap.~~ **Resolved:** §14.
