# Can a second generated body stand in for the oracle's reference?

Follow-up to `../2026-11-05-verification-gaps/`, where `--mutants` caught 0 of 7 known gaps and `--oracle` 1 of 7, and only with a hand-written reference most projects don't have.

## Question
Generate a second body for a region from the same spec, run both on the same inputs, and flag disagreements for a person. Does that surface the known gaps, and how much does the person have to read?

## Design (written before any model call)
- **Body A:** the frozen body in `selfhost/src` (at main 9f55ea3).
- **Body B:** a fresh compile of the same specs in a throwaway copy of `selfhost/`. Three models (`qwen3.5-9b`, `seed-coder-8b`, `qwen2.5-coder-7b`), seeds 1 to 3, temperature 0.6. At temperature 0 the same model and seed would reproduce A's prompt and most likely its body, so that case tells us nothing.
- **Regions:** three with known gaps (`model.parseOutput`, `p2p.broadcast`, `p2p.onGossip`) and three controls with none known (`p2p.peerTable`, `p2p.handshake`, `p2p.encodeVarint`). `p2p.decodeLengthPrefixed` started as a fourth control, but the first no-model run found that A hangs on `[128,0,0,0,1]` (a signed length prefix; the spec says unsigned). It is now scored separately as an eighth gap, outside the 7 in the rule.
- **Inputs:** `oracleInputs` plus structural variations (`compare.ts`), up to 2,000 of each per region. For a JSON string parameter: delete keys, change value types, empty the object, add a key. For a typed parameter the type holds: reorder, drop or repeat array items, change numbers, swap strings, including `__proto__`. Fake ports are kept fixed and rebuilt for every call, so `broadcast` can run.
- **Compile:** each target goes back to `arc.todo` and is compiled on its own in the copy. `release` alone keeps a body whose spec is unchanged, and a compile call commits nothing if any region in it fails. The first two starts of this queue hit those two behaviours and produced no valid data, so they were discarded. If B's `onGossip` fails, its `broadcast` usually fails too, since it calls `onGossip`.
- **Scoring:** stage 0's hand-written body decides who is right, and is never shown to a model. A gap is caught by a body when at least one input showing that gap makes A and B disagree. A person's reading load is the number of disagreement classes per region (the set of output paths that differ, indexes dropped).

## Decision rule (fixed before the run)
- **Second opinions are worth building as a `check` option** if one body from each of the 3 models together catch at least 5 of 7 gaps (seed 1), and the median body shows at most 5 disagreement classes on a control region.
- Otherwise they stay an idea and this note records why.
- **Structural inputs go into `oracleInputs` on their own merit** if, with the stage 0 reference, they raise 1 of 7 to at least 4 of 7, without adding disagreements on controls that turn out not to be real differences.

## Known limits
- The 7 gaps are few and were chosen after the fact, because a reviewer had already found them. These specs were also strengthened in #73, so they say more than a typical first draft.
- `__proto__` is in the input pool because of what we already know about `broadcast`. A generic input generator would have to carry it as a standard hostile string.
- Stage 0 is a reference, not the truth. Where stage 0 itself looks wrong, this note says so.

## Result
Second opinions stay an idea: **4 of 7 gaps, against the 5 the rule asked for.** Structural inputs meet their own rule: with the stage 0 reference they raise 1 of 7 to 7 of 7. Scores are in `results.txt` and `baseline-stage0.txt`.

| Gap | Structural inputs, stage 0 as reference | A second generated body (any of 9) |
|---|---|---|
| `parseOutput`: no `body` accepted | yes | yes (2 bodies) |
| `parseOutput`: bad import items accepted | yes | no |
| `parseOutput`: `imports` checked before unexpected properties | yes | yes (2 bodies) |
| `broadcast`: unknown peer throws | yes | no body compiled |
| `broadcast`: `__proto__` peer | yes | no body compiled |
| `onGossip`: candidates not sorted | yes | yes (1 body) |
| `onGossip`: negative `fanout` forwards | yes | yes (2 bodies) |
| Decoder hang (the eighth gap, found here) | yes | no: the one body compiled hangs too |

Seed 1's three bodies alone also catch 4 of 7, and all 9 together catch the same 4.

- **What limited it most was compiling.** Only 17 of 63 regions compiled (`peerTable` 9 of 9, `handshake` 3, `parseOutput` 2, `onGossip` 2, `decodeLengthPrefixed` 1, `broadcast` and `encodeVarint` 0). So most gaps had few or no bodies to compare. At temperature 0.6, with these models and 3 attempts, a second opinion usually doesn't exist. A stronger model or lower temperature might change this; neither was tried.
- **Shared bugs are real.** The only compiled decoder body hangs on the same kind of input as A, so the two agree on many of those inputs while both are wrong. Both compiled `parseOutput` bodies also miss the bad-import check.
- **Reading load is fine.** A median of 1 disagreement class per control region, maximum 5, inside the rule. Most disagreements there were the second body being wrong (`peerTable` skips sorting when a peer is refused), so a person would be reading the model's mistakes, not A's.
- **Structural inputs add no noise on controls.** `peerTable` and `encodeVarint` show nothing. `handshake` shows two real differences from stage 0. One is a contradiction in its spec: "reject (any phase but failed)" and "any event once ready or failed changes nothing" disagree on a reject while ready.
- **New bug:** the frozen `p2p.decodeLengthPrefixed` loops forever on a length prefix with the top bit set, such as `[128,0,0,0,1]`.

## Next
Add structural inputs to `oracleInputs`. The filter that respects literal unions is a named-keys shortcut here (`compare.ts`), and the real version should ask the type checker. They still need a reference, so this helps projects that have one, and `check --mutants`, which uses the same inputs.

Discarded runs: the queue's first two starts produced no valid data (see Compile, above). No MCEs during the run.
