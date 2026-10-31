# Code-first specs: regions, assertions and UI written as TypeScript

**Status:** design proposal, for approval. Nothing here is implemented. · **Date:** 2026-10-31 · **Builds on:** `docs/design/structured-specs.md` (worktree `openarc-wt-design`) and the `palette` branch (sketches, concepts, TSX UI specs, the palette) · **Prototype:** `/tmp/claude-1000/-mnt-data-projetos/0a52dddd-ec03-4d58-8441-c8ccfe4d6411/scratchpad/code-first/` (throwaway, see §12)

## 1. Problem and goals

Today a region is a configuration object: `arc.defineRegion<F>({ id, intent, examples, … })`. The type `F` is real TypeScript, but everything else is JSON. The intent is prose in a string, the examples are JSON (`"$NaN"` tokens, `{ "$fake": … }` references, `fakesAfter` snapshots), and the function itself is a separate `export const s: F = …` between markers. A class can't be a region at all (SPEC §3.2: a class member is `OARC-E033`), so stateful code has to be bent into pure functions whose state is an argument.

The user's request: region definitions, specs and assertions should **primarily be valid TypeScript**, and writing an OpenArc program should feel like coding interfaces, prototype classes, and atomic-design templates and organisms. `defineRegion` stays, as a layer for extra customization.

The user's clarification: **don't remove the current style, and make this the main version.** So:

- Every current form stays fully supported, with no deprecation and no breaking migration: `defineRegion` with intent and JSON examples, `defineBlock` with block markers, sketches in a spec, concepts, `ui:` structure specs and the palette. Existing projects and `selfhost/` keep compiling unchanged.
- Code-first is the **main, recommended** way. The README, the wiki, `openarc init` and the examples lead with it. The other forms are presented as fully supported alternatives and as the customization layer.

Goals:

1. **The code is the spec.** A pending body in an ordinary declaration makes a region. Its signature is the contract, its JSDoc is the intent, and tests are TypeScript that tsc checks against the real class.
2. **Classes work.** Methods, getters and arrow properties can be regions. Fields and sibling members are context. State is exercised the natural way: construct, then call.
3. **Nothing is run at analysis time.** The compiler reads code-first specs with the TS AST and the checker, exactly as it reads `defineRegion` literals today (§2.2).
4. **No new trust.** The model still returns data. The write scope, the sandbox, ownership and "a hand edit is never overwritten" keep every guarantee they have.
5. **The model's job doesn't grow.** A 9B model still gets one region's context package, which now shows a class shell and test source instead of a JSON spec.

Non-goals: test generation by the model, a general test framework (watch mode, snapshots, mocks of modules), decorators, non-TS targets.

## 2. The recommendation in one table

| Feature | Recommendation | Maps onto |
|---|---|---|
| **Implicit regions** (§3) | A function, method, getter or arrow property whose whole body is `arc.todo()` is a pending region. Signature = contract (generics allowed), JSDoc = intent, id derived from the module path, class and member, with `@arc id` to override | function regions (§3.2 F), with the declaration as its own scaffold |
| **Classes** (§4) | `class X implements I` with pending members. Fields, the constructor and the other members are developer-owned context. `extends arc.implement<I>()` scaffolds every member of `I` as pending. Abstract bases carry shared helpers | new region position (M): the statement list of a body |
| **Laws over an interface** (§4.5) | `arc.law(arc.implementations<I, Args>(), "name", …)` runs against every class that implements `I`; `@arc waive "law" reason` on a class | concepts: interface, laws, fixtures, waive |
| **In-place sketches** (§4.6) | `arc.hole<T>("…")` inside an ordinary body; the compiler fills it as `arc.hole("…", <fill>)`, so the sketch stays visible after compile | sketches (palette phase A): containment E099, per-hole probes |
| **Assertions** (§5) | `arc.test(target, "name", (subject, expect, fakes) => …)`, `arc.test.hidden(…)`, `arc.law(target, "name", (subject, expect, gen) => …)`. A small deterministic `expect`; a seeded `gen`; fakes injected by type with `fakes.of<T>()`. Bodies run **only in the sandbox**; the compiler reads a static plan and a static summary | examples, fakes, fakesAfter, the coverage probe (W045) |
| **Atomic UI** (§6) | Atoms and templates are developer-written; molecules may be pending; organisms are TSX sketches with holes; pages are developer wiring plus pending adapters. UI tests use `arc.render` | `ui:` specs and the jsdom harness (palette phase C) |
| **Customization** (§7) | JSDoc `@arc` tags, `arc.configure(target, {…})`, or `defineRegion` with the region's id. A field may be set in one place only (`OARC-E013`); intents, examples and tests add up | `RegionSpec` fields, `openarc.config.json` `regions` |
| **Markers** (§8.3) | Kept: inserted **inside** the body at the first commit, around the statements | markers, hashing, splice, write scope unchanged |
| **Coexistence** (§14) | All forms supported in the same project and the same file. `openarc migrate <id>` is optional and per region | — |

The smallest valuable slice (§16, phase 1) is implicit regions for functions and class methods, plus `arc.test` with `expect`. It needs no new dependency and no new file kind.

## 3. Implicit regions

### 3.1 What is a region

```ts
/**
 * The next healthy backend in rotation, in list order, wrapping around.
 * @param key ignored: round-robin does not look at keys
 * @returns the backend id, or null when no backend is healthy
 */
pick(key: string): string | null {
  return arc.todo();
}
```

A declaration is a **pending region** when its body is exactly one of: `{ return arc.todo(); }`, `{ arc.todo(); }`, or the arrow expression body `arc.todo()`. `arc.todo` keeps today's runtime meaning (throws `OpenArcTodoError`); its id argument becomes optional (`todo(id?: string): never`). A string argument is an id override, equivalent to `@arc id`.

A declaration is a **sketch region** when its body contains `arc.hole(…)` calls (§4.6).

Eligible declarations (phase 1 in bold):

| Declaration | Region? |
|---|---|
| **top-level `function f(…): R { … }`** and **`const f = (…): R => …`** | yes |
| **class methods**, static or instance | yes |
| getters, arrow-valued class properties | yes (phase 3) |
| setters, object-literal methods | no in v1 (object literals have no stable name) |
| constructors | no: the state shape is design, and `super()` ordering makes generated constructors fragile. The developer writes them |
| nested functions | no: a region must have a stable module-level or class-level name |
| overloads | the implementation signature is the region; the overload list is shown as context |

The return type must be written: `pick(key: string) { return arc.todo(); }` infers `never`, which every caller would accept. That is a new `OARC-E022` ("a region needs an explicit return type"); the prototype reports it (§12.1). Parameter types are already required by `strict` (implicit `any` is TS7006).

### 3.2 Contract

The contract is the declaration's own signature: parameters, return type, type parameters, and for methods `this` (the class). The compiler never asks the model for a signature; it splices only a body, as today (§8.4).

- **Contract binding (§2.4)** is trivially true: there is no separate `F` to bind to. When a `defineRegion<F>` is attached (§7), `F` must be mutually assignable with the declaration's type, or `OARC-E020`.
- **Generics are allowed.** `defineRegion<F>` can't express a generic function (`openarc extract` refuses them: "its type parameters can't be expressed in the non-generic alias defineRegion<F> needs"). A code-first region simply keeps its type parameters, and the body must type-check under them.
- **`this`** is the class. The §3.4 ban on `this` is for block regions and does not apply here, since the region is the whole body.

### 3.3 Intent

The intent is the declaration's JSDoc: the description, then `@param`, `@returns` and `@throws`. A method of a class that `implements I` and has no JSDoc of its own inherits the JSDoc of `I`'s member (the prototype shows `healthy()` getting `Balancer.healthy`'s text, §12.3). Interface and class JSDoc are context for every member.

JSDoc is guidance, as `intent` is today: it is never verified, and it is printed in place in the contract (§8.5), not in a separate section.

### 3.4 Ids and renames

**Derivation.** `id = <module>[.<class>].<member>`:

- `<module>` is the file path relative to the source root, without the extension or a trailing `index`, each segment camel-cased with a lower-case first letter: `src/lb/balancer.ts` gives `lb.balancer`. A file can override it with `/** @arc module lb */` on its first statement.
- `<class>` is the class name with a lower-case first letter (`RoundRobin` gives `roundRobin`; SPEC §2.3 requires segments to start lower-case). It is omitted when it equals the file's base name, so `src/lb/RoundRobin.ts` gives `lb.roundRobin.pick`.
- A top-level function whose name equals the file's base name is not repeated: `ui/molecules/Field.tsx` gives `ui.molecules.field`.
- `@arc id <id>` (or `arc.todo("<id>")`) overrides the whole id. A collision is `OARC-E011`, as today; the fix is `@arc id`.

**Stability.** The derived id is used only while a region is pending. At the first commit the compiler writes the id into markers inside the body (§8.3), and from then on **the markers are the identity**, exactly as for every region today.

| Change | Pending region (no markers yet) | Compiled region (has markers) |
|---|---|---|
| rename the method, the class or the file; move the file | new derived id; nothing generated is lost | id kept (the markers move with the body). `openarc graph` notes the derived name differs; nothing else |
| add `@arc id` that differs from the markers | id is the tag | `OARC-E064` (new): "id in `@arc id` disagrees with the markers"; rename explicitly with `openarc rename <old> <new>` (new command, rewrites markers and the manifest in one transaction) |
| delete the declaration or its markers | gone | `OARC-E062`, as today; `openarc resolve <id> --unlink` |
| change the signature or JSDoc | it is still pending | a spec change: a `compiler` region is stale and recompiles; a `developer` region becomes `conflicted` (`OARC-E061`) |

Tests, laws and `arc.configure` name their target by **expression** (`RoundRobin`, `hash32`, `RoundRobin.prototype.pick`), so an editor's rename refactoring updates them. Only `defineRegion({ id })` names a region by string, and that id is stable because the markers are.

## 4. Interfaces and prototype classes

### 4.1 Classes with pending members

```ts
export class RoundRobin implements Balancer {
  readonly backends: Backend[];
  /** Position in healthy() of the next pick. */
  next = 0;

  constructor(backends: Backend[]) {
    this.backends = backends.map((b) => ({ ...b }));
  }

  healthy(): Backend[] {                 // concrete: developer-written, visible to the model
    return this.backends.filter((b) => b.healthy);
  }

  pick(key: string): string | null {     // region lb.roundRobin.pick
    return arc.todo();
  }

  /** @throws Error "unknown backend <id>" when no backend has that id */
  markDown(id: string): void {           // region lb.roundRobin.markDown
    return arc.todo();
  }
}
```

- Each pending member is a region. The class **shell** (the heritage clause, fields with their initializers, the constructor, every member's signature and JSDoc) is developer-owned and is the region's context.
- Concrete siblings are shown by signature and JSDoc; pending siblings by signature, marked pending.
- `erasableSyntaxOnly` (SPEC §1) rules out parameter properties (`constructor(private x: X)`), so fields are declared and assigned explicitly. That's also clearer context for the model.

**Verification of several members.** Tests construct the class and call several members, so members of one class are verified together, like sibling blocks (§8.10). PLAN compiles a class's pending members in source order. A test that reaches a member that is still pending is inconclusive. Before commit, all generated members of the class are re-verified jointly (the W042 machinery), and each must be reached by a passing test (W045, §5.5).

### 4.2 State: construct, then call

A JSON example can't build an instance and then make a sequence of calls. A test does it directly:

```ts
arc.test(RoundRobin, "markDown skips the backend and keeps the position", (RR, expect) => {
  const rr = new RR(three);               // constructor arguments
  expect(rr.pick("x")).toBe("a");         // then a sequence of calls
  rr.markDown("b");
  expect(rr.pick("x")).toBe("c");
  expect(rr.healthy().map((b) => b.id)).toEqual(["a", "c"]);
});
```

So methods are verified by tests, not JSON examples. `arc.configure(m, { examples })` on an instance method is `OARC-E010` (detail `examples:method`); on a function or a static method it works as today.

### 4.3 `arc.implement<I>()`: a class from an interface

```ts
/** In-memory UserStore for tests and demos. */
export class MemoryUsers extends arc.implement<UserStore>() {
  users: User[] = [];
}
```

`arc.implement<I>()` is typed `new () => I`, so the class type-checks as an `I` immediately, and callers can use it. It's a scaffold request: `openarc scaffold` (and `openarc compile`, in memory, before VALIDATE, as §3.6 already does for pending function regions) rewrites the heritage to `implements I` and adds every member of `I` as a pending method. The prototype does this with **TypeScript's own "implement interface" code fix** (`fixClassIncorrectlyImplementsInterface`), then replaces its `throw new Error("Method not implemented.")` with `return arc.todo();` (§12.5):

```ts
export class MemoryUsers implements UserStore {
  findByEmail(email: string): Promise<User | null> {
    return arc.todo();
  }
  save(user: User): Promise<void> {
    return arc.todo();
  }
  users: User[] = [];
}
```

Interface JSDoc flows to the scaffolded members through inheritance (§3.3), so `I`'s documentation is the intent of every implementation. The member order is TypeScript's; a developer can reorder the scaffolded members freely before the first compile.

### 4.4 Abstract classes

```ts
export abstract class Strategy implements Balancer {
  readonly backends: Backend[];
  constructor(backends: Backend[]) { this.backends = backends.map((b) => ({ ...b })); }
  /** The healthy backends, in list order. */
  protected healthy(): Backend[] { return this.backends.filter((b) => b.healthy); }
  markDown(id: string): void { /* concrete */ }
  abstract pick(key: string): string | null;
}

export class RoundRobin extends Strategy {
  next = 0;
  /** The next healthy backend in list order, wrapping around. Keys are ignored. */
  pick(key: string): string | null { return arc.todo(); }
}
```

An abstract member has no body and is not a region; its overrides are. A concrete base member is context for every subclass region (signature and JSDoc, shown as "inherited, implemented"). A pending member in an abstract class is a region too, which gives the template-method pattern for free: the base's concrete `pick` calls a pending `score()`, and each subclass's `score()` is a region.

### 4.5 Interfaces as concepts: laws over implementations

A concept today is `defineConcept({ id, interface, intent, laws })`, with variants that name it and supply `fixtures` and `waive`. The code-first form uses what TypeScript already has:

| Concept part | Code-first form |
|---|---|
| interface | a TS `interface` |
| intent | the interface's JSDoc |
| variants | the classes that `implements` it (found statically with the checker) |
| laws | `arc.law(arc.implementations<I, Args>(), "name", (Impl, expect, gen) => …)` |
| fixtures | the law builds its own inputs (`gen`, or consts in the test file); `Args` is the constructor's parameter list |
| `waive` | `@arc waive "<law name>" <reason>` in the class's JSDoc |

```ts
arc.law(arc.implementations<Balancer, [Backend[]]>(), "pick is null exactly when nothing is healthy", (Impl, expect, gen) => {
  let n = 0;
  const backends = gen.array((g) => ({ id: `b${n++}`, healthy: g.bool(), weight: 1 }), { max: 5 });
  expect(new Impl(backends).pick(gen.string()) === null).toBe(!backends.some((b) => b.healthy));
});

/**
 * A hash ring …
 * @arc waive "equal backends share requests evenly" hashing pins each key to a backend, so the spread is statistical
 */
export class ConsistentHash implements Balancer { … }
```

`Impl` is typed `new (...a: Args) => I`. A class that implements `I` but whose constructor doesn't accept `Args` is `OARC-E010` (detail `law:constructor:<class>`) unless it waives the law. Waivers are printed and recorded in provenance, as concept waivers are today. The prototype runs both laws against `RoundRobin` and `ConsistentHash` and skips the waived one (§12.2).

`defineConcept` remains fully supported (§14); the two forms can coexist in one project.

### 4.6 In-place sketches

The palette's sketches live inside the spec (`defineRegion({ sketch })`), and the generated body is a second copy. The structured-specs design rejected holes in place (its S2) for two reasons: expression holes would need inline markers, and after the first compile the sketch would be gone from the file. Code-first sketches solve both without markers by **keeping the hole call and adding the fill as its second argument**:

```ts
// as written (sketch)
const h = hash32(key);
return arc.hole<string>("the id of the first ring entry with at >= h, else ring[0].id");

// as committed: the sketch is still readable; the fill is the second argument
return arc.hole<string>("the id of the first ring entry with at >= h, else ring[0].id", ((ring.find((e) => e.at >= h) ?? ring[0]!).id));
```

- `arc.hole(description, fill)` returns `fill`, so the committed code runs the fill; the cost is one function call per hole.
- The **sketch view** of a body is the body with every hole's second argument removed. Containment (`OARC-E099`) becomes a simple comparison: the sketch view of a candidate must equal the sketch the developer wrote (prototype: `true` for the fill, `false` after a change outside the hole, §12.2).
- Expression holes and function-valued holes work as in the palette (prototype: a JSX attribute hole of type `(e: FormEvent) => Promise<void>` and a JSX child hole of type `string`, §12.4).
- **Statement holes** use a distinct call, `arc.step("…");` (or `await arc.step("…");` in async code), filled as `arc.step("…", () => { … })` / `await arc.step("…", async () => { … })`. The §3.4 restrictions apply (no `return`, `break` or `continue` out of it; no declaration used after it), so the arrow wrapper doesn't change meaning except for one extra microtask in the async form. Not prototyped.
- `defineRegion({ sketch })` stays supported for anyone who prefers the sketch in a spec.

Ownership of an in-place sketch has two parts: the skeleton is the developer's, the fills are the compiler's (§8.4).

## 5. Assertions as TypeScript

### 5.1 The API

```ts
export function test<T extends AnyFn | Ctor>(target: T, name: string, body: (subject: T, expect: Expect, fakes: Fakes) => void | Promise<void>): void;
test.hidden = …same signature…;   // held out from the model (§5.4)
export function law<T extends AnyFn | Ctor>(target: T | Family<T>, name: string, body: (subject: T, expect: Expect, gen: Gen) => void | Promise<void>,
                                          o?: { runs?: number; seed?: number }): void;   // default 50 runs, seed 1
export function implementations<I, A extends unknown[] = []>(): Family<new (...a: A) => I>;

interface Matchers<T> {
  toBe(expected: T): void;                                        // Object.is, except -0 equals 0 (as §9.3)
  toEqual(expected: T, o?: { tolerance?: number; exact?: boolean }): void;   // §9.3 example equality
  toMatch(pattern: RegExp | string): void;
  toHaveLength(n: number): void;
  toContain(item: …): void;
  toThrow(message?: string | RegExp): void;                       // actual is a function
  toReject(message?: string | RegExp): Promise<void>;             // actual is a promise
}
interface Gen { int(lo, hi): number; bool(): boolean; pick<T>(xs: T[]): T; string(o?: { max?; alphabet? }): string; array<T>(item: (g: Gen) => T, o?: { min?; max? }): T[] }
interface Fakes { of<T>(init?: Json): T; snapshot(instance: object): Json }
```

- **Typed against the real code.** `subject` is the target itself: the function, or the class (so `new RR(…)`). `expect<T>(actual: T)` types the expected value by the actual one. The prototype's tsc catches `rr.pick(1)` (TS2345), `toBe(1)` on a `string | null` result (TS2345) and a misspelled method (TS2551) in the test file, before anything runs (§12.2). JSON examples get this only through the `Encoded<T>` type, and not at all for state.
- **Deterministic by construction.** No timers, no snapshots on disk, no module mocking, no `only`/`skip`, no retries. Equality is the harness's example equality (§9.3), so tolerance, `-0`, `NaN` and the faithful failure printing work exactly as for JSON examples. `gen` is the mulberry32 PRNG that `openarc check --oracle` already uses (§9.5), seeded per run, and every draw is recorded so a failing law prints its inputs (prototype: `failed at run 6/50 (seed 1); draws [false,false,"ycba "]`). There is no shrinking (phase later, if needed).
- **Soft assertions.** A failed `expect` is recorded and the test continues, so one run reports every failing assertion with its source text and line. An exception other than an assertion ends the test (`threw: …`); `OpenArcTodoError` marks it pending, as today.
- **Fakes injected by type.** `fakes.of<Transport>()` is resolved **statically**: the compiler finds the one `defineFake<T>` in `tests/fakes/` whose `T` is the same type, and rewrites the call in the staged sandbox copy to name it (`fakes.of("net.memory")`). None, or more than one, is `OARC-E010` (detail `fake:<type>`); `fakes.named("<name>", init)` is the explicit form. `fakes.snapshot(instance)` is the fake's snapshot, which replaces `fakesAfter`. Fakes stay authoritative and developer-written (Fakes wiki).

### 5.2 Where test bodies run

**Only in the sandbox, never at analysis time.** Tests import the module under test, which contains generated code, so running them anywhere else would break the safety model's rule 3. The compiler reads them as syntax:

- A test is a top-level expression statement `arc.test(…)`, `arc.test.hidden(…)` or `arc.law(…)` in any project file (`src/` or `tests/`). The target must be an identifier, a property access (`RoundRobin.prototype.pick`) or `arc.implementations<…>()`; the name a string literal; the body an arrow or function expression written inline. Anything else is `OARC-E010` (detail `test:<what>`).
- From this the compiler builds the **static test plan**: per test, its file, index, kind, name, hidden flag, target, the regions it targets, its assertion count and source spans, and its fakes. The plan goes into `harness-plan.json` next to the examples (new field `tests`).
- In the stage, the harness imports the test files, and the module-private registry in `open-arc` collects the registered tests. The harness **refuses a registry that differs from the static plan** (count, order, names, hidden flags: `OARC-E090` detail `test-registry`). A body can't import the registry: the internal entry point is a subpath (`open-arc/harness`), and §7 rule 2 allows a body to import only `"openarc"`, its `deps` and the file's own imports.
- Probes and assertion indexes are inserted in the staged copy only, never in committed text, as the coverage probe is today (§8.10).

Tests are developer-written and authoritative (tier 1, §9.1), like fakes. They run under the same sandbox as everything else; `arc.render` (§6) adds the DOM from the project's devDependencies, as palette phase C does.

### 5.3 What the model sees: test source, and a static summary

The context package shows the **source of the shown tests** that target the region's function or class, plus the test-file consts they read (the prototype prints `const three: Backend[] = …` before the tests, §12.3). Tests are code, they're compact, and a 9B model reads code better than a JSON encoding of it. They also carry what JSON can't: the construct-then-call sequence.

The compiler also extracts a **static summary** from the simple assertions, without executing anything: `expect(<call with literal args>).toBe|toEqual(<literal>)` becomes `call → value`, and `expect(() => <call>).toThrow("m")` becomes `call throws "m"`:

```
[lb.ringHash] h("") → 2872998923
[lb.roundRobin.pick,lb.roundRobin.markDown] new RR([]).pick("k") → null
[lb.roundRobin.pick,lb.roundRobin.markDown] new RR(three).markDown("z") throws "unknown backend z"
[lb.roundRobin.pick,lb.roundRobin.markDown] rr.pick("x") → "a"
```

The last line shows the summary's limit: without the test's setup, `rr.pick("x") → "a"` means nothing. So the summary is **not** the primary prompt form. It's used for:

1. **`OARC-W044` (thin examples):** the assertion count, and edge-case detection on the literal arguments (`""`, `[]`, `0`, negative numbers, `null`).
2. **`openarc check --oracle` seeds** for function regions: the summarized argument lists are the inputs it varies.
3. **The package under budget pressure:** when the test source doesn't fit, the summary replaces it before any other section is dropped.
4. `openarc graph` and `inspect`.

### 5.4 Shown and held-out tests

`arc.test.hidden(target, name, body)` is a test the model never sees:

- It's excluded from the context package and from the summary. The package says only `// plus N hidden test(s), not shown`.
- It runs in every sandbox run and counts for verification and coverage.
- When it fails, the repair prompt says `hidden test failed: "<name>"`, with no values and no source. The name is developer-chosen, so it can be neutral. Prototype output: `pass [hidden] fair over 300 picks`.
- Its source is in the region's spec hash, like everything else that can fail a compile.

This is the guard against overfitting to the shown tests, which JSON examples can't express today (every example is shown).

### 5.5 Coverage, fakes and the harness

- **Coverage (W045).** Each region gets a probe at the start of its body, and each hole one inside its fill (as the palette does). A region verified by tests must be reached by at least one passing test; otherwise it is unverified (`OARC-W045`, detail `unreached:<id>`) and not cached as verified. The prototype shows this with the two `markDown` tests removed: `lb.roundRobin.markDown: OARC-W045 unreached by any passing test` (§12.2). Hits through callers count: `lb.ringHash` is reached by the `ConsistentHash` test and the family laws as well as its own.
- **Which tests run for a region:** every test whose target is the region, its class, a class it extends, or `arc.implementations<I>()` for an interface its class implements. Tests elsewhere that happen to reach it are not run for it (they run for their own targets).
- **A region with no test and no example** gets `OARC-W044` (detail `tests:0`), as a function region with no examples does today. It's verified by tsc and the static rules only.
- **Repair prompts** list each failing assertion: the test name, the assertion's source and line, and `got …; expected …`, printed as §9.3 prints values. The prototype's runner produces exactly these lines (`FAIL line 12: expect(rr.pick("x")).toBe("a") / got "b"; expected "a"`).

### 5.6 JSON examples keep working

`defineRegion({ examples })` is unchanged. A code-first function region can also take JSON examples through `arc.configure(fn, { examples: [...] })`; the prototype runs `lb.ringHash`'s two JSON examples next to its tests (`json examples (arc.configure on lb.ringHash): 2/2`). Both kinds run in the same sandbox run and both count for verification.

## 6. Atomic design for UI

| Level | Who writes it | Region? | Verified by |
|---|---|---|---|
| **atom** (`Button`, `TextInput`) | the developer | no, normally. Atoms are the design system: their markup and accessibility are design decisions | its own render tests, if any |
| **molecule** (`Field` = label + input + error) | the developer, or pending | may be pending | render tests, derived accessibility checks |
| **organism** (`LoginForm`) | the developer writes the TSX structure; holes for state, handlers and computed content | sketch: holes are regions | render tests with interaction, derived checks |
| **template** (`AuthTemplate`) | the developer | no: layout with typed slots | nothing beyond tsc (layout isn't checked, as in structured-specs §12) |
| **page** (`LoginPage`) | the developer: wiring of template, organisms and concepts | its adapters are pending functions (`toOutcome`) | ordinary tests |

The level is the folder (`ui/atoms/`, `ui/molecules/`, …), or `@arc level <name>` in JSDoc. It decides nothing in the compiler except how a component is described in another region's package: an atom is shown by its props interface and JSDoc, a template by its slots.

**TSX holes.** A hole is an expression, so it can be a JSX child (`{arc.hole<string>("'Signing in…' while busy, else 'Sign in'")}`), an attribute value, or a function-valued `const` (a handler). Hooks stay in the developer's structure (`useState` calls in the skeleton), so hook order is fixed by the developer, not the model. The organism from the prototype:

```tsx
/** Organism, a sketch: the structure is the developer's; the holes are the model's. */
export function LoginForm(props: LoginFormProps): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = arc.hole<(e: FormEvent<HTMLFormElement>) => Promise<void>>(
    "prevent the default; read email and password from the form; clear the error and set busy while onLogin runs; on failure show its error, on success call onSuccess",
  );
  return (
    <form aria-label="Sign in" onSubmit={submit}>
      <Field id="login-email" name="email" type="email" label="Email" required autoComplete="username" />
      <Field id="login-password" name="password" type="password" label="Password" required autoComplete="current-password" error={error} />
      <Button type="submit" disabled={busy}>
        {arc.hole<string>("'Signing in…' while busy, else 'Sign in'")}
      </Button>
    </form>
  );
}
```

**UI tests** use `arc.render(<Component …/>)`, which returns a small screen API that finds elements by accessible name (`fill(label, value)`, `click(role, name)`, `text()`, `enabled(role, name)`). It's the palette's interaction script (`script`, `dom`), written as code:

```tsx
arc.test(LoginForm, "a wrong password shows the error and keeps the form", async (Form, expect) => {
  const calls: unknown[] = [];
  const screen = await arc.render(
    <Form onLogin={async (cred): Promise<LoginOutcome> => (calls.push(cred), { ok: false, error: "Wrong email or password." })} onSuccess={() => {}} />,
  );
  await screen.fill("Email", "ana@x.io");
  await screen.fill("Password", "nope");
  await screen.click("button", "Sign in");
  expect(screen.text()).toMatch("Wrong email or password.");
  expect(screen.enabled("button", "Sign in")).toBe(true);
  expect(calls).toEqual([{ email: "ana@x.io", password: "nope" }]);
});
```

**Connection to the structured-specs vocabulary.** The palette ships a fixed vocabulary (`Form`, `Field`, `ErrorText`, `Submit`), each with a typed declaration, a one-line meaning and a derived DOM check. In code-first, **the project's own atoms and molecules are the vocabulary**: their props interface is the typed declaration, their JSDoc the meaning, and their tests the check. On top, every `arc.render` runs **generic derived accessibility checks** on the rendered DOM: every form control has an accessible name, every button has a name, a form has a name. These are "Derived" tier checks (§9.1), like the palette's. The prototype renders the filled page and runs these checks: the good `Field` passes; a hand-broken `Field` that type-checks fine but drops `<label htmlFor>` fails with `input #login-email has no accessible name (no label[for])` (§12.4). The `ui:` structure specs and `open-arc/ui` stay supported (§14).

Runtime requirements are the palette's phase C: `.tsx` regions staged by transpiling, and jsdom and React from the project's devDependencies (`OARC-E092` detail `dom:*` when missing).

## 7. The optional customization layer

Three ways to add what a TS signature can't say, all optional:

```ts
/**
 * Mark one backend unhealthy.
 * @arc calls none
 * @arc effects clock
 * @arc deps ./ring.ts
 * @arc backend small
 * @arc id lb.markDown
 */
markDown(id: string): void { return arc.todo(); }

arc.configure(LeastConnections.prototype.pick, { backend: "small", calls: [], outputFormat: "code" });
arc.configure(hash32, { examples: [{ args: [""], expected: 2872998923 }] });

export const markDownSpec = arc.defineRegion<(id: string) => void>({ id: "lb.roundRobin.markDown", calls: [] });
```

- **JSDoc `@arc` tags** for one-line settings: `id`, `calls`, `effects`, `deps`, `backend`, `format`, `level`, `waive`, `module`.
- **`arc.configure(target, config)`**: the target is resolved statically with the checker (the prototype resolves `hash32` and `LeastConnections.prototype.pick`). The config is static JSON (§2.2, `OARC-E010` otherwise). It's a no-op at runtime.
- **`defineRegion` with the region's id** attaches to the code-first region with that id instead of creating a new one. `F` must match the declaration (`OARC-E020`). This is how an existing spec can be kept while its function moves to code-first (§14).

**Precedence.** Code is authoritative: the declaration's signature can't be overridden by any layer. Beyond that there is no silent override:

| Field | Rule |
|---|---|
| `intent` | JSDoc first, then a `defineRegion` intent appended after it |
| `examples`, tests, laws | all of them run |
| `calls`, `effects`, `deps`, `tolerance`, `outputFormat`, `backend`, `id` | set in one place only. Two layers setting the same field is `OARC-E013` (new: "region configured twice: <field> (<layer>, <layer>)") |
| `backend`, `contextLevel` | `openarc.config.json` `regions[id]` still wins, because it's machine-local configuration, not spec. `backend` from code is a default and is not in the spec hash |

## 8. Static extraction and safety

### 8.1 What the compiler reads, without executing code

PARSE builds the same tsconfig program it builds today, and reads:

1. Declarations whose body is `arc.todo()` or contains `arc.hole`/`arc.step` (§3.1), with their signatures (checker-printed and as written), JSDoc and `@arc` tags.
2. Classes: the heritage clause (and, through the checker, the interfaces and base classes), fields, the constructor's head, every member's head and JSDoc.
3. `arc.test`, `arc.test.hidden`, `arc.law` and `arc.configure` statements, as syntax (§5.2, §7).
4. `defineFake<T>` default exports, for fakes by type.
5. Everything it reads today: `defineRegion`, `defineBlock`, `defineConcept`, markers.

`arc.implement` classes are scaffolded in memory before VALIDATE (§4.3). Nothing in the user's code is evaluated.

### 8.2 Write scope

The region is the **statement list of the body**. Everything else is developer-owned: the JSDoc, the signature, the class shell, other members, and the test files. The model returns `{ body, imports }` exactly as today (or `{ fills }` for sketches), and the splice check (§8.7: outside the markers the file is byte-identical, except for added import lines) protects the signature and the shell without any new rule. Test files are never written: the spec-integrity rule extends from "every `defineRegion`/`defineBlock` statement" to "every file that contains a test, and every `arc.test`/`arc.law`/`arc.configure` statement".

For an in-place sketch the developer's skeleton is inside the markers, so containment (E099, on the sketch view) protects it.

### 8.3 Markers: kept, inside the body

```ts
pick(key: string): string | null {
  // @openarc:begin lb.roundRobin.pick
  const hs = this.healthy();
  if (hs.length === 0) return null;
  const b = hs[this.next % hs.length]!;
  this.next = (this.next + 1) % hs.length;
  return b.id;
  // @openarc:end lb.roundRobin.pick
}
```

A pending region has no markers: its body is already valid TypeScript, so no scaffold is needed. At its first COMMIT the compiler writes the body with markers as its first and last lines. A whole method body is the region, so markers aren't needed to find its *extent*, but they are still worth their two lines:

1. **Identity survives renames.** The id travels with the body (§3.4). Without markers, the manifest would have to locate a region by a symbol path (`RoundRobin.pick`), and a rename in the editor would orphan it.
2. **Ownership is visible** in the file, to the developer and to reviewers: what's between the markers was generated, and a hand edit there makes it `developer`.
3. **Every existing mechanism applies unchanged:** the marker grammar (§3.1), hashing of the owned text (§4.1), E062 when markers are removed, the splice check, W001, crash-safe commits. The manifest keeps "no line numbers, locations re-derived from markers" (§5).
4. **Block regions nest naturally** inside a code-first body, with the code-first region as their enclosing function region.

The new legal marker position (M) is "the begin marker is the first line of a function body block, the end marker its last line, and between them is the whole statement list". An arrow with an expression body becomes a block body at the first commit.

### 8.4 Hashing and ownership

- **Owned text and `hash`:** unchanged (§4.1), over the statements between the markers.
- **`specHash`** for a code-first region covers, through the same §4.1 normalisation: the declaration's head and JSDoc, the sketch view (if any), the merged configuration (canonical JSON), and the text of every test and law that targets it, hidden ones included. Editing a shown test is a spec change, just as editing a JSON example is today.
- **Context hash** (in the fingerprint, §4.3): the stable view of the class shell (fields, constructor head, sibling heads and JSDoc, heritage), the interfaces' text, and the type closure. Siblings appear by signature whether pending or not, so compiling one member doesn't invalidate the others (the 0.6.3 rule).
- **In-place sketches** record a second hash in the manifest, `sketchHash`, over the sketch view. Detection (§6.2) adds one row before the edit rule: if the sketch view's hash differs from `sketchHash`, the developer changed the structure, which is a spec change (stale for `compiler`, `OARC-E061` for `developer`); if only the whole-body hash differs, a fill was edited, so the region becomes `developer` (`OARC-W060`).

### 8.5 The context package

For a method region the package gains a **Contract** section: the class shell with the target's body as `<<<BODY>>>`, JSDoc in place (no separate intent section), siblings marked `implemented` or `pending`. Then the type closure (the interface and every project type the shell reaches, verbatim), the tests, the calls rule, and the rules. The prototype's package for `lb.roundRobin.pick` is 4,105 characters, 23% of the default 9B budget (§12.3). The other prototype regions: `p2p.peer.receive` 15%, `lb.consistentHash.pick` (a sketch) 11%.

Escalation by failure type (Context-Packages wiki) is unchanged; L2 still adds the whole file.

## 9. Full examples

These listings are type-checked in the prototype (`doc/loadBalancer.ts`, `doc/p2p.ts`, `ui/`; `tsc -p .` gives 0 errors), and part (a) of the prototype discovers their regions (§12.1).

### 9.1 Load balancer as classes

```ts
import * as arc from "open-arc";

export interface Backend {
  id: string;
  healthy: boolean;
  weight: number; // >= 1; only Weighted reads it
  connections: number; // open now; only LeastConnections reads it
}

/** Route requests to backends. Only healthy backends are eligible; with none, every pick is null. */
export interface Balancer {
  /** The backend id for one request, or null when no backend is healthy. */
  pick(key: string): string | null;
  /** Take a backend out of rotation. Throws "unknown backend <id>" for an id it doesn't have. */
  markDown(id: string): void;
}

/** Shared state and helpers; subclasses write pick. */
export abstract class Strategy implements Balancer {
  readonly backends: Backend[];
  constructor(backends: Backend[]) {
    this.backends = backends.map((b) => ({ ...b }));
  }
  /** The healthy backends, in list order. */
  protected healthy(): Backend[] {
    return this.backends.filter((b) => b.healthy);
  }
  markDown(id: string): void {
    const b = this.backends.find((x) => x.id === id);
    if (!b) throw new Error(`unknown backend ${id}`);
    b.healthy = false;
  }
  abstract pick(key: string): string | null;
}

export class RoundRobin extends Strategy {
  next = 0;
  /** The next healthy backend in list order, wrapping around. Keys are ignored. */
  pick(key: string): string | null {
    return arc.todo();
  }
}

export class LeastConnections extends Strategy {
  /** The healthy backend with the fewest connections (ties: first in list order); it then has one more. */
  pick(key: string): string | null {
    return arc.todo();
  }
}

/**
 * Smooth weighted round-robin (nginx).
 * @arc waive "equal backends share requests evenly" weights decide the share
 */
export class Weighted extends Strategy {
  /** Per backend id: the running "current" weight. */
  current = new Map<string, number>();
  /**
   * Add each healthy backend's weight to its current, pick the largest current (ties: first in list order),
   * then subtract the total healthy weight from the pick's current.
   */
  pick(key: string): string | null {
    return arc.todo();
  }
}

/**
 * Each healthy backend owns REPLICAS points on a hash ring.
 * @arc waive "equal backends share requests evenly" hashing pins keys, so the spread is statistical
 */
export class ConsistentHash extends Strategy {
  static readonly REPLICAS = 64;
  pick(key: string): string | null {
    const ring = this.healthy()
      .flatMap((b) => Array.from({ length: ConsistentHash.REPLICAS }, (_, i) => ({ at: hash32(`${b.id}#${i}`), id: b.id })))
      .sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1));
    if (ring.length === 0) return null;
    const h = hash32(key);
    return arc.hole<string>("the id of the first ring entry with at >= h, else ring[0].id");
  }
}

/**
 * 32-bit FNV-1a over UTF-16 code units, then murmur3's fmix32 finalizer. Unsigned.
 * @arc effects none
 */
export function hash32(text: string): number {
  return arc.todo();
}

// ── assertions: laws for every Balancer, tests per class ──
const node = (id: string, connections = 0, weight = 1, healthy = true): Backend => ({ id, healthy, weight, connections });

arc.law(arc.implementations<Balancer, [Backend[]]>(), "never route to an unhealthy backend", (B, expect, gen) => {
  let n = 0;
  const backends = gen.array((g) => node(`b${n++}`, g.int(0, 5), g.int(1, 3), g.bool()), { max: 6 });
  const lb = new B(backends);
  for (let i = 0; i < 8; i++) {
    const id = lb.pick(`k${i}`);
    expect(id === null ? !backends.some((b) => b.healthy) : backends.some((b) => b.id === id && b.healthy)).toBe(true);
  }
});

arc.law(arc.implementations<Balancer, [Backend[]]>(), "equal backends share requests evenly", (B, expect, gen) => {
  const k = gen.int(1, 4);
  const lb = new B(Array.from({ length: k }, (_, i) => node(`b${i}`)));
  const counts = new Map<string, number>();
  for (let i = 0; i < 3 * k; i++) {
    const id = lb.pick(`r${i}`)!;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  expect([...counts.values()]).toEqual(Array.from({ length: k }, () => 3));
});

arc.test(LeastConnections, "picks the minimum, then counts it", (LC, expect) => {
  const lb = new LC([node("a", 5), node("b", 1), node("c", 3)]);
  expect(["1", "2", "3", "4"].map((k) => lb.pick(k))).toEqual(["b", "b", "b", "c"]);
});

arc.test(Weighted, "weights 5:1:1 interleave smoothly", (W, expect) => {
  const lb = new W([node("a", 0, 5), node("b", 0, 1), node("c", 0, 1)]);
  expect(Array.from({ length: 7 }, (_, i) => lb.pick(String(i)))).toEqual(["a", "a", "b", "a", "c", "a", "a"]);
});

arc.test(hash32, "known values", (h, expect) => {
  expect(h("")).toBe(2872998923);
  expect(h("foobar")).toBe(202221276);
});

arc.configure(LeastConnections.prototype.pick, { backend: "small", calls: [] });
```

Regions: `lb.roundRobin.pick`, `lb.leastConnections.pick`, `lb.weighted.pick`, `lb.consistentHash.pick` (a sketch, one hole) and `lb.hash32`. The abstract `Strategy` is shared context. The two laws replace the palette's `lbStrategy` concept laws; the waivers replace its `waive` map. Compare the palette's `loadBalancer.ts`, where each strategy is a pure `(backends, keys) => (string | null)[]` so that its state (rotation position, smooth weights) can be passed through JSON examples.

### 9.2 Peer-to-peer: an interface and classes

```ts
/** Decode a byte stream that arrives in chunks of any size. Bytes are numbers 0..255. */
export interface Decoder {
  /** Add one chunk; return every message it completes, in order. */
  push(chunk: number[]): string[];
  /** The bytes of an incomplete trailing frame. */
  pending(): number[];
}
/** A framing: how messages become bytes and back. The concept every framing obeys is the laws below. */
export interface Framing {
  encode(message: string): number[];
  decoder(): Decoder;
}

export class LengthPrefixed implements Framing {
  /** UTF-8 bytes, prefixed with their count as a 4-byte unsigned big-endian integer. */
  encode(message: string): number[] {
    return arc.todo();
  }
  decoder(): Decoder {
    return new LengthPrefixedDecoder();
  }
}

export class LengthPrefixedDecoder implements Decoder {
  buf: number[] = [];
  /** Append chunk to buf; while buf holds a whole frame (4-byte length, then that many bytes), cut it off and decode it. */
  push(chunk: number[]): string[] {
    return arc.todo();
  }
  pending(): number[] {
    return [...this.buf];
  }
}

export class Varint implements Framing { /* encode pending: an unsigned LEB128 length; decoder(): new VarintDecoder() */ }
export class VarintDecoder implements Decoder { /* push pending: as above, the varint may itself be split across chunks */ }

arc.law(arc.implementations<Framing>(), "any chunking decodes every message, in order", (F, expect, gen) => {
  const f = new F();
  const messages = gen.array((g) => g.string({ alphabet: "ab é∑", max: 300 }), { max: 4 });
  const bytes = messages.flatMap((m) => f.encode(m));
  const d = f.decoder();
  const out: string[] = [];
  for (let i = 0; i < bytes.length; ) {
    const n = gen.int(1, 7);
    out.push(...d.push(bytes.slice(i, i + n)));
    i += n;
  }
  expect(out).toEqual(messages);
  expect(d.pending()).toHaveLength(0);
});

arc.test(LengthPrefixed, "an incomplete frame stays pending", (LP, expect) => {
  const d = new LP().decoder();
  expect(d.push([0, 0, 0, 2, 104, 105, 0, 0, 0, 5, 116])).toEqual(["hi"]);
  expect(d.pending()).toEqual([0, 0, 0, 5, 116]);
});

// ── gossip: a stateful peer over a port ──
export interface Gossip { id: string; origin: string; ttl: number; body: string }
/** The network as one peer sees it. Tests get the project's fake for this type. */
export interface Transport {
  send(from: string, to: string, msg: Gossip): Promise<void>;
}

export class Peer {
  readonly self: string;
  readonly peers: string[];
  readonly net: Transport;
  /** Message ids already handled, oldest first, at most 256. */
  seen: string[] = [];
  delivered: string[] = [];
  constructor(self: string, peers: string[], net: Transport) {
    this.self = self;
    this.peers = peers;
    this.net = net;
  }
  /**
   * A seen id: false, nothing else. Otherwise remember the id (keep the last 256), deliver the body, and when ttl > 0
   * send a copy with ttl - 1 to the first two peers in sorted order, skipping `from`, msg.origin and self.
   * @returns whether the message was delivered here
   * @arc calls this.net.send
   */
  async receive(from: string | null, msg: Gossip): Promise<boolean> {
    return arc.todo();
  }
}

arc.test(Peer, "forwards once, with one hop less", async (P, expect, fakes) => {
  const net = fakes.of<Transport>();
  const a = new P("a", ["d", "b", "c"], net);
  expect(await a.receive(null, { id: "g1", origin: "a", ttl: 2, body: "hi" })).toBe(true);
  expect(await a.receive("b", { id: "g1", origin: "a", ttl: 2, body: "hi" })).toBe(false);
  expect(fakes.snapshot(net)).toEqual({ sent: [["a", "b", "g1", 1], ["a", "c", "g1", 1]] });
});
```

The framing law is a property the palette's JSON laws approximate with five hand-picked chunkings (`split`, `partial`, …): here it's one law over random chunk boundaries, run 50 times per framing. The decoders are stateful (`buf`), which a JSON example can't drive across several `push` calls. `@arc calls this.net.send` is the code-first `calls` list; `this.<field>` paths whose field type is an interface join the restricted roots of §7 rule 6.

### 9.3 Login as atomic-design TSX

The prototype's `ui/` tree, abridged (full files in the prototype):

```tsx
// ui/atoms/Button.tsx: developer-written
export interface ButtonProps { children: ReactNode; type?: "button" | "submit"; disabled?: boolean; onClick?: () => void }
export function Button(props: ButtonProps) {
  return <button className="btn" type={props.type ?? "button"} disabled={props.disabled} onClick={props.onClick}>{props.children}</button>;
}

// ui/molecules/Field.tsx: pending
export interface FieldProps extends TextInputProps { label: string; error?: string | null }
/**
 * Molecule, pending: a `<label htmlFor={id}>` with the label text, then the TextInput.
 * When error is set: the input is invalid and described by a `<p role="alert" id={id + "-error"}>` with the error.
 */
export function Field(props: FieldProps): ReactElement {
  return arc.todo();
}

// ui/organisms/LoginForm.tsx: a sketch with two holes (§6)

// ui/templates/AuthTemplate.tsx: developer-written, typed slots
export interface AuthSlots { title: string; form: ReactNode; footer?: ReactNode }
export function AuthTemplate(s: AuthSlots) {
  return (
    <main className="auth">
      <section className="auth-card">
        <h1>{s.title}</h1>
        {s.form}
        {s.footer ? <footer>{s.footer}</footer> : null}
      </section>
    </main>
  );
}

// ui/pages/LoginPage.tsx: developer wiring + one pending adapter
/**
 * The message the form shows for an auth result. "invalid" and "unknown" get the same text,
 * "Wrong email or password.", so the page doesn't reveal which emails exist; "locked" is "Account locked. Try again later."
 */
export function toOutcome(r: AuthResult): LoginOutcome {
  return arc.todo();
}

export function LoginPage(props: { ports: AuthPorts; onSignedIn(): void }) {
  return (
    <AuthTemplate
      title="Sign in"
      form={<LoginForm onLogin={async (cred) => toOutcome(await password(cred, props.ports))} onSuccess={props.onSignedIn} />}
      footer={<a href="/reset">Forgot your password?</a>}
    />
  );
}

arc.test(toOutcome, "unknown and invalid look the same", (f, expect) => {
  expect(f({ ok: false, reason: "unknown" })).toEqual(f({ ok: false, reason: "invalid" }));
  expect(f({ ok: false, reason: "locked" })).toEqual({ ok: false, error: "Account locked. Try again later." });
  expect(f({ ok: true, userId: "u1" })).toEqual({ ok: true });
});
```

`password` is the auth concept's password strategy (the palette's `auth.password`; a stand-in in the prototype). The page is the composition root that the palette's `loginPage.spec.tsx` says to write by hand ("wire onLogin to auth.password at the composition root"); here the wiring is ordinary code and only the adapter is generated. Pending regions: `ui.molecules.field`, `ui.organisms.loginForm` (holes 1 and 2), `ui.pages.loginPage.toOutcome`.

## 10. Mapping to the existing machinery

| Code-first | Existing machinery it reuses | What's new |
|---|---|---|
| pending declaration | function region (§3.2 F), pending detection (§3.6), PLAN, GENERATE, `{body, imports}` | discovery by body shape; derived ids; E022 |
| signature | `F`, contract binding (§2.4) | generics; `this` |
| JSDoc | `intent` | inheritance of interface member docs |
| markers inside the body | marker grammar, owned-text hash, splice check, E062, ownership (§3–§6) | legal position (M) |
| class members verified together | joint verification of sibling blocks and W042 (§8.10) | applied per class |
| `arc.test` / `expect` | example equality and faithful printing (§9.3), harness outcome lines, `harness-plan.json` | test plan, assertion lines, soft assertions |
| `arc.test.hidden` | — | held-out tests |
| `arc.law` + `gen` | mulberry32 from `check --oracle` (§9.5) | seeded runs, recorded draws |
| `arc.implementations<I>()` + `@arc waive` | concepts: laws, fixtures, waive, interface assignability (palette phase B) | variants found from `implements` |
| `fakes.of<T>()`, `fakes.snapshot` | fakes, `$fake`, `fakesAfter` (§9.4) | resolution by type |
| per-region and per-hole probes | the coverage probe, W045 (§8.10) | — |
| `arc.hole(d, fill)` in place | sketches: holes, containment E099, E100, implied calls (palette phase A) | fill as second argument, sketch view, `sketchHash` |
| `arc.implement<I>()` | in-memory scaffold before VALIDATE (§3.6, F10) | TS code fix |
| `arc.render`, derived a11y checks | `.tsx` staging, jsdom harness, interaction scripts (palette phase C) | screen API as code; generic checks |
| `@arc` tags, `arc.configure`, `defineRegion` by id | `RegionSpec` fields, `openarc.config.json` `regions` | E013 |

## 11. Alternatives considered

| | Design | For | Against |
|---|---|---|---|
| **C1** (recommended) | **Implicit regions** from pending bodies, JSDoc intent, tests as TS run in the sandbox, markers inserted inside the body, configuration layered on | Plain TypeScript: classes, interfaces, generics, editor rename and go-to-definition all work. Reuses markers, hashing, ownership, the harness and the sketch machinery | Tests need a static plan and a registry check; class members need joint verification |
| C2 | **Decorators** (`@arc.region({ … })` on methods and classes) | Familiar from Angular and NestJS; metadata next to the code | OpenArc runs sources with Node's type stripping, which doesn't transform decorators, and V8 doesn't run them, so the sandbox couldn't load the code. Decorators don't apply to plain functions. Their arguments are runtime values, which invites dynamic specs |
| C3 | **Declaration files**: `declare class` / signatures in a `*.arc.ts` file; the compiler generates a separate implementation file | Clean split between spec and generated code | Two files per unit; the generated file is entirely compiler-owned, so adding one hand-written helper means a third file. It isn't "coding classes" |
| C4 | **Implicit regions without markers**: the manifest locates a region by symbol path (`lb/balancer.ts#RoundRobin.pick`) | Two fewer lines per region | A rename in the editor orphans the region (E062 on every refactor). Generated code isn't visible as generated. The hash, splice and write-scope code would need a second region-location path |
| C5 | **Tests with Vitest or Jest** | Developers know them | A new dependency in the sandbox; globals, timers, module mocking and snapshot files are nondeterminism or file writes; their runner can't be held to a static plan. A later `openarc test --vitest` adapter could run `arc.test` files in a developer's normal runner, outside the compile |
| C6 | **Tests compiled to JSON statically** (only the literal subset of `expect` calls) | No new harness code; same trust as today | Loses state sequences, loops, laws and fakes by type, which are the reasons to write tests as code. The static summary keeps this idea for what it's good at (§5.3) |
| C7 | **Code-first sketches only in the spec** (palette S1: `defineRegion({ sketch })`) | Already implemented | The sketch is duplicated by its generated body; in a class, a spec can't sit next to a method. In-place fills (§4.6) keep the sketch readable without duplication |

C1 is the only option that makes the code itself the spec without a new file kind, a new runtime dependency or a weaker identity model.

## 12. Prototype results

The prototype is throwaway, in `/tmp/claude-1000/-mnt-data-projetos/0a52dddd-ec03-4d58-8441-c8ccfe4d6411/scratchpad/code-first/`. It needs Node 25.9.0 and uses the TypeScript 5.9.3 compiler API from `stage0/node_modules/typescript`, and the example equality (`valuesEqual`, `showValue`, `toJson`) imported from `stage0/core/harness.ts` in the main checkout. React 18.3.1, react-dom and @types/react 18.3.31 come read-only from `GrapplingArc/GrapplingArcWeb/node_modules` through symlinks in the prototype's `node_modules/`. **No model was run** (the GPU is busy with model screening). Every "model output" is a hand-written file under `candidates/`, labelled as such in its first line. Tests ran **in-process** with Node's type stripping, as a stand-in for the sandbox; the real harness would run the same plan inside bwrap.

| File | What |
|---|---|
| `arc.ts` | stand-in DSL: `todo`, `hole` (1 or 2 arguments), `test`, `test.hidden`, `law`, `implementations`, `implement`, `configure`, `Expect`, `Gen`, `Fakes`, `render` (type only) |
| `app/balancer.ts`, `app/balancer.test.ts`, `app/balancer.laws.ts` | interface `Balancer`; `RoundRobin` (2 pending methods, 1 concrete); `ConsistentHash` (an in-place sketch); `hash32` (pending, `@arc id lb.ringHash`, JSON examples via `arc.configure`); tests, a hidden test and laws |
| `app/p2p.ts`, `app/p2p.test.ts`, `fakes/net.memory.ts` | `Peer` over a `Transport` port; tests with `fakes.of<Transport>()` |
| `app/store.ts` | `MemoryUsers extends arc.implement<UserStore>()` |
| `ui/` | `Button`, `TextInput` (atoms), `Field` (molecule, pending), `LoginForm` (organism, sketch) and its test, `AuthTemplate`, `LoginPage` (+ `toOutcome`, pending, with a same-file test) |
| `doc/` | the §9.1 and §9.2 listings |
| `proto.ts` | (a) discovery, (b) tests: typing, plan, summary, splice, run, coverage, (c) context package, (d) UI, (e) `arc.implement` scaffold |

```bash
cd /tmp/claude-1000/-mnt-data-projetos/0a52dddd-ec03-4d58-8441-c8ccfe4d6411/scratchpad/code-first
node_modules/typescript/bin/tsc -p .     # everything as written: 0 errors
node proto.ts a    # discovery
node proto.ts b    # tests
node proto.ts c    # context package for lb.roundRobin.pick (or: node proto.ts c <id>)
node proto.ts d    # atomic UI
node proto.ts e    # arc.implement scaffold
```

### 12.1 (a) Region discovery, without executing anything

```
$ node proto.ts a
tsc on the project as written (pending bodies, tests, fakes): 0 errors
doc examples (doc/*.ts, the design doc's listings): doc.loadBalancer.roundRobin.pick (pending), doc.loadBalancer.leastConnections.pick (pending),
  doc.loadBalancer.weighted.pick (pending), doc.loadBalancer.consistentHash.pick (sketch), doc.loadBalancer.hash32 (pending),
  doc.p2p.lengthPrefixed.encode (pending), doc.p2p.lengthPrefixedDecoder.push (pending), doc.p2p.varint.encode (pending),
  doc.p2p.varintDecoder.push (pending), doc.p2p.peer.receive (pending)
{ "id": "lb.roundRobin.pick", "file": "app/balancer.ts", "kind": "method", "state": "pending", "this": "RoundRobin implements Balancer",
  "signature": "pick(key: string): string | null", "checked": "(key: string): string | null",
  "intent": { "description": "The next healthy backend in rotation, in list order, wrapping around.",
              "params": { "key": "ignored: round-robin does not look at keys" }, "returns": "the backend id, or null when no backend is healthy" } }
{ "id": "lb.roundRobin.markDown", …, "signature": "markDown(id: string): void",
  "intent": { "description": "Mark one backend unhealthy. The rotation keeps its position.", "params": {},
              "throws": "Error \"unknown backend <id>\" when no backend has that id" }, "arc": { "calls": "none" } }
{ "id": "lb.consistentHash.pick", …, "state": "sketch", "this": "ConsistentHash implements Balancer",
  "holes": [ { "n": 1, "type": "string", "description": "the id of the first ring entry with at >= h, else ring[0].id" } ] }
{ "id": "lb.ringHash", "derivedId": "lb.hash32", …, "kind": "function", "signature": "export function hash32(text: string): number",
  "arc": { "id": "lb.ringHash" }, "config": { "examples": [ { "args": [ "" ], "expected": 2872998923 }, { "args": [ "a" ], "expected": 444641715 } ] } }
{ "id": "p2p.peer.receive", …, "signature": "async receive(from: string | null, msg: Gossip): Promise<boolean>", "arc": { "calls": "this.net.send" } }
{ "id": "ui.molecules.field", …, "checked": "(props: FieldProps): ReactElement<any, string | JSXElementConstructor<any>>" }
{ "id": "ui.organisms.loginForm", …, "state": "sketch" }
{ "id": "ui.pages.loginPage.toOutcome", …, "checked": "(r: AuthResult): LoginOutcome" }
variant without pick's return type: OARC-E022 app/balancer.ts:41 lb.roundRobin.pick: a region needs an explicit return type (arc.todo() would infer never)
```

(Lines are abridged with `…`; the script prints one JSON object per region.) The module id `lb` comes from `/** @arc module lb */`; `lb.ringHash` shows the `@arc id` override next to the derived `lb.hash32`; `arc.configure(hash32, …)` resolved to its region through the checker.

### 12.2 (b) Tests: typing, the static plan, the summary, the splice, the runs

```
$ node proto.ts b
static test plan: 12 entries (1 hidden, 3 law); fakes by type: Transport -> net.memory
  law "pick is null exactly when nothing is healthy" target arc.implementations<Balancer, [Backend[]]>() -> regions lb.roundRobin.pick, lb.roundRobin.markDown, lb.consistentHash.pick; 1 expect call(s)
  law "equal backends share requests evenly" target arc.implementations<Balancer, [Backend[]]>() -> regions lb.roundRobin.pick, lb.roundRobin.markDown; 1 expect call(s)
  test "rotates in list order and wraps" target RoundRobin -> regions lb.roundRobin.pick, lb.roundRobin.markDown; 4 expect call(s)
  …
  test [hidden] "fair over 300 picks" target RoundRobin -> regions lb.roundRobin.pick, lb.roundRobin.markDown; 1 expect call(s)
  test "known values" target hash32 -> regions lb.ringHash; 3 expect call(s)
  test "a new message is delivered and forwarded with one hop less" target Peer -> regions p2p.peer.receive; 3 expect call(s); fakes.of<Transport>
tsc with pick(1) instead of pick("x"): app/balancer.test.ts(12): TS2345 Argument of type 'number' is not assignable to parameter of type 'string'.
tsc with toBe(1) on a string | null result: app/balancer.test.ts(12): TS2345 Argument of type 'number' is not assignable to parameter of type 'string'.
tsc with a misspelled method: app/balancer.test.ts(26): TS2551 Property 'markDwn' does not exist on type 'RoundRobin'. Did you mean 'markDown'?

static examples summary (from simple expect calls; nothing executed):
  [lb.roundRobin.pick,lb.roundRobin.markDown] rr.pick("x") → "a"
  … (7 more lines for RoundRobin)
  [lb.roundRobin.pick,lb.roundRobin.markDown] new RR(three).markDown("z") throws "unknown backend z"
  [lb.ringHash] h("") → 2872998923
  [lb.ringHash] h("a") → 444641715
  [lb.ringHash] h("foobar") → 202221276
  not summarizable: 12 assertion(s) (shown to the model as test source instead)

tsc on the spliced program (what COMMIT would write): 0 errors
spliced RoundRobin.pick and ConsistentHash.pick:
  |   pick(key: string): string | null {
  |     // @openarc:begin lb.roundRobin.pick
  |     const hs = this.healthy();
  |     if (hs.length === 0) return null;
  |     const b = hs[this.next % hs.length]!;
  |     this.next = (this.next + 1) % hs.length;
  |     return b.id;
  |     // @openarc:end lb.roundRobin.pick
  |   }
  |   pick(key: string): string | null {
  |     // @openarc:begin lb.consistentHash.pick
  |     const ring = this.healthy()
  |       …
  |     const h = hash32(key);
  |     return arc.hole<string>("the id of the first ring entry with at >= h, else ring[0].id", ((ring.find((e) => e.at >= h) ?? ring[0]!).id));
  |     // @openarc:end lb.consistentHash.pick
  |   }
containment (sketch view of the filled body == the sketch): true
containment after a change outside the hole: false (E099)

run (good candidates), in-process stand-in for the sandbox:
  pass law: pick is null exactly when nothing is healthy [RoundRobin]  (50/50 assertions; 50/50 runs (seed 1); reached lb.roundRobin.pick)
  pass law: pick is null exactly when nothing is healthy [ConsistentHash]  (50/50 assertions; 50/50 runs (seed 1); reached lb.consistentHash.pick, lb.consistentHash.pick#1, lb.ringHash)
  pass law: equal backends share requests evenly [RoundRobin]  (20/20 assertions; 20/20 runs (seed 1); reached lb.roundRobin.pick)
  waived law: equal backends share requests evenly [ConsistentHash]  (hashing pins each key to a backend, so the spread is statistical)
  pass test: rotates in list order and wraps  (4/4 assertions; reached lb.roundRobin.pick)
      ok   line 12: expect(rr.pick("x")).toBe("a")
      ok   line 13: expect(rr.pick("x")).toBe("b")
      …
  pass test: markDown skips the backend and keeps the position  (3/3 assertions; reached lb.roundRobin.markDown, lb.roundRobin.pick)
  pass test: markDown of an unknown id throws  (1/1 assertions; reached lb.roundRobin.markDown)
  pass [hidden] fair over 300 picks
  pass law: never picks an unhealthy backend  (500/500 assertions; 50/50 runs (seed 1); reached lb.roundRobin.pick)
  pass test: known values  (3/3 assertions; reached lb.ringHash)
  pass test: removing a node moves only the keys it owned  (200/200 assertions; reached lb.consistentHash.pick, lb.consistentHash.pick#1, lb.ringHash)
  pass test: a new message is delivered and forwarded with one hop less  (3/3 assertions; reached p2p.peer.receive)
      ok   line 9: expect(fakes.snapshot(net)).toEqual({ sent: [["a", "b", "g1", 1], ["a", "c", "g1", 1]] })
  pass test: a duplicate is dropped and nothing is sent  (3/3 assertions; reached p2p.peer.receive)
  json examples (arc.configure on lb.ringHash): 2/2
 coverage:
  lb.roundRobin.pick: verified by 7 passing test(s)
  lb.roundRobin.markDown: verified by 2 passing test(s)
  lb.consistentHash.pick: verified by 2 passing test(s)
  lb.consistentHash.pick#1: verified by 2 passing test(s)
  lb.ringHash: verified by 3 passing test(s)
  p2p.peer.receive: verified by 2 passing test(s)

run (broken RoundRobin.pick), in-process stand-in for the sandbox:
  FAIL test: rotates in list order and wraps  (0/4 assertions; reached lb.roundRobin.pick)
      FAIL line 12: expect(rr.pick("x")).toBe("a")
           got "b"; expected "a"
      FAIL line 13: expect(rr.pick("x")).toBe("b")
           got "c"; expected "b"
      …
  FAIL test: markDown skips the backend and keeps the position  (1/3 assertions; reached lb.roundRobin.markDown, lb.roundRobin.pick)
      FAIL line 25: expect(rr.pick("x")).toBe("a")
           got "b"; expected "a"
      FAIL line 27: expect(rr.pick("x")).toBe("c")
           got "a"; expected "c"
      ok   line 28: expect(rr.healthy().map((b) => b.id)).toEqual(["a", "c"])
  pass [hidden] fair over 300 picks
  …

run (without the two markDown tests), in-process stand-in for the sandbox:
  …
 coverage:
  lb.roundRobin.pick: verified by 6 passing test(s)
  lb.roundRobin.markDown: OARC-W045 unreached by any passing test (not cached as verified)
  …

run (health-blind RoundRobin.pick), in-process stand-in for the sandbox:
  FAIL law: pick is null exactly when nothing is healthy [RoundRobin]  (5/6 assertions; failed at run 6/50 (seed 1); draws [false,false,"ycba "]; reached lb.roundRobin.pick)
      FAIL line 8: expect(new Impl(backends).pick(gen.string()) === null).toBe(!backends.some((b) => b.healthy))
           got false; expected true
  FAIL test: no healthy backend gives null  (1/2 assertions; reached lb.roundRobin.pick)
      FAIL line 20: expect(new RR([{ id: "a", healthy: false, weight: 1 }]).pick("k")).toBe(null)
           got "a"; expected null
  FAIL law: never picks an unhealthy backend  (4/10 assertions; failed at run 1/50 (seed 1); draws [false,false,false,true,true]; reached lb.roundRobin.pick)
  …
```

Findings:

- **Every assertion is reported on its own,** with its source text and line, which is exactly what a repair prompt needs. A test continues after a failed `expect` (the `markDown` test shows 1 of 3 passing).
- **The off-by-one `pick` passes the hidden fairness test and the "never unhealthy" law,** and fails only the shown rotation tests. A health-blind `pick` passes the rotation test and fails both laws on the first runs. Laws and example-style tests catch different bugs.
- **The registry check worked as designed:** the runner compares the registered tests with the static plan before running anything (a mismatch would be `E090 test-registry`).
- **Fakes by type:** `fakes.of<Transport>()` resolved statically to `fakes/net.memory.ts` (its `defineFake<Transport>`), and the staged copy names it.
- **The summary loses setup** (`rr.pick("x") → "a"` four times), which is why the package shows test source (§5.3).
- A gap in the prototype: the `draws` line doesn't record `gen.array`'s length draw. The real harness should record every draw.

### 12.3 (c) The context package for `lb.roundRobin.pick`

Verbatim, except that two tests in the middle are cut (marked `…`):

```
## Task
Write the body of one method. Reply {"body": "<statements>", "imports": []}.
The class shell (fields, constructor, other members, signatures) is fixed and checked to be unchanged.

## Contract (fixed)
// lb.roundRobin.pick in app/balancer.ts
export class RoundRobin implements Balancer {
  readonly backends: Backend[];
  /** Position in healthy() of the next pick. */
  next = 0;
  constructor(backends: Backend[]);  // sets the fields above
  /** The backends that can take requests now, in list order. */
  healthy(): Backend[];  // implemented
  /**
   * The next healthy backend in rotation, in list order, wrapping around.
   * @param key ignored: round-robin does not look at keys
   * @returns the backend id, or null when no backend is healthy
   */
  pick(key: string): string | null {
    <<<BODY>>>
  }
  /**
   * Mark one backend unhealthy. The rotation keeps its position.
   * @throws Error "unknown backend <id>" when no backend has that id
   * @arc calls none
   */
  markDown(id: string): void;  // pending: don't call it
}

## Types (verbatim)
/** Routes requests to backends. Implementations keep their own rotation state. */
export interface Balancer {
  /** The backend for one request; null when no backend is healthy. */
  pick(key: string): string | null;
  /** Take a backend out of rotation. */
  markDown(id: string): void;
  /** The backends that can take requests now, in list order. */
  healthy(): Backend[];
}
export interface Backend {
  id: string;
  healthy: boolean;
  weight: number;
}

## Tests your body must pass (TypeScript, run in a sandbox)
const three: Backend[] = [
  { id: "a", healthy: true, weight: 1 },
  { id: "b", healthy: true, weight: 1 },
  { id: "c", healthy: true, weight: 1 },
];

arc.law(arc.implementations<Balancer, [Backend[]]>(), "pick is null exactly when nothing is healthy", (Impl, expect, gen) => {
  let n = 0;
  const backends = gen.array((g) => ({ id: `b${n++}`, healthy: g.bool(), weight: 1 }), { max: 5 });
  expect(new Impl(backends).pick(gen.string()) === null).toBe(!backends.some((b) => b.healthy));
});

…

arc.test(RoundRobin, "rotates in list order and wraps", (RR, expect) => {
  const rr = new RR(three);
  expect(rr.pick("x")).toBe("a");
  expect(rr.pick("x")).toBe("b");
  expect(rr.pick("x")).toBe("c");
  expect(rr.pick("x")).toBe("a");
});

arc.test(RoundRobin, "no healthy backend gives null", (RR, expect) => {
  expect(new RR([]).pick("k")).toBe(null);
  expect(new RR([{ id: "a", healthy: false, weight: 1 }]).pick("k")).toBe(null);
});

arc.test(RoundRobin, "markDown skips the backend and keeps the position", (RR, expect) => {
  const rr = new RR(three);
  expect(rr.pick("x")).toBe("a");
  rr.markDown("b");
  expect(rr.pick("x")).toBe("c");
  expect(rr.healthy().map((b) => b.id)).toEqual(["a", "c"]);
});

arc.test(RoundRobin, "markDown of an unknown id throws", (RR, expect) => {
  expect(() => new RR(three).markDown("z")).toThrow("unknown backend z");
});

arc.law(RoundRobin, "never picks an unhealthy backend", (RR, expect, gen) => { … });
// plus 1 hidden test(s), not shown

## Calls
Unrestricted (no calls list).

## Rules
Return only statements. `this` is the instance. No imports beyond those listed. No process, globalThis, fetch, timers; effects: none.

[size] 4105 chars ≈ 1173 tokens; budget for the default 9B backend 17920 chars (23% used)
```

Observations: `healthy()` has no JSDoc of its own and inherits `Balancer.healthy`'s; the test const `three` is included because a shown test reads it; the hidden test is counted, not shown. One refinement for the real implementation: "pending: don't call it" on `markDown` is right for the body, but the tests do call `markDown`, so the note should say "pending; compiled jointly with this member". The other packages: `p2p.peer.receive` 2,683 characters (15%), `lb.consistentHash.pick` 2,039 (11%).

### 12.4 (d) Atomic UI

```
$ node proto.ts d
tsc on atoms, molecules, organisms, templates, pages and the UI test (React 18 types): 0 errors
  atom      ui/atoms/Button.tsx              no region: developer-written
  atom      ui/atoms/TextInput.tsx           no region: developer-written
  molecule  ui/molecules/Field.tsx           ui.molecules.field (pending)
  organism  ui/organisms/LoginForm.tsx       ui.organisms.loginForm (sketch: #1 (e: FormEvent<HTMLFormElement>) => Promise<void>; #2 string)
  template  ui/templates/AuthTemplate.tsx    no region: developer-written
  page      ui/pages/LoginPage.tsx           ui.pages.loginPage.toOutcome (pending)
  test "a wrong password shows the error and keeps the form" (ui/organisms/LoginForm.test.tsx) -> ui.organisms.loginForm
  test "unknown and invalid look the same" (ui/pages/LoginPage.tsx) -> ui.pages.loginPage.toOutcome

good: tsc on the spliced UI: 0 errors
  | export function LoginForm(props: LoginFormProps): ReactElement {
  |   // @openarc:begin ui.organisms.loginForm
  |   const [error, setError] = useState<string | null>(null);
  |   const [busy, setBusy] = useState(false);
  |   const submit = arc.hole<(e: FormEvent<HTMLFormElement>) => Promise<void>>(
  |     "prevent the default; …", (async (e) => { e.preventDefault(); const data = new FormData(e.currentTarget); setError(null); setBusy(true); … }),
  |   );
  |   return (
  |     <form aria-label="Sign in" onSubmit={submit}>
  |       …
  |       <Button type="submit" disabled={busy}>
  |         {arc.hole<string>("'Signing in…' while busy, else 'Sign in'", (busy ? "Signing in…" : "Sign in"))}
  |       </Button>
  |     </form>
  |   );
  |   // @openarc:end ui.organisms.loginForm
  | }
  rendered: <main class="auth"><section class="auth-card"><h1>Sign in</h1><form aria-label="Sign in"><div class="field"><label for="login-email">Email</label>
    <input class="input" id="login-email" name="email" type="email" required="" autoComplete="username"/></div><div class="field"><label for="login-password">Password</label>
    <input class="input" id="login-password" name="password" type="password" required="" autoComplete="current-password"/></div>
    <button class="btn" type="submit">Sign in</button></form><footer><a href="/reset">Forgot your password?</a></footer></section></main>
  derived a11y checks: pass

unlabelled Field: tsc on the spliced UI: 0 errors
  derived a11y checks: FAIL
    input #login-email has no accessible name (no label[for])
    input #login-password has no accessible name (no label[for])
```

The page was rendered with `react-dom/server`'s `renderToStaticMarkup` after `ts.transpileModule` (React JSX), in-process. The UI test (`LoginForm.test.tsx`) type-checks, but `arc.render` is a type-only stand-in here; the interaction path (jsdom inside bwrap, filling and clicking by accessible name) is the one palette phase C already runs. The broken `Field` type-checks, which is the point: only the rendered-DOM check catches it.

### 12.5 (e) `arc.implement<I>()`

```
$ node proto.ts e
TS2420: Class 'MemoryUsers' incorrectly implements interface 'UserStore'.   Type 'MemoryUsers' is missing the following properti…
export class MemoryUsers implements UserStore {
  findByEmail(email: string): Promise<User | null> {
    return arc.todo();
  }
  save(user: User): Promise<void> {
    return arc.todo();
  }
  users: User[] = [];
}

tsc after scaffold: 0 errors; regions found in app/store.ts: store.memoryUsers.findByEmail, store.memoryUsers.save
```

The scaffold is TypeScript's language-service code fix for TS2420, applied after rewriting the heritage clause; no member-printing code was written.

## 13. SPEC changes

| § | Change |
|---|---|
| §1 Scope | DSL row: add code-first regions (implicit pending declarations, class members), `arc.test`/`arc.law`, `arc.configure`. Region identification: markers plus derived ids for pending regions |
| §2.1 Types | `todo(id?: string)`; `hole(d, fill)` overload; `step`; `test`, `test.hidden`, `law`, `implementations`, `Family`, `implement`, `configure`, `RegionConfig`, `Expect`/`Matchers`, `Gen`, `Fakes` (`of`, `named`, `snapshot`), `render`/`Screen` (UI) |
| §2.2 Static evaluability | new readers: implicit regions (§3.1 here), test statements (shape rules, E010 details `test:*`, `fake:*`, `law:constructor:*`, `examples:method`), `arc.configure` (static JSON), `@arc` JSDoc tags |
| §2.3 Identifiers | derivation (§3.4 here), `@arc module`, `@arc id`; the markers are authoritative once present; E064 |
| §2.4 Contract binding | not needed for implicit regions; applies when `defineRegion<F>` attaches to one |
| new §2.7 Code-first regions | eligible declarations, E022, classes and shells, `arc.implement`, abstract bases, `implementations` laws and `@arc waive` |
| §3.1 / §3.2 | legal position (M): markers as the first and last lines of a function body block. Class members become legal regions in that position (today E033) |
| §3.6 Pending bodies | a declaration whose body is `arc.todo()` is pending without markers; markers are written at its first commit |
| §4.2 Spec hash | for implicit regions: head + JSDoc + sketch view + merged config + targeting tests and laws (§8.4 here) |
| §4.3 Fingerprint | the context stable view includes the class shell and the interfaces |
| §5 Manifest | `kind: "member"` (display), `declaration` (e.g. `RoundRobin.pick`, display only), `sketchHash` for in-place sketches; `provenance.verifiedBy` gains `tests:<passed>/<total>`, `laws:<n>`, `hidden:<n>` |
| §6.2 Detection | the `sketchHash` row for in-place sketches |
| §6.4 Rename | §3.4 table here; `openarc rename` |
| §7 rule 6 | restricted roots add `this.<field>` when the field's type is an interface (ports held as fields) |
| §7 rule 7 | containment on the sketch view for in-place sketches |
| §8.1 | PARSE reads code-first declarations, tests, configure; ANALYZE derives ids and the test plan; PLAN compiles a class's members in order and verifies them jointly; scaffolds `arc.implement` in memory |
| §8.5 Repair prompt | failing assertions with source and line; hidden tests by name only |
| §8.7 Write scope | spec integrity covers test files and `arc.test`/`arc.law`/`arc.configure` statements |
| §8.8 Context packages | Contract section (class shell, `<<<BODY>>>`, JSDoc in place, inherited member docs); Tests section (shown test source + the consts they read, hidden count); summary as the first fallback under budget |
| §8.10 | joint verification per class; probes per code-first region; W045 detail `unreached:<id>` |
| §9.1 Tiers | tests and laws are authoritative (tier 1); hidden tests too; generic a11y checks are Derived |
| §9.3 Harness | test plan entries in `harness-plan.json` (`tests`), the registry check (E090 `test-registry`), soft assertions and per-assertion outcome lines, law runs with recorded draws |
| §9.4 Fakes | fakes by type; `fakes.snapshot` |
| §9.5 | W044 counts assertions (detail `tests:<n>`) and uses the summary's literals for edge cases; `--oracle` seeds from the summary |
| §11 Diagnostics | new: E013 (configured twice), E022 (no explicit return type), E064 (`@arc id` disagrees with markers); new details on E010, E090, W044, W045 |
| §12 Conformance | a pending method compiled with markers inside the body; a rename after compile keeping the id; E022; E064; E013; a test that fails one of three assertions; a hidden test failing (name only in the repair prompt); a law failing with draws; a waived law; `fakes.of<T>` with no fake and with two; a class with one member unreached (W045); a registry mismatch (E090); an in-place sketch whose skeleton was edited (spec change) vs. whose fill was edited (W060); `arc.implement` scaffold |
| §13 Config | `src` roots for module ids (default `src`); `tests` globs for test discovery (default `src/**`, `tests/**`) |

## 14. Coexistence, and optional migration

**Every current form stays fully supported.** Nothing is deprecated, nothing changes behaviour, and no project has to migrate:

| Form | Status |
|---|---|
| `defineRegion<F>({ id, intent, examples, … })` + `export const s: F = …` between markers | supported, unchanged |
| `defineBlock` + block markers | supported, unchanged; blocks can also nest inside code-first bodies |
| `defineRegion({ sketch })` (palette phase A) | supported, unchanged |
| `defineConcept` + variants (palette phase B) | supported, unchanged; laws over `arc.implementations<I>()` are the code-first alternative |
| `ui:` structure specs, `open-arc/ui` (palette phase C) | supported, unchanged |
| JSON examples, `$fake`, `fakesAfter`, value tokens | supported, unchanged; also attachable to code-first functions via `arc.configure` |
| `selfhost/` | unchanged; it keeps compiling with `defineRegion` and `defineBlock` |

Forms mix freely: one file can hold a `defineRegion` spec, a code-first class and tests. A code-first region and a classic spec meet only when a `defineRegion` names the code-first region's id, in which case it attaches (§7).

**Code-first becomes the main way:**

- The README's first example becomes a code-first function with a JSDoc and an `arc.test`; the `defineRegion` example moves to "Other ways to write a region".
- The wiki's Writing Specs page leads with code-first regions, classes and tests; `defineRegion`, blocks, sketches, concepts and `ui:` specs follow as fully supported alternatives and as the customization layer.
- `openarc init` scaffolds a code-first `src/` example and a test file.
- `examples/demo` gets a code-first version; the palette demo keeps its palette forms.
- `openarc extract` gains a code-first output (wrap the existing body in markers inside the function, keep its JSDoc, no spec statement). It becomes the default once phase 2 ships, with `--style region` for today's output.

**Optional migration, per region:** `openarc migrate <id>` converts one classic function region into code-first form in one transaction:

1. `export const s: F = (a, b) => { … }` becomes `export function s(a: A, b: B): R { … }` (the parameter types and return type printed from `F`), with the markers moved inside the body.
2. The intent becomes the JSDoc.
3. `examples` stay JSON by default, attached with `arc.configure(s, { examples })` (lossless), or with `--tests` become `arc.test(s, "<name>", …)` blocks: `expected` to `toEqual` (with the example's `tolerance`/`exact`), `throws` to `toThrow`, `$fake` arguments to `fakes.named(…)`, `fakesAfter` to `fakes.snapshot` assertions, tokens such as `"$NaN"` to `NaN`.
4. The id, ownership and provenance are kept. The owned text changes shape (a declaration becomes a statement list), so the command records the new hash in the manifest itself, the way `resolve` does; it is not seen as a hand edit.

It refuses block parents (their blocks would need checking under the new shape) and regions in `conflicted` state. It is never run implicitly.

## 15. Open questions

1. **Where do tests live?** Recommended: anywhere in `src/` or `tests/`; `*.test.ts` next to the code is the documented convention. Same-file tests are allowed (the prototype's `LoginPage.tsx` has one), but they register at import in production builds (cheap, and `open-arc` is already a runtime import for `arc.todo`). A later build transform can strip them, as SPEC §2.1 already plans for `defineRegion`.
2. **Test source or summary in the package?** Recommended: the source of shown tests, with the summary only as the first budget fallback. The prototype shows why: the summary drops setup (`rr.pick("x") → "a"`). To be confirmed by the phase 1 benchmark on `qwen3.5:9b`.
3. **What does the model learn from a failing hidden test?** Recommended: its name only. Values or source would leak the held-out case; silence makes repairs blind. Developers who want no leak at all can give hidden tests neutral names.
4. **Should committed code keep `arc.hole(d, fill)`?** Recommended: yes. It keeps the sketch readable and the containment check trivial, for one function call per hole. The alternative (strip holes at commit and keep the sketch in the manifest) is exactly what structured-specs rejected as S2.
5. **Which tests run for a member region?** Recommended: every test that targets its class (or its base classes, or a family it belongs to), with coverage hits deciding which members a passing test verifies. A method reference as the target (`arc.test(RoundRobin.prototype.pick, …)`) is allowed to narrow selection only. Running per member would duplicate setup in every test and miss the cross-member sequences that classes exist for.

## 16. Phased implementation plan

All phases come **after the `palette` branch merges**: they reuse its sketch, concept, `.tsx` staging and jsdom work. Each phase leaves every existing form untouched.

| Phase | Ships | Why here | Size |
|---|---|---|---|
| **1: implicit regions + `arc.test`** (smallest valuable slice) | discovery of pending top-level functions and class methods; derived ids, `@arc id`, `@arc module`; E022; markers inside the body (position M); JSDoc intent with interface inheritance; `@arc calls/effects/deps`; the Contract section; `arc.test` + `expect` (no laws, no hidden tests, no fakes by type), the static plan and registry check, per-assertion outcome lines; per-region probes and W045; joint verification per class; specHash/context hash; conformance cases. **Benchmark:** the palette's load balancer and framing written both ways (palette style vs. code-first classes), same model, attempts and passes per region, package sizes | Delivers the request's core (code is the spec, classes work, assertions are TS) with no new dependency and no new file kind. Stays inside existing machinery: markers, hashing, harness, sandbox | about the size of palette phase A |
| **2: the main-version switch** | README, wiki (Writing Specs, Context Packages, Fakes), `openarc init` scaffold, `examples/demo` code-first, `openarc extract` code-first output (default, `--style region` kept), `openarc migrate` (optional), `openarc rename` | Only after phase 1 is measured: the docs should lead with the form that compiles at least as well on small models | small (mostly docs and two commands) |
| **3: the rest of the assertion model** | `arc.test.hidden`, `arc.law` + `gen`, `arc.implementations<I>()` + `@arc waive`, `fakes.of<T>()` / `fakes.snapshot`, `arc.configure`, `defineRegion` attaching by id, E013, `arc.implement<I>()` scaffold, getters and arrow properties, the static summary uses (W044, `--oracle` seeds, budget fallback) | Each is independent and builds on phase 1's plan and harness. Laws over implementations give code-first concepts | small to medium |
| **4: in-place sketches** | `arc.hole(d, fill)`, the sketch view, `sketchHash` and its detection row, `arc.step` statement holes, containment on the sketch view, per-hole probes in place | Reuses palette phase A's checks; changes only where the fills are written | small |
| **5: atomic UI** | `.tsx` code-first regions (palette phase C staging), `arc.render` with the screen API in the jsdom harness, generic derived a11y checks, `@arc level`, atom and template descriptions in packages | Needs phases 1 and 4 (organisms are sketches) and phase C's DOM | medium |

Phase 1 alone lets a user write `class RoundRobin implements Balancer { pick(key: string): string | null { return arc.todo(); } }` with a typed `arc.test`, and have it compiled, verified in the sandbox and tracked with the same guarantees as every region today.
