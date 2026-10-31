# OpenArc, written in OpenArc

This directory is the OpenArc compiler as an OpenArc project, in the state a developer commits it **after `openarc scaffold` and before the first `openarc compile`**. Each piece of the Phase 0 spec (`../SPEC-phase0.md`) is a typed region spec whose examples are its acceptance tests. Every body is still a placeholder.

`npx tsc -p .` passes. That proves every example's `args` and `expected` type-check against the declared function type. Spec ids and marker pairs match 1:1 (30 of each).

## 1. What the developer wrote by hand

| File | Hand-written content | Why it's not generated |
|---|---|---|
| `core/index.ts` | `defineRegion`, `defineBlock`, `todo`, `pending` | Bootstrap: OpenArc needs it to exist ([F12](#findings)) |
| `src/types.ts` | Every contract type and port | Types are authoritative. They're the part you never delegate. |
| `src/model.ts` (top) | `MODEL_OUTPUT_SCHEMA`, `PROMPT_TEMPLATE_VERSION` | Policy that's part of the cache key. Generating it would make the fingerprint depend on model output ([F11](#findings)). |
| `src/compile.ts` `run` body | Control flow of the §8 state machine | The architecture of the pipeline: ordering, early exits, the lock in `finally` |
| every `define*({...})` | id, intent, deps, examples | This is the "program" |

Everything else is a placeholder that OpenArc fills in.

## 2. The region tree

```
ids.isValidId                 F  pending   9 examples
ids.findDuplicateIds          F  pending   3
markers.scanMarkers           F  pending   6
markers.buildRegionTree       F  pending   4
hash.canonicalJson            F  pending   5
hash.normalizeOwnedText       F  pending   5
hash.sha256Tagged             F  pending   3
ownership.detect              F  pending   9   ← this is the §6.2 table, executable
block.checkRestrictions       F  pending  10
plan.selectTargets            F  pending   3
model.renderTemplate          F  pending   4
model.buildRequest            F  pending   1
model.parseOutput             F  pending   7
model.call                    F  pending   0   ⚠ effectful (F6)
sandbox.buildArgv             F  pending   1   ← argv run for real on this machine
sandbox.readHarnessOutput     F  pending   4
txn.planJournal               F  pending   2
txn.commit                    F  pending   0   ⚠ effectful (F6)
txn.recover                   F  pending   0   ⚠ effectful (F6)
cli.parseArgv                 F  pending  10
compile.run                   F  developer 0   ← hand-written skeleton, mixed resolution
├── compile.run.lock          B  pending       ⚠ W041
├── compile.run.recover       B  pending       ⚠ W041
├── compile.run.parse         B  pending       ⚠ W041
├── compile.run.analyze       B  pending       ⚠ W041
├── compile.run.plan          B  pending       ⚠ W041
├── compile.run.generate      B  pending       ⚠ W041   (inside the for-loop)
├── compile.run.stage         B  pending       ⚠ W041
├── compile.run.commit        B  pending       ⚠ W041
└── compile.run.unlock        B  pending       ⚠ W041   (inside finally)
```

## 3. The session

### Step 1: write a spec (what the developer types)

```ts
type IsValidId = (id: string) => boolean;

export const isValidIdSpec = arc.defineRegion<IsValidId>({
  id: "ids.isValidId",
  intent: "True iff id matches: segment ('.' segment)*, where segment = [a-z][a-zA-Z0-9]*. …",
  examples: [
    { args: ["tasks.create"], expected: true },
    { args: ["tasks..create"], expected: false },
    // …
  ],
});
```

An example with the wrong type, such as `expected: "yes"`, is a **tsc error in the editor**. That happens before OpenArc runs at all.

### Step 2: `openarc scaffold`

This step is deterministic and makes no model call. It adds the marker pair and a placeholder that type-checks:

```ts
// @openarc:begin ids.isValidId
export const isValidId: IsValidId = (id) => arc.todo("ids.isValidId");
// @openarc:end ids.isValidId
```

Block regions inside a hand-written parent are written by the developer, using `arc.pending("<id>")` as the body:

```ts
for (const id of targets) {
  let candidate: Candidate | null = null;
  // @openarc:begin compile.run.generate
  arc.pending("compile.run.generate");
  // @openarc:end compile.run.generate
  if (candidate === null) return done(1);   // parent owns control flow
  candidates.push(candidate);
}
```

The block reports back only through `candidate`, a `let` declared above it. It can't `return`, so the early exit lives in the parent (§3.4).

### Step 3: `openarc compile` (expected output)

```
$ openarc compile
parse     30 regions in 11 files
analyze   21 function regions: 20 pending, 1 developer (compile.run)
          9 block regions: 9 pending
warning   OARC-W041 compile.run.lock … compile.run.unlock: block region has no behavioral verification (parent has no examples)
plan      29 targets, post-order: ids.isValidId, ids.findDuplicateIds, …, compile.run.lock, …, compile.run.unlock
generate  ids.isValidId            qwen2.5-coder:14b  attempt 1  tsc ✓ static ✓ examples 9/9
generate  markers.scanMarkers      qwen2.5-coder:14b  attempt 1  tsc ✓ static ✗ OARC-E071 import "fs" not in deps
                                                      attempt 2  tsc ✓ static ✓ examples 6/6
…
stage     11 files + manifest
commit    tx 01J…  ok
done      exit 0 · 31 model calls · 29 regions compiler-managed
```

`compile.run` itself is never written, because it's `developer`. Only its 9 blocks are filled in, and every byte of the hand-written skeleton survives.

### Step 4: second run, nothing changed

```
$ openarc compile
plan      0 targets
done      exit 0 · 0 model calls
```

### Step 5: a hand edit

You edit `normalizeOwnedText` by hand. The next compile prints `OARC-W060 manual edit detected → developer` and never touches that region again. To hand it back, run `openarc release hash.normalizeOwnedText`, which backs up the body first.

## Findings

Writing OpenArc in OpenArc broke the draft spec in 12 places. Every finding except F11 is now folded into `../SPEC-phase0.md` and tagged `[Fn]`; F11 is recorded only here.

| # | Found by | Problem | Fix |
|---|---|---|---|
| F1 | writing `markers.ts` | Long intents need `.join()`, which is a call and violates §2.2 (static specs) | `intent: string \| string[]` |
| F2 | writing `markers.ts` | Spec examples contain marker text inside strings, so a line-based scanner raises W001 on OpenArc's own source | Recognise markers on comment tokens only |
| F3 | **running** the TS scanner | The raw scanner drops whitespace inside templates and regexes. A semantic edit could keep the old hash and be **silently overwritten** | Hash parse-tree leaves, not scanner tokens. Child slot = `/*«openarc-child:id»*/` |
| F4 | **tsc** on `compile.ts` | `arc.todo(): never` in a pending block makes the rest of the parent unreachable. Narrowing fails, so VALIDATE fails, so the first compile can never run | Blocks use `arc.pending(): void` |
| F5 | the developer skeleton | A hand-written parent with pending blocks: the old §6.2 rule made every new marked region `developer`, so the blocks could never be generated | A placeholder body means `pending` regardless of manifest |
| F6 | `model.call`, `txn.*`, `compile.run` | JSON examples can't pass ports, so 4 of 21 function regions and all 9 blocks have zero behavioral checks, and W040's "verified indirectly" was false here | New W041. Open question: `{"$fake": name}` args |
| F7 | `block.checkRestrictions` examples | §3.4 exempted arrows, but arrows capture `this`/`arguments` lexically | Arrows are transparent |
| F8 | **running** bwrap here | asdf shim → wrong Node inside the sandbox; `--as` < 4 GiB crashes V8; missing `/lib64` symlinks; `process.exit()` truncates harness output | Resolved binary + prefix bind, `--as ≥ 4 GiB`, `{done:n}` completion line |
| F9 | writing diagnostic examples | Prose messages make deep-equality examples brittle | Diagnostics carry code + structured `detail`, no message |
| F10 | tsc on cross-file imports | Code that imports a not-yet-scaffolded symbol fails tsc | Scaffold before VALIDATE; `openarc scaffold` |
| F11 | `model.ts` | A generated prompt template would put model output into its own cache key | Policy artifacts are hand-written, not regions |
| F12 | `core/index.ts` | OpenArc can't generate itself before it exists | Stage 0 by hand; these specs are its test suite; stage 1 = stage 2 check |

## Re-check

```bash
cd selfhost && npm install && npx tsc -p .     # 0 errors: every example is type-correct
```
