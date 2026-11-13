# Structural inputs in `oracleInputs`

Follow-up to `../2026-11-05-second-opinion/`. There, structural inputs scored on the bench's own path raised the stage 0 reference's catch from 1 of 7 known gaps to 7 of 7, and the note said to add them to `oracleInputs`. This is that change, measured on the production path.

## What changed
- **Structural edits, one change at a time:** they take half of `oracleInputs`' budget, and are taken in turn from every example's every parameter. They cover arrays reversed, rotated, or with one item dropped or repeated; numbers negated, zeroed or incremented; and strings swapped for another example's string or `""`. The bench's `"__proto__"` isn't carried. The one gap that needed it takes a fake port, which this path skips, and `check --mutants` would have suggested it as an example. A string parameter holding a JSON object is edited inside: a key deleted, retyped or added. Seeded variations fill the rest, as before.
- **A type filter:** every input has to fit the parameter types as far as JSON can show (`engine.fitsType`, through the type checker). This replaces the bench's named-keys shortcut. A literal union keeps its literals and an object its required keys. A string parameter takes any string, so edits inside a JSON string stay.
- **Nested array lengths:** without types (a pure call), a nested `[x, y]` keeps its length as before. With types, a nested array may change length.
- **`null` in examples:** an example containing `null` is no longer skipped. `null` stays as it is.
- **Default count:** `check --oracle` now defaults to 200 inputs, up from 60. `check --mutants` keeps 60, because it runs the inputs once per mutant.

## Method
Body A is selfhost's frozen body (main 9f55ea3), and the reference is stage 0's hand-written body, copied into the project for the run and removed afterwards. Each region was run with `openarc check <id> --oracle <copy>#<fn>` at the defaults, once with this branch and once with main. Gaps were scored with the predicates in `../2026-11-05-second-opinion/compare.ts`, applied by hand to the printed disagreements. Raw output is in `raw/`.

## Result
| Gap | main (60 inputs) | this branch (200) |
|---|---|---|
| `parseOutput`: no `body` accepted | yes | yes |
| `parseOutput`: bad import items accepted | no | no (6 of 1,000 inputs catch it with `--runs 1000`) |
| `parseOutput`: `imports` checked before unexpected properties | no | yes |
| `broadcast`: unknown peer throws | no | no |
| `broadcast`: `__proto__` peer | no | no |
| `onGossip`: candidates not sorted | no | yes |
| `onGossip`: negative `fanout` forwards | no | yes |

That's **4 of 7, up from 1 of 7**, meeting the rule fixed in the earlier note (at least 4 of 7).

- **Unreachable here:** `broadcast` has a fake port in every example, and the oracle path skips examples with fakes, so neither of its gaps can be reached. The bench built fakes itself, which is why it reached 7 of 7. That part is not in this change.
- **Decoder hang:** the hang in `p2p.decodeLengthPrefixed` is detected with both input sets, but only as `OARC-E090 harness crashed (exit 137)`, with no input named.
- **Controls:** `peerTable` had 10 disagreements on main, all on event types no caller could pass (such as `"conneced"`), and none now. `encodeVarint` shows none on either. `handshake` used to be skipped, because its examples contain `null`. It now shows one difference, the spec contradiction reported in the earlier note: a reject while ready.

## Limits
- These are the same 7 gaps, chosen after the fact, with stage 0 as the reference. A project needs its own reference for `--oracle`.
- No hostile strings are carried.
- `check --mutants` uses the same inputs (at 60). One test expectation changed: an example with a `null` argument used to have nothing to vary, and now mutants finds the input that tells the mutant apart (`[null, 0]`).
- The type filter is as good as the parameter types: a `string` that should be an enum lets everything through.
