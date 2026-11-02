# Multi-file evolution benchmark, after the fixes (2026-11-02)

Same scenario and D as `../2026-11-02-evolve-multi` (D is deterministic, copied from there). Arm A on the `retry-memory`
branch (33fd55d): failed regions are remembered across compiles (`.openarc/failed.json`), and a truncated repetition loop
is not retried with a bigger cap. Seeds 1-3.

| Arm | Seeds | Tokens | Wall s | Calls | Initial step tokens | Later steps tokens | Correct function-steps | Tokens per correct fn-step | Seconds per correct fn-step | Final functions passing | Final held-out tests | Regressions | Hand edit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 3 | 21163 | 99.8 | 22.7 | 5156 | 16006 | 12.7 | 1671 | 7.9 | 2.0/9 | 20.7/80 | 0.0 | kept |
| D | 3 | 16651 | 92.6 | 15.0 | 4411 | 12240 | 23.0 | 724 | 4.0 | 3.0/9 | 29.0/80 | 0.0 | kept |

Per seed: tokens / wall s / correct function-steps

| Arm | s1 | s2 | s3 |
|---|---|---|---|
| A | 21818 / 94.7 / 12 | 19309 / 93.6 / 14 | 22361 / 111.0 / 12 |
| D | 16651 / 92.6 / 23 | 16651 / 92.6 / 23 | 16651 / 92.6 / 23 |

## Against the first run (A before the fixes)

| | A before | A after | D |
|---|---|---|---|
| Tokens | 60.2k | 21.2k (-65 %) | 16.7k |
| Wall | 387 s | 100 s (-74 %) | 93 s |
| Calls | 59.3 | 22.7 | 15 |
| No-change step | 3-11 calls | 0 calls | 0 calls |
| Correct function-steps (held-out) | 13.3 | 12.7 | 23 |

## Two views of correctness at the end (10 functions)

| | Held-out: functions passing all held-out tests | Spec: functions satisfying their public examples |
|---|---|---|
| A | 2.0/9 scored (20.7/80 tests) | 6.7 (8, 6, 6 per seed: every committed body is verified, plus the hand-written `ofSize`); the rest stay unimplemented and are reported |
| D | 3/9 scored (29/80 tests) | 6 (`parse`, `makeDiamond`, `answer`, `encode` ship failing their own examples, unreported) |

The remaining held-out gap is the all-or-nothing rule: D keeps code that fails its examples, and some of it passes held-out
tests anyway (acronym: both arms produce "HML" for "HyperText Markup Language"; that case is a public example, not a
held-out one, so D's unverified code scores 3/3 held-out). OpenArc writes nothing it can't verify. OpenArc's committed
bodies also pass their public examples yet often fail held-out tests: the specs are thin (W044 on most regions), which is
what `openarc lint` and `openarc check --oracle` are for.
