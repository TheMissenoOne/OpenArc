# Writing Specs

## Code first: the main way

Write the program as ordinary TypeScript and leave `return arc.todo();` where the compiler should write a body. The declaration is the spec:

| Part | Comes from |
|---|---|
| contract | the signature (generics allowed; `this` for a method) |
| intent | the JSDoc, or the JSDoc of the interface member it implements |
| id | the module path, class and member (`lb.balancer.roundRobin.pick`), or `@arc id` |
| behaviour | `arc.test`, `arc.test.hidden` and `arc.law`: TypeScript, type-checked against the real code, run in the sandbox |
| context | the class shell (fields, constructor, other members' signatures), the types it reaches, the shown tests |
| extra settings | `@arc calls\|effects\|deps\|backend\|outputFormat` tags, `arc.configure(target, { … })`, or a `defineRegion` with the same id |

```ts
export class LeastConnections implements Balancer {
  readonly backends: Backend[];
  constructor(backends: Backend[]) {
    this.backends = backends.map((b) => ({ ...b }));
  }
  /** The healthy backend with the fewest connections (ties: first in list order); it then has one more. */
  pick(key: string): string | null {
    return arc.todo();
  }
}

arc.test(LeastConnections, "picks the minimum, then counts it", (LC, expect) => {
  const lb = new LC([{ id: "a", healthy: true, connections: 5 }, { id: "b", healthy: true, connections: 1 }]);
  expect(["1", "2", "3", "4", "5"].map((k) => lb.pick(k))).toEqual(["b", "b", "b", "b", "a"]);
});
```

Everything about this form (classes, ids and markers, `expect`, hidden tests, laws, fakes by type, the customization layer, `migrate`) is on [[Code First]].

## More ways to write regions

Every form below predates code-first and stays fully supported: nothing is deprecated, and the forms mix in one project and one file. They are also the customization layer for code-first regions (a `defineRegion` whose `id` is a code-first region's attaches to it).

## Function regions

```ts
type F = (a: A, b: B) => R;                 // the type is the contract, and it's authoritative
export const fooSpec = arc.defineRegion<F>({
  id: "module.foo",                          // [a-z][a-zA-Z0-9]* segments joined by dots, unique per project
  symbol: "foo",                             // optional; default = last id segment
  intent: "…" | ["…", "…"],                  // guidance for the model; never treated as verified
  effects: [],                               // "clock" | "random" | "log"
  deps: ["./helpers.ts", "node:crypto"],     // the only imports a body may add
  examples: [{ name?: "…", args: [...], expected: …, tolerance?: 1e-6, exact?: false }, { args: [...], throws: true | "…" }],
  tolerance: 1e-9,                           // optional: the default numeric tolerance of every example
  calls: ["helpers.slug", "ports.fs.read"],  // optional: the only imported/port functions the body may call
  sketch: (a, b) => { … arc.hole<T>("…") … }, // optional: the body as typed code with holes (see Sketches)
  concept: "auth", fixtures: { … }, waive: { … }, // optional: a variant of a concept (see Concepts)
});
```

Four ways to say what a region does, which mix freely:

| Form | Checked? | Use it for |
|---|---|---|
| `examples` (and a concept's laws) | yes, in the sandbox | behaviour |
| `sketch` with `arc.hole<T>()` | yes: the generated body must be the sketch with only the holes filled (`OARC-E099`) | structure you already know |
| `ui` in a `*.spec.tsx` file | yes, in a rendered DOM | a component's structure and wiring |
| `intent` (and hole descriptions) | no | everything else; optional once a sketch or `ui` exists |

Where they disagree, the checked forms win: examples, then the sketch, then the UI structure, then `calls`/`effects`, then prose.

**Specs must be static.** Only JSON literals are allowed: no identifiers, spreads, calls or template substitutions. The compiler reads them without running your code (`OARC-E010` otherwise). Use the array form for long intents.

**The signature never comes from the model.** The compiler prints it from `F`, and the model only returns the body.

## How examples compare

`expected` is compared with deep equality, strict about structure and types, with three exceptions for numbers:

| Case | Rule |
|---|---|
| floats | `a` and `b` match when `\|a − b\| ≤ tolerance × max(1, \|a\|, \|b\|)`: relative for large values, absolute near zero. `tolerance` comes from the example, else the spec, else `1e-9` |
| `-0` | equals `0`. JSON can't write `-0`, so `fitLine` returning `[-0, 1, 0]` for a horizontal line passes `expected: [0, 1, 0]` |
| `NaN` | equals `NaN` |

`exact: true` on an example compares numbers bit for bit (`Object.is`: `-0` differs from `0`, no tolerance; `NaN` still equals `NaN`).

JSON has no `NaN`, `Infinity` or `undefined`, so write them as string tokens, in `expected` and in `args`: `"$NaN"`, `"$Infinity"`, `"$-Infinity"`, `"$undefined"`. The harness decodes them wherever they appear (fake `init` values excepted), and the `Example` type accepts them where `F` has a `number` or `undefined`:

```ts
type SegDist = (p: Point, a: Point, b: Point) => number;
examples: [{ args: [[1, 1], [2, 2], [2, 2]], expected: 1.4142135623730951 }, { args: [["$NaN", 0], [0, 0], [1, 0]], expected: "$NaN" }]
```

Failure messages print values faithfully: `got [-0,1,NaN]; expected [0,1,0]`, not `got [0,1,null]`.

Recursive types work in `F`: `type Nested = Array<number | null | undefined | Nested>` type-checks in `args` and `expected` (before 0.7.1 it was `TS2589` on the spec itself). The tokens are accepted down to 8 levels of nesting; deeper values are checked against the plain type.

## Examples that throw

Write `throws` instead of `expected` when the call must fail. `throws: true` passes when the call throws (or its promise rejects) with anything; a string passes when it appears in the error's message:

```ts
type Find = (xs: number[], x: number) => number;
examples: [
  { args: [[1, 3, 5], 5], expected: 2 },
  { args: [[1, 3, 5], 4], throws: "not found" },
  { args: [[], 1], throws: true },
]
```

An example has `expected` or `throws`, never both (the type rejects it). `fakesAfter` still applies after the throw, and a body that is still pending counts as pending, not as a throw. When a body returns instead, the failure says what it returned: `got {"returned":0}; expected {"throws":"not found"}`; a different message prints as `got {"throws":"<message>"}`. The context package shows these examples to the model like any other.

## Thin examples

Examples are the only behaviour OpenArc checks, and in the evaluation three regions passed every example while disagreeing with the original code on ordinary inputs (`coverage` 50/80, `outputFileName` 8/40, `resolveChannelId` 1 of 5 URL forms). Two tools help:

- **`OARC-W044`** warns, when a function region is compiled, if it has fewer than 3 examples (detail `examples:<n>`) or if no example has an edge-case argument: `""`, `[]`, `{}`, `0`, a negative number, `null`, or a `$NaN`/`$Infinity`/`$undefined` token (detail `no-edge-case`). It's a cheap syntactic heuristic, so a boundary such as `5` in a `1..5` range goes unnoticed.
- **`openarc check <id> --oracle <module>#<export>`** compares the compiled region with a reference implementation you already have (the code you are porting). It runs both, in the sandbox, on the examples' argument lists plus seeded variations of them (60 inputs, seed 1, so the run is reproducible), and prints every input where they disagree. Two results agree when they are equal under the rules above, or when both throw. Only arguments made of numbers, strings, booleans, and arrays or objects of those are varied; examples with fakes or `null` are skipped. Variations keep shapes: a top-level array changes length only if the examples show different lengths there (so `[x, y]` stays a pair), and strings are sometimes swapped for another example's string at the same position (enum-like values). The module must be inside the project and self-contained (only it is copied into the sandbox); `.js` works.

```
$ npx openarc check text.outputFileName --oracle legacy/text.js#outputFileName
  #14 args ["João","Mirão",2024,"x"]: got "Joo_Miro_2024_x.txt"; oracle "Joao_Mirao_2024_x.txt"
check text.outputFileName against legacy/text.js#outputFileName: 52/60 inputs agree (seed 1)
```

Add the inputs it finds as examples, and recompile.

## What is verified, and what isn't

| Guaranteed (mechanically checked) | Not guaranteed |
|---|---|
| The body type-checks against `F` | Behaviour beyond your examples |
| Only declared imports and effects | Following the `intent` prose |
| Your examples pass, in the sandbox | Identical output on a fresh regeneration |
| Hand edits are never overwritten | |
| A failed compile writes nothing | |
| A sketch region keeps its sketch (only holes are generated) | |
| A concept variant passes its concept's laws | |
| A UI component has the structure, labels and wiring its `ui` describes | |

## Block regions (mixed resolution)

Hand-write a function's control flow and leave the steps abstract:

```ts
export const stepSpec = arc.defineBlock({ id: "job.run.load", intent: "rows = await loadRows(db, req.table)" });

// @openarc:begin job.run
export async function run(db: Db, req: Req): Promise<Result> {
  let rows: Row[] = [];
  // @openarc:begin job.run.load
  arc.pending("job.run.load");
  // @openarc:end job.run.load
  if (rows.length === 0) return { ok: false };
  …
}
// @openarc:end job.run
```

Rules for blocks:
- **Say which functions it may call.** `calls: ["loadRows"]` (see below). A block is verified only through its function's examples, so `calls` is the cheapest way to pin down what it does.
- **No escaping control flow:** no `return`/`break`/`continue` out of the block, and no `this`, `arguments` or `super`. Arrow functions are transparent to `this` and `arguments`, so those are caught inside arrows too.
- **Communicate through `let` variables declared above the block.** The parent owns all control flow.
- **They're verified through the enclosing function's examples.** Sibling blocks are jointly re-verified before commit, and **some passing example must reach each block**: a block that every example returns before is unverified (`OARC-W045`), not cached as verified and not committed. Add an example that goes all the way through.

## Sketches: structure as code

When you know how a function should work, write it in the spec and leave holes only where you want the model. A sketch is real TypeScript, typed by `F`, read as syntax and never run:

```ts
export const passwordSpec = arc.defineRegion<Strategy<PasswordCred>>({
  id: "auth.password",
  calls: ["ports.users.recordFailure", "ports.clock.now"],   // what fills may call besides what the sketch calls
  examples: [/* … */],
  sketch: async (cred, ports) => {
    const email = arc.hole<string>("cred.email trimmed and lower-cased");      // expression hole: one expression of type T
    const user = await ports.users.findByEmail(email);
    if (user === null) return { ok: false, reason: "invalid" };
    const valid = await ports.hasher.verify(cred.password, user.passwordHash);
    arc.hole("if not valid, record the failure for user.id");                 // statement hole: 0..n statements
    return valid ? { ok: true, userId: user.id } : { ok: false, reason: "invalid" };
  },
});
```

- **Holes.** `arc.hole<T>("…")` as an expression is one expression of type `T` (written, or inferred: `const n: number = arc.hole("…")`). As a statement it is zero or more statements, with the block rules: no `return`, `break` or `continue` out of it, no `this`, no declaration the sketch uses later (`OARC-E035`). A function-valued hole (`arc.hole<(s: string) => string>("…")`) is a local helper. Descriptions are string literals; two statement holes in a row are ambiguous (`OARC-E010`).
- **Checked before the model.** The sketch type-checks against `F` with your file: a hole of the wrong type is `OARC-E070` (detail `sketch:TS<code>`) before any model call.
- **What the model does.** It sees the sketch with `«1»`, `«2»`… in place, one line per hole (its type and description), and replies `{"fills": {"1": "…", "2": "…"}}`. The compiler splices the fills (an expression fill is parenthesised) and commits the sketch with them as the region body. A model that sends a whole body anyway is not rejected outright: containment recovers its fills. With `outputFormat: "code"` there is no schema to carry per-hole fills, so the model is asked for the whole filled sketch as one code block and containment recovers the fills the same way.
- **Containment (`OARC-E099`).** The body must be the sketch with only the holes filled: comments, whitespace and quote style don't matter, anything else does (`body line 3 has 'invalid' where the sketch has "unknown"`).
- **Calls.** Fills may call what the sketch itself calls plus `calls` (`OARC-E098` otherwise). Most sketches need no `calls` at all. The sketch's own calls are never checked: you wrote them.
- **Coverage (`OARC-W045`, detail `hole:<id>#<n>`).** Every hole must be reached by a passing example, or the region isn't committed. Add an example that goes through it.
- **`OARC-E100`.** An example that fails without reaching any hole is decided by your sketch, so no fill can fix it: the compiler says so after one attempt instead of spending the rest.
- Parameter names come from the sketch, `intent` becomes optional, and callees the sketch calls are compiled first.

A block region is a statement hole in code you edit in place; a sketch keeps the structure in the spec and allows expression holes. Both stay.

## Concepts: one contract, many variants

A concept is a family of regions with a shared intent and **laws**, the rules every variant must obey. Each variant is an ordinary region that names the concept:

```ts
export const authConcept = arc.defineConcept({
  id: "auth",
  interface: "Strategy",       // optional: each variant's F must be Strategy<…> (else OARC-E020 concept-interface)
  intent: "Authenticate one credential. An unknown user gets the same answer as a wrong secret.",
  laws: [
    { name: "wrong secret is rejected", args: ["$fixture:wrong", "$fixture:ports"], expected: { ok: false, reason: "invalid" } },
  ],
});

export const apiKeySpec = arc.defineRegion<Strategy<ApiKeyCred>>({
  id: "auth.apiKey",
  concept: "auth",
  intent: "…",
  fixtures: { ports: { $fake: "palette.auth", init: { … } }, wrong: { apiKey: "k1.guess" } },
  waive: { "some law": "why it can't apply here" },
});
```

- Every law becomes an example of every variant, named `law: <name>`, with `"$fixture:<name>"` replaced by the variant's fixture (a missing one is `OARC-E010 fixture-missing:<name>`). Laws are as authoritative as your own examples.
- `waive` skips a law with a reason; `compile` prints it and the manifest provenance records it.
- Changing a law recompiles every variant. A region that calls a variant sees its signature and the concept's one-line summary, never its body.

To build a library of your own concepts (a worked `cache` concept with LRU and TTL variants), see [[Your own palette|Palette]]. The bundled palette built this way (auth, load balancing, p2p, a login page) is deprecated and frozen since 0.9.0.

## UI specs: TSX structure

A UI region's spec goes in a `*.spec.tsx` file and describes the component's rough structure with a small vocabulary; the region is a React component in the sibling `.tsx` file:

```tsx
/** @jsxImportSource open-arc/ui */
import * as arc from "open-arc";
import { ErrorText, Field, Form, Submit } from "open-arc/ui";

export type LoginPageFn = (props: LoginPageProps) => unknown;   // an exported type name: the component file imports it

export const loginPageSpec = arc.defineRegion<LoginPageFn>({
  id: "ui.loginPage",
  symbol: "LoginPage",
  ui: (props) => (
    <Form title="Sign in" onSubmit={props.onLogin} onSuccess={props.onSuccess}>
      <Field name="email" type="email" label="Email" required autoComplete="username" />
      <Field name="password" secret label="Password" required autoComplete="current-password" />
      <ErrorText />
      <Submit busyText="Signing in…">Sign in</Submit>
    </Form>
  ),
  examples: [{
    name: "a wrong password shows the error",
    args: [{ onLogin: { $fake: "action#onLogin", init: { returns: [{ ok: false, error: "Wrong email or password." }] } }, onSuccess: { $fake: "action#onSuccess" } }],
    script: [{ fill: { label: "Email", value: "ana@x.io" } }, { fill: { label: "Password", value: "nope" } }, { click: { role: "button", name: "Sign in" } }],
    dom: { text: ["Wrong email or password."], enabled: [{ role: "button", name: "Sign in" }] },
    fakesAfter: { "action#onLogin": { calls: [[{ email: "ana@x.io", password: "nope" }]] } },
  }],
});
```

- **Vocabulary:** `Form`, `Field`, `ErrorText`, `Submit` (from `open-arc/ui`). tsc checks the attributes; the compiler reads the tree without running it. Spreads, `.map`, conditionals, computed attributes and other tags are `OARC-E010` (`ui:*`): repetition and conditions belong in the intent. This built-in vocabulary is deprecated and frozen since 0.9.0: it keeps working unchanged, and the mechanism (the static reader, the DOM harness, `ui.dom`) stays supported; project-defined vocabularies come with code-first phase 5.
- **Checks, in a DOM in the sandbox:** derived structure and accessibility (each Field is an input whose accessible name is its label, with the right name, type, required and autocomplete; an alert for ErrorText; a submit button named by its text), a derived **wiring** example (fill every field, submit, the prop `Form onSubmit` points to is called once with `{ name: value }`, and while it is pending the submit button is disabled and shows `busyText`), then your examples: `script` steps (`fill` by label, `click` by role and name), `dom` assertions (`text`, `notText`, `enabled`, `disabled`) and `fakesAfter`.
- **`action#<name>`** is a built-in fake: a function that records its calls and returns `init.returns` in order.
- **Setup:** `"ui": { "dom": "jsdom" }` in `openarc.config.json`, and `jsdom`, `react`, `react-dom` (plus `@types/react` and `"jsx": "react-jsx"` in tsconfig) in the project. Without them a UI region is `OARC-E092` (`dom:not-configured`, `dom:jsdom-missing`, …) before any model call.

## `calls`: what a body may call

`calls` is an optional allowlist, on `defineRegion` and `defineBlock`, of the imported or port functions the body may call:

```ts
export const unlockSpec = arc.defineBlock({ id: "compile.run.unlock", intent: "await ports.fs.remove('.openarc/lock').", calls: ["ports.fs.remove"] });
export const parseStepSpec = arc.defineBlock({ id: "compile.run.parse", intent: "project = await engine.parse(ports, req, diagnostics);", calls: ["engine.parse"] });
```

Every call in the body whose root is one of the file's imports (or a requested import), or a parameter of type `Ports`, must match an entry exactly or a `prefix.*` entry (`"engine.*"`). Anything else is `OARC-E098 call not allowed by spec: <path> (allowed: …)`, and the model gets another attempt. Calls on locals (`diagnostics.push`, `rows.map`), on functions the body defines, and on globals (governed by `effects`) are never restricted. The prompt says "You may call exactly: …".

Why: in OpenArc's own self-compile, three `compile.run` blocks were cached as verified while doing the wrong thing: `unlock` released the lock and then re-ran parse through commit, `recover` ran a commit, and `analyze` parsed twice. Their function's only conclusive example returned before reaching them. With `calls`, all three are rejected before any example runs.

## Ownership states

| State | Meaning |
|---|---|
| `pending` | body is the placeholder; will be generated |
| `compiler` | body is exactly what OpenArc committed; may be regenerated when stale |
| `stale` (display only) | a `compiler` region whose spec (or, when known, fingerprint) no longer matches the manifest: the body was verified against an older spec. `graph`, `inspect` and watch show it; if its recompile fails, `compile` reports `OARC-W043` and exits 1. Ownership is still `compiler` |
| `developer` | you edited it, froze it, or wrote it yourself; never written by OpenArc |
| `conflicted` | spec changed under a developer-owned body, or markers were damaged; resolve explicitly |
