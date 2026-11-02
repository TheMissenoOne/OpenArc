# Multi-file evolution benchmark: 6 public examples per function (2026-11-02)

`BENCH_PUBLIC=6` (split rule min(6, floor(eligible/2))), separate work dir, open-arc 0.9.6, seeds 1-3. Held-out sets are
smaller than with 3 (68 vs 80 tests), so compare arms within a run, not across runs.

| Arm | Tokens | Wall s | Calls | Correct function-steps | Final held-out tests |
|---|---|---|---|---|---|
| A, 3 examples | 21.2k | 99.8 | 22.7 | 12.7 | 20.7/80 |
| A, 6 examples | 24.8k | 129.0 | 24.0 | 12.7 | 13.7/68 |
| D, 3 examples | 16.7k | 92.6 | 15.0 | 23.0 | 29.0/80 |
| D, 6 examples | 27.0k | 135.3 | 21.0 | 23.0 | 26.0/68 |

More examples changed no arm's correctness and cost both more tokens.

## Where the gap comes from

Correct steps per exercise, summed over 3 seeds (both runs identical):

| | acronym | flatten-array | spiral-matrix |
|---|---|---|---|
| A | 0 | 23 | 15 |
| D | 27 | 27 | 15 |

The whole A-vs-D gap is acronym (9 steps per seed) plus flatten-array's first step. D's acronym body gives "HML" for
"HyperText Markup Language": it fails its own public example and passes every held-out test (none tests a capital
inside a word). A produces the same body and refuses to commit it. Counting a function as correct only when it passes
its public examples too, A has 12.7 correct function-steps and D about 14: the reported 12.7 vs 23 is mostly the
metric rewarding unverified code that the held-out split happens not to catch. summarize-multi should report both.
