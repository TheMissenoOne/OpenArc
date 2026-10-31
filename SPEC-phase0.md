# OpenArc — Phase 0 Technical Specification

**Version:** 0.3.0-draft. Revised after self-hosting (`selfhost/WALKTHROUGH.md`) and after the stage 0 implementation (`stage0/`). · **Date:** 2026-10-31 · **Status:** for review, not implemented

The keywords MUST, MUST NOT, SHOULD, and MAY are normative. Diagnostics use the code `OARC-Exxx` (error) or `OARC-Wxxx` (warning). Section 11 lists every code.

---

## 1. Scope

| Component | v0 |
|---|---|
| Source | TypeScript ≥ 5.8, with `erasableSyntaxOnly: true`, `strict: true` |
| Spec DSL | `defineRegion<F>` (function regions), `defineBlock` (block regions) |
| Region identification | Line-comment markers + a manifest |
| Ownership | Non-overlapping, nested, hash-based |
| Model backend | One Ollama instance, structured output |
| Verification | tsc, static effect/import check, developer examples in a sandbox |
| Reverse | Provenance (manifest), and `openarc extract` of whole functions (§10). Extraction of arbitrary selections is Phase 5 |
| Editor | Out of scope for this document. It consumes the manifest (§5) |

**Non-goals for v0:** operator algebra, CUE/TypeSpec, projection or virtual documents, same-region three-way merge, non-TS targets, LLM-written authoritative tests, extraction of arbitrary selections.

---

## 2. The DSL (`openarc`)

### 2.1 Types

```ts
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type Effect =
  | "clock"   // Date, performance.now
  | "random"  // Math.random, crypto.getRandomValues
  | "log";    // console.*

export interface Example<F extends (...a: any[]) => any> {
  name?: string;
  args: Parameters<F>;
  expected: Awaited<ReturnType<F>>;   // compared with deep strict equality (§9.3)
}

export interface RegionSpec<F extends (...a: any[]) => any> {
  id: string;                 // §2.3
  symbol?: string;            // default: last id segment
  intent: string | string[];  // non-verifiable guidance; array form joined with single spaces [F1]
  effects?: Effect[];         // default []
  deps?: string[];            // allowed import specifiers, default []
  examples?: Example<F>[];    // authoritative tests, default []
  refine?: "concrete" | "next"; // default "concrete"; "next" is reserved, v0 rejects it (OARC-E041)
}

export interface BlockSpec {
  id: string;
  intent: string | string[];
  effects?: Effect[];
  deps?: string[];
}

export function defineRegion<F extends (...a: any[]) => any>(spec: RegionSpec<F>): RegionSpec<F>;
export function defineBlock(spec: BlockSpec): BlockSpec;
export function todo(id: string): never;    // pending FUNCTION body; throws OpenArcTodoError(id)
export function pending(id: string): void;  // pending BLOCK body; throws too, but typed void [F4]
```

Convention: import as `import * as arc from "openarc"`. The rest of this document writes `arc.todo` and so on.

At runtime, `defineRegion` and `defineBlock` return their argument unchanged. Removing them from production builds is a later build transform (not v0). Implementations MUST NOT rely on tree shaking.

### 2.2 Static evaluability

The compiler reads specs **without executing them**. A spec call MUST satisfy all of the following:

- It is the initializer of a module-scope `const` (exported or not).
- Its argument is an object literal whose values are JSON literals (strings, numbers, booleans, `null`, arrays, object literals). It has no identifiers, spreads, template expressions with substitutions, or computed keys.
- `F` is a type reference or function type literal that resolves to exactly one call signature.

Violation: `OARC-E010`. Async functions are allowed. `expected` is compared against the awaited result.

### 2.3 Identifiers

```
id      = segment { "." segment }
segment = lower { lower | upper | digit }
lower   = "a".."z" ; upper = "A".."Z" ; digit = "0".."9"
```

- IDs are unique per project (`OARC-E011` on a duplicate).
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

---

## 3. Region grammar

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

The compiler finds its spec with `defineRegion` whose `id` equals the marker id, in the same file or in a file imported by it. `S` must equal `spec.symbol` (`OARC-E021`).

**(B) Block region.** One or more complete statements, contiguous, all in the *same* block of an enclosing function body (or of a nested block). Its spec is `defineBlock` with the matching id. Block regions MUST be nested (directly or transitively) inside an (F) region (`OARC-E032`).

Anything else (a partial statement, a class member, top-level non-function statements, statements from two different blocks): `OARC-E033`.

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

---

## 4. Hashing

### 4.1 Normalized owned text

`norm(region)` is computed as follows:
1. Take the region's body lines. Replace each direct child region (its begin marker through its end marker) with the single line `/*«openarc-child:<id>»*/`.
2. Parse the result with `ts.createSourceFile(…, setParentNodes = true)`. Walk `node.getChildren()` depth-first, skipping JSDoc nodes. For each leaf, emit its leading comment ranges, then `leaf.getText()` if it is non-empty, then its **trailing** comment ranges. Each comment is emitted once, trimmed. `getLeadingCommentRanges` alone misses a comment on the same line as code, so editing `x = 1; // why` would not change the hash. The examples caught this in stage 0.
3. Join with U+0020.

The **raw scanner MUST NOT be used**. It doesn't rescan template continuations or regex literals, so whitespace inside `` `a ${b}   c` `` or `/a  b/` would be dropped. A semantic edit could then keep the old hash and be silently overwritten. This was verified while self-hosting. [F3] Comments count as edits; whitespace outside literals does not.

`hash(region) = "sha256:" + hex(sha256(utf8(norm(region))))`

A formatter run therefore never changes ownership. Editing a child never changes the parent's hash.

### 4.2 Spec hash

`specHash = sha256(canonicalJson(specLiteral) + "\n" + printType(F))`. Here `canonicalJson` means sorted keys and no whitespace, and `printType` uses `checker.typeToString` with `NoTruncation`. For (B), the `printType` part is the canonical JSON of `{reads, writes}`.

### 4.3 Fingerprint (cache key)

```
fingerprint = sha256(canonicalJson({
  specHash,
  parentSpecHash,            // null for (F)
  depContracts: sorted list of printed export types of every module in spec.deps that is project-local,
  model: { name, digest },   // digest from Ollama GET /api/tags
  options: { temperature, seed, num_ctx },
  promptTemplate: "<version>",
  compiler: "<openarc version>",
  typescript: "<version>"
}))
```

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
      "ownership": "compiler",          // §6
      "hash": "sha256:…",               // hash at last commit
      "specHash": "sha256:…",           // spec hash at last commit
      "fingerprint": "sha256:…",        // fingerprint that produced the body; null if never generated
      "contract": null,                 // block regions: { reads:[…], writes:[…] }
      "provenance": {
        "source": "generated",          // "generated" | "extracted" | "scaffold"
        "model": "qwen2.5-coder:14b@sha256:…",
        "attempts": 2,
        "verifiedBy": ["tsc", "static", "examples:3/3"],
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

### 6.4 Rename

A changed id is treated as removal of the old id (`OARC-E062` until resolved with `--unlink`) plus a new region. v0 does not track renames.

---

## 7. Static verification rules

Static rules are applied to the owned text of each **candidate** body, and to the whole staged program for tsc. They are best-effort. The sandbox (§9.2) is the security boundary.

1. `tsc --noEmit` on the staged program, with the project tsconfig, MUST produce zero errors (`OARC-E070`).
2. Imports: every import specifier in the candidate MUST appear in `spec.deps`, or be `openarc` (`OARC-E071`). Dynamic `import()` and `require` are always rejected (`OARC-E072`).
3. Forbidden free identifiers, unless allowed by `effects`: `process`, `globalThis`, `global`, `window`, `self`, `eval`, `Function`, `fetch`, `XMLHttpRequest`, `WebSocket`, `Deno`, `Bun`, `setTimeout`, `setInterval`, `queueMicrotask` (`OARC-E073`).
4. Effect-gated identifiers: `Date`, `performance` need `clock`; `Math.random` and `crypto` need `random`; `console` needs `log` (`OARC-E074`).
5. Any other capability (DB, network, filesystem, env) MUST arrive as a parameter of `F` (ports or injected dependencies). There is no effect token for it. This is what lets examples run against fakes.

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
| PARSE | Load the tsconfig program. Find spec calls (§2.2) and markers (§3.1) | E010, E030, E031, W001 |
| ANALYZE | Pair specs with markers. Build the region tree. Compute hashes and ownership (§6.2), block contracts (§3.5) and fingerprints | E011, E012, E021, E032–E035, E061–E063 |
| VALIDATE | Contract binding (§2.4) on the **current** code. Example typing (tsc). `refine` | E020, E041, E070 |
| PLAN | Select targets: pending regions, plus `compiler` regions whose fingerprint ≠ `m.fingerprint`, restricted to the requested ids and their descendants. Skip `developer`/`conflicted` regions with W060/E061. Order: children before parents (post-order). Parents are generated with children as opaque `«openarc-child»` slots. | — |
| GENERATE | Cache lookup by fingerprint. On a miss, call the model (§8.4). A connection error (`ECONNREFUSED`, `fetch failed`) is retried once after 10 s. After 3 consecutive E080s in one run, the remaining targets are skipped without calling the backend (E080, detail `stopped:3-consecutive`) | E080 (backend unreachable), E081 (schema invalid) |
| STATIC | Splice the candidate into an in-memory copy. Apply §7 | E070–E074 |
| SANDBOX | Run the examples of the enclosing (F) region(s) (§9) | E090 (example failed), E091 (timeout/limit), E092 (sandbox unavailable) |
| repair | If STATIC or SANDBOX fails and attempts < 3, go back to GENERATE with a repair prompt (§8.5). Otherwise ABORT for this run | E082 (attempts exhausted) |
| STAGE | Write every changed file to `.openarc/txn/<txid>/`, plus the new manifest. When PLAN found no targets but ownership changed (a W060 transition to `developer`, a new hand-written region), STAGE and COMMIT still run with the manifest alone, so the transition is recorded once and a later spec change is detected as E061. Write `.openarc/txn/<txid>/journal.json` listing `{target, backupOf}` | E093 (I/O) |
| COMMIT | For each file: copy the original to the journal backup, then `rename(staged, target)`. Then rename the manifest. Delete the journal last. | — |

### 8.2 Crash recovery

At startup, every `openarc` command checks `.openarc/txn/*/journal.json`. If one exists, it restores every `backupOf` file over its target, deletes the txn directory, and emits `OARC-W094`. This makes multi-file commits all-or-nothing.

### 8.3 Concurrency

`.openarc/lock` is taken with an exclusive create (`O_EXCL`) for the whole run and holds the creator's PID. If it's held: `OARC-E095`. Before taking it, `compile`, `extract` and `watch` remove a **stale** lock, one whose PID is not a running process (`kill(pid, 0)` fails with ESRCH), with a warning. A lock without a PID is stale only once it is 10 s old.

### 8.4 Model request

Function regions: the compiler prints the signature from `F` (the parameter names and types come from the call signature). The model returns **only the statements of the body**. Block regions: the model returns the statements between the markers.

Request: `POST {OLLAMA_HOST}/api/chat`, `stream: false`, `options: {temperature: 0, seed: <cfg>, num_ctx: <cfg>}`, `format:` the JSON schema below, `keep_alive` from config. Hosted providers send the same schema in their own structured-output field (§13).

```json
{
  "type": "object",
  "required": ["body"],
  "additionalProperties": false,
  "properties": {
    "body":    { "type": "string" },
    "imports": { "type": "array", "items": {
      "type": "object", "required": ["from", "names"], "additionalProperties": false,
      "properties": { "from": { "type": "string" }, "names": { "type": "array", "items": { "type": "string" } } } } }
  }
}
```

The prompt is the versioned template `PROMPT_TEMPLATE` (`src/model.ts`) filled with a **context package** (§8.8) and, on retries, a repair section (§8.5).

The compiler, not the model, merges `imports` into the file's import list after checking them against rule §7.2. Child slots in a parent body MUST appear verbatim as the line `/*«openarc-child:<id>»*/`. The compiler replaces each one with the child's current full region text. A missing or duplicated slot is `OARC-E083`.

### 8.5 Repair prompt

This is the original request plus the previous `body` plus the diagnostics (code, message, and for E090 the example name with expected and actual values). Attempts are capped at 3 total per node per run.

### 8.6 Cache

`.openarc/cache/<fingerprint>.json = {body, imports, verifiedBy}` is written only after SANDBOX passes. A cache hit still goes through STATIC and SANDBOX, because neighbouring code may have changed. If nothing changed, a run makes **zero** model calls.

---

### 8.7 Write scope (structural)

The model never writes files. It returns `{body, imports}` as data, and the compiler is the only writer. The following are enforced **in code, independent of any prompt**:

1. **Containment.** `body` must parse, with no syntax errors, as exactly one statement when wrapped as `async function __region() {\n<body>\n}`. A body that closes its braces to escape (`}; export const xSpec = …; function q() {`) is rejected. A body containing `@openarc:` is rejected, because markers belong to the compiler. → `OARC-E097`
2. **Splice.** After splicing, every line outside the region's markers is byte-identical to before. The only exception is added `import { … } from "<specifier>"` lines, and only for specifiers in `deps`. → `OARC-E097`
3. **Spec integrity.** At STAGE, only files under `src/` may change, never tests, fakes or core. In every changed file, the text of every `defineRegion`/`defineBlock` statement is byte-identical to the file on disk. → `OARC-E097` (detail `spec-integrity`), and nothing is written.
4. **Examples are static.** The harness receives the examples from the compiler's static extraction (§2.2) through `harness-plan.json`, not from the module's runtime `spec.examples`. A body that mutates its spec object at runtime cannot weaken its own tests. The sandbox mounts the stage read-only.

The executable form is `selfhost/tests/write-scope.check.ts`.

### 8.8 Context packages and adaptive budgets

A region is compiled the way a unit test isolates code. The model receives a deterministic **context package** built from the type graph, never whole files by default:

| Level | Adds |
|---|---|
| L0 contract | the fixed signature, the **type closure** of `F` (every project-local type alias or interface reachable from the signature, verbatim), intent, effects, allowed imports, examples, rules |
| L1 dependencies | the file's import lines; exported value signatures of local modules the file imports or the spec lists in `deps`, plus their type closure |
| L2 source | the region's whole file |

Block regions always start at L1, plus the variables in scope (`let`/`const`/params with checker-printed types) and the enclosing function with `<<<HERE>>>`.

The **budget** is `(maxContextTokens − outputReserveTokens) × 3.5` characters for the selected backend (§13). Optional sections are dropped (full file first, then helpers, then imports) until the package fits.

Under "Allowed new imports", each package (non-relative) dep is followed by the exact import declaration the project already uses for it, most frequent value import first (e.g. `import ts from "typescript";`, which needs a default import), or by the bare specifier if the project never imports it.

**Escalation by failure type.** If attempt *n* fails with a missing name, property or export (TS2304/2305/2339/2551/2552/2724), or with the wrong import form for a module (TS2595/TS1259/TS2497), that's a context problem, so attempt *n+1* expands one level. Any other failure is repaired at the same level, with the diagnostics. The last attempt uses `fallbackBackend` if one is configured.

The hash of the initial context package is part of the fingerprint (§4.3). A change in any type the region depends on therefore invalidates the cache.

### 8.9 Model output normalisation [F13]

Small models often return a whole function when asked for a body. If a function region's `body` parses as a single function declaration or a `const` bound to an arrow or function expression, the compiler unwraps it to the inner statements (or `return <expr>;`). Markdown fences are stripped. This normalisation runs **before** the write-scope checks.

### 8.10 Joint verification of sibling blocks [F14]

Block regions are verified through their function's examples, but sibling blocks can only pass those examples together. While generating a block, an example outcome that fails only because another block is still `arc.pending` is **inconclusive**, not a failure. At STAGE, every function whose blocks were generated in this run must pass **all** its examples with every candidate applied. Otherwise the run aborts with `OARC-E090` (detail `joint:…`) and nothing is written.

A generated block is committed **only** if its function passed that joint check (or has no examples, W041). If a sibling block is still pending (it failed under `--keep-going`, or it was outside the requested ids), the joint check cannot run: the generated blocks of that function are **held back** (`OARC-W042`, detail `waiting:<function id>`) and stay pending on disk and in the manifest. Their verified bodies stay in the cache, so a later run that completes the siblings commits them without a model call. Under `--keep-going`, a failed joint check holds back that function's blocks (`OARC-E090`) instead of aborting the run.

## 9. Verification

### 9.1 Tiers

| Tier | Source | Can fail a compile |
|---|---|---|
| Authoritative | `examples` written by the developer in specs; project tests under `tests/` that are not in `tests/advisory/` | yes |
| Derived | Generated mechanically from authoritative data (v0: the contract-binding check §2.4) | yes |
| Advisory | Model-written tests, under `tests/advisory/` | no; reported only (`OARC-W096`) |

The compiler output MUST list exactly what was checked, for example `examples 3/3, tsc, static` (stored in `provenance.verifiedBy`). Passing means "these checks passed", not "the region is correct".

### 9.2 Sandbox

Each example run executes the staged program in a fresh process:

```
bwrap --unshare-all --die-with-parent --new-session \
      --ro-bind <stage> /work --ro-bind /usr /usr --ro-bind <node-prefix> <node-prefix> \
      --symlink usr/lib64 /lib64 --symlink usr/lib /lib --symlink usr/bin /bin \
      --tmpfs /tmp --proc /proc --dev /dev --chdir /work \
  prlimit --as=<bytes ≥ 4294967296> --cpu=<sec> \
  <node-bin> --permission --allow-fs-read=/work \
       --max-old-space-size=<heapMb> /work/.openarc/harness.mjs <id>
```

The executable form is `selfhost/src/sandbox.ts` (`sandbox.buildArgv`). The following were verified on the target machine (Fedora 43, Node v25.9.0, bwrap) [F8]:
- `<node-bin>` MUST be the **resolved** binary. A version-manager shim (asdf/nvm/volta) on `PATH` silently resolved to `/usr/bin/node` v22 inside the sandbox. `<node-prefix>` is its install prefix, bound read-only.
- `/usr` plus the `/lib64`, `/lib` and `/bin` symlinks are needed for the dynamic loader on merged-`/usr` distros.
- `prlimit --as` below 4 GiB crashes V8 at startup (it can't reserve the pointer-compression cage). Loading any `.ts` file needs **≥ 16 GiB**, because Node's type stripper (amaro) is WebAssembly and each WASM memory reserves about 10 GiB of virtual address space. The default is 32 GiB. That limit is virtual address space, not RAM: the heap is capped by `--max-old-space-size`, and `--as` is only a backstop.
- Observed results: network → `ENETUNREACH` (bwrap netns); fs write → `ERR_ACCESS_DENIED` (permission model); `process.exit(7)` in generated code → exit 7 and a truncated harness output (see §9.3).

- No `--allow-net`, `--allow-child-process`, `--allow-worker`, `--allow-addons`, `--allow-wasi`, or `--allow-fs-write`.
- Wall-clock timeout: 10 s per region (configurable).
- Node ≥ 23.6 runs `.ts` directly via type stripping. That's why `erasableSyntaxOnly` is required (§1).
- `bwrap` and `node --permission` are both required. If either is missing, the result is `OARC-E092`, and there is no fallback to unsandboxed execution. (Verified on the target machine: Node v25.9.0 with `--allow-net`, and `/usr/bin/bwrap` present.)

### 9.3 Harness

For each example, the harness calls `S(...args)`, awaits the result, and compares it to `expected` using `node:util` `isDeepStrictEqual`. Output on stdout is JSON lines `{name, ok, actual?}`, followed by a final `{done: n}`. A thrown error counts as a failure, with the actual result recorded as `{throws: message}`. A run is **complete** only if the `done` line is present and `n` equals the number of outcome lines. Generated code can call `process.exit()`, so a missing `done` line counts as a failure (`OARC-E090`, detail `incomplete`) even if every printed outcome passed. [F8]

### 9.4 Fakes [F6]

An example argument may be `{"$fake": "<name>", "init"?: <Json>}`. The harness replaces it with the instance from `tests/fakes/<name>.ts`, whose default export is `defineFake<T>((init) => ({ instance, snapshot }))`. Within one example, a name denotes one instance.

`fakesAfter: { "<name>": <Json> }` compares `snapshot()` after the call. For functions returning `void`, `expected` is omitted (enforced by the type), and `fakesAfter` is the assertion.

Fakes are developer-authored and authoritative (§9.1). They run inside the sandbox under the same static rules as regions. The compiler checks that `T` is assignable to the parameter type at that position.

---

## 10. Reverse (Phase 0 subset)

`openarc inspect <id>` and `openarc graph` read the manifest and markers only. A region whose `provenance.source` is `"extracted"` has a spec the developer wrote, but its implementation was not generated.

**"Extract as Abstraction"** (the editor/CLI `openarc extract-region <file> <startLine> <endLine> <id>`):
1. The selection is widened to whole statements. If it does not satisfy §3.2 (B) and §3.4, the command fails with the specific diagnostic code.
2. The command inserts markers and a `defineBlock({id, intent: "TODO"})` at module scope, and records `{kind: "block", ownership: "developer", source: "extracted"}`. The body is unchanged, so no regeneration happens until `openarc release`.
3. It MAY ask the model to propose an `intent`. The proposal is written as `intent` prefixed with `"[inferred] "`, which is left for the developer to remove.

**`openarc extract <file> [--function <name>] [--id <id>]`** adopts existing functions as (F) regions. It is deterministic and never calls a model.
1. Candidates are the top-level `function` declarations and `const S = (...) => ...` / `= function (...) {...}` statements of a file under `src/`: every exported one, or only `--function <name>` (exported or not). `--id` requires `--function`.
2. For each, the command writes, above the declaration (and above its JSDoc, which stays attached and outside the markers), `type <Name>Fn = <signature>;`, where the signature is printed by the type checker as a non-generic arrow type, and then `export const <name>Spec = arc.defineRegion<<Name>Fn>({ id, intent: ["[inferred] <first JSDoc line | TODO describe>"], examples: [] })`. `symbol` is added when the id's last segment differs from the function name. Markers go around the declaration lines. `import * as arc from "openarc"` is added if missing.
3. The id defaults to `<file-stem>.<functionName>`, each segment normalised to §2.3 (separators camel-cased, leading non-letters dropped, first letter lowercased).
4. Each region is recorded as `{kind: "function", ownership: "developer", fingerprint: null, provenance: {source: "extracted"}}` with the hashes ANALYZE computes. The declaration's text is unchanged byte for byte, so nothing is regenerated until `openarc release <id>`. Editing the spec of a developer region is E061 as usual (`resolve --keep` accepts it).
5. It refuses, with a message and exit code 1: overloaded functions, generic functions (type parameters can't be expressed in a non-generic `F`), default-exported anonymous functions, class methods, declarations that share a line with other code, invalid or already-used ids, and any result that type-checks worse than the original file or fails ANALYZE.
6. It is idempotent: a declaration already inside a region is skipped. File and manifest are written in one transaction (§8.1 STAGE/COMMIT) under the lock (§8.3).

---

## 11. Diagnostics

A diagnostic is `{code, id?, file?, line?, detail?}`. It has **no message field**; messages come from this table. `detail` is a structured token (`return`, `binding:y`, `invalid-json`, …), never prose, and absent fields are omitted rather than set to `undefined`. That keeps examples that assert diagnostics stable under deep strict equality. [F9]

| Code | Meaning |
|---|---|
| W001 | `@openarc:` text that is not a valid marker |
| E010 | spec not statically evaluable |
| E011 | duplicate region id |
| E012 | marker id with no spec |
| E020 | implementation not assignable to spec type F |
| E021 | declared symbol ≠ spec.symbol |
| E030 | unmatched marker |
| E031 | crossed marker nesting |
| E032 | block region outside a function region |
| E033 | illegal region body |
| E034 | nested function region |
| E035 | unsupported construct in a block region |
| W040 | block region verified indirectly |
| W041 | block region has no behavioral verification (parent has no examples) |
| W042 | block held back: its function can't be verified until all its blocks exist (§8.10) |
| E041 | `refine: "next"` unsupported in v0 |
| E050 | unknown manifest schema |
| W060 | manual edit detected; region is now developer-managed |
| E061 | spec changed on a developer-managed region |
| E062 | region markers removed |
| E063 | region moved to a different parent |
| E070 | type error |
| E071 | import not in `deps` |
| E072 | dynamic import / require |
| E073 | forbidden global |
| E074 | effect-gated identifier without that effect |
| E080 | model backend unreachable |
| E081 | model output does not match schema |
| E082 | repair attempts exhausted |
| E083 | child slot missing or duplicated |
| E090 | example failed |
| E091 | sandbox timeout or resource limit |
| E092 | sandbox unavailable |
| E093 | staging I/O error |
| W094 | recovered interrupted transaction |
| E095 | another openarc process holds the lock |
| E097 | write-scope violation: generated code changed something outside its own region (§8.7) |
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
  "sandbox": { "heapMb": 512, "cpuSeconds": 20 }
}
```

- `provider` is one of:
  - `"ollama"`: `POST {host}/api/chat` as in §8.4. `host` defaults to `http://127.0.0.1:11434`; `keepAlive` (default `"2m"`) is sent as `keep_alive`, so an idle model leaves RAM.
  - `"openai"`: any OpenAI-compatible Chat Completions endpoint (OpenAI, OpenRouter, Groq, LM Studio, vLLM, llama.cpp server). `POST {baseUrl}/chat/completions` (default `https://api.openai.com/v1`) with `temperature: 0`, `seed`, `max_tokens` and `response_format: {type: "json_schema", json_schema: {name: "openarc_region", strict: true, schema}}`, where `schema` is the §8.4 schema with `imports` also required (strict mode needs every property in `required`). `structuredOutput: "json_object"` is for providers without `json_schema`. Optional `headers` (e.g. OpenRouter's `HTTP-Referer`, `X-Title`).
  - `"anthropic"`: the Messages API, `POST {baseUrl}/messages` (default `https://api.anthropic.com/v1`) with headers `x-api-key` and `anthropic-version`, `max_tokens`, and `output_config: {format: {type: "json_schema", schema}}`. The text block of the reply is the `{body, imports}` JSON.
  
  Every provider returns the raw `{body, imports}` text, which goes through `model.parseOutput` unchanged.
- **Keys only via env var names.** A hosted backend names its key with `apiKeyEnv` (the *name* of an environment variable). A literal `apiKey` field is invalid config (`OARC-E051`). An unset variable is `OARC-E080` with detail `missing-key:<ENV_NAME>`. The key is never printed, logged, snapshotted or put in a diagnostic.
- `maxContextTokens` sets the context budget (§8.8) for every provider; Ollama also gets it as `num_ctx`. `outputReserveTokens` is sent to hosted APIs as `max_tokens`.
- `think: false` disables reasoning on Ollama reasoning models, because structured output is enough.
- The model **digest** from `/api/tags` is part of the fingerprint. If a model is re-pulled, everything it compiled goes stale. Hosted providers have no digest and the fingerprint uses `"<provider>:<baseUrl>:<model>"` without any network call. A hosted model can change silently behind its id; that is acceptable because cached bodies are re-verified on every use (§8.6).
- A backend is a bounded compilation interface: request in, `{body, imports}` out. A future adapter for a tool-using agent (Codex, Claude) MUST go through the same interface, so the compiler stays the only writer (§8.7).
- Invalid config: `OARC-E051`.

## 14. Bootstrap [F12]

1. **Stage 0** is `selfhost/` with every region body written by hand, outside OpenArc. Those regions are `developer`-owned. Its acceptance test is the self-hosted examples (`node tools/run-examples.ts --strict`: 24/24). It is built into the npm package `openarc` (`node tools/build.ts`).
2. **Stage 1:** stage 0, installed as the devDependency `openarc-stage0`, compiles a pristine `selfhost/` scaffold (`selfhost-scaffold.tgz`). Its output is `compiler`-owned regions.
3. **Stage 2:** the package built from stage 1 compiles the scaffold again, with stage 1's cache. That run must make **zero** model calls and produce a byte-identical tree and manifest (excluding `provenance.at`). Fingerprints use `COMPILER_VERSION`, not a build hash, so stages share cache keys.

Stage 0 stays installed as the known-good compiler. A broken stage N is never needed to repair itself.

## 15. Watch mode

`openarc watch [--debounce <ms>]` (default 300) keeps regions compiled while the developer edits. The queue logic is the regions `watch.classifyPath`, `watch.enqueue` and `watch.takeNext`; the loop is hand-written (`src/watcher.ts`).

1. **Events.** `src/` and `tests/fakes/` are watched recursively and the project root non-recursively. Every changed path is classified by `watch.classifyPath`; an `ignore` path MUST have no effect (no analysis). A `source`, `fakes` or `config` path sets a dirty flag and (re)starts the debounce timer.
2. **Single worker.** At most one `compile.run` is in flight. Analysis MUST NOT run while a compile is in flight; it runs when the worker is idle and the flag is dirty, and once after every run (with `running` still set, so a region edited during its own run lands in `rerun`).
3. **Analysis.** PARSE + ANALYZE + PLAN as in §8.1, with fingerprints when the backend answers its digest call (§8.4, no model is loaded). If it doesn't, a `compiler` region whose `specHash` differs from the manifest is treated as stale. Every block target is replaced by its enclosing function region (blocks are only verified jointly, §8.10). Targets are queued with `watch.enqueue`, in plan order.
4. **Dispatch.** Before each `watch.takeNext`, the default backend is checked: Ollama's `/api/tags` must list the model; a hosted backend needs its `apiKeyEnv` set. On failure the worker prints one line and pauses for 5 s, 10 s, 30 s, then 60 s per retry, resetting after a success. The queue MUST NOT be dropped. A relevant change during a pause retries immediately. Each region is `compile.run(ports, {…req, ids: [id], keepGoing: true})`.
5. **Failed regions.** A run with exit 1 records the region's key: the `specHash`es of the function and its blocks, and their fingerprints (empty when unknown). The region MUST NOT be queued again while its key is unchanged (fingerprints are compared only when both are known). A `config` or `fakes` change clears all keys. A run that fails with `OARC-E080` or `OARC-E095` is not a failure: the region goes back to the front of the queue and the worker pauses as in 4.
6. **History.** Each dispatch appends `{at, id, state, ms, detail}` to `.openarc/watch-history.jsonl`, `state` ∈ `running | done | failed | interrupted`; the file keeps its last 1000 lines. At start, a region whose last entry is `running` is reported and recorded `interrupted`. The history never decides what to compile.
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
