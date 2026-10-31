# Structured specs: sketches, concepts and UI structure

**Status:** design proposal, for approval. Nothing here is implemented in `stage0/` or `selfhost/`. · **Date:** 2026-10-31 · **Prototype:** `/tmp/claude-1000/-mnt-data-projetos/0a52dddd-ec03-4d58-8441-c8ccfe4d6411/scratchpad/structured-specs/` (throwaway, see §9)

## 1. Problem

Today a region is `arc.defineRegion<F>({ id, intent, examples, deps, effects, calls })`. The type and the examples are checked, and `calls` constrains the structure a little. Everything else the developer knows about *how* the function should work has to be written as prose in `intent`, and prose isn't verified (Writing-Specs: "Following the `intent` prose: not guaranteed").

Real specs already push past what prose can hold:

- The `compile.run.*` block intents in `stage0/src/compile.ts` are code written inside strings: `"project = await engine.parse(ports, req, diagnostics);"`. The developer knew the exact statement, wrote it as a string, and a model then had to retype it. Three of those blocks were cached as verified while doing the wrong thing (Design Log, self-compile 3), which is why `calls` and the coverage probe exist.
- Block regions are the only way to say "this structure, with gaps", and they cost a `defineBlock` statement, two marker lines, `let` variables for every output, and one model call per gap.
- There is no way to say "this is one of several authentication strategies, and all of them must obey the same rules", or "this is a form with these two fields wired to this action", other than prose.

The user's request: other ways to structure regions. Pseudo-code, reusable framework-level building blocks (an `auth` with many strategies), rough UI structure written as TSX, and not only prompts inside strings, while prose stays possible.

## 2. Goals and non-goals

Goals:

1. **Structure is code, and it is checked.** Whatever the developer writes as structure (a sketch, a component tree, a concept's rules) is type-checked by tsc before any model runs, and the generated code is mechanically checked to respect it.
2. **The model's job gets smaller.** A small local model (the default backend is `qwen3.5:9b` with 8,192 tokens) should fill gaps, not design functions.
3. **No new trust.** The safety model (§8.7 write scope, the sandbox, ownership) keeps every guarantee it has today. Nothing depends on the model following instructions.
4. **Per-function isolation stays.** A model still sees one region's context package and nothing else.
5. **Prose keeps working,** and can be mixed with every new form.

Non-goals: a general macro system, generated tests, cross-region refactoring, non-TypeScript targets, a UI design system.

## 3. The recommendation in one table

| Feature | Recommendation | Verified by |
|---|---|---|
| **Sketches** (§4) | `defineRegion<F>({ …, sketch: async (a, b) => { … arc.hole<T>("…") … } })`. The sketch is real TypeScript, typed by `F`. The model returns one fill per hole; the compiler splices them | tsc on the sketch (before any model call); AST containment of the generated body in the sketch (new `OARC-E099`); §3.4 restrictions on statement holes; calls implied by the sketch; a coverage probe per hole (W045) |
| **Concepts** (§5) | `arc.defineConcept({ id, intent, laws })`; variants are ordinary regions with `concept`, `fixtures` and `waive`. Compiled once and shared by import; never expanded per use | laws × fixtures become authoritative examples of each variant; users get the concept's summary and the variant's signature in their package |
| **UI structure** (§6) | `ui: (props) => <Form …><Field …/><Submit>…</Submit></Form>` in a `*.spec.tsx` file, typed by a small structure vocabulary, read statically as a JSON tree. Target: a React component | derived structure and accessibility checks plus a derived wiring example, and interaction-script examples, rendered with jsdom inside the existing sandbox |
| **Prose** (§7) | `intent` stays, becomes optional once a sketch or `ui` exists, and explains holes | not verified, as today; a sketch beats an intent |

The smallest valuable slice is **sketches for function regions** (§13, phase A). It needs no new dependency and no new file kind, and it changes the model's job from writing a function to writing a few expressions.

## 4. Sketches: pseudo-code as real TypeScript

### 4.1 Alternatives

| | Design | For | Against |
|---|---|---|---|
| **S1** (recommended) | The sketch lives **in the spec**: `sketch: (…) => { … }` inside `defineRegion`, contextually typed by `F`. The region body (between markers) is generated from it | One statement holds the whole contract. tsc checks the sketch for free (holes are typed, parameters come from `F`). Spec integrity (§8.7.3) already protects it, because it's inside a `defineRegion` statement. Ownership is unchanged: the sketch is spec, the body is compiler output | The file holds the sketch and the filled body, which are nearly the same text. Mitigation: the body can be folded in the editor, and specs can sit in a separate file (§4.8) |
| S2 | Holes **in place**: the developer writes the body inside markers, with `arc.hole()` where the gaps are, and the compiler rewrites only the hole spans | No duplicated text | Expression holes need inline markers, but markers are line comments only (§3.1) and that rule exists to keep the scanner sound (F2). After the first compile the sketch is gone from the file, so it would have to be reconstructed from the manifest. A hand edit can't be classified as "changed the structure" or "changed a fill" without span tracking |
| S3 | **Extend block regions**: allow expression blocks and lighter syntax | Reuses the current machinery | Still one `defineBlock`, two marker lines and one model call per gap. Expression positions don't fit line markers. It doesn't remove the `let` plumbing |

S1 wins because it adds no new marker grammar, keeps ownership as it is, and gets typing and integrity from mechanisms that already exist.

### 4.2 Syntax

```ts
export function hole<T = void>(description: string): T;   // new in open-arc; throws if ever run
```

- **Expression hole:** `arc.hole<T>("…")` anywhere an expression is allowed. The fill is exactly one expression of type `T`. `T` may be written or inferred from context (`const n: number = arc.hole("…")`).
- **Statement hole:** `arc.hole("…");` as a statement. The fill is 0..n statements, under the block-region restrictions of §3.4: no `return`, `break` or `continue` out of it, no `this`, and no declaration that is used after it.
- **Function-valued hole:** `const norm = arc.hole<(s: string) => string>("…")` gives the model a local helper to write, still one expression.
- **Steps that don't exist yet:** a sketch calls other regions, including pending ones (`session.create` below). PLAN compiles a region's callees first (§8.1 change). While a callee is still pending, examples that reach it are inconclusive, as for sibling blocks (§8.10).
- `description` must be a string literal (it is part of the static spec). Holes are numbered in source order: `«1»`, `«2»`, and so on.
- `intent` becomes optional when `sketch` is present.

The sketch is read as syntax and never run. At runtime it is a function value that nothing calls.

### 4.3 What the model returns

```json
{ "fills": { "1": "cred.email.trim().toLowerCase()", "2": "user.lockedUntil > ports.clock.now()",
             "3": "if (!valid) await ports.users.recordFailure(user.id);" },
  "imports": [] }
```

The compiler splices each fill into the sketch. An expression fill is wrapped in parentheses, so it cannot change how the code around it parses. A model that returns a whole body anyway (the F13 habit) is not rejected outright: the containment check (§4.4) recovers the fills from it, or rejects it. The prototype does both (§9.1).

### 4.4 Verification

Before any model call, at VALIDATE:

1. **tsc on the sketch.** The sketch is contextually typed by `F`, so the parameters, the return type and every hole's type are checked. A wrong hole type is a TS error in the developer's own file (prototype: `arc.hole<number>` where `findByEmail` expects a string gives TS2345).

For each candidate, at STATIC:

2. **Containment (`OARC-E099`, new): the generated body is the sketch with holes replaced, and nothing else changed.** The check walks the sketch's AST and the body's AST in parallel. An expression hole matches any single expression subtree. A statement hole matches 0..n consecutive statements (sequence alignment with backtracking; two adjacent statement holes are a spec error, since they would be ambiguous). Every other node must have the same kind and the same children, and every leaf token the same text (string literals compare by value, so `'x'` equals `"x"`). Comments and whitespace are ignored. The result is either the list of fills or the first mismatch, reported as `body line 3 has "invalid" where the sketch has "unknown"`.
3. **Statement-hole restrictions (`OARC-E035`).** The existing `block.checkRestrictions` runs on each statement fill, with `usedAfter` set to the sketch bindings referenced after the hole. The prototype calls stage0's function unchanged.
4. **Calls (`OARC-E098`).** Each fill is checked against the implied allowlist (§4.6).
5. **tsc, effects, imports, splice and spec integrity:** unchanged (§7, §8.7).

At SANDBOX:

6. **Examples** run as today. **Coverage:** the staged sandbox copy gets a probe in every hole: `(globalThis.__openarcHit?.("id#n"), (fill))` for expressions, and a probe statement for statement holes. A hole that no passing example reaches is unverified (`OARC-W045`, detail `hole:<id>#<n>`). The prototype shows this with the concept laws alone: hole 2 (the lock check) is never reached, so W045 fires until the "locked account" example is added.
7. **Sketch versus example conflict (`OARC-E100`, new, cheap).** If an example fails and its run reached **no** hole, its result is fully determined by the developer's code, and no fill can fix it. The compiler reports E100 (detail = the example name) right away instead of spending the remaining attempts.

### 4.5 Relation to block regions

A block region is a statement hole whose sketch is the developer-owned parent text, held in place with markers. A sketch generalises it:

| | Block regions (today) | Sketch |
|---|---|---|
| gap kinds | statements only | expressions, statements, function-valued expressions |
| outputs from a gap | `let` declared above the block, assigned inside | the hole's value (`const x = arc.hole<T>(…)`) |
| specs per function | 1 + one `defineBlock` per gap, plus 2 marker lines per gap | 1 |
| model calls | one per block | one per region (all holes together) |
| verification | joint check of sibling blocks (§8.10), probe per block | one candidate, probe per hole, no joint check needed |
| structure owner | the developer edits the parent in place | the sketch, inside the spec |

Recommendation: **keep block regions** (the self-hosted compiler uses them, and they remain the way to fill gaps in code a developer edits in place). The two share code: the restriction check, the probe and the `«child»` slot logic. Whether to migrate `selfhost/` from blocks to sketches is open question 5.

### 4.6 The `calls` allowlist, implied

The sketch's own calls on restricted roots (imports, and parameters of a ports type, as in §7 rule 6) form the **implied allowlist**. The fills may call `implied ∪ spec.calls`. The sketch's own code is never checked against `calls`, because the developer wrote it. In the prototype the sketch implies `ports.users.findByEmail` and `ports.crypto.verifyPassword`, `spec.calls` adds `ports.users.recordFailure` and `ports.clock.now`, and a fill that calls `ports.crypto.sha256` gets E098. A sketch that needs no extra calls needs no `calls` field at all: `app.login` below has none. See open question 2.

### 4.7 Worked example: a non-UI function (`compile.run` as a sketch)

This is the real `compile.run` from `stage0/src/compile.ts`, rewritten. Today it is a hand-written parent, 9 `defineBlock` specs, 18 marker lines and 9 model calls, and most of the block intents are code in strings. As a sketch, those intents simply become code. Two real gaps remain as holes. The file type-checks against stage0's actual `engine.ts`, `txn.ts` and `types.ts` (`app/compileRun.ts` in the prototype, `tsc -p .` gives 0 errors).

```ts
export const runSpec = arc.defineRegion<Run>({
  id: "compile.run",
  intent: "One compile transaction (§8). Disk is untouched unless every target passes STATIC and SANDBOX.",
  calls: ["ports.newTxId"],
  examples: [/* the three existing examples, unchanged */],
  sketch: async (ports, req) => {
    const diagnostics: Diagnostic[] = [];
    const txid = ports.newTxId();
    let modelCalls = 0;
    const done = (exit: 0 | 1): CompileResult => ({ exit, diagnostics, modelCalls });

    if (!(await ports.fs.createExclusive(".openarc/lock"))) {
      diagnostics.push({ code: "OARC-E095" });
      return done(1);
    }
    try {
      for (const id of await recover(ports.fs)) diagnostics.push({ code: "OARC-W094", detail: id });
      const project = await engine.parse(ports, req, diagnostics);
      if (hasErrors(diagnostics) || project === null) return done(1);
      await engine.analyze(ports, req, project, diagnostics);
      if (hasErrors(diagnostics)) return done(1);
      const targets = engine.plan(project, req, diagnostics);
      if (targets.length === 0 && !engine.manifestChanged(project)) return done(hasErrors(diagnostics) ? 1 : 0);

      const candidates: Candidate[] = [];
      for (const id of targets) {
        const r = await engine.generate(ports, req, project, id, diagnostics);
        modelCalls += r.modelCalls;
        if (r.candidate !== null) candidates.push(r.candidate);
        else if (arc.hole<boolean>("stop the run here? (true unless req.keepGoing)")) return done(1);
      }
      const staged: StagedFile[] = await engine.stage(ports, req, project, candidates, txid, diagnostics);
      if (staged.length === 0) return done(1);
      await commit(ports.fs, planJournal(txid, arc.hole<{ target: string; staged: string }[]>(
        "each staged file's target, staged at .openarc/txn/<txid>/stage/<index>")));
      return done(hasErrors(diagnostics) ? 1 : 0);
    } finally {
      await ports.fs.remove(".openarc/lock");
    }
  },
});
```

What changes: 1 spec instead of 10, 1 model call instead of 9, and 2 one-line expressions to generate. The three bugs from self-compile 3 (unlock re-running the pipeline, recover running a commit, analyze parsing twice) can't happen, because that code is no longer generated, and containment rejects any change to it. The coverage probe also gives an honest finding: none of the three existing examples makes `engine.generate` fail, so hole 1 would get W045 until an example covers `keepGoing`.

The other worked sketch, `auth.password`, is in §5.4.

### 4.8 Where sketches live

The sketch sits inside the `defineRegion` call, in the region's file or in a separate spec file (`login.spec.ts`). The compiler already finds specs in every `src/` file, but SPEC §3.2 says "in the same file or in a file imported by it", and that wording would be widened. See open question 1.

## 5. Concepts: typed, reusable building blocks

### 5.1 Alternatives

| | Design | For | Against |
|---|---|---|---|
| **K1** (recommended) | A **concept is a family of regions**. It declares an interface (a TS type), its laws (example templates) and an intent. Each variant is an ordinary region that names the concept. Variants are compiled once and shared by import | Nothing new at runtime. Per-function isolation is untouched: a user of `auth.password` sees its signature, never its body. Laws become ordinary examples, run by the existing harness. Caching is per variant | Variants that are almost the same are still compiled separately (that's cheap) |
| K2 | **Templates expanded per use**: `auth.password` expands into each caller's body, as a sketch with holes | Each use can be specialised | The same code is generated N times, verified N times and cached N times. Every caller's package grows. A law violation shows up in the caller's examples, far from its cause. It breaks "compiled once" |
| K3 | **A hand-written library plus configuration**: `createAuth({ strategies })` | No compiler work | Not a spec at all: the model never fills anything, and the laws aren't connected to verification |

K1 is the smallest change that makes "auth covers many kinds of auth" checkable. A template form (K2) can come later, and only if it turns out to be needed. It would be a sketch that a concept exports.

### 5.2 Declaring a concept

```ts
// The interface is a plain TS type; the variants are regions of that type.
export type Strategy<C> = (cred: C, ports: AuthPorts) => Promise<AuthResult>;

export const authConcept = arc.defineConcept({
  id: "auth",
  intent: ["Authenticate one credential against stored users. Every strategy returns an AuthResult and never throws for bad input.",
           "Never put a secret in the result."],
  laws: [
    { name: "valid credential authenticates", args: ["$fixture:valid", "$fixture:ports"], expected: { ok: true, userId: "u1" } },
    { name: "wrong secret is rejected",       args: ["$fixture:invalid", "$fixture:ports"], expected: { ok: false, reason: "invalid" } },
    { name: "unknown user",                   args: ["$fixture:unknown", "$fixture:ports"], expected: { ok: false, reason: "unknown" } },
  ],
});
```

- **Interface:** a TS type, usually generic in the variant's input. A variant's `F` must be an instance of it. VALIDATE checks that with the §2.4 assignability mechanism, against an interface named in the concept (`interface: "Strategy"`, a string, so the spec stays static).
- **Invariants become laws:** example templates. The string `"$fixture:<name>"` is replaced, anywhere in `args`, `expected` or `fakesAfter`, by the variant's `fixtures[name]`. It is pure JSON substitution, so it stays statically evaluable. Each law becomes an ordinary example named `law: <name>`, authoritative (tier 1, §9.1).
- **Opting out:** a law that can't apply to a variant needs an explicit `waive: { "<law>": "<reason>" }`. The reason is printed in the compile output and stored in the manifest provenance. A missing fixture without a waiver is `OARC-E010`, detail `fixture-missing:<name>`. The prototype has a real case: an API key has no user name, so "unknown user" is waived for `auth.apiKey`.
- **Properties beyond examples** (for example "the result never contains the secret", over generated inputs): later (phase D), as a developer-written predicate module run in the sandbox, as authoritative as a fake. Until then a law's `expected` carries it.

### 5.3 Variants: a sketch and a prose one

```ts
export const passwordSpec = arc.defineRegion<Strategy<PasswordCred>>({
  id: "auth.password",
  concept: "auth",
  intent: "Email and password. Emails compare case-insensitively.",
  calls: ["ports.users.recordFailure", "ports.clock.now"],
  fixtures: {
    ports:   { $fake: "auth.memory", init: { users: [{ id: "u1", email: "ana@x.io", passwordHash: "h:secret", apiKeyHash: "s:k1", lockedUntil: null }], now: 1000 } },
    valid:   { email: " Ana@X.io ", password: "secret" },
    invalid: { email: "ana@x.io", password: "nope" },
    unknown: { email: "bob@x.io", password: "secret" },
  },
  examples: [
    { name: "locked account", args: [{ email: "ana@x.io", password: "secret" }, { $fake: "auth.memory", init: { /* lockedUntil: 5000, now: 1000 */ } }], expected: { ok: false, reason: "locked" } },
    { name: "expired lock is ignored; a failure is recorded", args: [/* lockedUntil: 500, wrong password */], expected: { ok: false, reason: "invalid" },
      fakesAfter: { "auth.memory": { failures: ["u1"] } } },
  ],
  sketch: async (cred, ports) => {
    const email = arc.hole<string>("cred.email trimmed and lower-cased");
    const user = await ports.users.findByEmail(email);
    if (user === null) return { ok: false, reason: "unknown" };
    if (user.lockedUntil !== null && arc.hole<boolean>("the lock is still active at ports.clock.now()")) return { ok: false, reason: "locked" };
    const valid = await ports.crypto.verifyPassword(cred.password, user.passwordHash);
    arc.hole("if not valid, record the failure for user.id");
    return valid ? { ok: true, userId: user.id } : { ok: false, reason: "invalid" };
  },
});

export const apiKeySpec = arc.defineRegion<Strategy<ApiKeyCred>>({
  id: "auth.apiKey",
  concept: "auth",
  intent: "Look the user up by ports.crypto.sha256(cred.apiKey) with ports.users.findByApiKeyHash. No match is 'invalid'. Locks don't apply.",
  calls: ["ports.crypto.sha256", "ports.users.findByApiKeyHash"],
  fixtures: { ports: { /* same fake */ }, valid: { apiKey: "k1" }, invalid: { apiKey: "k2" } },
  waive: { "unknown user": "an API key carries no user name, so a non-matching key is indistinguishable from a wrong one" },
});
```

### 5.4 Using a concept: the `login` region

A region uses a concept by importing and calling the variant. There is no new `uses` field: the calls are the use, and the sketch implies the allowlist.

```ts
type Login = (cred: auth.PasswordCred, ports: AppPorts) => Promise<LoginResult>;

export const loginSpec = arc.defineRegion<Login>({
  id: "app.login",
  examples: [
    { name: "wrong password", args: [/* … */], expected: { ok: false, error: "Wrong email or password." } },
    { name: "unknown email gets the same message", args: [/* … */], expected: { ok: false, error: "Wrong email or password." } },
    { name: "locked", args: [/* … */], expected: { ok: false, error: "Account locked. Try again later." } },
  ],
  sketch: async (cred, ports) => {
    const r = await auth.password(cred, ports);
    if (!r.ok) return { ok: false, error: arc.hole<string>("user-facing message for r.reason; 'unknown' and 'invalid' get the same text") };
    const s = await session.create(r.userId, ports);            // session.create is a pending region: PLAN compiles it first
    return { ok: true, token: s.token, expiresAt: s.expiresAt };
  },
});
```

An umbrella "auth that covers many types" is a hand-written dispatcher or a three-line sketch (`switch (cred.kind) { case "password": return auth.password(cred, ports); … }`). It needs no feature of its own.

### 5.5 What the model sees

When **compiling a variant**, the package (prototype output, §9.3) adds one `Concept` section: the concept's intent, plus the note "your examples include the concept's laws (marked `law:`) with this variant's fixtures". The laws arrive as concrete examples. Other variants are never shown.

When **compiling a user** (`app.login`), the section "Functions the sketch calls" lists each callee's signature. For a concept variant it adds a one-line comment: the concept's intent and the names of its laws. The callee's body and its examples are not shown. That's the per-function isolation principle: the caller is told what `auth.password` promises, and the promise is enforced where it belongs, in `auth.password`'s own verification.

Concepts are regions, compiled once. The fingerprint of a variant includes its concept's spec hash (intent and laws), so changing a law recompiles every variant. A user's stable-view hash includes the concept's one-line summary, so editing the concept's intent invalidates its users' caches, and nothing else does.

## 6. TSX structure specs for UI

### 6.1 Alternatives

| | Design | For | Against |
|---|---|---|---|
| **U1** (recommended) | **JSX in the spec**, typed by a structure vocabulary: `ui: (props) => <Form …>…</Form>` in a `*.spec.tsx` file with `/** @jsxImportSource open-arc/ui */`. The compiler reads it statically into a JSON tree | Real TSX, as the user asked: tsc checks attribute names and types and the references (`<Field nme=…>` is TS2322 in the prototype). It's statically readable, and the arrow's parameter gives typed `props.x` references | Needs a separate spec file (one JSX runtime per file: the vocabulary for the spec, React for the component) |
| U2 | TSX in a **string** (`ui: "<Form>…</Form>"`), parsed by the compiler | Valid JSON today, no new file kind | No editor typing or completion. It is exactly the "prompting inside strings" the user wants to move away from |
| U3 | A **TSX sketch**: the real component with holes (`{arc.hole<ReactNode>("…")}`) | The strongest structural guarantee, and it falls out of §4 once `.tsx` regions exist | Not "rough": the developer writes the real markup. It remains available for anyone who wants it (phase D) |

### 6.2 The accepted static subset

`ui` must be an arrow function with zero or one parameter whose body is (optionally parenthesised) JSX. Inside it:

```
node      = element | fragment | text
element   = "<" Tag attr* "/>" | "<" Tag attr* ">" child* "</" Tag ">"      Tag = Identifier (a vocabulary word)
fragment  = "<>" child* "</>"
attr      = Name                                   → true
          | Name "=" StringLiteral                 → the string
          | Name "=" "{" json "}"                  → a JSON literal, by the §2.2 rules
          | Name "=" "{" ref "}"                   → {"$ref": "props.onLogin"}
ref       = (param | importBinding) ("." Identifier)*
child     = node | "{" StringLiteral "}" | "{" /* comment */ "}"
```

Rejected with `OARC-E010` and a detail token: spreads (`ui:spread`), any other expression child, such as `.map`, conditionals or calls (`ui:child-expression:…`), computed attributes (`ui:expression:…`), namespaced or dotted tags (`ui:tag:…`), and lowercase tags (the vocabulary declares no intrinsic elements, so tsc rejects them too). The prototype covers each case (§9.2). Repetition and conditionals belong in the intent, or in a TSX sketch (U3).

References: `props.*` wire the structure to a prop, which an example can fake. A reference rooted at an import (`{auth.password}`) means the component calls that import directly. That implies a `calls` entry, and it can't be faked, so it should be used for pure helpers. Actions should arrive through props, for the same reason ports are parameters (§7 rule 5).

### 6.3 The worked example: `LoginForm.spec.tsx`

```tsx
/** @jsxImportSource open-arc/ui */
import * as arc from "open-arc";
import { ErrorText, Field, Form, Submit } from "open-arc/ui";
import type { PasswordCred } from "./auth.ts";
import type { LoginResult } from "./types.ts";
import type { ReactElement } from "react";

export type LoginFormProps = { onLogin: (cred: PasswordCred) => Promise<LoginResult>; onSuccess: (token: string) => void };
type LoginForm = (props: LoginFormProps) => ReactElement;

export const loginFormSpec = arc.defineRegion<LoginForm>({
  id: "app.loginForm",
  intent: "While submitting, disable the button and show busyText. A failed result shows its error; success calls onSuccess(token).",
  ui: (props) => (
    <Form title="Sign in" onSubmit={props.onLogin} onSuccess={props.onSuccess}>
      <Field name="email" type="email" label="Email" required autoComplete="username" />
      <Field name="password" secret label="Password" required autoComplete="current-password" />
      {/* the failure message from onLogin */}
      <ErrorText />
      <Submit busyText="Signing in…">Sign in</Submit>
    </Form>
  ),
  examples: [{
    name: "wrong password shows the error and keeps the form",
    args: [{ onLogin: { $fake: "action#onLogin", init: { returns: [{ ok: false, error: "Wrong email or password." }] } },
             onSuccess: { $fake: "action#onSuccess" } }],
    script: [{ fill: { label: "Email", value: "ana@x.io" } }, { fill: { label: "Password", value: "nope" } },
             { click: { role: "button", name: "Sign in" } }],
    dom: { text: ["Wrong email or password."], enabled: [{ role: "button", name: "Sign in" }] },
    fakesAfter: { "action#onLogin": { calls: [[{ email: "ana@x.io", password: "nope" }]] }, "action#onSuccess": { calls: [] } },
  }],
});
```

The full stack: `app.loginForm` (UI) gets `onLogin` wired at the composition root to `app.login` (sketch), which calls `auth.password` (a concept variant, sketched) and `session.create` (prose).

### 6.4 The vocabulary

Each vocabulary word has three parts. The first slice ships `Form`, `Field`, `ErrorText` and `Submit` in `open-arc/ui`.

1. A **typed declaration** (`declare function Field(p: { name: string; label: string; type?: …; secret?: boolean; required?: boolean; autoComplete?: string }): UiNode`), so tsc checks the spec.
2. A **meaning**, one line in the context package (for example "Field: `<label for=id>` plus `<input id name type required autocomplete>`; secret means type=password").
3. A **derived check** in the harness that verifies that meaning in the rendered DOM.

Project-defined vocabularies (for example a `<DataTable>` word with its own checker module, written by the developer and as authoritative as a fake) are phase D.

### 6.5 Verification

All of this runs **in the existing sandbox** (§9.2), in the region's examples run:

1. **Derived structure and accessibility checks**, generated from the JSON tree (tier "Derived", §9.1, like contract binding): a `<form>`, a heading with the title, and, for each `Field`, an input whose **accessible name** is its label (`label[for]` or `aria-label`), with the right `name`, `type`, `required` and `autocomplete`. Also a `role=alert` element for `ErrorText`, and a `type=submit` button whose name is the `Submit` text.
2. **A derived wiring example:** fill every field, click Submit, and check that the faked `onSubmit` reference (`props.onLogin`) was called once with `{name: value}` for every field. No developer input is needed.
3. **Interaction-script examples** from the spec: `fill` by label, `click` by role and name, then `dom.text` and `dom.enabled` assertions, and `fakesAfter` on the action fakes. Elements are always found by accessible name, so a script doubles as an accessibility check.
4. tsc, static rules, write scope and ownership: unchanged.

**Feasibility, checked on this machine:**

- jsdom and happy-dom are **not** in `stage0/node_modules`. jsdom 25.0.1 and React 18.3.1 are installed in another project here (`/mnt/data/GrapplingArc/GrapplingArcWeb/node_modules`), and the prototype used them read-only.
- They run **inside the exact §9.2 sandbox** (bwrap with `--unshare-all`, `prlimit --as=32 GiB`, `node --permission --allow-fs-read=/work --max-old-space-size=512`), with `node_modules` bound read-only at `/work/node_modules`. The good component passes in 0.38 s wall time, and a miswired one fails with a precise message (§9.4). jsdom needs no worker, child process or network.
- **Node can't strip JSX:** `node x.tsx` gives `ERR_UNKNOWN_FILE_EXTENSION`. So STAGE must transpile `.tsx` files (`ts.transpileModule`, which is already a dependency), or the harness must register an in-thread load hook (`module.registerHooks`, Node ≥ 23.5, so no worker is needed, which matters because `--allow-worker` isn't granted). The prototype pre-transpiled; the hook variant is not tested.

Recommendation: the DOM library comes from the **project's own devDependencies** (`"ui": { "dom": "jsdom" }` in `openarc.config.json`), and open-arc doesn't bundle it. If it's missing, UI regions get `OARC-E092` (detail `dom:jsdom-missing`), and there's no unverified fallback. See open question 4.

Harness extensions this needs: `$fake` anywhere inside an argument (today only top-level arguments), named instances (`"action#onLogin"`: fake file `action`, instance `onLogin`), and `script` and `dom` on examples.

## 7. Prose intents, and mixing the forms

`intent` stays as it is (a string or an array of strings). It becomes optional when `sketch` or `ui` is present. Hole descriptions are local intents.

**Precedence**, from strongest to weakest. A stronger form wins where they disagree, and only the checked forms can make a compile fail:

| Rank | Form | Checked? | On conflict |
|---|---|---|---|
| 1 | `examples` and concept laws | yes (sandbox) | authoritative |
| 2 | `sketch` | yes (containment, E099) | the model can't change it. Sketch versus example: `OARC-E100` as soon as a failing example reaches no hole |
| 3 | `ui` structure | yes (derived checks) | the structure is required; the intent can only add to it |
| 4 | `calls`, `effects`, `deps` | yes (static) | as today |
| 5 | hole descriptions | no | guidance for that hole only |
| 6 | `intent` | no | the package's rules say: "If the intent disagrees with the sketch or the structure, they are right" |

Prose contradictions can't be detected mechanically, and the design doesn't pretend they can. What it does is move everything checkable out of prose.

## 8. How this interacts with the existing guarantees

| Guarantee | Effect |
|---|---|
| **Write scope (§8.7)** | Unchanged and strengthened. The model still returns data. Fills are spliced by the compiler, with expression fills parenthesised. Containment (E099) is an extra structural check inside the region. The splice check (byte-identical outside the markers) and spec integrity are unchanged, and integrity extends to `defineConcept` statements and to `*.spec.tsx` files, which the compiler never writes |
| **Fingerprints and caching (§4)** | `specHash` covers the sketch through the §4.1 normalisation (comments count, because the model sees them) and the `ui` tree through canonical JSON. A variant's `specHash` includes its concept's spec hash. The fingerprint adds the vocabulary version for UI regions (the compiler version, while the vocabulary is built in). Later: a per-hole cache, so editing one hole's description doesn't regenerate the others (phase D) |
| **Ownership and hand edits (§6)** | No change. The region body is `compiler`-owned. Any hand edit, inside a fill or not, makes it `developer` (W060). The sketch is spec: editing it while the region is `developer` is E061, as with any spec change |
| **`calls` (E098)** | Implied from the sketch (§4.6). `ui` references rooted at imports add implied entries too. `spec.calls` only ever adds |
| **Coverage (W045)** | One probe per hole (prototype: `run 1, laws only` gives W045 on hole 2). UI regions: the derived wiring example covers the form's action |
| **Small-model budgets (§8.8)** | Measured in the prototype (§9.3). With the default 9B budget of 17,920 characters: `auth.password` uses 4,248 characters (24%), `app.login` 3,573 (20%), `app.loginForm` 2,720 (15%). The model writes 142 characters of fills for `auth.password` instead of a 539-character body (3.8 times less), and 111 characters for `app.login`. The package adds the sketch, which is the function itself, so it is about as large as the old intent plus examples, but the output and the room for error shrink. A sketch never escalates to L2 (whole file): a context failure inside a hole escalates to L1, as for blocks |

## 9. Prototype results

The prototype lives in `/tmp/claude-1000/-mnt-data-projetos/0a52dddd-ec03-4d58-8441-c8ccfe4d6411/scratchpad/structured-specs/`. It needs Node 25.9.0, uses the TypeScript compiler API from `stage0/node_modules/typescript`, and calls stage0's own `block.checkRestrictions`. **No model was run** (the GPU was busy with a benchmark). Every "model output" is a hand-written file under `candidates/`, labelled as such in its first line.

| File | What |
|---|---|
| `arc.ts` | stand-in DSL with the proposed `sketch`, `hole`, `defineConcept`, `concept`, `fixtures`, `waive` and `ui` |
| `app/auth.ts` | the `auth` concept, `auth.password` (sketch) and `auth.apiKey` (prose) |
| `app/login.ts`, `app/session.ts` | `app.login` (sketch using the concept) and `session.create` (prose, pending) |
| `app/LoginForm.spec.tsx`, `ui/` | the TSX structure spec and the vocabulary (`jsx-runtime.ts`, `vocab.ts`) |
| `app/compileRun.ts` | §4.7: `compile.run` as a sketch, type-checked against stage0's real modules |
| `proto.ts` | (a) containment, calls, restrictions and the coverage run; (b) the static TSX reader; (c) law expansion and context packages |
| `ui-stage.ts`, `ui-harness.mjs` | `.tsx` transpile, and the DOM harness for the UI feasibility run |

Commands:

```bash
cd /tmp/claude-1000/-mnt-data-projetos/0a52dddd-ec03-4d58-8441-c8ccfe4d6411/scratchpad/structured-specs
/mnt/data/projetos/openarc/stage0/node_modules/.bin/tsc -p .     # sketches, concept, TSX spec, compile.run sketch
node proto.ts a      # sketches
node proto.ts b      # TSX → JSON
node proto.ts c      # concept laws + context packages
node ui-stage.ts && <bwrap … node --permission … ui-harness.mjs ./.stage-ui/LoginForm.<variant>.mjs>   # see §9.4
```

### 9.1 (a) Sketch: typing, containment, calls, coverage

```
$ tsc -p .
(no output, exit 0)

$ node proto.ts a
tsc on the project as written (sketches + scaffolds): 0 errors
tsc with hole 1 retyped arc.hole<number>: app/auth.ts(50,48): TS2345 Argument of type 'number' is not assignable to parameter of type 'string'.
holes: #1 expr "cred.email trimmed and lower-cased" | #2 expr "the lock is still active at ports.clock.now()" | #3 stmt "if not valid, record the failure for user.id"
implied calls (from the sketch): ports.users.findByEmail, ports.crypto.verifyPassword; spec.calls adds: ports.users.recordFailure, ports.clock.now

per-hole replies (compiler splices, then re-checks):
  password.fills.json: ACCEPTED (contained; fills recovered: {"1":"cred.email.trim().toLowerCase()","2":"user.lockedUntil > ports.clock.now()","3":"if (!valid) await ports.users.recordFailure(user.id);"}; tsc 0 errors; calls ok)
  password.escape.fills.json: contained, fills {…,"3":"if (!valid) { await ports.users.recordFailure(user.id); return { ok: false, reason: \"invalid\" }; }"}
    but REJECTED:
    OARC-E035 hole 3: return
  password.offlist.fills.json: contained, fills {…,"3":"if (!valid) await ports.users.recordFailure(ports.crypto.sha256(user.id));"}
    but REJECTED:
    OARC-E098 hole 3: call not allowed by spec: ports.crypto.sha256 (allowed: ports.users.findByEmail, ports.crypto.verifyPassword, ports.users.recordFailure, ports.clock.now)

whole-body replies (model ignored the format; containment recovers or rejects):
  password.whole-good.body.ts: ACCEPTED (contained; fills recovered: {"1":"cred.email.trim().toLowerCase()","2":"user.lockedUntil > ports.clock.now()","3":"if (!valid) {\n  await ports.users.recordFailure(user.id);\n}"}; tsc 0 errors; calls ok)
  password.whole-bad.body.ts: REJECTED E099 sketch not preserved: body line 3 has `"invalid"` where the sketch has `"unknown"`
  password.whole-dropped.body.ts: REJECTED E099 sketch not preserved: body line 4 has `const valid = await ports.crypto.verifyPassword(cred.password, user.pa` where the sketch has `if (user.lockedUntil !== null && arc.hole<boolean>("the lock is still `

spliced body (what would be committed):
  |     const email = (cred.email.trim().toLowerCase());
  |     const user = await ports.users.findByEmail(email);
  |     if (user === null) return { ok: false, reason: "unknown" };
  |     if (user.lockedUntil !== null && (user.lockedUntil > ports.clock.now())) return { ok: false, reason: "locked" };
  |     const valid = await ports.crypto.verifyPassword(cred.password, user.passwordHash);
  |     if (!valid) await ports.users.recordFailure(user.id);
  |     return valid ? { ok: true, userId: user.id } : { ok: false, reason: "invalid" };

examples for auth.password = concept laws (with this variant's fixtures) + its own:
  run 1, laws only:
    pass law: valid credential authenticates  (reached 1,3)
    pass law: wrong secret is rejected  (reached 1,3)
    pass law: unknown user  (reached 1)
    → examples 3/3; OARC-W045 unreached hole(s): 2 (not cached as verified)
  run 2, laws + own examples:
    pass law: valid credential authenticates  (reached 1,3)
    pass law: wrong secret is rejected  (reached 1,3)
    pass law: unknown user  (reached 1)
    pass locked account  (reached 1,2)
    pass expired lock is ignored; a failure is recorded  (reached 1,2,3)
    → examples 5/5; every hole reached by a passing example
```

The two rejected whole bodies pass tsc. `whole-bad` is a plausible "helpful" model edit (hiding user enumeration), and only containment catches it. The example runs used a plain `node` import of a staged copy, not bwrap; the real harness would run them in the sandbox.

### 9.2 (b) The TSX spec read statically into JSON

`ts.createSourceFile(…, ScriptKind.TSX)` parses the file, and nothing in it is executed:

```
$ node proto.ts b
{
  "param": "props",
  "root": {
    "tag": "Form",
    "props": { "title": "Sign in", "onSubmit": { "$ref": "props.onLogin" }, "onSuccess": { "$ref": "props.onSuccess" } },
    "children": [
      { "tag": "Field", "props": { "name": "email", "type": "email", "label": "Email", "required": true, "autoComplete": "username" }, "children": [] },
      { "tag": "Field", "props": { "name": "password", "secret": true, "label": "Password", "required": true, "autoComplete": "current-password" }, "children": [] },
      { "tag": "ErrorText", "props": {}, "children": [] },
      { "tag": "Submit", "props": { "busyText": "Signing in…" }, "children": [ "Sign in" ] }
    ]
  }
}
tsc on the spec file (typed by the vocabulary): 0 errors
tsc with <Field nme=…>: app/LoginForm.spec.tsx(18,14): TS2322 Type '{ nme: string; type: "email"; label: string; required: true; autoComplete: string; }' is not assignable to type '{ name: string; label: string; type?: "number" | "text" | "email" | "tel" | undefined; secret?: boolean …
  a .map() child: OARC-E010 ui:child-expression:props.fields.map((f) => <Field name={f}
  a spread attribute: OARC-E010 ui:spread
  a conditional child: OARC-E010 ui:child-expression:props.busy ? <ErrorText /> : null
  a computed attribute: OARC-E010 ui:expression:"Sign " + "in"
```

(The JSON is printed with two-space indentation by the script and compacted here.)

### 9.3 (c) The concept, and what a 9B model would receive

```
$ node proto.ts c
auth.password: 3 law examples
  {"name":"law: valid credential authenticates","args":[{"email":" Ana@X.io ","password":"secret"},{"$fake":"auth.memory","init":{…}}],"expected":{"ok":true,"userId":"u1"}}
  {"name":"law: wrong secret is rejected","args":[{"email":"ana@x.io","password":"nope"},{"$fake":"auth.memory",…}],"expected":{"ok":false,"reason":"invalid"}}
  {"name":"law: unknown user","args":[{"email":"bob@x.io","password":"secret"},{"$fake":"auth.memory",…}],"expected":{"ok":false,"reason":"unknown"}}
auth.apiKey: 2 law examples; waived: unknown user (an API key carries no user name, so a non-matching key is indistinguishable from a wrong one)
  {"name":"law: valid credential authenticates","args":[{"apiKey":"k1"},…],"expected":{"ok":true,"userId":"u1"}}
  {"name":"law: wrong secret is rejected","args":[{"apiKey":"k2"},…],"expected":{"ok":false,"reason":"invalid"}}
```

The full context package for **`app.login`**, verbatim (the region that uses the concept):

```
## Task
Fill the numbered holes «n» in the sketch. Everything else is fixed and is checked to be unchanged.
Reply {"fills": {"1": "<code>", ...}, "imports": []}.

## Sketch of export const login: Login (fixed)
// Login = (cred: PasswordCred, ports: AppPorts): Promise<LoginResult>
async (cred, ports) => {
    const r = await auth.password(cred, ports);
    if (!r.ok) return { ok: false, error: «1» };
    const s = await session.create(r.userId, ports);
    return { ok: true, token: s.token, expiresAt: s.expiresAt };
  }

## Holes
«1» one expression of type string: user-facing message for r.reason; 'unknown' and 'invalid' get the same text

## Types (verbatim)
type Login = (cred: auth.PasswordCred, ports: AppPorts) => Promise<LoginResult>;
export type PasswordCred = { email: string; password: string };
export interface AppPorts extends AuthPorts { sessions: SessionPort }
export interface AuthPorts { users: UsersPort; crypto: CryptoPort; clock: ClockPort }
export interface UsersPort {
  findByEmail(email: string): Promise<User | null>;
  findByApiKeyHash(hash: string): Promise<User | null>;
  recordFailure(userId: string): Promise<void>;
}
export interface User { id: string; email: string; passwordHash: string; apiKeyHash: string | null; lockedUntil: number | null }
export interface CryptoPort { verifyPassword(password: string, hash: string): Promise<boolean>; sha256(s: string): string }
export interface ClockPort { now(): number }
export interface SessionPort { insert(s: Session): Promise<void>; newToken(): string }
export interface Session { token: string; userId: string; expiresAt: number }
export type LoginResult = { ok: true; token: string; expiresAt: number } | { ok: false; error: string };
export type Strategy<C> = (cred: C, ports: AuthPorts) => Promise<AuthResult>;
export type AuthResult = { ok: true; userId: string } | { ok: false; reason: "invalid" | "locked" | "unknown" };
type CreateSession = (userId: string, ports: AppPorts) => Promise<Session>;

## Functions the sketch calls
auth.password: Strategy<PasswordCred>  // variant of concept auth: Authenticate one credential against stored users. Every strategy returns an AuthResult and never throws for bad input. Never put a secret in the result. Laws: valid credential authenticates; wrong secret is rejected; unknown user.
session.create: CreateSession

## Calls allowed in fills
You may call exactly: auth.password, session.create. Calls on locals are fine.

## Examples (deep equality; {"$fake": name} is a test double)
{"name":"wrong password","args":[{"email":"ana@x.io","password":"x"},{"$fake":"app.memory","init":{…}}],"expected":{"ok":false,"error":"Wrong email or password."}}
{"name":"unknown email gets the same message","args":[…],"expected":{"ok":false,"error":"Wrong email or password."}}
{"name":"locked","args":[…],"expected":{"ok":false,"error":"Account locked. Try again later."}}

## Rules
…

[size] 3573 chars ≈ 1021 tokens; budget for the default 9B backend 17920 chars (20% used)
[output] the model writes 111 chars
```

The `auth.password` package has the same shape. Its sketch shows `«1»`, `«2»` and `«3»` in place, the Holes section gives each hole's type (`string`, `boolean`, statements), a `Concept` section is added, and the examples are the 3 laws plus the variant's own 2. Size: `4248 chars ≈ 1214 tokens … (24% used)`. Output: `the model writes 142 chars; a whole body would be 539 chars`.

The `app.loginForm` package contains: the fixed signature, the structure re-printed as TSX, one line of meaning per vocabulary word, the prop types, the intent and the interaction example. Size: `2720 chars ≈ 777 tokens … (15% used)`.

Known simplification: the Holes section prints declared types, not narrowed ones (`user` shows as `User | null` inside hole 2, where tsc knows it is `User`). The real implementation can ask the checker for a narrowed type at the hole position.

### 9.4 UI feasibility: jsdom and React inside the sandbox

`candidates/LoginForm.tsx` is a hand-written stand-in for the model's component. `ui-stage.ts` transpiles it, plus two hand-broken variants, with `ts.transpileModule`. `ui-harness.mjs` runs the derived checks from the §9.2 JSON and the spec's interaction example:

```
$ bwrap --unshare-all --die-with-parent --new-session --ro-bind . /work --ro-bind <GrapplingArcWeb>/node_modules /work/node_modules \
    --ro-bind /usr /usr --ro-bind <node-prefix> <node-prefix> --symlink usr/lib64 /lib64 --symlink usr/lib /lib --symlink usr/bin /bin \
    --tmpfs /tmp --proc /proc --dev /dev --chdir /work \
  prlimit --as=34359738368 --cpu=20 <node-bin> --permission --allow-fs-read=/work --max-old-space-size=512 \
    /work/ui-harness.mjs ./.stage-ui/LoginForm.<variant>.mjs

good:      PASS: 2 fields + form + error + submit structure, a11y names, derived wiring example, 1 interaction example(s)   (0.38 s wall)
miswired:  FAIL
             wiring: props.onLogin called with [[{"email":"a@b.co","password":"a@b.co"}]], want [[{"email":"a@b.co","password":"v-password"}]]
             wrong password shows the error and keeps the form: action#onLogin {"calls":[[{"email":"ana@x.io","password":"ana@x.io"}]]}, want {"calls":[[{"email":"ana@x.io","password":"nope"}]]}
unlabelled (outside bwrap, node --permission only):
           FAIL
             Field password: no input labelled "Password" (a11y: accessible name)
             wrong password shows the error and keeps the form: no field "Password"
             …
```

A side finding that repeats F8: `which node` gave the asdf shim. The sandbox needs `process.execPath` (`/home/vetor/.asdf/installs/nodejs/25.9.0/bin/node`), exactly as §9.2 already says.

## 10. SPEC sections that would change

| § | Change |
|---|---|
| §1 Scope | add sketches, concepts and UI structure specs to the DSL row; `.tsx` regions (UI phase) |
| §2.1 Types | `RegionSpec`: `intent` becomes optional when `sketch` or `ui` is set; new `sketch?: F`, `ui?: (...a: Parameters<F>) => UiNode`, `concept?`, `fixtures?`, `waive?`. New `hole<T>()`, `defineConcept()`, `ConceptSpec`. `Example` gains `script` and `dom` (UI) |
| §2.2 Static evaluability | two values are read as **syntax** and never evaluated: `sketch` (an arrow or function expression) and `ui` (the JSX subset of §6.2). `"$fixture:"` substitution. New E010 details |
| §2.4 Contract binding | a variant's `F` must be assignable to its concept's interface |
| §3.2 | specs may live in any `src/` file, including `*.spec.tsx` files that are never imported |
| §4.2 / §4.3 | `specHash` covers the normalised sketch, the canonical `ui` JSON and the concept's hash; the fingerprint adds the vocabulary version |
| §7 | rule 6: calls implied by the sketch. New rule 7: containment (E099). §3.4 restrictions apply to statement holes |
| §8.1 PLAN | callee regions (from sketch calls) before callers; E100 stops the repair loop early |
| §8.4 | output schema `{fills, imports}` for sketch regions |
| §8.7 | spec integrity covers `defineConcept` statements and spec-only files |
| §8.8 | package sections: Sketch, Holes, Functions the sketch calls (with concept summaries), Concept, Structure, Vocabulary meaning |
| §8.9 | a whole-body reply to a sketch region goes through containment to recover its fills |
| §8.10 | one coverage probe per hole; W045 detail `hole:<id>#<n>` |
| §9.1 | laws are authoritative; UI-derived checks are Derived |
| §9.2–9.4 | `.tsx` transpile at STAGE (or an in-thread load hook); a DOM from the project's devDependencies; nested `$fake` and `name#instance`; interaction scripts |
| §11 | new codes `E099 sketch not preserved`, `E100 example fails without reaching any hole`; E092 detail `dom:*` |
| §12 | conformance cases: a sketch filled correctly; a whole-body reply that alters non-hole code (E099); a statement hole with `return` (E035); a fill calling an off-list port (E098); an unreached hole (W045); a sketch contradicting an example (E100); a waived law; a TSX spec with `.map` (E010) |

## 11. Open questions

1. **Where does the sketch live?** Recommended: inside `defineRegion({ sketch })`, in the region's file or in a spec file. A separate `arc.sketch(id, fn)` statement is the alternative. One statement keeps the contract in one place and gets contextual typing and spec integrity for free.
2. **What may fills call?** Recommended: what the sketch itself calls, plus `spec.calls`. The alternatives are only `spec.calls` (strict, but every sketch then needs a list) or unrestricted when `calls` is absent (today's default for regions). The recommended rule makes most sketches need no `calls` at all, and it still stops a hole from wandering into unrelated ports.
3. **UI target.** Recommended: React first (the component is a real `.tsx` file, which is what people will deploy). A framework-agnostic target (a plain vnode tree) is easier to verify without a DOM, but nobody ships it.
4. **The DOM for UI verification.** Recommended: the project's own `jsdom` devDependency, opted into in `openarc.config.json`, with E092 when it is missing and no unverified fallback. Bundling happy-dom into `open-arc` adds weight for users who never write UI, and static-only checks can't run interaction scripts.
5. **Block regions versus sketches in `selfhost/`.** Recommended: keep block regions, don't deprecate them, and convert `compile.run` to a sketch as the phase A benchmark (attempts and passes on `qwen3.5:9b`, blocks versus sketch). Decide on deprecation from that data.

## 12. Risks

- **Containment and formatting.** The check ignores whitespace and comments and compares string literals by value. Other equivalent rewrites (`a.b` versus `a["b"]`, reordered object keys) are rejected. That is deliberate: the compiler splices the fills itself, so only whole-body replies can hit it, and those are already non-conforming.
- **Holes inside the sketch's own nested functions** (for example inside a `.map` callback) work in the prototype's matcher, but the statement restrictions then apply relative to that callback. That needs a conformance case.
- **UI checks are as good as the vocabulary.** The derived checks verify the vocabulary's meaning, not the visual design. Layout, styling and focus order are out of scope.

## 13. Phased implementation plan

| Phase | Ships | Why first or next | Size |
|---|---|---|---|
| **A: sketches** (the smallest valuable slice) | `arc.hole`, `RegionSpec.sketch`, the static reading of `sketch`, `{fills}` output plus whole-body recovery, containment E099, statement-hole restrictions (reusing `block.checkRestrictions`), implied calls, per-hole probes, E100, the Sketch and Holes package sections, specHash. Benchmark: `compile.run` as blocks versus as a sketch on `qwen3.5:9b` | No new dependency, no new file kind, no harness change. It directly addresses the self-compile 3 failure class, and it is the change that most reduces the model's job | about the size of the `calls` plus coverage work in 0.6.3: one engine module (matcher, splice), package sections, tests in the style of `selfhost/tests/v063.check.ts` |
| **B: concepts** | `defineConcept`, `concept`/`fixtures`/`waive`, law expansion, interface assignability, PLAN ordering by region calls, concept summaries in callers' packages | Builds on A (variants are often sketches). Pure JSON plus planning, no runtime change | small |
| **C: UI structure** | `.tsx` regions (transpile or in-thread hook), the `*.spec.tsx` reader, `open-arc/ui` with 4 words, the DOM harness with derived checks and interaction scripts, nested and named fakes, the `ui.dom` config | The largest piece: a new file kind, a new runtime dependency (the project's jsdom) and harness work | medium |
| **D: later, if needed** | per-hole cache, narrowed hole types, project-defined vocabularies with checker modules, TSX sketches (U3), property checks for concepts, a concept-template form (K2) | Each is independent and none is needed for the first three | — |

Nothing in phase A changes how existing specs compile: a spec without `sketch` takes exactly today's path.
