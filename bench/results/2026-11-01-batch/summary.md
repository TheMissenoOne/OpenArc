# Issue #19: per-file batching, repeat-stop, resample (open-arc 0.9.2)

Same model (qwen2.5-coder 7B Q4_K_M, Vulkan llama-server, port 18080, flags in `server-qwen2.5-coder-7b.log`), same 8 exercises, seeds 1-3, budget of 3 calls per unit. Arms: A and E-resample on 0.9.2 (branch `batch`, b8cc8dd), D rerun as the control. Compared with A/E-resample 0.9.1 and D from `results/2026-11-01-efficiency`. Full tables: `compare.md` (`node compare.mjs results/2026-11-01-batch/compare.md results/2026-11-01-efficiency results/2026-11-01-batch`) and `tables.md`.

## What changed in 0.9.2

1. Per-file batching (`compilation.batch: "file"`, default): the first attempt of a file's independent pending function regions is one request. Each region is still verified and committed on its own; only failed regions retry, one by one.
2. Repeat-stop at the first repeated reply (E082 `repeat:`).
3. A body that failed only examples or tests is retried with the base prompt plus a short failure note, without the body. Sampling still varies.

## Coverage

Only food-chain (`verse`, `verses`) has more than one region in a file: 1 of 8 exercises, 3 of 24 tasks per arm (12.5%). The other 7 have one region each, so only levers 2 and 3 apply to them. All 6 batched first requests (A and E-resample, 3 seeds each) failed in the same way: `verses`' body called a `verses` table that `verse`'s body had declared (TS2339 `Property 'slice' does not exist on type 'VersesFn'`). The model treats the bodies as sharing one scope.

## Results (95% bootstrap CIs over the 8 exercises)

| arm | tokens/task | s/task | calls/task | accepted-and-correct | tokens per acc. task | s per acc. task |
|---|---|---|---|---|---|---|
| A@0.9.1 | 2306 [810, 4532] | 9.6 [5.1, 17.0] | 2.13 [1.00, 3.38] | 25% [0%, 63%] | 9223 [1732, 33671] | 38.3 [10.4, 129] |
| A@0.9.2 | 2123 [783, 4123] | 12.0 [5.0, 24.1] | 1.88 [1.00, 2.83] | 25% [0%, 63%] | 8494 [1649, 30468] | 48.1 [10.4, 184] |
| E-resample@0.9.2 | 2025 [798, 3807] | 10.9 [4.7, 21.2] | 1.75 [1.00, 2.50] | 25% [0%, 63%] | 8100 [1665, 28085] | 43.7 [9.8, 160] |
| D@0.9.2 (control) | 1752 [611, 3242] | 7.4 [3.4, 12.7] | 1.75 [1.00, 2.50] | 25% [0%, 63%] | 7010 [1362, 24460] | 29.7 [7.5, 95.8] |

D reproduced exactly: D@0.9.2 minus D@0.9.1 is 0 tokens and 0.0 s.

| pair | tokens/task | s/task | calls/task | accepted-and-correct | tokens per acc. task | s per acc. task |
|---|---|---|---|---|---|---|
| A@0.9.2 - A@0.9.1 | -182 [-417, +0] | +2.4 [-0.1, +7.1] | -0.25 [-0.58, +0.00] | +0.0 pp | -729 [-2916, +0] | +9.8 [-0.5, +55.1] |
| A@0.9.2 - D@0.9.2 | +371 [+2, +973] | +4.6 [+0.6, +11.8] | +0.13 [-0.25, +0.63] | +0.0 pp | +1484 [+24, +7153] | +18.4 [+2.0, +90.4] |
| E-resample@0.9.2 - E-resample@0.9.1 | +20 [-1, +61] | +0.9 [-0.0, +2.7] | -0.38 [-1.13, +0.00] | +0.0 pp | +81 [-4, +484] | +3.6 [-0.0, +21.7] |
| E-resample@0.9.2 - D@0.9.2 | +273 [-27, +667] | +3.5 [+0.4, +8.8] | +0.00 [+0.00, +0.00] | +0.0 pp | +1091 [-84, +4583] | +14.0 [+1.4, +66.6] |

## Findings

- **OpenArc still doesn't beat D.** At equal accepted-and-correct (25%, the same 2 exercises), A costs 371 more tokens and 4.6 s more per task. Both CIs exclude 0.
- **Tokens went down and wall time went up.** A used 182 fewer tokens per task (-311 prompt tokens), but took 2.4 s more. All of the extra time is food-chain (52.7 s against 34.2 s per task). The batched request costs fewer calls (4.7 against 6.0) and fewer prompt tokens (6152 against 8038). After the batched attempt fails on the shared-scope error, though, each region's single retry writes the whole lyrics table again: 2520 completion tokens against 1540.
- **Repeat-stop and the resample note helped where they apply.** On acronym, A went from 3.0 to 2.3 calls and from 1815 to 1330 tokens. Repeats dropped from 16 to 3, and each one now ends its region. On relative-distance, tokens dropped from 3303 to 3237.
- **The gap on single-region exercises is per-call overhead.** On the five exercises that take one call, A spends about 150 to 200 more prompt tokens than D (for example, flatten-array 549 against 362) and about 1.5 to 2 s more wall time that is not model time (tsc, sandbox, staging; for example, flatten-array 4.6 s wall against 3.0 s model).

## Next levers (not implemented)

1. **Batch scope note.** Add one sentence to the batched template: each body is its own function, and nothing one body declares is visible in another. This targets the systematic TS2339 seen in 6 of 6 batched requests. It should also bring food-chain's time back down by avoiding the long single retries.
2. **Per-call prompt overhead.** About 180 tokens per call on closed single-region tasks. Candidates:
   - the signature and its type appear twice (in `Fixed signature` and again in `Types`);
   - the JSON system prompt;
   - the Rules lines.
3. **Verification wall time.** About 1.5 s per verified attempt outside the model. Candidates: reuse the staged sandbox between attempts, and run tsc incrementally.
4. **Multi-region exercises to show batching** (suggested, not added): `house` (`verse`/`verses`) and `variable-length-quantity` (`encode`/`decode`) from the same ts-bench set. More generally, exercises with two or three independent helpers in one file.
